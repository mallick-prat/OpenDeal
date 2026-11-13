import { crm } from "@/config/crm.config";
/**
 * ── Availability domain logic, pure ─────────────────────────────────────────
 * Turns "busy" intervals from Google FreeBusy into suggestable open slots in
 * the member's working hours, Eastern time. All the timezone arithmetic is
 * done through Intl against real instants, so DST transitions come out right
 * and everything here tests without IO.
 */

export interface BusyInterval {
  start: string; // ISO instant
  end: string;
}

export interface OpenSlot {
  startISO: string;
  endISO: string;
  dayKey: string; // "2026-08-11" in the display tz
  dayLabel: string; // "Tue, Aug 11"
  timeLabel: string; // "2:00 PM"
}

export interface SlotConfig {
  tz: string; // display + working-hours timezone
  slotMinutes: number;
  /** Working window, minutes from midnight local. */
  dayStartMin: number;
  dayEndMin: number;
  /** Skip slots starting sooner than this many minutes from now. */
  minNoticeMin: number;
  /** How many WEEKDAYS ahead to offer. */
  businessDays: number;
}

export const DEFAULT_SLOT_CONFIG: SlotConfig = {
  tz: crm.org.timezone,
  slotMinutes: 30,
  dayStartMin: 9 * 60, // 9:00a
  dayEndMin: 17 * 60 + 30, // 5:30p
  minNoticeMin: 120,
  businessDays: 7,
};

/** Minutes this tz is ahead of UTC at the given instant (negative for ET). */
export function tzOffsetMin(tz: string, utc: Date): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  const p = Object.fromEntries(dtf.formatToParts(utc).map((x) => [x.type, x.value]));
  const asUTC = Date.UTC(
    Number(p.year), Number(p.month) - 1, Number(p.day),
    Number(p.hour) % 24, Number(p.minute)
  );
  return (asUTC - utc.getTime()) / 60000;
}

/** The instant when a wall-clock time (y-m-d + minutes) occurs in tz. */
export function wallToUtc(tz: string, y: number, m: number, d: number, minutes: number): Date {
  let guess = Date.UTC(y, m - 1, d, 0, minutes);
  // Two refinement passes settle on the right side of a DST transition.
  for (let i = 0; i < 2; i++) {
    const off = tzOffsetMin(tz, new Date(guess));
    guess = Date.UTC(y, m - 1, d, 0, minutes) - off * 60000;
  }
  return new Date(guess);
}

interface LocalDay {
  y: number;
  m: number;
  d: number;
  weekday: string; // "Mon"…"Sun"
}

function localDayOf(tz: string, instant: Date): LocalDay {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short",
  });
  const p = Object.fromEntries(dtf.formatToParts(instant).map((x) => [x.type, x.value]));
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day), weekday: p.weekday };
}

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

function timeLabel(tz: string, instant: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hour: "numeric", minute: "2-digit", hour12: true,
  }).format(instant).replace(/ /g, " ");
}

/**
 * Compute open slots: for each of the next `businessDays` weekdays, walk the
 * working window in `slotMinutes` steps and keep starts that clear the busy
 * list and the notice window.
 */
export function openSlots(busy: BusyInterval[], nowISO: string, cfg: SlotConfig = DEFAULT_SLOT_CONFIG): OpenSlot[] {
  const now = new Date(nowISO);
  const earliest = now.getTime() + cfg.minNoticeMin * 60000;
  const intervals = busy
    .map((b) => ({ s: new Date(b.start).getTime(), e: new Date(b.end).getTime() }))
    .filter((b) => Number.isFinite(b.s) && Number.isFinite(b.e) && b.e > b.s);

  const out: OpenSlot[] = [];
  // Anchor each day at local noon to step across DST changes safely.
  let probe = new Date(now);
  let daysUsed = 0;
  let guard = 0;
  while (daysUsed < cfg.businessDays && guard++ < 40) {
    const day = localDayOf(cfg.tz, probe);
    const isWeekend = day.weekday === "Sat" || day.weekday === "Sun";
    if (!isWeekend) {
      const dayKey = `${day.y}-${String(day.m).padStart(2, "0")}-${String(day.d).padStart(2, "0")}`;
      const dayLabel = `${day.weekday}, ${MONTHS[day.m - 1]} ${day.d}`;
      for (let t = cfg.dayStartMin; t + cfg.slotMinutes <= cfg.dayEndMin; t += cfg.slotMinutes) {
        const start = wallToUtc(cfg.tz, day.y, day.m, day.d, t);
        const end = new Date(start.getTime() + cfg.slotMinutes * 60000);
        if (start.getTime() < earliest) continue;
        const clash = intervals.some((b) => start.getTime() < b.e && end.getTime() > b.s);
        if (clash) continue;
        out.push({
          startISO: start.toISOString(),
          endISO: end.toISOString(),
          dayKey,
          dayLabel,
          timeLabel: timeLabel(cfg.tz, start),
        });
      }
      daysUsed++;
    }
    probe = new Date(wallToUtc(cfg.tz, day.y, day.m, day.d, 12 * 60).getTime() + 24 * 3600000);
  }
  return out;
}

/** Group for the picker: [{dayKey, dayLabel, slots}] in day order. */
export function groupSlotsByDay(slots: OpenSlot[]): { dayKey: string; dayLabel: string; slots: OpenSlot[] }[] {
  const map = new Map<string, { dayKey: string; dayLabel: string; slots: OpenSlot[] }>();
  for (const s of slots) {
    let g = map.get(s.dayKey);
    if (!g) {
      g = { dayKey: s.dayKey, dayLabel: s.dayLabel, slots: [] };
      map.set(s.dayKey, g);
    }
    g.slots.push(s);
  }
  return [...map.values()].sort((a, b) => a.dayKey.localeCompare(b.dayKey));
}
