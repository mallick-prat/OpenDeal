import { NextResponse } from "next/server";
import { sql, poolGeneration } from "@/lib/db";
import { isCronAuthorized } from "@/lib/cronAuth";

export const maxDuration = 120;

/**
 * Pipeline-load diagnostic: times every query the dashboard runs, one by
 * one, inside the real production runtime — connection acquisition, each
 * table read, row counts, and payload sizes. Cron-secret gated so it can
 * be curled during an incident without a browser session.
 */
export async function GET(req: Request) {
  if (!isCronAuthorized(req)) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }
  const t0 = Date.now();
  const steps: {
    step: string;
    ms: number;
    rows?: number;
    bytes?: number;
    error?: string;
  }[] = [];

  async function time<T>(
    step: string,
    fn: () => Promise<T>,
    count?: (r: T) => number
  ): Promise<T | null> {
    const s = Date.now();
    try {
      const r = await fn();
      steps.push({
        step,
        ms: Date.now() - s,
        rows: count ? count(r) : undefined,
        bytes: JSON.stringify(r ?? "").length,
      });
      return r;
    } catch (err) {
      steps.push({
        step,
        ms: Date.now() - s,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  await time("connect (select 1)", () => sql`select 1`);
  await time(
    "membership (app_users)",
    () => sql`select email, role from app_users limit 20`,
    (r) => (r as unknown[]).length
  );
  await time(
    "deals (dashboard select)",
    () => sql`
      select gid, name, left(notes, 200) as notes, stage, section_gid,
             schools, owner, created_on, modified_on, url,
             financing_amount, round, attachment_count, offered, created_by, visibility
      from deals order by created_on desc
    `,
    (r) => (r as unknown[]).length
  );
  await time(
    "deal owners join",
    () => sql`
      select o.deal_gid, u.email, u.name, u.image
      from deal_owners o join app_users u on u.email = o.email
    `,
    (r) => (r as unknown[]).length
  );
  await time(
    "pool stats",
    () => sql`
      select count(*)::int as total,
             count(*) filter (where state = 'active')::int as active,
             count(*) filter (where wait_event_type = 'Lock')::int as waiting_on_locks
      from pg_stat_activity where datname = current_database()
    `
  );

  return NextResponse.json({
    ok: true,
    totalMs: Date.now() - t0,
    region: process.env.VERCEL_REGION ?? "unknown",
    coldStart: !globalThis.__diagWarm,
    // Which pool this instance is on — increments each time the poisoned-pool
    // detector rebuilt it. A rising number here during an incident is the
    // self-heal working; a flat 1 with hangs means the detector never saw the
    // failures (check that the failing path goes through withRetry).
    pool_generation: poolGeneration(),
    steps,
  });
}

declare global {
   
  var __diagWarm: boolean | undefined;
}
globalThis.__diagWarm = true;
