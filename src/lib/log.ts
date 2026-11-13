import "server-only";
import { sql } from "./db";
import { errorInfo } from "./errorInfo";
import { setRetryObserver, withDeadline } from "./retry";
import { noteClientDeadline } from "./dbHealth";

/**
 * ── Internal event log ───────────────────────────────────────────────────────
 *
 * Structured troubleshooting events in the `app_events` table (Vercel's
 * runtime logs are ephemeral and this project can't query them by API).
 * Everything also mirrors to the console so platform logs stay useful.
 *
 * Levels: error (something failed), warn (retries, slow paths, denials),
 * info (job summaries). Writes are fire-and-forget — logging must never
 * break or slow the thing being logged.
 *
 * Viewer: Settings → System log (super admins). Retention: the daily cron
 * prunes events older than 30 days.
 * ────────────────────────────────────────────────────────────────────────────
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

type Detail = Record<string, string | number | boolean | null>;

/**
 * Per-instance rate limit on DB log WRITES. During a pool-starvation storm
 * every retrying query fires a retry-log, and each of those INSERTs competes
 * for the same starved connections — logging that amplifies the outage it's
 * recording. The console mirror is always emitted (free); only the DB write is
 * throttled, so a storm can't turn logging into a self-reinforcing DoS.
 */
const LOG_WINDOW_MS = 10_000;
const LOG_MAX_PER_WINDOW = 40;
let logWindowStart = 0;
let logWindowCount = 0;

function allowDbLogWrite(): boolean {
  const now = Date.now();
  if (now - logWindowStart > LOG_WINDOW_MS) {
    logWindowStart = now;
    logWindowCount = 0;
  }
  if (logWindowCount >= LOG_MAX_PER_WINDOW) return false;
  logWindowCount++;
  return true;
}

export function logEvent(
  level: LogLevel,
  source: string,
  message: string,
  detail: Detail = {},
  durationMs?: number
): void {
  const line = `[${source}] ${message}`;
  // In dev, console.error pops Next's full-screen overlay for failures the
  // app already handled and rendered; keep the mirror quieter there.
  const errorMirror =
    process.env.NODE_ENV === "production" ? console.error : console.warn;
  if (level === "error") errorMirror(line, detail);
  else if (level === "warn") console.warn(line, detail);
  else console.log(line, detail);

  // Fire-and-forget AND bounded: a log write must never zombie a pooled
  // connection (an unbounded INSERT stuck on a frozen lambda held a slot for
  // ~2 min), and must never flood the pool during a retry storm.
  if (!allowDbLogWrite()) return;
  void withDeadline(
    sql`
      insert into app_events (level, source, message, detail, duration_ms)
      values (${level}, ${source}, ${message.slice(0, 300)}, ${sql.json(detail)},
              ${durationMs != null ? Math.round(durationMs) : null})
    `,
    3_000
  ).catch(() => {});
}

export function logError(
  source: string,
  message: string,
  err: unknown,
  detail: Detail = {}
): void {
  logEvent("error", source, message, { ...detail, ...errorInfo(err) });
}

/**
 * Time an async operation. Failures are logged and rethrown; successes are
 * logged only when they exceed `slowMs`, so the log captures tail latency
 * without a row per healthy request.
 */
export async function timed<T>(
  source: string,
  label: string,
  fn: () => Promise<T>,
  slowMs = 2500
): Promise<T> {
  const t0 = Date.now();
  try {
    const result = await fn();
    const ms = Date.now() - t0;
    if (ms > slowMs) logEvent("warn", source, `slow: ${label}`, {}, ms);
    return result;
  } catch (err) {
    logEvent("error", source, `failed: ${label}`, errorInfo(err), Date.now() - t0);
    throw err;
  }
}

// Surface every transient-error retry: the flaky-DNS class of problem is
// invisible unless the retries themselves are recorded.
setRetryObserver((info) => {
  // A burst of CLIENT_DEADLINEs means the pool is starving right now — trip the
  // reactive sweep (it self-debounces and runs on a dedicated connection).
  if (info.code === "CLIENT_DEADLINE") noteClientDeadline();
  logEvent("warn", "retry", `attempt ${info.attempt} after ${info.code}`, {
    code: info.code,
    attempt: info.attempt,
  });
});

export interface AppEventRow {
  id: number;
  level: LogLevel;
  source: string;
  message: string;
  detail: Record<string, unknown>;
  duration_ms: number | null;
  created_at: Date;
}

export async function recentEvents(limit = 200): Promise<AppEventRow[]> {
  return sql<AppEventRow[]>`
    select id::int, level, source, message, detail, duration_ms, created_at
    from app_events
    order by created_at desc
    limit ${limit}
  `;
}

/** Called by the daily cron: keep the log 30 days deep. */
export async function pruneEvents(): Promise<number> {
  const result = await sql`
    delete from app_events where created_at < now() - interval '30 days'
  `;
  return result.count;
}
