import { describe, expect, it } from "vitest";
import { brandCss, brandRamp, normalizeHex, orgInitials } from "../brandPure";

describe("brandRamp", () => {
  it("keeps the chosen color exactly as shade 500", () => {
    expect(brandRamp("#0f62fe")[500]).toBe("#0f62fe");
    expect(brandRamp("#c31a2d")[500]).toBe("#c31a2d");
  });

  it("steps from pale to dark, monotonically in lightness", () => {
    const r = brandRamp("#0f62fe");
    const lum = (hex: string) => {
      const n = parseInt(hex.slice(1), 16);
      return 0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255);
    };
    const order = [50, 100, 200, 300, 500, 600, 700, 800, 950] as const;
    for (let i = 1; i < order.length; i++) {
      expect(lum(r[order[i]])).toBeLessThan(lum(r[order[i - 1]]));
    }
  });

  it("always yields valid 6-digit hex, even for grey and extreme colors", () => {
    for (const c of ["#000000", "#ffffff", "#808080", "#ff0000", "#00ff00"]) {
      for (const v of Object.values(brandRamp(c))) expect(v).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it("falls back to the default for garbage input instead of throwing", () => {
    expect(brandRamp("not-a-color")[500]).toBe("#0f62fe");
  });
});

describe("normalizeHex", () => {
  it("accepts with or without #, any case", () => {
    expect(normalizeHex("C31A2D", "#000000")).toBe("#c31a2d");
    expect(normalizeHex("#C31A2D", "#000000")).toBe("#c31a2d");
  });
  it("rejects short hex and junk", () => {
    expect(normalizeHex("#fff", "#123456")).toBe("#123456");
    expect(normalizeHex(undefined, "#123456")).toBe("#123456");
  });
});

describe("brandCss", () => {
  it("overrides the ramp tokens and the link/focus tokens", () => {
    const css = brandCss("#0f62fe");
    expect(css).toContain("--brand-red-500:#0f62fe");
    expect(css).toContain("--text-link:#0f62fe");
    expect(css.startsWith(":root{")).toBe(true);
  });
});

describe("orgInitials", () => {
  it("uses two words' first letters, or two letters of one word", () => {
    expect(orgInitials("Acme Ventures")).toBe("AV");
    expect(orgInitials("Acme")).toBe("AC");
    expect(orgInitials("  ")).toBe("D");
    expect(orgInitials(null)).toBe("D");
  });
});

describe("brandRamp with very dark or very light brand colors", () => {
  it("keeps every step distinct (no collapsed shades)", () => {
    for (const c of ["#0e7c66", "#1a1a40", "#f5d90a", "#ffffff"]) {
      const values = Object.values(brandRamp(c));
      expect(new Set(values).size, `ramp for ${c}`).toBe(values.length);
    }
  });
});
