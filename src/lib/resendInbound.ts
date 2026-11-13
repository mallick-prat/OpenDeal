import "server-only";
import { htmlToText } from "./emailParse";
import {
  normalizeAddress,
  isResendUrl,
  decodeDataUriHtml,
} from "./inboundEmailWebhook";
import type { WebhookEmailInput } from "./inbound";
import { logError } from "./log";

export { isResendReceivedEvent } from "./inboundEmailWebhook";

/**
 * ── Resend inbound email ─────────────────────────────────────────────────────
 * your inbound domain's MX points at Resend, so mail to (or CC'ing)
 * your intake address raises an `email.received` webhook. That webhook
 * is METADATA-ONLY — the body and attachments live behind the Received Emails
 * API — so ingestion is: webhook nudge (email_id) → authenticated fetch of the
 * full email → the shared ingest pipeline.
 *
 * Security note: we deliberately act only on data returned by Resend's API
 * (authenticated with RESEND_API_KEY), never on the webhook body itself. A
 * forged webhook can at most make us fetch a nonexistent id from Resend.
 */

const API = "https://api.resend.com";
const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;
const MAX_ATTACHMENTS = 6;

/* eslint-disable @typescript-eslint/no-explicit-any */
async function resendGet(path: string): Promise<any> {
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error("RESEND_API_KEY not set");
  const res = await fetch(`${API}${path}`, {
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`Resend ${res.status} for ${path}`);
  return res.json();
}

/**
 * Fetch the full received email + its attachment bytes, shaped for
 * ingestWebhookEmail. Attachment failures degrade to fewer attachments,
 * never a thrown ingest.
 */
export async function fetchResendEmail(emailId: string): Promise<WebhookEmailInput> {
  const email = await resendGet(`/emails/receiving/${emailId}`);

  const text = typeof email.text === "string" ? email.text : "";
  const html = decodeDataUriHtml(email.html);
  const bodyText = (text.trim() || htmlToText(html)).slice(0, 40_000);
  const from = normalizeAddress(email.headers?.from ?? email.from);

  const attachments: WebhookEmailInput["attachments"] = [];
  if (Array.isArray(email.attachments) && email.attachments.length > 0) {
    try {
      const list = await resendGet(`/emails/receiving/${emailId}/attachments`);
      for (const a of (list.data ?? []).slice(0, MAX_ATTACHMENTS)) {
        const url = String(a?.download_url ?? "");
        const size = Number(a?.size ?? 0);
        if (!isResendUrl(url) || size > MAX_ATTACHMENT_BYTES) continue;
        try {
          const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
          if (!res.ok) continue;
          const bytes = Buffer.from(await res.arrayBuffer());
          if (bytes.length === 0 || bytes.length > MAX_ATTACHMENT_BYTES) continue;
          attachments.push({
            filename: String(a?.filename ?? "attachment"),
            mimeType: String(a?.content_type ?? "application/octet-stream"),
            bytes,
          });
        } catch (err) {
          logError("inbound", "resend attachment fetch failed", err, {
            emailId,
            file: String(a?.filename ?? ""),
          });
        }
      }
    } catch (err) {
      logError("inbound", "resend attachment list failed", err, { emailId });
    }
  }

  return {
    messageId: String(email.message_id ?? "") || `resend-${emailId}`,
    from,
    subject: String(email.subject ?? ""),
    bodyText,
    attachments,
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */
