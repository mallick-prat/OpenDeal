import { crm } from "@/config/crm.config";

/**
 * ── Org-timezone date labels ────────────────────────────────────────────────
 * One timezone for the whole product (crm.org.timezone, set with
 * NEXT_PUBLIC_TIMEZONE), so a deal "added Jul 8" means the same Jul 8 to
 * everyone no matter where the reader sits. Two
 * reasons this lives in one module:
 *
 *  1. **Correctness.** A `toLocaleDateString` call with no `timeZone` renders
 *     in the *reader's* zone — on the server that is UTC, so a late-evening
 *     ET timestamp server-rendered as tomorrow, then flipped back on hydration.
 *  2. **Speed.** `Intl.DateTimeFormat` construction is the expensive part, and
 *     `toLocaleDateString` builds one per call — once per row, per render, on
 *     lists thousands of rows long. Formatters here are built once per process.
 */

export const ET = crm.org.timezone;

const shortDateFmt = new Intl.DateTimeFormat("en-US", {
  month: "short", day: "numeric", timeZone: ET,
});
const monthYearFmt = new Intl.DateTimeFormat("en-US", {
  month: "short", year: "numeric", timeZone: ET,
});
const longMonthYearFmt = new Intl.DateTimeFormat("en-US", {
  month: "long", year: "numeric", timeZone: ET,
});
const fullDateFmt = new Intl.DateTimeFormat("en-US", {
  month: "short", day: "numeric", year: "numeric", timeZone: ET,
});
const weekdayDateFmt = new Intl.DateTimeFormat("en-US", {
  weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: ET,
});
const weekdayDayFmt = new Intl.DateTimeFormat("en-US", {
  weekday: "short", month: "short", day: "numeric", timeZone: ET,
});
const longMonthDayFmt = new Intl.DateTimeFormat("en-US", {
  month: "long", day: "numeric", timeZone: ET,
});
const longMonthDayYearFmt = new Intl.DateTimeFormat("en-US", {
  month: "long", day: "numeric", year: "numeric", timeZone: ET,
});
const longWeekdayDateFmt = new Intl.DateTimeFormat("en-US", {
  weekday: "long", month: "long", day: "numeric", timeZone: ET,
});
const shortDateTimeFmt = new Intl.DateTimeFormat("en-US", {
  month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: ET,
});
const fullDateTimeFmt = new Intl.DateTimeFormat("en-US", {
  month: "short", day: "numeric", year: "numeric",
  hour: "numeric", minute: "2-digit", timeZone: ET,
});
const dayFirstDateTimeFmt = new Intl.DateTimeFormat("en-GB", {
  day: "numeric", month: "short", year: "numeric",
  hour: "numeric", minute: "2-digit", hour12: true, timeZone: ET,
});
const timeFmt = new Intl.DateTimeFormat("en-US", {
  hour: "numeric", minute: "2-digit", hour12: true, timeZone: ET,
});
const dayKeyFmt = new Intl.DateTimeFormat("en-CA", {
  year: "numeric", month: "2-digit", day: "2-digit", timeZone: ET,
});

/** Formats defensively: a malformed timestamp renders as an em dash, not "Invalid Date". */
function fmt(f: Intl.DateTimeFormat, value: string | number | Date | null | undefined): string {
  if (value === null || value === undefined || value === "") return "—";
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? "—" : f.format(d);
}

/** "Jul 8" */
export const etShortDate = (v: string | number | Date | null | undefined) => fmt(shortDateFmt, v);
/** "Jul 2026" */
export const etMonthYear = (v: string | number | Date | null | undefined) => fmt(monthYearFmt, v);
/** "July 2026" */
export const etLongMonthYear = (v: string | number | Date | null | undefined) => fmt(longMonthYearFmt, v);
/** "Jul 8, 2026" */
export const etFullDate = (v: string | number | Date | null | undefined) => fmt(fullDateFmt, v);
/** "Tue, Jul 8, 2026" */
export const etWeekdayDate = (v: string | number | Date | null | undefined) => fmt(weekdayDateFmt, v);
/** "Tue, Jul 8" */
export const etWeekdayDay = (v: string | number | Date | null | undefined) => fmt(weekdayDayFmt, v);
/** "July 8" */
export const etLongMonthDay = (v: string | number | Date | null | undefined) => fmt(longMonthDayFmt, v);
/** "July 8, 2026" */
export const etLongMonthDayYear = (v: string | number | Date | null | undefined) => fmt(longMonthDayYearFmt, v);
/** "Tuesday, July 8" */
export const etLongWeekdayDate = (v: string | number | Date | null | undefined) => fmt(longWeekdayDateFmt, v);
/** "Jul 8, 3:45 PM" */
export const etShortDateTime = (v: string | number | Date | null | undefined) => fmt(shortDateTimeFmt, v);
/** "Jul 8, 2026, 3:45 PM" */
export const etFullDateTime = (v: string | number | Date | null | undefined) => fmt(fullDateTimeFmt, v);
/** "8 Jul 2026, 11:30 PM" */
export const etDayFirstDateTime = (v: string | number | Date | null | undefined) =>
  fmt(dayFirstDateTimeFmt, v).replace(/\b(am|pm)\b/gi, (part) => part.toUpperCase());
/** "3:45 PM" */
export const etTime = (v: string | number | Date | null | undefined) => fmt(timeFmt, v);
/** "2026-07-08" — a stable key for grouping by ET calendar day. */
export const etDayKey = (v: string | number | Date | null | undefined) => fmt(dayKeyFmt, v);
