import { NextResponse } from "next/server";
import { sweepStuckBackends } from "@/lib/dbHealth";
import { logError } from "@/lib/log";
import { isCronAuthorized } from "@/lib/cronAuth";

export const maxDuration = 30;

/**
 * Operational backstop for pool starvation: terminate any Postgres backend
 * left stuck by a frozen serverless lambda (ClientRead / idle-in-transaction)
 * beyond the server-side statement/idle timeouts. Cron-secret gated. With the
 * ALTER ROLE timeouts in place this usually finds nothing — it's the safety
 * net for anything that slips past them.
 */
export async function GET(req: Request) {
  if (!isCronAuthorized(req)) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }
  try {
    const result = await sweepStuckBackends();
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    logError("cron", "db-sweep failed", err);
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "sweep failed" },
      { status: 500 }
    );
  }
}
