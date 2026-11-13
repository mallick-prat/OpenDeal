import "server-only";
import { sql } from "./db";

/**
 * ── Field instrumentation ────────────────────────────────────────────────────
 * The optimization work in this codebase kept flying blind: targets like
 * "inbox under 400ms" could not be verified because nothing measured the
 * running app. This module is the whole fix — one table, one wrapper.
 *
 *   timed("api.cockpit", fn)  →  perf_events row {name, ms, meta, at}
 *
 * Writes are fire-and-forget: telemetry must never add a failure mode (or
 * measurable latency) to the path it observes. Retention self-prunes to 30
 * days on ~0.5% of writes. The Settings page renders perfSummary().
 *
 * Naming: page.* (server component renders), api.* (route handlers),
 * action.* (server actions), cron.* (schedules), llm.* (model calls),
 * vitals.* (browser web-vitals via /api/vitals).
 */

let ready: Promise<void> | null = null;
/**
 * Catalog-check FIRST, DDL only on genuine absence. The lesson is written in
 * a production incident: `create index if not exists` still takes a SHARE
 * lock on the table before noticing the index exists, so every cold lambda
 * briefly blocked all perf inserts; under a deploy's cold-start burst the
 * lock queue convoyed, ate every pooler backend, and starved the dashboard.
 * to_regclass() reads the catalog with no table lock at all.
 */
function ensurePerfSchema(): Promise<void> {
  ready ??= (async () => {
    const t = await sql<{ ok: boolean }[]>`
      select to_regclass('public.perf_events') is not null as ok`;
    if (!t[0]?.ok) {
      // First-ever creation only; a concurrent racer's error is tolerated.
      await sql`
        create table if not exists perf_events (
          id bigint generated always as identity primary key,
          name text not null,
          ms integer not null,
          meta jsonb,
          at timestamptz not null default now()
        )`.catch(() => {});
    }
    const i = await sql<{ ok: boolean }[]>`
      select to_regclass('public.perf_events_name_at_idx') is not null as ok`;
    if (!i[0]?.ok) {
      await sql`create index if not exists perf_events_name_at_idx on perf_events (name, at desc)`.catch(
        () => {}
      );
    }
  })().catch((err) => {
    ready = null; // next record() retries the check
    throw err;
  });
  return ready;
}

// Telemetry is droppable by definition: when the pool is struggling, the
// worst thing measurement can do is join the queue. Cap in-flight writes per
// lambda so perf_events can never hold more than a sliver of the pool.
let inFlight = 0;
const MAX_IN_FLIGHT = 3;

/** Record one measurement. Never throws, never blocks the caller, and
 * sheds load (drops the event) rather than queue on a busy pool. */
export function record(
  name: string,
  ms: number,
  meta?: Record<string, unknown>
): void {
  if (inFlight >= MAX_IN_FLIGHT) return;
  inFlight++;
  void (async () => {
    await ensurePerfSchema();
    await sql`
      insert into perf_events (name, ms, meta)
      values (${name.slice(0, 80)}, ${Math.max(0, Math.round(ms))}, ${
        meta ? sql.json(meta as never) : null
      })`;
    if (Math.random() < 0.005) {
      await sql`delete from perf_events where at < now() - interval '30 days'`;
    }
  })()
    .catch(() => {})
    .finally(() => {
      inFlight--;
    });
}

/** Time an async span and record it under `name`. The span's failure still
 * records (meta.err) — slow failures are the most interesting datapoints. */
export async function timed<T>(
  name: string,
  fn: () => Promise<T>,
  meta?: Record<string, unknown>
): Promise<T> {
  const t0 = performance.now();
  try {
    const out = await fn();
    record(name, performance.now() - t0, meta);
    return out;
  } catch (err) {
    record(name, performance.now() - t0, { ...meta, err: true });
    throw err;
  }
}

export interface PerfSummaryRow {
  name: string;
  count: number;
  p50: number;
  p95: number;
  max: number;
  lastAt: string | null;
}

/** Per-name p50/p95/max over the window — the Settings "Performance" card. */
export async function perfSummary(hours = 24): Promise<PerfSummaryRow[]> {
  await ensurePerfSchema().catch(() => {});
  const rows = await sql<
    { name: string; count: number; p50: number; p95: number; max: number; last_at: Date | null }[]
  >`
    select name,
           count(*)::int as count,
           coalesce(percentile_cont(0.5) within group (order by ms), 0)::int as p50,
           coalesce(percentile_cont(0.95) within group (order by ms), 0)::int as p95,
           coalesce(max(ms), 0)::int as max,
           max(at) as last_at
      from perf_events
     where at > now() - make_interval(hours => ${hours})
     group by name
     order by name
  `.catch(() => []);
  return rows.map((r) => ({
    name: r.name,
    count: r.count,
    p50: r.p50,
    p95: r.p95,
    max: r.max,
    lastAt: r.last_at ? r.last_at.toISOString() : null,
  }));
}
