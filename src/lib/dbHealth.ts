import "server-only";
import postgres from "postgres";
import { databaseSsl, databaseUrl } from "./dbConfig";

/**
 * ── Zombie-backend sweep (pool-starvation backstop) ──────────────────────────
 * When a serverless lambda is frozen/reclaimed mid-query, its Postgres backend
 * is left waiting on a client that will never speak again (ClientRead), or idle
 * inside a transaction — holding a Supavisor pool slot. Enough of those starve
 * the pool and every page load times out.
 *
 * `ALTER ROLE ... SET statement_timeout` is the primary defense (it auto-aborts
 * stuck backends); this is the operational backstop that terminates any that
 * outlive it. It runs on its OWN one-shot connection — never the shared pool —
 * so it can act even when that pool is exhausted, and closes it immediately.
 */

const STUCK_SECONDS = 90;

export interface SweepResult {
  terminated: number;
  scanned: number;
}

/* ── Reactive sweep: self-heal the moment starvation is detected ───────────── */

// Deliberately hard to trip. This sweep fires pg_terminate_backend against a
// SHARED Supavisor transaction pooler: backends multiplex many clients, so a
// termination can land 57P01 on an innocent in-flight query — ours or another
// instance's. A trigger-happy version of this (3 deadlines in 15s, 60s
// debounce, 45s threshold) amplified pool-starvation blips into 57P01 storms.
// Deadline bursts are now handled first by the pool recycling itself (db.ts);
// this remains only for genuine server-side zombies from dead lambdas.
const DEADLINE_WINDOW_MS = 15_000;
const DEADLINE_TRIP = 6;
const SWEEP_DEBOUNCE_MS = 5 * 60_000;
let deadlineTimestamps: number[] = [];
let lastReactiveSweep = 0;

/**
 * Called on every CLIENT_DEADLINE. A burst of them means the pool is starving
 * NOW — so fire a sweep immediately (debounced), on the dedicated connection
 * that bypasses the starved pool. This reclaims slots between the periodic
 * cron runs, exactly when it matters. Per-lambda-instance state, which is fine:
 * whichever instance is starving trips first and the sweep is global.
 */
export function noteClientDeadline(): void {
  const now = Date.now();
  deadlineTimestamps = deadlineTimestamps.filter((t) => now - t < DEADLINE_WINDOW_MS);
  deadlineTimestamps.push(now);
  if (deadlineTimestamps.length < DEADLINE_TRIP) return;
  if (now - lastReactiveSweep < SWEEP_DEBOUNCE_MS) return;
  lastReactiveSweep = now;
  deadlineTimestamps = [];
  // Fire-and-forget. Full threshold even reactively: a backend 45s into its
  // work can be a legitimate slow statement; 90s past statement_timeout is not.
  void sweepStuckBackends(STUCK_SECONDS).catch(() => {});
}

export async function sweepStuckBackends(
  stuckSeconds = STUCK_SECONDS
): Promise<SweepResult> {
  const url = databaseUrl();
  if (!url) return { terminated: 0, scanned: 0 };
  // Dedicated short-lived client so the sweep never competes for — or lingers
  // in — the app's pool.
  const client = postgres(url, {
    ssl: databaseSsl(url),
    prepare: false,
    max: 1,
    connect_timeout: 8,
    idle_timeout: 2,
    max_lifetime: 30,
  });
  try {
    const scanned = await client<{ n: number }[]>`
      select count(*)::int as n from pg_stat_activity
      where datname = current_database() and pid <> pg_backend_pid()
    `;
    // Only genuinely-stuck states, and only ones older than the threshold —
    // no healthy query sits in ClientRead or idle-in-transaction for 90s, so
    // this can't catch a legitimately-running statement.
    const killed = await client<{ pid: number }[]>`
      select pg_terminate_backend(pid) as ok, pid
      from pg_stat_activity
      where datname = current_database()
        and pid <> pg_backend_pid()
        and (
          (state = 'active' and wait_event = 'ClientRead')
          or state = 'idle in transaction'
          or state = 'idle in transaction (aborted)'
        )
        and now() - state_change > make_interval(secs => ${stuckSeconds})
    `;
    if (killed.length > 0) {
      console.warn("[db] swept stuck backends", {
        terminated: killed.length,
        stuck_seconds: stuckSeconds,
      });
      // Written through THIS dedicated client, not logEvent's shared pool:
      // the incident forensics could not rule the sweeper in or out as the
      // 57P01 source precisely because reactive sweeps were console-only —
      // invisible in app_events. Every termination is now on the record.
      await client`
        insert into app_events (level, source, message, detail)
        values ('warn', 'db', 'swept stuck backends',
                ${client.json({ terminated: killed.length, stuck_seconds: stuckSeconds, reactive: stuckSeconds !== STUCK_SECONDS ? false : true, pids: killed.map((k) => k.pid) })})
      `.catch(() => {});
    }
    return { terminated: killed.length, scanned: scanned[0]?.n ?? 0 };
  } catch (err) {
    console.error("[db] backend sweep failed", err instanceof Error ? err.message : err);
    return { terminated: 0, scanned: 0 };
  } finally {
    await client.end({ timeout: 5 }).catch(() => {});
  }
}
