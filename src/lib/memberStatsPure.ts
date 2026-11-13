/**
 * ── Member activity math, pure ──────────────────────────────────────────────
 * Sessions, hands-on time, active days, and weekly buckets derived from the
 * activity log's timestamps. Deterministic and honest: "hands-on time" is an
 * ESTIMATE built from recorded actions (the log doesn't see pure reading),
 * and the log only exists since 2026-07-09 — callers label accordingly.
 */

import { etDayKey } from "./etDates";

export interface SessionSummary {
  sessions: number;
  /** Estimated minutes: each session spans first→last action + a 5m tail. */
  totalMinutes: number;
  activeDays: number;
  lastActive: string | null; // ISO
}

const GAP_MIN = 30;
const TAIL_MIN = 5;

/** Cluster action timestamps into sessions with a 30-minute idle cutoff. */
export function sessionize(timesISO: string[]): SessionSummary {
  const ts = timesISO
    .map((t) => new Date(t).getTime())
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);
  if (ts.length === 0) return { sessions: 0, totalMinutes: 0, activeDays: 0, lastActive: null };

  let sessions = 1;
  let minutes = 0;
  let start = ts[0];
  let prev = ts[0];
  for (let i = 1; i < ts.length; i++) {
    if (ts[i] - prev > GAP_MIN * 60000) {
      minutes += (prev - start) / 60000 + TAIL_MIN;
      sessions++;
      start = ts[i];
    }
    prev = ts[i];
  }
  minutes += (prev - start) / 60000 + TAIL_MIN;

  const days = new Set(timesISO.map(etDayKey));
  return {
    sessions,
    totalMinutes: Math.round(minutes),
    activeDays: days.size,
    lastActive: new Date(ts[ts.length - 1]).toISOString(),
  };
}

export interface WeekBucket {
  label: string; // "Jul 27"
  count: number;
}

/** Actions per ISO week (Mon-anchored) for the trailing `weeks` weeks. */
export function weeklyActivity(timesISO: string[], nowISO: string, weeks = 8): WeekBucket[] {
  const now = new Date(nowISO);
  const dow = (now.getUTCDay() + 6) % 7;
  const thisMonday = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - dow);
  const starts: number[] = [];
  for (let i = weeks - 1; i >= 0; i--) starts.push(thisMonday - i * 7 * 86400000);
  const counts = new Array<number>(weeks).fill(0);
  for (const t of timesISO) {
    const ms = new Date(t).getTime();
    if (!Number.isFinite(ms)) continue;
    for (let i = weeks - 1; i >= 0; i--) {
      if (ms >= starts[i] && ms < starts[i] + 7 * 86400000) {
        counts[i]++;
        break;
      }
    }
  }
  const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return starts.map((s, i) => {
    const d = new Date(s);
    return { label: `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`, count: counts[i] };
  });
}

/** "3h 40m" / "25m" / "—". */
export function fmtMinutes(min: number): string {
  if (min <= 0) return "—";
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}
