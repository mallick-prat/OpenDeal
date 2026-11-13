import { parseFrom, htmlToText } from "./emailParse";

/**
 * ── Inbound-email webhook normalizer ─────────────────────────────────────────
 * Mail sent to (or CC'ing) the intake address your intake address is
 * received by an inbound-parse service and POSTed here. Providers disagree on
 * field names and envelope shape (SendGrid/Mailgun multipart, Postmark/CloudMailin
 * JSON, …), so this maps the common shapes to one structure. Attachment BYTES
 * arrive inline — no follow-up fetch — so PDF decks work anywhere, incl. Vercel.
 *
 * The multipart branch lives in the route (it needs Web FormData); the JSON
 * branch here is pure and unit-tested.
 */

export interface InboundAttachmentInput {
  filename: string;
  mimeType: string;
  /** Exactly one of these carries the payload. */
  base64?: string;
  url?: string;
}

export interface NormalizedInbound {
  messageId: string | null;
  from: { name: string; email: string };
  subject: string;
  text: string;
  html: string;
  attachments: InboundAttachmentInput[];
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export function pickField(obj: any, names: string[]): string {
  for (const n of names) {
    const v = obj?.[n];
    if (typeof v === "string" && v.trim()) return v;
    if (typeof v === "number") return String(v);
  }
  return "";
}

/** A "from" can be a string, {email,name}, {address}, or an array of those. */
export function normalizeAddress(v: any): { name: string; email: string } {
  if (!v) return { name: "", email: "" };
  if (Array.isArray(v)) return normalizeAddress(v[0]);
  if (typeof v === "string") return parseFrom(v);
  if (typeof v === "object") {
    const email = String(v.email ?? v.address ?? v.Email ?? "").toLowerCase().trim();
    const name = String(v.name ?? v.Name ?? v.personal ?? "").trim();
    if (email) return { name, email };
    // Some providers nest {value:[{address,name}]} (Postmark FromFull is flat).
    if (v.value) return normalizeAddress(v.value);
  }
  return { name: "", email: "" };
}

function normalizeAttachments(raw: any): InboundAttachmentInput[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((a: any) => {
      const filename = String(a?.filename ?? a?.name ?? a?.Name ?? a?.fileName ?? "").trim();
      const mimeType = String(
        a?.contentType ?? a?.type ?? a?.ContentType ?? a?.["content-type"] ?? "application/octet-stream"
      ).trim();
      // base64 content under various keys, or a URL to fetch.
      const base64 =
        typeof a?.content === "string" && !/^https?:\/\//i.test(a.content)
          ? a.content
          : typeof a?.Content === "string"
            ? a.Content
            : typeof a?.data === "string"
              ? a.data
              : undefined;
      const url =
        typeof a?.url === "string" ? a.url
        : typeof a?.Url === "string" ? a.Url
        : typeof a?.content === "string" && /^https?:\/\//i.test(a.content) ? a.content
        : undefined;
      return { filename: filename || "attachment", mimeType, base64, url };
    })
    .filter((a) => a.base64 || a.url);
}

/** Map a JSON inbound-email payload to the normalized shape. */
export function normalizeJsonPayload(obj: any): NormalizedInbound {
  const from = normalizeAddress(
    obj?.from ?? obj?.From ?? obj?.FromFull ?? obj?.sender ?? obj?.envelope?.from
  );
  const subject = pickField(obj, ["subject", "Subject"]);
  const text = pickField(obj, ["text", "plain", "TextBody", "body-plain", "body", "StrippedTextBody"]);
  const html = pickField(obj, ["html", "HtmlBody", "body-html"]);
  const messageId =
    pickField(obj, ["messageId", "MessageID", "Message-Id", "message_id", "id"]) || null;
  const attachments = normalizeAttachments(obj?.attachments ?? obj?.Attachments);
  return { messageId, from, subject, text, html, attachments };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** Best plain-text body: prefer text, else strip the HTML. */
export function bodyTextOf(n: { text: string; html: string }): string {
  return (n.text.trim() || htmlToText(n.html)).slice(0, 40_000);
}

/* ── Resend-specific pure helpers (I/O lives in resendInbound.ts) ──────────── */

/** Is this JSON body a Resend `email.received` webhook envelope? */
/* eslint-disable @typescript-eslint/no-explicit-any */
export function isResendReceivedEvent(obj: any): obj is { data: { email_id: string } } {
  return obj?.type === "email.received" && typeof obj?.data?.email_id === "string";
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** Presigned attachment URLs must stay on Resend's own hosts. */
export function isResendUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && /(?:^|\.)resend\.com$/.test(u.hostname);
  } catch {
    return false;
  }
}

/** Resend may deliver `html` as a data: URI (html_format: "data_uri"). */
export function decodeDataUriHtml(html: unknown): string {
  if (typeof html !== "string" || !html) return "";
  if (html.startsWith("data:")) {
    const comma = html.indexOf(",");
    if (comma < 0) return "";
    const meta = html.slice(0, comma);
    const payload = html.slice(comma + 1);
    try {
      return /;base64/i.test(meta)
        ? Buffer.from(payload, "base64").toString("utf8")
        : decodeURIComponent(payload);
    } catch {
      return "";
    }
  }
  return html;
}
