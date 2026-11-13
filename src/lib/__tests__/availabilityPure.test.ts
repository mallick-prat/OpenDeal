import { describe, expect, it } from "vitest";
import {
  DEFAULT_SLOT_CONFIG,
  groupSlotsByDay,
  openSlots,
  tzOffsetMin,
  wallToUtc,
  type SlotConfig,
} from "../availabilityPure";

// Friday morning, Eastern daylight time (UTC-4).
const NOW = "2026-08-07T13:00:00.000Z"; // 9:00 AM ET

const CFG: SlotConfig = { ...DEFAULT_SLOT_CONFIG, businessDays: 3 };

describe("timezone arithmetic", () => {
  it("ET offset flips across the November DST boundary", () => {
    expect(tzOffsetMin("America/New_York", new Date("2026-07-01T12:00:00Z"))).toBe(-240);
    expect(tzOffsetMin("America/New_York", new Date("2026-12-01T12:00:00Z"))).toBe(-300);
  });
  it("wallToUtc lands 9:00 AM ET on the right instant either side of DST", () => {
    // EDT: 9:00 ET = 13:00Z. EST (after Nov 1 2026): 9:00 ET = 14:00Z.
    expect(wallToUtc("America/New_York", 2026, 8, 7, 9 * 60).toISOString()).toBe("2026-08-07T13:00:00.000Z");
    expect(wallToUtc("America/New_York", 2026, 11, 2, 9 * 60).toISOString()).toBe("2026-11-02T14:00:00.000Z");
  });
});

describe("openSlots", () => {
  it("skips weekends: Friday now → Fri, Mon, Tue", () => {
    const slots = openSlots([], NOW, CFG);
    const days = [...new Set(slots.map((s) => s.dayKey))];
    expect(days).toEqual(["2026-08-07", "2026-08-10", "2026-08-11"]);
    expect(slots[0].dayLabel).toBe("Fri, Aug 7");
  });
  it("honors the notice window: nothing before 11:00 AM ET today", () => {
    const slots = openSlots([], NOW, CFG).filter((s) => s.dayKey === "2026-08-07");
    expect(slots[0].timeLabel).toBe("11:00 AM");
    // Working window ends 5:30p; last 30-minute start is 5:00p.
    expect(slots[slots.length - 1].timeLabel).toBe("5:00 PM");
  });
  it("subtracts busy intervals, including partial overlaps", () => {
    const busy = [
      // 1:00–2:10 PM ET Friday → kills the 1:00, 1:30, and 2:00 slots.
      { start: "2026-08-07T17:00:00Z", end: "2026-08-07T18:10:00Z" },
    ];
    const friday = openSlots(busy, NOW, CFG).filter((s) => s.dayKey === "2026-08-07");
    const times = friday.map((s) => s.timeLabel);
    expect(times).not.toContain("1:00 PM");
    expect(times).not.toContain("1:30 PM");
    expect(times).not.toContain("2:00 PM");
    expect(times).toContain("12:30 PM");
    expect(times).toContain("2:30 PM");
  });
  it("a fully booked day yields no slots for that day but later days survive", () => {
    const busy = [{ start: "2026-08-10T00:00:00Z", end: "2026-08-11T00:00:00Z" }];
    const slots = openSlots(busy, NOW, CFG);
    expect(slots.some((s) => s.dayKey === "2026-08-10")).toBe(false);
    expect(slots.some((s) => s.dayKey === "2026-08-11")).toBe(true);
  });
  it("60-minute slots step by the hour and respect the window end", () => {
    const slots = openSlots([], NOW, { ...CFG, slotMinutes: 60 }).filter(
      (s) => s.dayKey === "2026-08-10"
    );
    expect(slots[0].timeLabel).toBe("9:00 AM");
    // 5:30p end → last 60-minute start is 4:00p (4:30 would spill past).
    expect(slots[slots.length - 1].timeLabel).toBe("4:00 PM");
  });
  it("garbage busy intervals are ignored, not fatal", () => {
    const slots = openSlots(
      [{ start: "nonsense", end: "alsobad" }, { start: "2026-08-07T18:00:00Z", end: "2026-08-07T17:00:00Z" }],
      NOW,
      CFG
    );
    expect(slots.length).toBeGreaterThan(0);
  });
});

describe("groupSlotsByDay", () => {
  it("keeps day order and slot order", () => {
    const groups = groupSlotsByDay(openSlots([], NOW, CFG));
    expect(groups.map((g) => g.dayKey)).toEqual(["2026-08-07", "2026-08-10", "2026-08-11"]);
    expect(groups[0].slots[0].timeLabel).toBe("11:00 AM");
  });
});
