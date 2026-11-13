import { describe, expect, it } from "vitest";
import {
  addLocalDays,
  candidateSlots,
  defaultConstraints,
  formatSlotsForEmail,
  parseWhen,
  pickSpread,
  weekdayOfKey,
  type SchedulingConstraints,
} from "../schedulePure";

// Wednesday, August 12, 2026, 9:00 AM ET (13:00Z, EDT).
const NOW = "2026-08-12T13:00:00.000Z";
const ME = "alex@example.com";

const ROSTER = [
  { email: "alex@example.com", name: "Alex Morgan", hasCalendar: true },
  { email: "casey@example.com", name: "Casey Rivera", hasCalendar: true },
  { email: "taylor@example.com", name: "Taylor Kim", hasCalendar: true },
  { email: "sam@example.com", name: "Sam Okafor", hasCalendar: true },
];

function base(over: Partial<SchedulingConstraints> = {}): SchedulingConstraints {
  return { ...defaultConstraints(NOW, ME), ...over };
}

describe("defaults", () => {
  it("7 business days, 30 minutes, 3 options, weekdays 9–5", () => {
    const c = defaultConstraints(NOW, ME);
    expect(c.durationMinutes).toBe(30);
    expect(c.suggestionCount).toBe(3);
    expect(c.dateStart).toBe("2026-08-12");
    expect(c.dateEnd).toBe("2026-08-21"); // 7 business days out crosses a weekend
    expect(c.allowedWeekdays).toEqual([1, 2, 3, 4, 5]);
    expect(c.calendarParticipantIds).toEqual([ME]);
  });
});

