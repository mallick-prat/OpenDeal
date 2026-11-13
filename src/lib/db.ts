import "server-only";
import postgres from "postgres";
import { createPoolHealth } from "./dbPoolHealth";
import { setRetryObserver } from "./retry";
import { databaseSsl, databaseUrl } from "./dbConfig";

/**
 * Postgres client for the Supabase "Deal-room" database, reached through the
 * Supavisor TRANSACTION pooler (port 6543) — hence no prepared statements.
 *
 * ── Why this pool heals itself ───────────────────────────────────────────────
 * The app's recurring outage was never the database: psql answered in 0.3s
 * while every page hung on "Waking the database…". The fault unit is the warm
 * in-process pool. Sockets die underneath it — a pooler restart, a laptop
 * sleep, our own backend sweep terminating a shared backend — and postgres.js
 * only discovers a dead socket by using it, so each query waits out its
 * deadline first. Restarting the process always fixed it; this module makes
 * that restart automatic and scoped to the pool alone.
 *
 * The exported `sql` is a Proxy over the CURRENT pool. When the failure
 * pattern says "poisoned" (see dbPoolHealth: terminated backends, or a cluster
 * of deadlines/resets), we build a fresh pool, swap the Proxy target, and
 * drain the old one in the background. Callers never see the swap — same
 * import, same tagged-template API, next query lands on live sockets.
 *
 * Failures reach the detector through retry.ts's observer: every transient
 * failure in withRetry (which fronts all hot-path queries) reports its code.
 */

type Sql = ReturnType<typeof postgres>;

const DEV = process.env.NODE_ENV !== "production";

function build(): Sql {
  const url = databaseUrl();
  if (!url && DEV) {
    console.error(
      "[db] DATABASE_URL is not set. Copy .env.example to .env.local and fill it in (see docs/SETUP.md)."
    );
  }
  return postgres(url!, {
    ssl: databaseSsl(url),
    prepare: false,
    // Idempotent DDL ("create ... if not exists") emits NOTICEs on every
    // cold start; they are expected and only clutter the logs.
    onnotice: () => {},
    // Dev machines routinely run several dev servers against the same pooler;
    // 4 each keeps a stray instance from hogging client slots. Prod lambdas
    // get the full 10 — one dashboard render fans out most of that.
    max: DEV ? 4 : 10,
    idle_timeout: 20,
    // Supavisor can take >5s to hand out a connection when scaling from cold;
    // a too-tight connect timeout turned that into a fake outage.
    connect_timeout: 10,
    // Dead cross-region sockets are the hang source: keepalive probes turn
    // them into errors the retry layer can handle, and a short, jittered
    // max_lifetime recycles sockets before the pooler's NAT forgets them —
    // jittered so a pool's connections don't all expire (and reconnect) in
    // the same instant.
    keep_alive: 20,
    max_lifetime: 90 + Math.floor(Math.random() * 90),
    connection: {
      // Attribution in pg_stat_activity, for the sweep and for humans.
      application_name: "opendeal-app",
    },
    // Dev-only query counter (DEBUG_SQL=1): a running per-process count plus
    // each query's head — the cheap way to spot an N+1 render path.
    debug:
      DEV && process.env.DEBUG_SQL
        ? (_conn, query) => {
            const g = globalThis as unknown as { __opendealQueryCount?: number };
            g.__opendealQueryCount = (g.__opendealQueryCount ?? 0) + 1;
            console.log(
              `[sql #${g.__opendealQueryCount}] ${String(query).replace(/\s+/g, " ").slice(0, 140)}`
            );
          }
        : undefined,
  });
}

interface PoolState {
  current: Sql;
  generation: number;
}

// Dev HMR must reuse the manager, not spawn a pool per hot reload.
const g = globalThis as unknown as { __opendealDbState?: PoolState };
const state: PoolState = g.__opendealDbState ?? { current: build(), generation: 1 };
if (DEV) g.__opendealDbState = state;

const health = createPoolHealth();

function recycle(reason: string): void {
  const old = state.current;
  state.generation += 1;
  state.current = build();
  // console first — logging rides the pool, and the pool just failed. Then a
  // best-effort record through the NEW pool so recycles show up in /systemlog
  // next to the failures that caused them. Dynamic import: log.ts imports
  // this module, so a static import here would be a cycle.
  console.warn(
    `[db] pool poisoned (${reason}) — recycled to generation ${state.generation}`
  );
  void import("./log")
    .then((l) =>
      l.logEvent("warn", "db", "pool recycled", {
        reason,
        generation: state.generation,
      })
    )
    .catch(() => {});
  // Let stragglers finish, then close the old pool. Queries queued on it that
  // never got a connection are rejected by end(), which surfaces as one more
  // transient failure to the retry layer — exactly what retries are for.
  const t = setTimeout(() => {
    void old.end({ timeout: 5 }).catch(() => {});
  }, 2_000);
  t.unref?.();
}

/**
 * Report a database failure code. The detector decides whether the pattern
 * means the pool is poisoned; a single blip never recycles.
 */
export function reportDbFailure(code: string): void {
  if (health.record(code, Date.now())) recycle(code);
}

// Every withRetry-fronted query reports its transient failures here.
setRetryObserver((info) => {
  reportDbFailure(info.code);
});

/**
 * The shared client. A Proxy so the pool can be swapped mid-flight: tagged
 * template calls and helper access (sql.json, sql.array, sql.begin, sql.end,
 * dynamic identifiers) all resolve against the CURRENT pool at call time.
 */
export const sql: Sql = new Proxy(function proxyTarget() {} as unknown as Sql, {
  apply(_target, thisArg, args) {
    return Reflect.apply(
      state.current as unknown as (...a: unknown[]) => unknown,
      thisArg,
      args
    );
  },
  get(_target, prop) {
    const value = Reflect.get(state.current as object, prop);
    return typeof value === "function"
      ? (value as (...a: unknown[]) => unknown).bind(state.current)
      : value;
  },
}) as Sql;

/** Current pool generation — exposed for /api/diag. */
export function poolGeneration(): number {
  return state.generation;
}

/** One row of the deals table. */
export interface DealRow {
  gid: string;
  name: string;
  notes: string;
  stage: string;
  section_gid: string | null;
  schools: string[];
  owner: string;
  created_on: string | Date | null;
  modified_on: string | Date | null;
  due_on: string | Date | null;
  completed: boolean;
  subtasks: number;
  followers: number;
  url: string;
  met_at_event: boolean;
  financing_amount: string | null;
  round: string | null;
  attachment_count: number;
  offered: boolean;
  created_by: string | null;
  visibility?: string | null;
}

export function isoDate(v: string | Date | null): string {
  if (!v) return "";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}
