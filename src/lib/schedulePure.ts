import { crm } from "@/config/crm.config";
import { tzOffsetMin, wallToUtc } from "./availabilityPure";

/**
 * ── Scheduling domain logic, pure ───────────────────────────────────────────
 * The typed constraint model, a DETERMINISTIC natural-language parser for the
 * composer's "When" box, and multi-calendar slot generation. No LLM anywhere:
 * every phrase in the supported grammar resolves by rule, everything else is
 * flagged unresolved for the human to set in ordinary controls. No IO.
 *
 * Time zone: Eastern is the team's working zone (matching the rest of the
 * app); all wall-clock math routes through availabilityPure's DST-safe
 * helpers.
 */

export interface SchedulingConstraints {
  durationMinutes: number;
  dateStart: string; // YYYY-MM-DD, inclusive
  dateEnd: string; // YYYY-MM-DD, inclusive
  allowedWeekdays: number[]; // 1 = Monday … 7 = Sunday
  dailyStartTime: string; // "HH:MM" wall clock
  dailyEndTime: string;
  timezone: string;
  suggestionCount: number;
  minimumNoticeMinutes: number;
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
  calendarParticipantIds: string[]; // member emails
  meetingFormat?: "video" | "phone" | "in_person" | "unspecified";
  location?: string;
}

export interface ParseOutcome {
  constraints: Partial<SchedulingConstraints>;
  /** Fields the text mentioned but the parser could not resolve. */
  unresolved: string[];
  /** A question to show when ambiguity materially changes the result. */
  clarify: string | null;
  /** Participant first-name mentions that matched nobody / several people. */
  unknownNames: string[];
}

const TZ = crm.org.timezone;
const DAY_MS = 86_400_000;
const WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
const MONTHS = ["january","february","march","april","may","june","july","august","september","october","november","december"];

/* ── Local-date helpers (all in the scheduling tz) ───────────────────────── */

interface LocalDate {
  y: number;
  m: number; // 1-12
  d: number;
  weekday: number; // 1=Mon … 7=Sun
}

export function localDate(nowISO: string, tz = TZ): LocalDate {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short",
  });
  const p = Object.fromEntries(dtf.formatToParts(new Date(nowISO)).map((x) => [x.type, x.value]));
  const wd = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(p.weekday) + 1;
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day), weekday: wd };
}

function toKey(ld: { y: number; m: number; d: number }): string {
  return `${ld.y}-${String(ld.m).padStart(2, "0")}-${String(ld.d).padStart(2, "0")}`;
}

/** Step a local calendar date by n days (DST-proof: anchored at local noon). */
export function addLocalDays(key: string, n: number, tz = TZ): string {
  const [y, m, d] = key.split("-").map(Number);
  const noon = wallToUtc(tz, y, m, d, 12 * 60);
  return toKey(localDate(new Date(noon.getTime() + n * DAY_MS).toISOString(), tz));
}

export function weekdayOfKey(key: string, tz = TZ): number {
  const [y, m, d] = key.split("-").map(Number);
  return localDate(wallToUtc(tz, y, m, d, 12 * 60).toISOString(), tz).weekday;
}

/* ── Defaults ────────────────────────────────────────────────────────────── */

/** 7 business days out, 30 minutes, 3 options, 9–5 ET weekdays, 2h notice. */
export function defaultConstraints(nowISO: string, viewerEmail: string): SchedulingConstraints {
  const today = toKey(localDate(nowISO));
  let end = today;
  let business = 0;
  while (business < 7) {
    end = addLocalDays(end, 1);
    if (weekdayOfKey(end) <= 5) business++;
  }
  return {
    durationMinutes: 30,
    dateStart: today,
    dateEnd: end,
    allowedWeekdays: [1, 2, 3, 4, 5],
    dailyStartTime: "09:00",
    dailyEndTime: "17:00",
    timezone: TZ,
    suggestionCount: 3,
    minimumNoticeMinutes: 120,
    bufferBeforeMinutes: 0,
    bufferAfterMinutes: 0,
    calendarParticipantIds: [viewerEmail],
    meetingFormat: "unspecified",
  };
}

