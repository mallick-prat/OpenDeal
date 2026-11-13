import type { Deal, StageKey } from "./types";
import { NO_SCHOOL, STAGES } from "./stages";
import { etFullDate, etTime } from "./etDates";

export interface SchoolStats {
  school: string;
  total: number;
  active: number;
  diligenceCount: number;
  diligence: number;
  passed: number;
  byStage: Record<StageKey, number>;
  latest: string; // YYYY-MM-DD of most recent deal
  topOwner: string;
}

const ACTIVE_STAGES = new Set<StageKey>(
  STAGES.filter((s) => s.active).map((s) => s.key)
);

export function isActive(stage: StageKey): boolean {
  return ACTIVE_STAGES.has(stage);
}

export function dealSchools(d: Deal): string[] {
  return d.schools.length > 0 ? d.schools : [NO_SCHOOL];
}

export function emptyStageCounts(): Record<StageKey, number> {
  return Object.fromEntries(STAGES.map((s) => [s.key, 0])) as Record<
    StageKey,
    number
  >;
}

export function countByStage(deals: Deal[]): Record<StageKey, number> {
  const counts = emptyStageCounts();
  for (const d of deals) counts[d.stage]++;
  return counts;
}

export function schoolStats(deals: Deal[]): SchoolStats[] {
  const map = new Map<
    string,
    { stats: SchoolStats; owners: Map<string, number> }
  >();
  for (const d of deals) {
    for (const school of dealSchools(d)) {
      let entry = map.get(school);
      if (!entry) {
        entry = {
          stats: {
            school,
            total: 0,
            active: 0,
            diligenceCount: 0,
            diligence: 0,
            passed: 0,
            byStage: emptyStageCounts(),
            latest: "",
            topOwner: "",
          },
          owners: new Map(),
        };
        map.set(school, entry);
      }
      const s = entry.stats;
      s.total++;
      s.byStage[d.stage]++;
      if (isActive(d.stage)) s.active++;
      if (d.stage === "diligence") s.diligenceCount++;
      if (d.stage === "diligence" || d.stage === "elevate") s.diligence++;
      if (d.stage === "passed" || d.stage === "to-pass") s.passed++;
      if (d.created > s.latest) s.latest = d.created;
      entry.owners.set(d.owner, (entry.owners.get(d.owner) ?? 0) + 1);
    }
  }
  const out: SchoolStats[] = [];
  for (const { stats, owners } of map.values()) {
    let best = "";
    let bestN = -1;
    for (const [owner, n] of owners) {
      if (n > bestN && owner !== "Unassigned") {
        best = owner;
        bestN = n;
      }
    }
    stats.topOwner = best;
    out.push(stats);
  }
  out.sort((a, b) => b.total - a.total || a.school.localeCompare(b.school));
  return out;
}

export interface QuarterCount {
  label: string; // e.g. "’24 Q3"
  count: number;
  active: number;
}

export function byQuarter(deals: Deal[]): QuarterCount[] {
  if (deals.length === 0) return [];
  const buckets = new Map<string, { count: number; active: number }>();
  let min = "9999-9";
  let max = "0000-0";
  for (const d of deals) {
    const year = d.created.slice(0, 4);
    const q = Math.floor((parseInt(d.created.slice(5, 7), 10) - 1) / 3) + 1;
    const key = `${year}-${q}`;
    if (key < min) min = key;
    if (key > max) max = key;
    const b = buckets.get(key) ?? { count: 0, active: 0 };
    b.count++;
    if (isActive(d.stage)) b.active++;
    buckets.set(key, b);
  }
  // Walk every quarter from min to max so gaps render as zero.
  const out: QuarterCount[] = [];
  let [y, q] = min.split("-").map(Number);
  const [maxY, maxQ] = max.split("-").map(Number);
  while (y < maxY || (y === maxY && q <= maxQ)) {
    const b = buckets.get(`${y}-${q}`) ?? { count: 0, active: 0 };
    out.push({ label: `’${String(y).slice(2)} Q${q}`, ...b });
    q++;
    if (q === 5) {
      q = 1;
      y++;
    }
  }
  return out;
}

export function dealsForSchool(deals: Deal[], school: string): Deal[] {
  return deals.filter((d) => dealSchools(d).includes(school));
}

export function formatDate(iso: string): string {
  if (!iso) return "—";
  const [y, m, d] = iso.split("-").map(Number);
  const months = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ];
  return `${months[m - 1]} ${d}, ${y}`;
}

export function formatMonth(iso: string): string {
  if (!iso) return "—";
  return formatDate(iso).replace(/ \d+,/, "");
}

/** "Jul 7, 2026 at 3:45 PM" — fixed to ET so server and client agree. */
export function formatDateTime(iso: string): string {
  if (!iso) return "—";
  return `${etFullDate(iso)} at ${etTime(iso)}`;
}

export interface MonthCount {
  label: string; // e.g. "Aug ’25"
  count: number;
}

/** Deals added per month over the trailing 12 months. */
export function byMonth(deals: Deal[], now: string): MonthCount[] {
  const months: { key: string; label: string }[] = [];
  let y = Number(now.slice(0, 4));
  let m = Number(now.slice(5, 7));
  for (let i = 0; i < 12; i++) {
    const key = `${y}-${String(m).padStart(2, "0")}`;
    const names = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    months.unshift({ key, label: `${names[m - 1]} ’${String(y).slice(2)}` });
    m--;
    if (m === 0) { m = 12; y--; }
  }
  const counts = new Map(months.map((mo) => [mo.key, 0]));
  for (const d of deals) {
    const key = d.created.slice(0, 7);
    if (counts.has(key)) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return months.map((mo) => ({ label: mo.label, count: counts.get(mo.key) ?? 0 }));
}

/** Cumulative total deals over time, quarter by quarter. */
export function cumulativeByQuarter(deals: Deal[]): QuarterCount[] {
  const quarters = byQuarter(deals);
  let total = 0;
  let live = 0;
  return quarters.map((q) => {
    total += q.count;
    live += q.active;
    return { label: q.label, count: total, active: live };
  });
}
