import "server-only";
import { sql } from "./db";

/**
 * ── Field provenance (A-01) ──────────────────────────────────────────────────
 * Deal fields used to carry no memory of where their values came from: a
 * financing figure could arrive from a pitch email, a Granola note, a merge,
 * or a hand edit, and the card showed them all identically. Every writer now
 * drops a claim here, so "where did this number come from" is one query and
 * the Edit card can caption its fields.
 *
 * Append-only; the latest row per (deal, field) is the current provenance.
 */

export type FieldSource = "email" | "granola" | "merge" | "manual" | "calendar";

export interface FieldClaim {
  field: string;
  source: FieldSource;
  sourceId: string | null;
  actor: string | null;
  at: string;
}

let ready: Promise<void> | null = null;
// Catalog-check first — DDL statements take table locks even as no-ops, and
// this ensure runs on hot paths (see the perf_events lock-convoy incident).
function ensureProvenanceSchema(): Promise<void> {
  ready ??= (async () => {
    const t = await sql<{ ok: boolean }[]>`
      select to_regclass('public.deal_field_sources') is not null as ok`;
    if (!t[0]?.ok) {
      await sql`
        create table if not exists deal_field_sources (
          id bigint generated always as identity primary key,
          deal_gid text not null,
          field text not null,
          value text,
          source text not null,
          source_id text,
          actor text,
          at timestamptz not null default now()
        )`.catch(() => {});
    }
    const i = await sql<{ ok: boolean }[]>`
      select to_regclass('public.deal_field_sources_deal_idx') is not null as ok`;
    if (!i[0]?.ok) {
      await sql`
        create index if not exists deal_field_sources_deal_idx
          on deal_field_sources (deal_gid, field, at desc)`.catch(() => {});
    }
  })().catch((err) => {
    ready = null;
    throw err;
  });
  return ready;
}

/**
 * Record one claim. Fire-and-forget — provenance must never break the write
 * it describes. Value is truncated; the ledger answers "where from", the
 * deal row itself answers "what".
 */
export function recordFieldSource(
  dealGid: string,
  field: "financing" | "round" | "notes" | "name",
  value: string | null,
  source: FieldSource,
  sourceId: string | null,
  actor: string | null
): void {
  void (async () => {
    await ensureProvenanceSchema();
    await sql`
      insert into deal_field_sources (deal_gid, field, value, source, source_id, actor)
      values (${dealGid}, ${field}, ${value ? value.slice(0, 300) : null},
              ${source}, ${sourceId}, ${actor})`;
  })().catch(() => {});
}

/** Latest claim per field for one deal — feeds the Edit card captions. */
export async function fieldSourcesForDeal(
  gid: string
): Promise<Record<string, FieldClaim>> {
  await ensureProvenanceSchema().catch(() => {});
  const rows = await sql<
    { field: string; source: FieldSource; source_id: string | null; actor: string | null; at: Date }[]
  >`
    select distinct on (field) field, source, source_id, actor, at
      from deal_field_sources
     where deal_gid = ${gid}
     order by field, at desc
  `.catch(() => []);
  const out: Record<string, FieldClaim> = {};
  for (const r of rows) {
    out[r.field] = {
      field: r.field,
      source: r.source,
      sourceId: r.source_id,
      actor: r.actor,
      at: r.at.toISOString(),
    };
  }
  return out;
}