/* ── Natural-language parsing (deterministic) ────────────────────────────── */

export interface RosterMember {
  email: string;
  name: string;
  hasCalendar: boolean;
}

function hhmm(hours: number, minutes = 0): string {
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

/** "after 2" → 14:00 when small; "after 9" is ambiguous-morning → 9:00. */
function clockFrom(nRaw: string, meridiem: string | undefined, edge: "start" | "end"): string | null {
  let n = Number(nRaw.replace(/[^\d.]/g, ""));
  if (!Number.isFinite(n) || n < 0 || n > 23) return null;
  const mins = /\d[.:]30/.test(nRaw) ? 30 : 0;
  if (meridiem === "pm" && n < 12) n += 12;
  else if (meridiem === "am") n = n === 12 ? 0 : n;
  else if (!meridiem) {
    // Bare numbers: 1–7 read as afternoon; 8–11 read as morning.
    if (n >= 1 && n <= 7) n += 12;
  }
  if (edge === "end" && n === 12 && meridiem === "am") n = 24;
  return hhmm(Math.floor(n), mins);
}

/** Next occurrence of a weekday STRICTLY AFTER today (documented rule). */
function nextWeekday(todayKey: string, weekday: number): string {
  let k = todayKey;
  for (let i = 0; i < 8; i++) {
    k = addLocalDays(k, 1);
    if (weekdayOfKey(k) === weekday) return k;
  }
  return todayKey;
}

function monthDayToKey(month: number, day: number, todayKey: string): string {
  const year = Number(todayKey.slice(0, 4));
  const candidate = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  // A date that already passed this year means next year.
  return candidate >= todayKey ? candidate : `${year + 1}${candidate.slice(4)}`;
}

/**
 * Parse the "When" text. Every recognized phrase writes a visible constraint;
 * anything else lands in `unresolved`/`clarify` — the parser never guesses
 * when ambiguity would materially change the result.
 */
export function parseWhen(
  text: string,
  nowISO: string,
  roster: RosterMember[] = []
): ParseOutcome {
  const out: Partial<SchedulingConstraints> = {};
  const unresolved: string[] = [];
  const unknownNames: string[] = [];
  let clarify: string | null = null;
  let t = ` ${text.toLowerCase().trim()} `;
  if (!t.trim()) return { constraints: {}, unresolved: [], clarify: null, unknownNames: [] };
  const today = toKey(localDate(nowISO));

  const consume = (re: RegExp): RegExpMatchArray | null => {
    const m = t.match(re);
    if (m) t = t.replace(m[0], " ");
    return m;
  };

  /* Duration — before dates so "30 minutes" isn't half-eaten by numbers. */
  {
    const m = consume(/\b(\d{1,3})\s*(?:minutes?|mins?|m)\b/);
    if (m) out.durationMinutes = Math.min(240, Math.max(10, Number(m[1])));
    else if (consume(/\bhalf\s+an?\s+hour\b/)) out.durationMinutes = 30;
    else if (consume(/\ban?\s+hour(?:\s+and\s+a\s+half)?\b/)) {
      out.durationMinutes = /and a half/.test(text.toLowerCase()) ? 90 : 60;
    } else {
      const h = consume(/\b(\d(?:\.\d)?)\s*(?:hours?|hrs?)\b/);
      if (h) out.durationMinutes = Math.min(240, Math.round(Number(h[1]) * 60));
    }
  }

  /* Counts */
  {
    const m = consume(/\b(\d)\s*(?:times|options|slots|suggestions)\b/);
    if (m) out.suggestionCount = Math.min(8, Math.max(1, Number(m[1])));
    else if (consume(/\ba\s+couple(?:\s+of)?\s*(?:times|options|slots)?\b/)) out.suggestionCount = 2;
    else if (consume(/\ba\s+few\s*(?:times|options|slots)?\b/)) out.suggestionCount = 3;
    else {
      const w = consume(/\b(two|three|four|five)\s+(?:times|options|slots)\b/);
      if (w) out.suggestionCount = { two: 2, three: 3, four: 4, five: 5 }[w[1]]!;
    }
  }

  /* Participants — roster-matched by first name; never fuzzy-guessed. */
  {
    const m = t.match(/\b(?:with|for)\s+((?:me|[a-z]+)(?:(?:\s*(?:,|&|\band\b|\bor\b)\s*)+(?:me|[a-z]+))*)\b/);
    if (m) {
      const FILLER = /^(sometime|next|this|today|tomorrow|on|at|in|the|a|an|call|meeting|time|times)$/;
      const names = m[1]
        // Word boundaries matter: a bare "and" would split inside "sANDy".
        .split(/(?:\s*(?:,|&|\band\b|\bor\b)\s*)+/)
        .filter(Boolean)
        .filter((n) => !FILLER.test(n));
      const usedOr = /\bor\b/.test(m[1]);
      const resolved: string[] = [];
      let anyUnknown = false;
      for (const raw of names) {
        if (raw === "me") continue; // the signed-in calendar is always included
        const hits = roster.filter((r) => {
          const first = r.name.split(/\s+/)[0]?.toLowerCase() ?? "";
          return first === raw || r.email.split("@")[0].toLowerCase() === raw;
        });
        if (hits.length === 1) resolved.push(hits[0].email);
        else {
          anyUnknown = true;
          unknownNames.push(raw);
        }
      }
      if (usedOr && names.filter((n) => n !== "me").length > 1) {
        clarify = `"${m[1].trim()}" — should I check both calendars, or is either person fine? Pick the calendars below.`;
      } else if (resolved.length > 0) {
        out.calendarParticipantIds = resolved; // caller unions the viewer in
        t = t.replace(m[0], " ");
      }
      if (anyUnknown && !clarify) {
        clarify = `I don't know ${unknownNames.map((n) => `"${n}"`).join(" or ")} — pick their calendar below if they're on the team.`;
      }
    }
  }

  /* Meeting format + place */
  {
    if (consume(/\bin\s+person\b/)) out.meetingFormat = "in_person";
    else if (consume(/\bvideo\s*(?:call)?\b|\bzoom\b|\bmeet\b(?!ing)/)) out.meetingFormat = "video";
    else if (consume(/\bphone\s*(?:call)?\b|\bcall\b/)) out.meetingFormat = "phone";
    if (out.meetingFormat === "in_person") {
      const loc = consume(/\bin\s+(?!the\b)([a-z][a-z .]{2,30}?)(?=\s+(?:next|this|on|before|after|between|tomorrow|today)\b|\s*$)/);
      if (loc) out.location = loc[1].trim().replace(/\b\w/g, (c) => c.toUpperCase());
    }
  }

  /* Time windows — before dates ("after August 20" must not read as a time). */
  {
    if (consume(/\bbusiness\s+hours\b/)) {
      out.dailyStartTime = "09:00";
      out.dailyEndTime = "17:00";
    }
    if (consume(/\bmornings?\b/)) {
      out.dailyStartTime = "09:00";
      out.dailyEndTime = "12:00";
    } else if (consume(/\bafternoons?\b/)) {
      out.dailyStartTime = "12:00";
      out.dailyEndTime = "17:00";
    } else if (consume(/\bevenings?\b/)) {
      out.dailyStartTime = "17:00";
      out.dailyEndTime = "20:00";
    }
    const between = consume(/\bbetween\s+(\d{1,2}(?:[.:]\d{2})?)\s*(am|pm)?\s+and\s+(\d{1,2}(?:[.:]\d{2})?)\s*(am|pm)?\b/);
    if (between) {
      const a = clockFrom(between[1], between[2], "start");
      const b = clockFrom(between[3], between[4], "end");
      if (a && b) {
        out.dailyStartTime = a;
        out.dailyEndTime = b;
      } else unresolved.push("hours");
    }
    const after = consume(/\bafter\s+(\d{1,2}(?:[.:]\d{2})?)\s*(am|pm)?\b(?!\s*(?:am|pm)?\s*(?:business|days))/);
    if (after) {
      const a = clockFrom(after[1], after[2], "start");
      if (a) out.dailyStartTime = a;
      else unresolved.push("hours");
    }
    if (consume(/\bbefore\s+noon\b/)) out.dailyEndTime = "12:00";
    else {
      const before = consume(/\bbefore\s+(\d{1,2}(?:[.:]\d{2})?)\s*(am|pm)?\b/);
      if (before) {
        const b = clockFrom(before[1], before[2], "end");
        if (b) out.dailyEndTime = b;
        else unresolved.push("hours");
      }
    }
  }

  /* Dates */
  {
    // "before Friday" / "after August 20" / "before 8/20"
    const monthRe = MONTHS.map((m) => m.slice(0, 3)).join("|");
    const beforeDay = consume(new RegExp(`\\bbefore\\s+(${WEEKDAYS.join("|")})\\b`));
    if (beforeDay) {
      out.dateStart = today;
      out.dateEnd = addLocalDays(nextWeekday(today, WEEKDAYS.indexOf(beforeDay[1]) + 1), -1);
    }
    const afterDate = consume(new RegExp(`\\bafter\\s+(?:(${monthRe})[a-z]*\\s+(\\d{1,2})|(\\d{1,2})/(\\d{1,2}))\\b`));
    if (afterDate) {
      const key = afterDate[1]
        ? monthDayToKey(MONTHS.findIndex((mm) => mm.startsWith(afterDate[1])) + 1, Number(afterDate[2]), today)
        : monthDayToKey(Number(afterDate[3]), Number(afterDate[4]), today);
      out.dateStart = addLocalDays(key, 1);
      if (!out.dateEnd) out.dateEnd = addLocalDays(key, 14);
    }
    const onDate = consume(new RegExp(`\\b(?:on\\s+)?(${monthRe})[a-z]*\\s+(\\d{1,2})\\b`));
    if (onDate) {
      const key = monthDayToKey(MONTHS.findIndex((mm) => mm.startsWith(onDate[1])) + 1, Number(onDate[2]), today);
      out.dateStart = key;
      out.dateEnd = out.dateEnd ?? key;
    }

    if (consume(/\btoday\b/)) {
      out.dateStart = today;
      out.dateEnd = today;
    } else if (consume(/\btomorrow\b/)) {
      const k = addLocalDays(today, 1);
      out.dateStart = k;
      out.dateEnd = k;
    } else if (consume(/\bthis\s+week\b/)) {
      out.dateStart = today;
      out.dateEnd = addLocalDays(today, 7 - weekdayOfKey(today)); // through Sunday
    } else if (consume(/\bnext\s+week\b/)) {
      const monday = addLocalDays(today, 8 - weekdayOfKey(today));
      out.dateStart = monday;
      out.dateEnd = addLocalDays(monday, 4); // Mon–Fri
    } else if (consume(/\bin\s+the\s+next\s+(two|three|2|3)\s+weeks?\b/)) {
      out.dateStart = today;
      const n = /two|2/.test(text.toLowerCase()) ? 14 : 21;
      out.dateEnd = addLocalDays(today, n);
    }

    // Weekday lists: "Tuesday or Wednesday", "next Friday", bare "Tuesday".
    const dayList: number[] = [];
    let nextFlag = false;
    let m: RegExpMatchArray | null;
    const dayRe = new RegExp(`\\b(next\\s+)?(${WEEKDAYS.join("|")})s?\\b`);
    while ((m = t.match(dayRe))) {
      t = t.replace(m[0], " ");
      if (m[1]) nextFlag = true;
      dayList.push(WEEKDAYS.indexOf(m[2]) + 1);
    }
    if (dayList.length > 0) {
      out.allowedWeekdays = [...new Set(dayList)].sort();
      if (!out.dateStart) {
        // Documented rule: a bare weekday means its NEXT occurrence (today's
        // name refers to next week); "next <day>" skips a week when the day
        // is still ahead this week.
        const first = Math.min(...dayList);
        let anchor = nextWeekday(today, first);
        if (nextFlag && weekdayOfKey(today) < first) anchor = addLocalDays(anchor, 7);
        out.dateStart = anchor;
        const last = Math.max(...dayList);
        out.dateEnd = last === first ? anchor : nextWeekday(anchor, last);
      }
    }
  }

  /* Whatever meaningful text is left over → tell the human. */
  const leftover = t.replace(/[\s,.;:!?-]+/g, " ").trim();
  if (leftover.length > 2 && !/^(and|or|the|a|an|at|on|me|please|find|time|times)$/.test(leftover)) {
    unresolved.push(`"${leftover}"`);
  }

  return { constraints: out, unresolved, clarify, unknownNames };
}

/* ── Slot generation over multiple calendars ─────────────────────────────── */

export interface BusyInterval {
  start: string;
  end: string;
}

export interface ScheduleSlot {
  startISO: string;
  endISO: string;
  dayKey: string;
  dayLabel: string; // "Tuesday, August 18"
  timeLabel: string; // "2:00 PM"
}

function labelFor(
  startISO: string,
  dayLabelFmt: Intl.DateTimeFormat,
  timeLabelFmt: Intl.DateTimeFormat
): { dayLabel: string; timeLabel: string } {
  const d = new Date(startISO);
  return {
    dayLabel: dayLabelFmt.format(d),
    timeLabel: timeLabelFmt.format(d),
  };
}

function toMin(hhmmStr: string): number {
  const [h, m] = hhmmStr.split(":").map(Number);
  return h * 60 + (m || 0);
}

/**
 * Every candidate start that clears EVERY calendar's busy set plus notice
 * and buffers. Free means known-free: callers must only pass busy sets for
 * calendars that actually loaded.
 */
export function candidateSlots(
  busyByParticipant: Record<string, BusyInterval[]>,
  c: SchedulingConstraints,
  nowISO: string
): ScheduleSlot[] {
  const busy: { s: number; e: number }[] = [];
  for (const list of Object.values(busyByParticipant)) {
    for (const b of list) {
      const s = new Date(b.start).getTime();
      const e = new Date(b.end).getTime();
      if (Number.isFinite(s) && Number.isFinite(e) && e > s) {
        busy.push({ s: s - c.bufferBeforeMinutes * 60000, e: e + c.bufferAfterMinutes * 60000 });
      }
    }
  }
  const earliest = new Date(nowISO).getTime() + c.minimumNoticeMinutes * 60000;
  const stepMin = c.durationMinutes % 30 === 0 ? 30 : 15;
  const out: ScheduleSlot[] = [];
  const dayLabelFmt = new Intl.DateTimeFormat("en-US", {
    timeZone: c.timezone, weekday: "long", month: "long", day: "numeric",
  });
  const timeLabelFmt = new Intl.DateTimeFormat("en-US", {
    timeZone: c.timezone, hour: "numeric", minute: "2-digit", hour12: true,
  });

  let day = c.dateStart;
  let guard = 0;
  while (day <= c.dateEnd && guard++ < 62) {
    if (c.allowedWeekdays.includes(weekdayOfKey(day, c.timezone))) {
      const [y, m, d] = day.split("-").map(Number);
      const startMin = toMin(c.dailyStartTime);
      const endMin = toMin(c.dailyEndTime);
      for (let tmin = startMin; tmin + c.durationMinutes <= endMin; tmin += stepMin) {
        const start = wallToUtc(c.timezone, y, m, d, tmin);
        const end = new Date(start.getTime() + c.durationMinutes * 60000);
        if (start.getTime() < earliest) continue;
        // Touching intervals don't clash: a meeting may start exactly when
        // another ends.
        const clash = busy.some((b) => start.getTime() < b.e && end.getTime() > b.s);
        if (clash) continue;
        out.push({
          startISO: start.toISOString(),
          endISO: end.toISOString(),
          dayKey: day,
          ...labelFor(start.toISOString(), dayLabelFmt, timeLabelFmt),
        });
      }
    }
    day = addLocalDays(day, 1, c.timezone);
  }
  return out;
}

/**
 * Pick suggestions with a spread: round-robin across days (max 2 per day
 * while other days still have options), earliest-first within a day.
 */
export function pickSpread(all: ScheduleSlot[], count: number, exclude: Set<string> = new Set()): ScheduleSlot[] {
  const pool = all.filter((s) => !exclude.has(s.startISO));
  const byDay = new Map<string, ScheduleSlot[]>();
  for (const s of pool) {
    const list = byDay.get(s.dayKey) ?? [];
    list.push(s);
    byDay.set(s.dayKey, list);
  }
  const days = [...byDay.keys()].sort();
  const picked: ScheduleSlot[] = [];
  const takenPerDay = new Map<string, number>();
  let pass = 0;
  while (picked.length < count && pass < 8) {
    let took = false;
    for (const dayKey of days) {
      if (picked.length >= count) break;
      const cap = pass + 1;
      if ((takenPerDay.get(dayKey) ?? 0) >= cap) continue;
      // The first slot that's unpicked AND at least 90 minutes from any
      // same-day pick — spacing is part of the search, not a veto.
      const next = (byDay.get(dayKey) ?? []).find(
        (s) =>
          !picked.some((p) => p.startISO === s.startISO) &&
          !picked.some(
            (p) =>
              p.dayKey === dayKey &&
              Math.abs(new Date(p.startISO).getTime() - new Date(s.startISO).getTime()) < 90 * 60000
          )
      );
      if (next) {
        picked.push(next);
        takenPerDay.set(dayKey, (takenPerDay.get(dayKey) ?? 0) + 1);
        took = true;
      }
    }
    if (!took) pass++;
  }
  // Fall back to plain earliest-first if spacing starved the count.
  if (picked.length < Math.min(count, pool.length)) {
    for (const s of pool) {
      if (picked.length >= count) break;
      if (!picked.some((p) => p.startISO === s.startISO)) picked.push(s);
    }
  }
  return picked.sort((a, b) => a.startISO.localeCompare(b.startISO));
}

/** The inserted email block — plain text, ET-labeled, editable afterwards. */
export function formatSlotsForEmail(slots: ScheduleSlot[]): string {
  const lines = slots.map((s) => `• ${s.dayLabel} at ${s.timeLabel} ET`);
  return `Would any of these times work for you?\n\n${lines.join("\n")}\n`;
}

/** Re-exported for the panel's tz math. */
export { tzOffsetMin };

/** "https://calendar.google.com/calendar/embed?src=a%40b.com&ctz=…" → "a@b.com".
 * Accepts a bare email/calendar id too; null when nothing parseable. */
export function extractCalendarId(input: string): string | null {
  const t = input.trim();
  if (!t) return null;
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t)) return t.toLowerCase();
  try {
    const u = new URL(t);
    const src = u.searchParams.get("src");
    if (src && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(src)) return src.toLowerCase();
    if (src && /group\.calendar\.google\.com$/.test(src)) return src.toLowerCase();
  } catch {
    return null;
  }
  return null;
}
