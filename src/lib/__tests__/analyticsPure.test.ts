import { describe, expect, it } from "vitest";
import { STAGE_BY_KEY } from "../stages";
import {
  AGE_BUCKETS,
  ageBucketOf,
  bucketForSpan,
  bucketLabel,
  bucketStart,
  daysBetween,
  deltaLabel,
  fillSeries,
  nextBucket,
  pctOf,
  resolvePeriod,
  stageGroupingIsTotal,
  stageGroupOf,
  STAGE_GROUPS,
} from "../analyticsPure";

const TODAY = "2026-08-09";

describe("resolvePeriod", () => {
  it("90d: inclusive window plus the equally long prior window", () => {
    const p = resolvePeriod("90d", undefined, undefined, TODAY);
    expect(p.start).toBe("2026-05-12"); // 90 days inclusive of today
    expect(p.end).toBe(TODAY);
    expect(p.prevEnd).toBe("2026-05-11");
    expect(p.prevStart).toBe("2026-02-11");
    expect(daysBetween(p.prevStart!, p.prevEnd!)).toBe(daysBetween(p.start!, p.end));
    expect(p.bucket).toBe("week");
    expect(p.compareLabel).toBe("vs prior 90 days");
  });
  it("all time has no comparison window", () => {
    const p = resolvePeriod("all", undefined, undefined, TODAY);
    expect(p.start).toBeNull();
    expect(p.prevStart).toBeNull();
    expect(p.bucket).toBe("quarter");
    expect(p.compareLabel).toBeNull();
  });
  it("custom windows bucket by span; garbage falls back to 12m", () => {
    const p = resolvePeriod("custom", "2026-01-01", "2026-01-31", TODAY);
    expect(p.bucket).toBe("day");
    expect(p.prevStart).toBe("2025-12-01");
    const junk = resolvePeriod("custom", "2026-13-99", "nope", TODAY);
    expect(junk.key).toBe("12m");
  });
  it("bucket thresholds: day → week → month → quarter", () => {
    expect(bucketForSpan(30)).toBe("day");
    expect(bucketForSpan(90)).toBe("week");
    expect(bucketForSpan(365)).toBe("month");
    expect(bucketForSpan(1800)).toBe("quarter");
  });
});

describe("bucketing", () => {
  it("week starts on Monday", () => {
    expect(bucketStart("2026-08-09", "week")).toBe("2026-08-03"); // Sunday → prior Monday
    expect(bucketStart("2026-08-03", "week")).toBe("2026-08-03");
  });
  it("month and quarter truncate; nextBucket steps over year ends", () => {
    expect(bucketStart("2026-08-09", "month")).toBe("2026-08-01");
    expect(bucketStart("2026-08-09", "quarter")).toBe("2026-07-01");
    expect(nextBucket("2026-12-01", "month")).toBe("2027-01-01");
    expect(nextBucket("2026-10-01", "quarter")).toBe("2027-01-01");
  });
  it("labels read like a chart axis", () => {
    expect(bucketLabel("2026-08-03", "day")).toBe("Aug 3");
    expect(bucketLabel("2026-08-03", "week")).toBe("Wk of Aug 3");
    expect(bucketLabel("2026-08-01", "month")).toBe("Aug ’26");
    expect(bucketLabel("2026-07-01", "quarter")).toBe("’26 Q3");
  });
  it("fillSeries renders gaps as zeros", () => {
    const s = fillSeries(
      new Map([["2026-08-03", 4]]),
      "2026-07-27",
      "2026-08-12", // Wednesday of the third week
      "week"
    );
    expect(s.map((p) => p.count)).toEqual([0, 4, 0]);
    expect(s[1].label).toBe("Wk of Aug 3");
  });
});

describe("deltas stay honest", () => {
  it("formats direction without judgment", () => {
    expect(deltaLabel(112, 100)).toBe("↑ 12%");
    expect(deltaLabel(88, 100)).toBe("↓ 12%");
    expect(deltaLabel(100, 100)).toBe("→ 0%");
  });
  it("no base, no claim", () => {
    expect(deltaLabel(5, 0)).toBeNull();
  });
});

describe("age buckets", () => {
  it("edges land where the labels say", () => {
    expect(ageBucketOf(0)).toBe("u7");
    expect(ageBucketOf(6)).toBe("u7");
    expect(ageBucketOf(7)).toBe("u30");
    expect(ageBucketOf(30)).toBe("u30");
    expect(ageBucketOf(31)).toBe("u60");
    expect(ageBucketOf(60)).toBe("u60");
    expect(ageBucketOf(61)).toBe("o60");
    expect(AGE_BUCKETS).toHaveLength(4);
  });
});

describe("stage grouping is explicit and total", () => {
  it("covers every stage exactly once", () => {
    expect(stageGroupingIsTotal()).toBe(true);
  });
  it("maps terminal stages to the neutral group", () => {
    expect(stageGroupOf("to-pass")).toBe("passed");
    expect(stageGroupOf("passed")).toBe("passed");
    expect(stageGroupOf("to-meet")).toBe("early");
    expect(STAGE_GROUPS.find((g) => g.key === "passed")?.color).toBe(STAGE_BY_KEY.passed.color);
  });
});

describe("pctOf", () => {
  it("rounds and refuses division by zero", () => {
    expect(pctOf(48, 2073)).toBe("2%");
    expect(pctOf(1, 0)).toBe("—");
  });
});
