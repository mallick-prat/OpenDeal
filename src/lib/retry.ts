/**
 * Retry helper for transient network trouble (flaky DNS, dropped sockets).
 * Retries ONLY infrastructure errors — a real query error (bad SQL, RLS)
 * or a clean "no rows" result is never retried.
 */

const TRANSIENT = new Set([
  // A backend terminated under us (pg_terminate_backend, pooler restart,
  // server shutdown). The QUERY is perfectly retryable — a fresh connection
  // succeeds — but before these were listed here, every termination failed
  // the whole page instead. Under a shared transaction pooler our own
  // backend sweep could 57P01 an innocent in-flight query, so this gap
  // turned the self-healing mechanism into an outage amplifier.
  "57P01",
  "57P00",
  "CLIENT_DEADLINE",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EPIPE",
  "CONNECT_TIMEOUT",
  "CONNECTION_CLOSED",
  "CONNECTION_ENDED",
  "CONNECTION_DESTROYED",
]);

export function isTransientNetworkError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: unknown; errno?: unknown; name?: unknown };
  return (
    (typeof e.code === "string" && TRANSIENT.has(e.code)) ||
    (typeof e.errno === "string" && TRANSIENT.has(e.errno)) ||
    // AbortSignal.timeout() fires a DOMException named TimeoutError.
    e.name === "TimeoutError" ||
    e.name === "AbortError"
  );
}

/**
 * Optional hook so the (server-only) logger can record retries without this
 * module importing it — keeps retry.ts pure and unit-testable.
 */
type RetryObserver = (info: {
  attempt: number;
  code: string;
  /** True when the budget is exhausted and this failure will be thrown. */
  gaveUp?: boolean;
}) => void;
// Multiple listeners: telemetry (log.ts) and pool health (db.ts) both need
// every transient failure. "set" appends — the name is kept for call sites.
const observers: RetryObserver[] = [];
export function setRetryObserver(fn: RetryObserver): void {
  observers.push(fn);
}

/**
 * A query that stops responding must FAIL (so it can be retried), not hang.
 * When the deadline fires, the abandoned promise is also CANCELLED if it
 * supports it (postgres.js query promises do) — otherwise the query lives
 * on server-side as a zombie holding a pool connection until Postgres's own
 * 2-minute statement timeout kills it and leaks the error onto whichever
 * request uses that connection next.
 */
export function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      const t = setTimeout(() => {
        const cancellable = promise as { cancel?: () => void };
        try {
          cancellable.cancel?.();
        } catch {
          // cancellation is best-effort
        }
        // The cancelled query will reject ("canceling statement due to user
        // request") — that's expected, not an unhandled rejection.
        promise.catch(() => {});
        const err = new Error(`No response after ${ms}ms`) as Error & {
          code: string;
        };
        err.code = "CLIENT_DEADLINE";
        reject(err);
      }, ms);
      // Don't keep the lambda's event loop alive for a settled race.
      if (typeof t === "object" && "unref" in t) t.unref();
    }),
  ]);
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  attempts = 3,
  delayMs = 400,
  // Healthy dashboard queries run in well under 1s (measured via /api/diag),
  // so a 6s attempt is a dead pooled connection, not a slow query. The old
  // 20s ceiling let ONE stalled attempt eat two-thirds of the page's 30s
  // budget; failing fast and retrying recovers in ~7s worst case per stall.
  attemptTimeoutMs = 6_000
): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await withDeadline(fn(), attemptTimeoutMs);
    } catch (err) {
      lastErr = err;
      const transient = isTransientNetworkError(err);
      const gaveUp = !transient || i === attempts - 1;
      if (transient) {
        const e = err as { code?: string; name?: string };
        for (const fn of observers) {
          try {
            fn({ attempt: i + 1, code: e.code ?? e.name ?? "unknown", gaveUp });
          } catch {
            // observers never break the retry itself
          }
        }
      }
      if (gaveUp) throw err;
      await new Promise((r) => setTimeout(r, delayMs * (i + 1)));
    }
  }
  throw lastErr;
}
