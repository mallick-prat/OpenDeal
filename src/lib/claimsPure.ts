/**
 * ── Extracted claims, pure (PR-06, Phase 0 trust base) ──────────────────────
 * A claim is one sourced assertion about one field of one subject — the
 * provenance ledger under every "fact" the app displays. The ledger is
 * append-only; these helpers only RESOLVE it: a human-confirmed row always
 * outranks the machine, no matter how fresh the machine's re-extraction is.
 */

export type ClaimSubjectType = "candidate" | "deal" | "company";

export type ClaimSourceType =
  | "email_extracted"
  | "deck_extracted"
  | "founder_claimed"
  | "team_confirmed"
  | "externally_verified"
  | "granola"
  | "manual";

export const CLAIM_SUBJECT_TYPES: ClaimSubjectType[] = ["candidate", "deal", "company"];

/** One row of extracted_claims (sql/015_claims.sql). */
export interface ClaimRow {
  id: string;
  subject_type: ClaimSubjectType;
  subject_id: string;
  field: string;
  value: unknown;
  source_type: ClaimSourceType;
  source_ref: string | null;
  source_span: string | null;
  confidence: number | null;
  confirmed_by: string | null;
  superseded_at: string | Date | null;
  created_at: string | Date;
}

/** source_type → the short chip label the UI shows next to a fact. */
export const PROVENANCE_LABEL: Record<ClaimSourceType, string> = {
  email_extracted: "Email-extracted",
  deck_extracted: "Deck-extracted",
  founder_claimed: "Founder-claimed",
  team_confirmed: "Team-confirmed",
  externally_verified: "Verified",
  granola: "Granola notes",
  manual: "Manual",
};

/** A human stands behind this row — it can never be outvoted by a machine. */
export function isHumanClaim(row: ClaimRow): boolean {
  return (
    row.confirmed_by !== null ||
    row.source_type === "team_confirmed" ||
    row.source_type === "manual"
  );
}

function ts(v: string | Date): number {
  return (v instanceof Date ? v : new Date(v)).getTime();
}

function newest(rows: ClaimRow[]): ClaimRow | null {
  let best: ClaimRow | null = null;
  for (const r of rows) {
    if (best === null || ts(r.created_at) > ts(best.created_at)) best = r;
  }
  return best;
}

/**
 * Resolve a field's ledger to the value the app should display:
 * the newest CONFIRMED (human) row wins over any machine row — regardless of
 * recency — else the newest machine row. Superseded rows never count.
 */
export function currentValue(rows: ClaimRow[]): ClaimRow | null {
  const live = rows.filter((r) => r.superseded_at === null || r.superseded_at === undefined);
  return newest(live.filter(isHumanClaim)) ?? newest(live.filter((r) => !isHumanClaim(r)));
}

/** Order-insensitive structural JSON equality (key order never matters). */
export function jsonEqual(a: unknown, b: unknown): boolean {
  return stable(a) === stable(b);
}

function stable(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "undefined";
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stable(o[k])}`)
    .join(",")}}`;
}

/**
 * The disagreement worth surfacing: the team confirmed one value while the
 * newest machine extraction still says another. Returns both rows so the UI
 * can show "Founder claims X · Team confirmed Y", or null when they agree
 * (or one side is missing).
 */
export function fieldConflict(
  rows: ClaimRow[]
): { machine: ClaimRow; confirmed: ClaimRow } | null {
  const live = rows.filter((r) => r.superseded_at === null || r.superseded_at === undefined);
  const confirmed = newest(live.filter(isHumanClaim));
  if (!confirmed) return null;
  const machine = newest(live.filter((r) => !isHumanClaim(r)));
  if (!machine) return null;
  return jsonEqual(machine.value, confirmed.value) ? null : { machine, confirmed };
}

/** Per-field view of a subject's ledger: all live rows + the resolved winner. */
export interface FieldClaims {
  current: ClaimRow | null;
  rows: ClaimRow[];
}

/** Group a subject's rows by field with currentValue applied per field. */
export function groupClaims(rows: ClaimRow[]): Record<string, FieldClaims> {
  const out: Record<string, FieldClaims> = {};
  for (const r of rows) (out[r.field] ??= { current: null, rows: [] }).rows.push(r);
  for (const g of Object.values(out)) g.current = currentValue(g.rows);
  return out;
}
