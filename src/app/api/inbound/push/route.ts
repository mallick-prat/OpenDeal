import { NextResponse } from "next/server";
import { after } from "next/server";
import { createHmac, timingSafeEqual } from "crypto";
import { ingestSince } from "@/lib/inbound";
import { logError, logEvent } from "@/lib/log";

export const maxDuration = 300;

/**
 * Gmail push endpoint (Google Pub/Sub push subscription). A message arriving at
 * the sourcing mailbox triggers this within seconds; we ack immediately and do
 * the history-based ingest in the background so the draft pops into /inbound
 * right away. Authenticated by a shared secret in the query string (Pub/Sub
 * can't carry a session) — not the message body, which is untrusted.
 */
function authorized(url: URL): boolean {
  const secret = process.env.INBOUND_PUSH_SECRET;
  if (!secret) return false;
  const got = url.searchParams.get("token") ?? "";
  // HMAC both sides with the same key → equal-length digests, constant-time
  // compare, equal iff the supplied token matches the secret.
  const a = createHmac("sha256", secret).update(got).digest();
  const b = createHmac("sha256", secret).update(secret).digest();
  return timingSafeEqual(a, b);
}

export async function POST(req: Request) {
  const url = new URL(req.url);
  if (!authorized(url)) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }
  // Body is a Pub/Sub envelope; we don't trust it for anything but a nudge.
  // The real work reads Gmail's history from our stored watermark.
  await req.text().catch(() => "");
  logEvent("info", "inbound", "push received", {});
  after(async () => {
    try {
      await ingestSince();
    } catch (err) {
      logError("inbound", "push ingest failed", err);
    }
  });
  // Ack fast so Pub/Sub doesn't redeliver while we process.
  return NextResponse.json({ ok: true });
}
