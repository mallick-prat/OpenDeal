import { describe, expect, it } from "vitest";
import { createPoolHealth } from "../dbPoolHealth";

const T0 = 1_785_100_000_000;

describe("createPoolHealth", () => {
  it("two backend terminations inside a minute recycle the pool", () => {
    const h = createPoolHealth();
    expect(h.record("57P01", T0)).toBe(false);
    expect(h.record("57P01", T0 + 30_000)).toBe(true);
    expect(h.recycles()).toBe(1);
  });

  it("a lone termination is a blip, not a poisoning", () => {
    const h = createPoolHealth();
    expect(h.record("57P01", T0)).toBe(false);
    // The next one lands outside the window — still a blip.
    expect(h.record("57P01", T0 + 90_000)).toBe(false);
  });

  it("a cluster of deadlines recycles; a trickle does not", () => {
    const h = createPoolHealth();
    expect(h.record("CLIENT_DEADLINE", T0)).toBe(false);
    expect(h.record("CLIENT_DEADLINE", T0 + 5_000)).toBe(false);
    expect(h.record("CLIENT_DEADLINE", T0 + 10_000)).toBe(false);
    expect(h.record("CLIENT_DEADLINE", T0 + 15_000)).toBe(true);

    const slow = createPoolHealth();
    // Same four failures spread over two minutes: never trips.
    for (let i = 0; i < 4; i++) {
      expect(slow.record("CLIENT_DEADLINE", T0 + i * 30_000)).toBe(false);
    }
  });

  it("mixed cluster codes count toward the same trip", () => {
    const h = createPoolHealth();
    expect(h.record("ECONNRESET", T0)).toBe(false);
    expect(h.record("CONNECTION_CLOSED", T0 + 1_000)).toBe(false);
    expect(h.record("CLIENT_DEADLINE", T0 + 2_000)).toBe(false);
    expect(h.record("ETIMEDOUT", T0 + 3_000)).toBe(true);
  });

  it("cooldown blocks a second recycle even under continued failure", () => {
    const h = createPoolHealth();
    h.record("57P01", T0);
    expect(h.record("57P01", T0 + 1_000)).toBe(true);
    // Storm continues — but we just rebuilt; don't thrash.
    expect(h.record("57P01", T0 + 2_000)).toBe(false);
    expect(h.record("57P01", T0 + 3_000)).toBe(false);
    // After the cooldown, a fresh storm can trip again.
    expect(h.record("57P01", T0 + 62_000)).toBe(false);
    expect(h.record("57P01", T0 + 63_000)).toBe(true);
    expect(h.recycles()).toBe(2);
  });

  it("ignores codes that say nothing about the pool", () => {
    const h = createPoolHealth();
    for (let i = 0; i < 10; i++) {
      expect(h.record("23505", T0 + i * 100)).toBe(false); // unique violation
      expect(h.record("42P01", T0 + i * 100)).toBe(false); // missing table
      expect(h.record("", T0 + i * 100)).toBe(false);
    }
    expect(h.recycles()).toBe(0);
  });
});
