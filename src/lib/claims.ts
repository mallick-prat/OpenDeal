import "server-only";
import { sql } from "./db";
import { withRetry } from "./retry";
import {
  fieldConflict,
  groupClaims,
  type ClaimRow,
  type ClaimSourceType,
  type ClaimSubjectType,
  type FieldClaims,
} from "./claimsPure";

/**
 * ── Extracted-claims provenance ledger (PR-06) ──────────────────────────────
 * Append-only writes over sql/015_claims.sql. The one invariant that matters:
 * human rows (team_confirmed/manual, or confirmed_by set) are NEVER updated
 * or deleted here — a reparse may only supersede prior MACHINE rows. Reads
 * resolve the ledger with the pure helpers (human beats machine, newest wins
 * within each camp).
 */

let schemaReady = false;
export async function ensureClaimsSchema(): Promise<void> {
  if (schemaReady) return;
  await sql`
    create table if not exists extracted_claims (
      id            uuid primary key default gen_random_uuid(),
      subject_type  text not null,
      subject_id    text not null,
      field         text not null,
      value         jsonb not null,
      source_type   text not null,
      source_ref    text,
      source_span   text,
      confidence    numeric,
      confirmed_by  text,
      superseded_at timestamptz,
      created_at    timestamptz default now()
    )`;
  await sql`
    create index if not exists extracted_claims_subject_idx
      on extracted_claims (subject_type, subject_id, field, created_at desc)`;
  schemaReady = true;
}

/** One machine-extracted assertion headed for the ledger. */
export interface ClaimInput {
  field: string;
  value: unknown;
  sourceType: ClaimSourceType;
  sourceRef?: string | null;
  sourceSpan?: string | null;
  confidence?: number | null;
}

/** numeric comes back from postgres.js as a string — normalize once, on read. */
function normalizeRow(r: ClaimRow): ClaimRow {
  return { ...r, confidence: r.confidence === null ? null : Number(r.confidence) };
}

/**
 * Append machine rows for a subject. Prior MACHINE rows for the same fields
 * are superseded (the newest extraction is the machine's current belief);
 * human rows are untouched — always, by construction of the WHERE clause.
 */
export async function recordClaims(
  subjectType: ClaimSubjectType,
  subjectId: string,
  claims: ClaimInput[]
): Promise<void> {
  if (claims.length === 0) return;
  await ensureClaimsSchema();
  const fields = [...new Set(claims.map((c) => c.field))];
  await withRetry(
    () => sql`
      update extracted_claims
      set superseded_at = now()
      where subject_type = ${subjectType}
        and subject_id = ${subjectId}
        and field = any(${fields})
        and superseded_at is null
        and confirmed_by is null
        and source_type not in ('team_confirmed', 'manual')`
  );
  for (const c of claims) {
    await withRetry(
      () => sql`
        insert into extracted_claims
          (subject_type, subject_id, field, value, source_type,
           source_ref, source_span, confidence)
        values
          (${subjectType}, ${subjectId}, ${c.field}, ${sql.json(c.value as never)},
           ${c.sourceType}, ${c.sourceRef ?? null}, ${c.sourceSpan ?? null},
           ${c.confidence ?? null})`
    );
  }
}

/**
 * Append a team_confirmed row — the human vouches for this value. Pure
 * append: earlier confirmations stay in the ledger as history; resolution
 * picks the newest confirmed row.
 */
export async function confirmClaim(
  subjectType: ClaimSubjectType,
  subjectId: string,
  field: string,
  value: unknown,
  editorEmail: string
): Promise<void> {
  await ensureClaimsSchema();
  await withRetry(
    () => sql`
      insert into extracted_claims
        (subject_type, subject_id, field, value, source_type, confirmed_by)
      values
        (${subjectType}, ${subjectId}, ${field}, ${sql.json(value as never)},
         'team_confirmed', ${editorEmail})`
  );
}

async function liveRows(
  subjectType: ClaimSubjectType,
  subjectId: string
): Promise<ClaimRow[]> {
  await ensureClaimsSchema();
  const rows = await withRetry(
    () => sql<ClaimRow[]>`
      select * from extracted_claims
      where subject_type = ${subjectType}
        and subject_id = ${subjectId}
        and superseded_at is null
      order by created_at desc`
  );
  return rows.map(normalizeRow);
}

/** All non-superseded rows grouped by field, each with currentValue applied. */
export async function claimsFor(
  subjectType: ClaimSubjectType,
  subjectId: string
): Promise<Record<string, FieldClaims>> {
  return groupClaims(await liveRows(subjectType, subjectId));
}

/** One surfaced disagreement: the machine still says X, the team says Y. */
export interface ClaimConflict {
  field: string;
  machine: ClaimRow;
  confirmed: ClaimRow;
}

/**
 * Fields where a live machine claim disagrees (JSON-inequality) with the
 * current confirmed value — the "Founder claims X · Team confirmed Y" list.
 */
export async function conflictsFor(
  subjectType: ClaimSubjectType,
  subjectId: string
): Promise<ClaimConflict[]> {
  const grouped = await claimsFor(subjectType, subjectId);
  const out: ClaimConflict[] = [];
  for (const [field, g] of Object.entries(grouped)) {
    const conflict = fieldConflict(g.rows);
    if (conflict) out.push({ field, ...conflict });
  }
  return out;
}
