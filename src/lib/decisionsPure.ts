/**
 * ── Deal decisions: pure helpers ─────────────────────────────────────────────
 * A decision is the team's verdict on a deal (watch / diligence / invest / pass
 * / lost), kept SEPARATE from the pipeline stage. It answers "what did we
 * decide and why", which board position alone can't. No I/O here, so it's
 * unit-tested; the DB half lives in decisions.ts.
 */

export type DecisionKey = "watch" | "diligence" | "invest" | "pass" | "lost";

export interface DecisionMeta {
  key: DecisionKey;
  label: string;
  /** Chip color; chosen to read distinctly from the red stage palette. */
  color: string;
  hint: string;
}

/** Ordered from "still deciding" toward the two terminal verdicts. */
export const DECISIONS: DecisionMeta[] = [
  { key: "watch", label: "Watch", color: "#b88746", hint: "Keeping an eye on it; not acting yet." },
  { key: "diligence", label: "Diligence", color: "#1f3a5f", hint: "Actively evaluating; running diligence." },
  { key: "invest", label: "Invest", color: "#198038", hint: "We want to invest." },
  { key: "pass", label: "Pass", color: "#6b625b", hint: "We are declining this one." },
  { key: "lost", label: "Lost", color: "#a61626", hint: "We wanted in but the deal is gone." },
];

export const DECISION_KEYS: DecisionKey[] = DECISIONS.map((d) => d.key);

const DECISION_BY_KEY: Record<string, DecisionMeta> = Object.fromEntries(
  DECISIONS.map((d) => [d.key, d])
);

export function isDecisionKey(x: unknown): x is DecisionKey {
  return typeof x === "string" && Object.prototype.hasOwnProperty.call(DECISION_BY_KEY, x);
}

export function decisionMeta(key: string): DecisionMeta | null {
  return DECISION_BY_KEY[key] ?? null;
}

/** A rationale is required: trim, reject empty, clamp to a sane length. */
export function normalizeRationale(raw: string): string | null {
  const r = String(raw ?? "").replace(/\r\n/g, "\n").trim();
  if (!r) return null;
  return r.slice(0, 2000);
}

/**
 * The current decision from a history list = the newest by created_at. Pure so
 * the "which one wins" rule is testable independent of SQL ordering.
 */
export function latestDecision<T extends { created_at: string | Date }>(
  rows: T[]
): T | null {
  let best: T | null = null;
  let bestT = -Infinity;
  for (const r of rows) {
    const t = new Date(r.created_at).getTime();
    if (t >= bestT) {
      bestT = t;
      best = r;
    }
  }
  return best;
}
