import { NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { withRetry } from "@/lib/retry";
import { currentAppUser } from "@/lib/users";

// A stalled pool retries for ~22s; the platform default (15s) would 504
// first. Explicit ceiling so retries get to finish.
export const maxDuration = 30;

/**
 * The inbox's heartbeat: a fingerprint of the queue that changes whenever a
 * candidate arrives, is upgraded from parsing, or gets reviewed. The client
 * polls this and refreshes the page only when the fingerprint moves — so a
 * forwarded pitch appears on screen without anyone reloading, and an idle
 * inbox costs one cheap indexed query per poll instead of a full render.
 */
export async function GET() {
  const member = await currentAppUser();
  if (!member) return NextResponse.json({ ok: false }, { status: 401 });
  try {
    const rows = await withRetry(
      () => sql<{ stamp: string | null; open: number }[]>`
        select greatest(
                 max(c.received_at),
                 max(c.reviewed_at),
                 max(e.processed_at)
               )::text as stamp,
               count(*) filter (
                 where c.status in ('detected', 'parsing', 'ready', 'assigned')
               )::int as open
          from deal_candidates c
          left join inbound_emails e on e.id = c.source_email_id
      `
    );
    return NextResponse.json({
      ok: true,
      stamp: `${rows[0]?.stamp ?? ""}|${rows[0]?.open ?? 0}`,
    });
  } catch {
    // A pulse failure must never look like a queue change.
    return NextResponse.json({ ok: false }, { status: 500 });
  }
}
