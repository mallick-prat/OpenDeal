import type { StageKey } from "./types";
import { STAGES, STAGE_BY_KEY } from "./stages";

/**
 * ── Analytics domain logic, pure ────────────────────────────────────────────
 * Period resolution, time bucketing, series gap-filling, deltas, age buckets,
 * and the explicit stage grouping used by the university chart. No IO.
 *
 * Everything here is deterministic arithmetic over data the app already
 * stores. There is deliberately no funnel-conversion math: stage history is
 * only recorded from 2026-07-09 onward (activity_log.moved_deal), which is
 * too little coverage of a five-year dataset to state conversion honestly.
 */

/* ── Periods ─────────────────────────────────────────────────────────────── */

export type PeriodKey = "30d" | "90d" | "6m" | "12m" | "all" | "custom";
export type Bucket = "day" | "week" | "month" | "quarter";

export const PERIODS: { key: PeriodKey; label: string }[] = [
  { key: "30d", label: "30 days" },
  { key: "90d", label: "90 days" },
  { key: "6m", label: "6 months" },
  { key: "12m", label: "12 months" },
  { key: "all", label: "All time" },
  { key: "custom", label: "Custom" },
];

export interface ResolvedPeriod {
  key: PeriodKey;
  /** ISO dates, inclusive. start is null only for "all". */
  start: string | null;
  end: string;
  /** The equally-long window immediately before [start, end]. Null for "all". */
  prevStart: string | null;
  prevEnd: string | null;
  bucket: Bucket;
  /** "vs prior 90 days" — comparison caption, null when no comparison. */
  compareLabel: string | null;
}

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function addDays(isoDate: string, n: number): string {
  const d = new Date(isoDate + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return iso(d);
}
export function daysBetween(a: string, b: string): number {
  return Math.round(
    (new Date(b + "T00:00:00Z").getTime() - new Date(a + "T00:00:00Z").getTime()) / 86400000
  );
}

/** Bucket by span so charts stay readable at any zoom. */
export function bucketForSpan(days: number): Bucket {
  if (days <= 45) return "day";
  if (days <= 150) return "week";
  if (days <= 750) return "month";
  return "quarter";
}

export function resolvePeriod(
  key: string | undefined,
  from: string | undefined,
  to: string | undefined,
  today: string
): ResolvedPeriod {
  const DATE = /^\d{4}-\d{2}-\d{2}$/;
  if (key === "custom" && from && to && DATE.test(from) && DATE.test(to) && from <= to) {
    const span = daysBetween(from, to) + 1;
    return {
      key: "custom",
      start: from,
      end: to,
      prevStart: addDays(from, -span),
      prevEnd: addDays(from, -1),
      bucket: bucketForSpan(span),
      compareLabel: `vs prior ${span} days`,
    };
  }
  if (key === "all") {
    return {
      key: "all",
      start: null,
      end: today,
      prevStart: null,
      prevEnd: null,
      bucket: "quarter",
      compareLabel: null,
    };
  }
  const days =
    key === "30d" ? 30 : key === "90d" ? 90 : key === "6m" ? 182 : 365;
  const k: PeriodKey = key === "30d" || key === "90d" || key === "6m" ? key : "12m";
  const start = addDays(today, -(days - 1));
  return {
    key: k,
    start,
    end: today,
    prevStart: addDays(start, -days),
    prevEnd: addDays(start, -1),
    bucket: bucketForSpan(days),
    compareLabel:
      k === "30d" ? "vs prior 30 days"
      : k === "90d" ? "vs prior 90 days"
      : k === "6m" ? "vs prior 6 months"
      : "vs prior 12 months",
  };
}

/* ── Series ──────────────────────────────────────────────────────────────── */

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

/** Truncate an ISO date to its bucket's starting ISO date. */
export function bucketStart(isoDate: string, bucket: Bucket): string {
  const [y, m] = [Number(isoDate.slice(0, 4)), Number(isoDate.slice(5, 7))];
  if (bucket === "day") return isoDate;
  if (bucket === "week") {
    // ISO week: back up to Monday.
    const d = new Date(isoDate + "T00:00:00Z");
    const dow = (d.getUTCDay() + 6) % 7;
    d.setUTCDate(d.getUTCDate() - dow);
    return iso(d);
  }
  if (bucket === "month") return `${isoDate.slice(0, 7)}-01`;
  const q0 = Math.floor((m - 1) / 3) * 3 + 1;
  return `${y}-${String(q0).padStart(2, "0")}-01`;
}

export function nextBucket(startISO: string, bucket: Bucket): string {
  if (bucket === "day") return addDays(startISO, 1);
  if (bucket === "week") return addDays(startISO, 7);
  const [y, m] = [Number(startISO.slice(0, 4)), Number(startISO.slice(5, 7))];
  const step = bucket === "month" ? 1 : 3;
  const nm = m + step;
  const ny = y + Math.floor((nm - 1) / 12);
  const mm = ((nm - 1) % 12) + 1;
  return `${ny}-${String(mm).padStart(2, "0")}-01`;
}

export function bucketLabel(startISO: string, bucket: Bucket): string {
  const [y, m, d] = [startISO.slice(0, 4), Number(startISO.slice(5, 7)), Number(startISO.slice(8, 10))];
  if (bucket === "day") return `${MONTHS[m - 1]} ${d}`;
  if (bucket === "week") return `Wk of ${MONTHS[m - 1]} ${d}`;
  if (bucket === "month") return `${MONTHS[m - 1]} ’${y.slice(2)}`;
  return `’${y.slice(2)} Q${Math.floor((m - 1) / 3) + 1}`;
}

export interface SeriesPoint {
  b: string; // bucket start ISO
  label: string;
  count: number;
}

/**
 * Fill a sparse {bucket → count} map into a dense series across [start, end]
 * so gaps render as zero instead of vanishing.
 */
export function fillSeries(
  counts: Map<string, number>,
  start: string,
  end: string,
  bucket: Bucket
): SeriesPoint[] {
  const out: SeriesPoint[] = [];
  let b = bucketStart(start, bucket);
  const last = bucketStart(end, bucket);
  let guard = 0;
  while (b <= last && guard++ < 400) {
    out.push({ b, label: bucketLabel(b, bucket), count: counts.get(b) ?? 0 });
    b = nextBucket(b, bucket);
  }
  return out;
}

/* ── Deltas ──────────────────────────────────────────────────────────────── */

/** "↑ 12%" / "↓ 4%" / "→ 0%" — neutral by design; no value judgment colors. */
export function deltaLabel(current: number, previous: number): string | null {
  if (previous <= 0) return null; // no honest base to compare against
  const pct = Math.round(((current - previous) / previous) * 100);
  if (pct === 0) return "→ 0%";
  return `${pct > 0 ? "↑" : "↓"} ${Math.abs(pct)}%`;
}

/* ── Age buckets ─────────────────────────────────────────────────────────── */

/** Age = days since the deal was added (its creation date). */
export const AGE_BUCKETS = [
  { key: "u7", label: "< 7 days", min: 0, max: 6 },
  { key: "u30", label: "7–30 days", min: 7, max: 30 },
  { key: "u60", label: "30–60 days", min: 31, max: 60 },
  { key: "o60", label: "60+ days", min: 61, max: null as number | null },
] as const;
export type AgeBucketKey = (typeof AGE_BUCKETS)[number]["key"];

export function ageBucketOf(days: number): AgeBucketKey {
  if (days <= 6) return "u7";
  if (days <= 30) return "u30";
  if (days <= 60) return "u60";
  return "o60";
}

/* ── Stage grouping (explicit, deterministic) ────────────────────────────── */

/**
 * The tag chart groups eight stages into six segments so rows stay
 * readable. The mapping is explicit — nothing is inferred:
 *   early     = to-meet + first-meeting
 *   cultivate = cultivate
 *   elevate   = elevate
 *   diligence = diligence
 *   offered   = offered
 *   passed    = to-pass + passed   (terminal, neutral color)
 */
const stageLabel = (k: StageKey) => STAGE_BY_KEY[k]?.label ?? k;
const stageColor = (k: StageKey) => STAGE_BY_KEY[k]?.color ?? "#c6c6c6";
export const STAGE_GROUPS = [
  { key: "early", label: "Early", detail: `${stageLabel("to-meet")} + ${stageLabel("first-meeting")}`, color: stageColor("first-meeting"), stages: ["to-meet", "first-meeting"] as StageKey[] },
  { key: "cultivate", label: stageLabel("cultivate"), detail: stageLabel("cultivate"), color: stageColor("cultivate"), stages: ["cultivate"] as StageKey[] },
  { key: "elevate", label: stageLabel("elevate"), detail: stageLabel("elevate"), color: stageColor("elevate"), stages: ["elevate"] as StageKey[] },
  { key: "diligence", label: stageLabel("diligence"), detail: stageLabel("diligence"), color: stageColor("diligence"), stages: ["diligence"] as StageKey[] },
  { key: "offered", label: stageLabel("offered"), detail: stageLabel("offered"), color: stageColor("offered"), stages: ["offered"] as StageKey[] },
  { key: "passed", label: "Passed", detail: `${stageLabel("to-pass")} + ${stageLabel("passed")}`, color: stageColor("passed"), stages: ["to-pass", "passed"] as StageKey[] },
] as const;
export type StageGroupKey = (typeof STAGE_GROUPS)[number]["key"];

export function stageGroupOf(stage: StageKey): StageGroupKey {
  for (const g of STAGE_GROUPS) if ((g.stages as StageKey[]).includes(stage)) return g.key;
  return "early";
}

/** Sanity: the grouping covers every stage exactly once. */
export function stageGroupingIsTotal(): boolean {
  const seen = new Set<string>();
  for (const g of STAGE_GROUPS) for (const s of g.stages) seen.add(s);
  return STAGES.every((s) => seen.has(s.key)) && seen.size === STAGES.length;
}

/* ── Misc formatting ─────────────────────────────────────────────────────── */

export function fmtInt(n: number): string {
  return n.toLocaleString("en-US");
}

export function pctOf(part: number, whole: number): string {
  if (whole <= 0) return "—";
  return `${Math.round((part / whole) * 100)}%`;
}
