import "server-only";
import { sql } from "./db";
import { withRetry } from "./retry";
import type { DecisionKey } from "./decisionsPure";

/**
 * ── Deal decisions (DB) ──────────────────────────────────────────────────────
 * Each decision change is appended as a row; a deal's CURRENT decision is the
 * newest row for that gid. History is kept so we can always answer "why did we
 * pass, and who decided". FK to deals(gid) cascades on gid-adoption and delete.
 */

let schemaReady = false;
export async function ensureDecisionsSchema(): Promise<void> {
  if (schemaReady) return;
  await sql`
    create table if not exists deal_decisions (
      id uuid primary key default gen_random_uuid(),
      deal_gid text not null references deals(gid) on update cascade on delete cascade,
      decision text not null,
      rationale text not null,
      actor_email text not null,
      actor_name text not null,
      created_at timestamptz not null default now()
    )
  `;
  await sql`
    create index if not exists deal_decisions_gid_idx
      on deal_decisions (deal_gid, created_at desc)
  `;
  schemaReady = true;
}

export interface DecisionRow {
  id: string;
  decision: DecisionKey;
  rationale: string;
  actor_email: string;
  actor_name: string;
  created_at: Date;
}

export interface DecisionActor {
  email: string;
  name: string;
}

/** Record a new decision for a deal (append-only). */
export async function setDealDecision(
  gid: string,
  actor: DecisionActor,
  decision: DecisionKey,
  rationale: string
): Promise<{ id: string }> {
  await ensureDecisionsSchema();
  const rows = await sql<{ id: string }[]>`
    insert into deal_decisions (deal_gid, decision, rationale, actor_email, actor_name)
    values (${gid}, ${decision}, ${rationale}, ${actor.email.toLowerCase()},
            ${actor.name || actor.email})
    returning id
  `;
  return { id: rows[0].id };
}

/** Full decision history for a deal, newest first. */
export async function listDealDecisions(gid: string): Promise<DecisionRow[]> {
  await ensureDecisionsSchema();
  return withRetry(
    () => sql<DecisionRow[]>`
      select id, decision, rationale, actor_email, actor_name, created_at
      from deal_decisions
      where deal_gid = ${gid}
      order by created_at desc
    `
  );
}

/** The current (newest) decision for a deal, or null. */
export async function currentDealDecision(gid: string): Promise<DecisionRow | null> {
  const rows = await listDealDecisions(gid);
  return rows[0] ?? null;
}

/**
 * The current decision KEY for every deal that has one — one query, used to
 * paint chips across the whole board. Never throws to the pipeline read: a
 * missing table (fresh DB) yields an empty map rather than a failed render.
 */
export async function currentDecisionKeys(): Promise<Map<string, DecisionKey>> {
  try {
    await ensureDecisionsSchema();
    const rows = await withRetry(
      () => sql<{ deal_gid: string; decision: DecisionKey }[]>`
        select distinct on (deal_gid) deal_gid, decision
        from deal_decisions
        order by deal_gid, created_at desc
      `
    );
    const map = new Map<string, DecisionKey>();
    for (const r of rows) map.set(r.deal_gid, r.decision);
    return map;
  } catch {
    return new Map();
  }
}
