import { describe, it, expect } from "vitest";
import {
  etShortDate,
  etFullDate,
  etDayKey,
  etTime,
  etShortDateTime,
  etLongMonthYear,
  etLongMonthDayYear,
  etLongWeekdayDate,
  etFullDateTime,
  etDayFirstDateTime,
} from "../etDates";

describe("etDates", () => {
  it("labels a timestamp in Eastern, not the reader's zone", () => {
    // 03:30 UTC on the 9th is still the evening of the 8th in Boston.
    const iso = "2026-07-09T03:30:00.000Z";
    expect(etShortDate(iso)).toBe("Jul 8");
    expect(etFullDate(iso)).toBe("Jul 8, 2026");
    expect(etDayKey(iso)).toBe("2026-07-08");
    expect(etTime(iso)).toBe("11:30 PM");
    expect(etShortDateTime(iso)).toBe("Jul 8, 11:30 PM");
    expect(etLongMonthDayYear(iso)).toBe("July 8, 2026");
    expect(etLongMonthYear(iso)).toBe("July 2026");
    expect(etLongWeekdayDate(iso)).toBe("Wednesday, July 8");
    expect(etFullDateTime(iso)).toBe("Jul 8, 2026, 11:30 PM");
    expect(etDayFirstDateTime(iso)).toBe("8 Jul 2026, 11:30 PM");
  });

  it("keeps standard time in winter", () => {
    expect(etShortDateTime("2026-01-06T14:00:00.000Z")).toBe("Jan 6, 9:00 AM");
  });

  it("renders a dash for missing or malformed input", () => {
    expect(etShortDate(null)).toBe("—");
    expect(etShortDate("")).toBe("—");
    expect(etShortDate("not a date")).toBe("—");
    expect(etLongMonthYear("")).toBe("—");
    expect(etLongMonthDayYear("not a date")).toBe("—");
    expect(etLongWeekdayDate(null)).toBe("—");
    expect(etFullDateTime("")).toBe("—");
    expect(etDayFirstDateTime("not a date")).toBe("—");
  });
});