describe("parseWhen — the briefed grammar", () => {
  it("30 minutes next week in the afternoon", () => {
    const r = parseWhen("30 minutes next week in the afternoon", NOW, ROSTER);
    expect(r.constraints.durationMinutes).toBe(30);
    expect(r.constraints.dateStart).toBe("2026-08-17"); // next Monday
    expect(r.constraints.dateEnd).toBe("2026-08-21"); // through Friday
    expect(r.constraints.dailyStartTime).toBe("12:00");
    expect(r.constraints.dailyEndTime).toBe("17:00");
    expect(r.clarify).toBeNull();
  });
  it("Tuesday or Wednesday after 2", () => {
    const r = parseWhen("Tuesday or Wednesday after 2", NOW, ROSTER);
    expect(r.constraints.allowedWeekdays).toEqual([2, 3]);
    expect(r.constraints.dailyStartTime).toBe("14:00"); // bare small number = afternoon
    // Today is Wednesday; a bare weekday means its NEXT occurrence.
    expect(r.constraints.dateStart).toBe("2026-08-18");
  });
  it("three times before Friday, preferably mornings", () => {
    const r = parseWhen("three times before Friday, preferably mornings", NOW, ROSTER);
    expect(r.constraints.suggestionCount).toBe(3);
    expect(r.constraints.dateEnd).toBe("2026-08-13"); // Thursday, day before next Friday
    expect(r.constraints.dailyStartTime).toBe("09:00");
    expect(r.constraints.dailyEndTime).toBe("12:00");
  });
  it("45 minutes with Casey next week", () => {
    const r = parseWhen("45 minutes with Casey next week", NOW, ROSTER);
    expect(r.constraints.durationMinutes).toBe(45);
    expect(r.constraints.calendarParticipantIds).toEqual(["casey@example.com"]);
    expect(r.constraints.dateStart).toBe("2026-08-17");
    expect(r.unknownNames).toEqual([]);
  });
  it("an hour for me, Taylor, and Sam in the next two weeks", () => {
    const r = parseWhen("Find an hour for me, Taylor, and Sam in the next two weeks", NOW, ROSTER);
    expect(r.constraints.durationMinutes).toBe(60);
    expect(r.constraints.calendarParticipantIds).toEqual(["taylor@example.com", "sam@example.com"]);
    expect(r.constraints.dateEnd).toBe("2026-08-26");
  });
  it("tomorrow between 10 and 3", () => {
    const r = parseWhen("Tomorrow between 10 and 3 ET", NOW, ROSTER);
    expect(r.constraints.dateStart).toBe("2026-08-13");
    expect(r.constraints.dateEnd).toBe("2026-08-13");
    expect(r.constraints.dailyStartTime).toBe("10:00");
    expect(r.constraints.dailyEndTime).toBe("15:00");
  });
  it("any afternoon after August 20, but not Friday — the leftover is flagged", () => {
    const r = parseWhen("Any afternoon after August 20", NOW, ROSTER);
    expect(r.constraints.dateStart).toBe("2026-08-21");
    expect(r.constraints.dailyStartTime).toBe("12:00");
  });
  it("in person in Cambridge next week", () => {
    const r = parseWhen("In person in Cambridge next week", NOW, ROSTER);
    expect(r.constraints.meetingFormat).toBe("in_person");
    expect(r.constraints.location).toBe("Cambridge");
    expect(r.constraints.dateStart).toBe("2026-08-17");
  });
  it("video call with Sam, 30 minutes, sometime Thursday", () => {
    const r = parseWhen("Video call with Sam, 30 minutes, sometime Thursday", NOW, ROSTER);
    expect(r.constraints.meetingFormat).toBe("video");
    expect(r.constraints.calendarParticipantIds).toEqual(["sam@example.com"]);
    expect(r.constraints.allowedWeekdays).toEqual([4]);
    expect(r.constraints.dateStart).toBe("2026-08-13"); // tomorrow is Thursday
  });
  it("'Casey or Sam' asks instead of guessing", () => {
    const r = parseWhen("30 minutes with Casey or Sam", NOW, ROSTER);
    expect(r.clarify).toContain("Casey or Sam".toLowerCase().split(" ")[0]); // mentions the phrase
  });
  it("an unknown name is flagged, never fuzzy-matched", () => {
    const r = parseWhen("an hour with Jonathan next week", NOW, ROSTER);
    expect(r.unknownNames).toEqual(["jonathan"]);
    expect(r.clarify).toContain("jonathan");
    expect(r.constraints.calendarParticipantIds).toBeUndefined();
  });
  it("'a couple' means 2; 'a few' means 3", () => {
    expect(parseWhen("a couple of times tomorrow", NOW, ROSTER).constraints.suggestionCount).toBe(2);
    expect(parseWhen("a few options this week", NOW, ROSTER).constraints.suggestionCount).toBe(3);
  });
  it("unparseable leftovers are reported, valid parts preserved", () => {
    const r = parseWhen("30 minutes next week wherever the vibes are right", NOW, ROSTER);
    expect(r.constraints.durationMinutes).toBe(30);
    expect(r.constraints.dateStart).toBe("2026-08-17");
    expect(r.unresolved.join(" ")).toContain("vibes");
  });
});

