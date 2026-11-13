import { NextResponse } from "next/server";
import { after } from "next/server";
import { createHmac, timingSafeEqual } from "crypto";
import { ingestWebhookEmail, type WebhookEmailInput } from "@/lib/inbound";
import {
  normalizeJsonPayload,
  normalizeAddress,
  bodyTextOf,
  type InboundAttachmentInput,
} from "@/lib/inboundEmailWebhook";
import { isResendReceivedEvent, fetchResendEmail } from "@/lib/resendInbound";
import { logError, logEvent } from "@/lib/log";

export const maxDuration = 300;

/**
 * Inbound-email webhook. The intake address is just an address on a
 * domain we own — its subdomain's MX record routes mail to Resend, and Resend
 * POSTs each received email here (any generic inbound-parse provider works
 * too, multipart or JSON). We ack fast and ingest in the background so the
 * draft appears in /inbound within seconds. Authenticated by a shared secret
 * (query ?token= or Bearer) — the body is untrusted data.
 */
function authorized(req: Request, url: URL): boolean {
  const secret = process.env.INBOUND_WEBHOOK_SECRET;
  if (!secret) return false;
  const bearer = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const got = url.searchParams.get("token") || bearer;
  const a = createHmac("sha256", secret).update(got).digest();
  const b = createHmac("sha256", secret).update(secret).digest();
  return timingSafeEqual(a, b);
}

const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;
const MAX_ATTACHMENTS = 6;

/** Fetch a URL attachment only if its host is allowlisted (SSRF guard). */
async function fetchUrlAttachment(url: string): Promise<Buffer | null> {
  const hosts = (process.env.INBOUND_ATTACHMENT_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  let host = "";
  try {
    const u = new URL(url);
    if (u.protocol !== "https:") return null;
    host = u.hostname.toLowerCase();
  } catch {
    return null;
  }
  if (!hosts.some((h) => host === h || host.endsWith(`.${h}`))) return null;
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) }).catch(() => null);
  if (!res?.ok) return null;
  const buf = Buffer.from(await res.arrayBuffer());
  return buf.length > 0 && buf.length <= MAX_ATTACHMENT_BYTES ? buf : null;
}

async function resolveAttachments(
  inputs: InboundAttachmentInput[]
): Promise<{ attachments: WebhookEmailInput["attachments"]; skipped: string[] }> {
  const attachments: WebhookEmailInput["attachments"] = [];
  const skipped: string[] = [];
  for (const a of inputs.slice(0, MAX_ATTACHMENTS)) {
    let bytes: Buffer | null = null;
    if (a.base64) {
      const b = Buffer.from(a.base64, "base64");
      if (b.length > 0 && b.length <= MAX_ATTACHMENT_BYTES) bytes = b;
    } else if (a.url) {
      bytes = await fetchUrlAttachment(a.url);
      if (!bytes) skipped.push(a.filename);
    }
    if (bytes) attachments.push({ filename: a.filename, mimeType: a.mimeType, bytes });
  }
  return { attachments, skipped };
}

/** Parse a multipart/form-data inbound payload (SendGrid/Mailgun-style). */
async function fromMultipart(form: FormData): Promise<WebhookEmailInput> {
  const field = (names: string[]): string => {
    for (const n of names) {
      const v = form.get(n);
      if (typeof v === "string" && v.trim()) return v;
    }
    return "";
  };
  const from = normalizeAddress(field(["from", "From", "sender"]));
  const subject = field(["subject", "Subject"]);
  const text = field(["text", "plain", "body-plain", "TextBody", "stripped-text"]);
  const html = field(["html", "body-html", "HtmlBody"]);
  const messageId = field(["Message-Id", "message-id", "messageId"]) || null;

  const attachments: WebhookEmailInput["attachments"] = [];
  for (const [, value] of form.entries()) {
    if (value instanceof File && value.size > 0 && value.size <= MAX_ATTACHMENT_BYTES) {
      if (attachments.length >= MAX_ATTACHMENTS) break;
      const bytes = Buffer.from(await value.arrayBuffer());
      attachments.push({
        filename: value.name || "attachment",
        mimeType: value.type || "application/octet-stream",
        bytes,
      });
    }
  }
  return { messageId, from, subject, bodyText: bodyTextOf({ text, html }), attachments };
}

export async function POST(req: Request) {
  const url = new URL(req.url);
  if (!authorized(req, url)) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }

  const ctype = req.headers.get("content-type") ?? "";
  let payload: WebhookEmailInput | null = null;
  try {
    if (ctype.includes("multipart/form-data")) {
      payload = await fromMultipart(await req.formData());
    } else {
      const obj = await req.json();

      // Resend `email.received` (the Resend path): the webhook is
      // metadata-only, so ack now and fetch the full email from Resend's API
      // (authenticated — we never act on the webhook body) in the background.
      if (isResendReceivedEvent(obj)) {
        const emailId = obj.data.email_id;
        logEvent("info", "inbound", "resend email.received", { emailId });
        after(async () => {
          try {
            await ingestWebhookEmail(await fetchResendEmail(emailId));
          } catch (err) {
            logError("inbound", "resend ingest failed", err, { emailId });
          }
        });
        return NextResponse.json({ ok: true });
      }

      // Generic JSON providers (Postmark/CloudMailin/inbound.new/etc.).
      const n = normalizeJsonPayload(obj);
      const { attachments, skipped } = await resolveAttachments(n.attachments);
      if (skipped.length) logEvent("info", "inbound", "webhook url attachments skipped", { skipped: skipped.join(", ") });
      payload = {
        messageId: n.messageId,
        from: n.from,
        subject: n.subject,
        bodyText: bodyTextOf(n),
        attachments,
      };
    }
  } catch (err) {
    logError("inbound", "webhook payload parse failed", err, { ctype });
    return NextResponse.json({ ok: false, error: "Unparseable payload." }, { status: 400 });
  }

  if (!payload.from.email && !payload.subject && !payload.bodyText) {
    return NextResponse.json({ ok: false, error: "Empty email." }, { status: 400 });
  }

  logEvent("info", "inbound", "webhook email received", {
    from: payload.from.email,
    subject: payload.subject.slice(0, 120),
    attachments: payload.attachments.length,
  });
  const toIngest = payload;
  after(async () => {
    try {
      await ingestWebhookEmail(toIngest);
    } catch (err) {
      logError("inbound", "webhook ingest failed", err, { from: toIngest.from.email });
    }
  });
  return NextResponse.json({ ok: true });
}
