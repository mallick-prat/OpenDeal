import { describe, it, expect } from "vitest";
import {
  DECISIONS,
  DECISION_KEYS,
  isDecisionKey,
  decisionMeta,
  normalizeRationale,
  latestDecision,
} from "../decisionsPure";

describe("decision catalog", () => {
  it("has the five verdicts, each with a label and color", () => {
    expect(DECISION_KEYS).toEqual(["watch", "diligence", "invest", "pass", "lost"]);
    for (const d of DECISIONS) {
      expect(d.label.length).toBeGreaterThan(0);
      expect(d.color).toMatch(/^#[0-9a-f]{6}$/i);
      expect(d.hint.length).toBeGreaterThan(0);
    }
  });

  it("has distinct keys and colors", () => {
    expect(new Set(DECISIONS.map((d) => d.key)).size).toBe(DECISIONS.length);
    expect(new Set(DECISIONS.map((d) => d.color)).size).toBe(DECISIONS.length);
  });
});

describe("isDecisionKey", () => {
  it("accepts the valid keys only", () => {
    expect(isDecisionKey("invest")).toBe(true);
    expect(isDecisionKey("watch")).toBe(true);
    expect(isDecisionKey("passed")).toBe(false); // that's a stage, not a decision
    expect(isDecisionKey("")).toBe(false);
    expect(isDecisionKey(null)).toBe(false);
    expect(isDecisionKey(undefined)).toBe(false);
    expect(isDecisionKey("toString")).toBe(false); // no prototype leakage
  });
});

describe("decisionMeta", () => {
  it("returns meta for a real key, null otherwise", () => {
    expect(decisionMeta("pass")?.label).toBe("Pass");
    expect(decisionMeta("nope")).toBeNull();
  });
});

describe("normalizeRationale", () => {
  it("trims, normalizes CRLF, and clamps", () => {
    expect(normalizeRationale("  weak team  ")).toBe("weak team");
    expect(normalizeRationale("a\r\nb")).toBe("a\nb");
    expect(normalizeRationale("x".repeat(3000))!.length).toBe(2000);
  });
  it("rejects empty as null (rationale is required)", () => {
    expect(normalizeRationale("")).toBeNull();
    expect(normalizeRationale("   \n  ")).toBeNull();
  });
});

describe("latestDecision", () => {
  it("picks the newest row by created_at", () => {
    const rows = [
      { decision: "watch", created_at: "2026-07-01T00:00:00Z" },
      { decision: "invest", created_at: "2026-07-20T00:00:00Z" },
      { decision: "diligence", created_at: "2026-07-10T00:00:00Z" },
    ];
    expect(latestDecision(rows)?.decision).toBe("invest");
  });
  it("returns null for an empty list", () => {
    expect(latestDecision([])).toBeNull();
  });
  it("accepts Date instances too", () => {
    const rows = [
      { decision: "pass", created_at: new Date("2026-01-01T00:00:00Z") },
      { decision: "lost", created_at: new Date("2026-02-01T00:00:00Z") },
    ];
    expect(latestDecision(rows)?.decision).toBe("lost");
  });
});