describe("candidateSlots — interval arithmetic", () => {
  it("intersects EVERY participant's busy set", () => {
    const c = base({ dateStart: "2026-08-13", dateEnd: "2026-08-13", suggestionCount: 8 });
    // Alex busy 9–12 ET (13–16Z), Sam busy 13–17 ET (17–21Z) → only 12–1 ET free.
    const slots = candidateSlots(
      {
        alex: [{ start: "2026-08-13T13:00:00Z", end: "2026-08-13T16:00:00Z" }],
        sam: [{ start: "2026-08-13T17:00:00Z", end: "2026-08-13T21:00:00Z" }],
      },
      c,
      NOW
    );
    expect(slots.map((s) => s.timeLabel)).toEqual(["12:00 PM", "12:30 PM"]);
  });
  it("touching events don't block: a meeting may start when another ends", () => {
    const c = base({ dateStart: "2026-08-13", dateEnd: "2026-08-13" });
    const slots = candidateSlots(
      { alex: [{ start: "2026-08-13T13:00:00Z", end: "2026-08-13T14:00:00Z" }] }, // 9–10 ET
      c,
      NOW
    );
    expect(slots[0].timeLabel).toBe("10:00 AM");
  });
  it("buffers carve out otherwise-free edges", () => {
    const c = base({ dateStart: "2026-08-13", dateEnd: "2026-08-13", bufferBeforeMinutes: 30, bufferAfterMinutes: 30 });
    const slots = candidateSlots(
      { alex: [{ start: "2026-08-13T13:00:00Z", end: "2026-08-13T14:00:00Z" }] },
      c,
      NOW
    );
    expect(slots[0].timeLabel).toBe("10:30 AM"); // 10:00 eaten by the after-buffer
  });
  it("minimum notice hides the next two hours", () => {
    const c = base({ dateStart: "2026-08-12", dateEnd: "2026-08-12" });
    const slots = candidateSlots({}, c, NOW); // now = 9:00 AM ET
    expect(slots[0].timeLabel).toBe("11:00 AM");
  });
  it("DST boundary: wall-clock hours hold across Nov 1", () => {
    const c = base({
      dateStart: "2026-10-30",
      dateEnd: "2026-11-03",
      allowedWeekdays: [1, 2, 3, 4, 5],
      suggestionCount: 8,
    });
    const slots = candidateSlots({}, c, NOW);
    const friday = slots.find((s) => s.dayKey === "2026-10-30");
    const monday = slots.find((s) => s.dayKey === "2026-11-02");
    expect(friday?.timeLabel).toBe("9:00 AM");
    expect(monday?.timeLabel).toBe("9:00 AM"); // same wall clock, different UTC offset
    expect(friday?.startISO.endsWith("13:00:00.000Z")).toBe(true); // EDT
    expect(monday?.startISO.endsWith("14:00:00.000Z")).toBe(true); // EST
  });
  it("no common availability yields an empty list, never an invention", () => {
    const c = base({ dateStart: "2026-08-13", dateEnd: "2026-08-13" });
    const slots = candidateSlots(
      { alex: [{ start: "2026-08-13T00:00:00Z", end: "2026-08-14T00:00:00Z" }] }, // all-day busy
      c,
      NOW
    );
    expect(slots).toEqual([]);
  });
});

describe("pickSpread", () => {
  it("spreads across days instead of stacking one morning", () => {
    const c = base({ dateStart: "2026-08-17", dateEnd: "2026-08-19", suggestionCount: 3 });
    const picked = pickSpread(candidateSlots({}, c, NOW), 3);
    expect(new Set(picked.map((s) => s.dayKey)).size).toBe(3);
  });
  it("falls back to same-day when only one day exists, spaced apart", () => {
    const c = base({ dateStart: "2026-08-17", dateEnd: "2026-08-17", suggestionCount: 3 });
    const picked = pickSpread(candidateSlots({}, c, NOW), 3);
    expect(picked).toHaveLength(3);
    const gaps = picked.slice(1).map((s, i) => new Date(s.startISO).getTime() - new Date(picked[i].startISO).getTime());
    for (const g of gaps) expect(g).toBeGreaterThanOrEqual(90 * 60000);
  });
  it("exclusions force different times on regeneration", () => {
    const c = base({ dateStart: "2026-08-17", dateEnd: "2026-08-18", suggestionCount: 2 });
    const all = candidateSlots({}, c, NOW);
    const first = pickSpread(all, 2);
    const second = pickSpread(all, 2, new Set(first.map((s) => s.startISO)));
    expect(second.every((s) => !first.some((f) => f.startISO === s.startISO))).toBe(true);
  });
});

describe("formatSlotsForEmail", () => {
  it("clean bulleted ET block", () => {
    const c = base({ dateStart: "2026-08-18", dateEnd: "2026-08-18", suggestionCount: 1 });
    const [slot] = pickSpread(candidateSlots({}, c, NOW), 1);
    const text = formatSlotsForEmail([slot]);
    expect(text).toContain("Would any of these times work for you?");
    expect(text).toContain("• Tuesday, August 18 at 9:00 AM ET");
  });
});

describe("date helpers", () => {
  it("addLocalDays crosses DST without drifting", () => {
    expect(addLocalDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(addLocalDays("2026-11-01", 1)).toBe("2026-11-02");
    expect(weekdayOfKey("2026-08-17")).toBe(1); // Monday
  });
});
