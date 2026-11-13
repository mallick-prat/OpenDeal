import { NextResponse } from "next/server";
import { currentAppUser } from "@/lib/users";
import { logEvent } from "@/lib/log";

// A stalled pool retries for ~22s; the platform default (15s) would 504
// first. Explicit ceiling so retries get to finish.
export const maxDuration = 30;


/**
 * Browser-side errors land here (see ClientErrorReporter) so hydration
 * failures and runtime crashes in the field show up in the System log
 * instead of dying silently in someone's console.
 */
export async function POST(req: Request) {
  const member = await currentAppUser();
  if (!member) return NextResponse.json({ ok: false }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as {
    message?: string;
    stack?: string;
    url?: string;
  };
  if (!body.message) return NextResponse.json({ ok: false }, { status: 400 });
  logEvent("error", "client", String(body.message).slice(0, 300), {
    by: member.email,
    url: String(body.url ?? "").slice(0, 200),
    stack: String(body.stack ?? "").slice(0, 600),
  });
  return NextResponse.json({ ok: true });
}
