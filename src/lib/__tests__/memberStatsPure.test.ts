import { describe, expect, it } from "vitest";
import { fmtMinutes, sessionize, weeklyActivity } from "../memberStatsPure";

describe("sessionize", () => {
  it("clusters with a 30-minute cutoff: 29m stays, 31m splits", () => {
    const s = sessionize([
      "2026-08-07T13:00:00Z",
      "2026-08-07T13:29:00Z", // same session
      "2026-08-07T14:01:00Z", // 32m after previous → new session
    ]);
    expect(s.sessions).toBe(2);
    // Session 1 spans 29m + 5 tail; session 2 is a lone action = 5m tail.
    expect(s.totalMinutes).toBe(39);
    expect(s.lastActive).toBe("2026-08-07T14:01:00.000Z");
  });
  it("a lone action is one short session", () => {
    const s = sessionize(["2026-08-07T13:00:00Z"]);
    expect(s).toMatchObject({ sessions: 1, totalMinutes: 5, activeDays: 1 });
  });
  it("active days count Eastern days, not UTC", () => {
    // 2:00 UTC = 10:00 PM ET previous day → both stamps are the SAME ET day.
    const s = sessionize(["2026-08-08T02:00:00Z", "2026-08-07T21:00:00Z"]);
    expect(s.activeDays).toBe(1);
  });
  it("empty and garbage input degrade to zeros", () => {
    expect(sessionize([]).sessions).toBe(0);
    expect(sessionize(["nope"]).sessions).toBe(0);
  });
});

describe("weeklyActivity", () => {
  it("buckets into Monday-anchored weeks with stable labels", () => {
    const w = weeklyActivity(
      ["2026-08-04T12:00:00Z", "2026-08-05T12:00:00Z", "2026-07-28T12:00:00Z"],
      "2026-08-09T12:00:00Z",
      3
    );
    expect(w.map((x) => x.label)).toEqual(["Jul 20", "Jul 27", "Aug 3"]);
    expect(w.map((x) => x.count)).toEqual([0, 1, 2]);
  });
});

describe("fmtMinutes", () => {
  it("formats hours and minutes", () => {
    expect(fmtMinutes(0)).toBe("—");
    expect(fmtMinutes(25)).toBe("25m");
    expect(fmtMinutes(60)).toBe("1h");
    expect(fmtMinutes(220)).toBe("3h 40m");
  });
});
