import "server-only";
import { sql } from "./db";
import { withRetry } from "./retry";

/**
 * ── Backfill bookkeeping ────────────────────────────────────────────────────
 * Every long migration runs as a named, pausable, resumable backfill:
 * an admin route processes batches inside a time budget, records progress
 * here, and can be re-invoked (or paused) at any point. Deploy-safe by
 * construction — state lives in the DB, not the process.
 */

export interface BackfillRow {
  name: string;
  cursor: string | null;
  total: number | null;
  done: number;
  status: "idle" | "running" | "paused" | "complete" | "failed";
  last_error: string | null;
  started_at: string | Date | null;
  updated_at: string | Date;
}

let schemaReady = false;
export async function ensureBackfillsSchema(): Promise<void> {
  if (schemaReady) return;
  await sql`
    create table if not exists backfills (
      name        text primary key,
      cursor      text,
      total       integer,
      done        integer not null default 0,
      status      text not null default 'idle',
      last_error  text,
      started_at  timestamptz,
      updated_at  timestamptz not null default now()
    )`;
  schemaReady = true;
}

export async function getBackfill(name: string): Promise<BackfillRow | null> {
  await ensureBackfillsSchema();
  const rows = await withRetry(
    () => sql<BackfillRow[]>`select * from backfills where name = ${name}`
  );
  return rows[0] ?? null;
}

export async function markBackfill(
  name: string,
  patch: Partial<Pick<BackfillRow, "cursor" | "total" | "done" | "status" | "last_error">>
): Promise<void> {
  await ensureBackfillsSchema();
  await withRetry(
    () => sql`
      insert into backfills (name, cursor, total, done, status, last_error, started_at)
      values (
        ${name},
        ${patch.cursor ?? null},
        ${patch.total ?? null},
        ${patch.done ?? 0},
        ${patch.status ?? "running"},
        ${patch.last_error ?? null},
        now()
      )
      on conflict (name) do update set
        cursor     = coalesce(${patch.cursor ?? null}, backfills.cursor),
        total      = coalesce(${patch.total ?? null}, backfills.total),
        done       = coalesce(${patch.done ?? null}, backfills.done),
        status     = coalesce(${patch.status ?? null}, backfills.status),
        last_error = ${patch.last_error ?? null},
        updated_at = now()`
  );
}
