import { NextResponse } from "next/server";
import { reparseInbound } from "@/lib/inbound";
import { logEvent } from "@/lib/log";
import { isCronAuthorized } from "@/lib/cronAuth";

export const maxDuration = 300;

/**
 * Re-run the full inbound parse for one email (CRON_SECRET only) — the ops
 * lever for "the deck didn't capture": attachment fetch, thread sweep,
 * member-mailbox recovery, DocSend conversion, extraction, classification.
 * POST { id: "<inbound_emails.id>" }.
 */
export async function POST(req: Request) {
  if (!isCronAuthorized(req)) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }
  const body = (await req.json().catch(() => ({}))) as { id?: string };
  const id = (body.id ?? "").trim();
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    return NextResponse.json({ ok: false, error: "bad id" }, { status: 400 });
  }
  const result = await reparseInbound(id);
  logEvent("info", "inbound", "manual reparse", { id, result });
  return NextResponse.json({ ok: result === "parsed", result });
}
