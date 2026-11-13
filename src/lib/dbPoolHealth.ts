/**
 * ── Pool poison detector (pure) ──────────────────────────────────────────────
 * The recurring outage in this app is not the database dying — psql answers in
 * 0.3s while every page hangs. It's the app's warm connection pool going bad:
 * sockets killed by a pooler restart, a laptop sleep, or our own backend sweep
 * stay in the pool, and every query routed to one waits out its deadline. A
 * process restart always fixed it, which is the tell: the *pool* is the fault
 * unit, not the server.
 *
 * This module decides when the pool has crossed from "a blip" to "poisoned and
 * must be rebuilt". Pure — the caller supplies the clock — so the thresholds
 * are unit-tested rather than tuned in production.
 *
 * Two signals, because the failure modes differ:
 *  - FATAL codes (57P01/57P00: a backend was terminated under us) mean some
 *    connections are now definitely dead. Two in a minute is not a coincidence.
 *  - TRANSIENT codes (deadlines, resets, closed connections) are individually
 *    normal; a cluster of them is starvation or dead sockets. Four in twenty
 *    seconds is a cluster.
 *
 * A cooldown stops recycle storms: rebuilding the pool costs new TLS
 * connections, so doing it more than once a minute would itself be an outage.
 */

/** The backend was killed out from under the connection (pg_terminate_backend,
 *  pooler restart, crash). The socket that carried it is unusable. */
const FATAL_CODES = new Set(["57P01", "57P00"]);

/** Individually-normal trouble that becomes a poisoning signal in clusters. */
const CLUSTER_CODES = new Set([
  "CLIENT_DEADLINE",
  "CONNECT_TIMEOUT",
  "CONNECTION_CLOSED",
  "CONNECTION_ENDED",
  "CONNECTION_DESTROYED",
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EPIPE",
]);

export interface PoolHealthOptions {
  /** Fatal hits within this window trip a recycle. */
  fatalWindowMs?: number;
  fatalTrip?: number;
  /** Cluster hits within this window trip a recycle. */
  clusterWindowMs?: number;
  clusterTrip?: number;
  /** Minimum time between recycles. */
  cooldownMs?: number;
}

export interface PoolHealth {
  /** Record a failure; returns true when the pool should be recycled NOW. */
  record(code: string, now: number): boolean;
  /** The recycle count so far (for logging/diagnostics). */
  recycles(): number;
}

export function createPoolHealth(opts: PoolHealthOptions = {}): PoolHealth {
  const fatalWindowMs = opts.fatalWindowMs ?? 60_000;
  const fatalTrip = opts.fatalTrip ?? 2;
  const clusterWindowMs = opts.clusterWindowMs ?? 20_000;
  const clusterTrip = opts.clusterTrip ?? 4;
  const cooldownMs = opts.cooldownMs ?? 60_000;

  let fatalHits: number[] = [];
  let clusterHits: number[] = [];
  let lastRecycleAt = -Infinity;
  let recycleCount = 0;

  return {
    record(code: string, now: number): boolean {
      const c = String(code ?? "");
      const isFatal = FATAL_CODES.has(c);
      const isCluster = CLUSTER_CODES.has(c);
      if (!isFatal && !isCluster) return false;

      // Failures inside the cooldown are stragglers from the pool we just
      // replaced — queries that were already in flight on it. Counting them
      // toward the NEXT trip would make one storm look like two, so they are
      // dropped entirely: a post-cooldown recycle needs fresh evidence.
      if (now - lastRecycleAt < cooldownMs) return false;

      if (isFatal) {
        fatalHits = fatalHits.filter((t) => now - t < fatalWindowMs);
        fatalHits.push(now);
      } else {
        clusterHits = clusterHits.filter((t) => now - t < clusterWindowMs);
        clusterHits.push(now);
      }

      const tripped =
        fatalHits.length >= fatalTrip || clusterHits.length >= clusterTrip;
      if (!tripped) return false;

      lastRecycleAt = now;
      fatalHits = [];
      clusterHits = [];
      recycleCount += 1;
      return true;
    },
    recycles: () => recycleCount,
  };
}
