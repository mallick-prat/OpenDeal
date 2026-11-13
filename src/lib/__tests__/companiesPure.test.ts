import { describe, expect, it } from "vitest";
import {
  autoLinkThreshold,
  isInternalEmail,
  isCompanyEmailDomain,
  nameSimilarity,
  normalizeCompanyDomain,
  normalizeCompanyName,
} from "../companiesPure";

describe("normalizeCompanyName", () => {
  it("lowercases, strips punctuation, collapses whitespace", () => {
    expect(normalizeCompanyName("  Acme,   Widgets!  ")).toBe("acme widgets");
  });
  it("strips trailing legal suffixes", () => {
    expect(normalizeCompanyName("Acme Technologies, Inc.")).toBe("acme");
    expect(normalizeCompanyName("Readable Cyber LLC")).toBe("readable cyber");
    expect(normalizeCompanyName("Beta Labs Ltd")).toBe("beta");
  });
  it("never strips the name to nothing", () => {
    expect(normalizeCompanyName("Labs")).toBe("labs");
    expect(normalizeCompanyName("Inc")).toBe("inc");
  });
  it("keeps interior suffix words", () => {
    expect(normalizeCompanyName("Tech For Good")).toBe("tech for good");
  });
  it("handles unicode via NFKC", () => {
    expect(normalizeCompanyName("Café Ｎｏｖａ")).toBe("café nova");
  });
  it("empty and symbol-only input", () => {
    expect(normalizeCompanyName("")).toBe("");
    expect(normalizeCompanyName("★☆!!")).toBe("");
  });
});

describe("normalizeCompanyDomain", () => {
  it("extracts eTLD+1 from URLs", () => {
    expect(normalizeCompanyDomain("https://www.acme.co.uk/about")).toBe("acme.co.uk");
    expect(normalizeCompanyDomain("http://app.getacme.io")).toBe("getacme.io");
  });
  it("handles bare hosts and emails", () => {
    expect(normalizeCompanyDomain("acme.com")).toBe("acme.com");
    expect(normalizeCompanyDomain("jane@mail.acme.com")).toBe("acme.com");
  });
  it("rejects freemail providers", () => {
    expect(normalizeCompanyDomain("founder@gmail.com")).toBeNull();
    expect(normalizeCompanyDomain("proton.me")).toBeNull();
  });
  it("rejects garbage", () => {
    expect(normalizeCompanyDomain("")).toBeNull();
    expect(normalizeCompanyDomain(null)).toBeNull();
    expect(normalizeCompanyDomain("not a domain at all")).toBeNull();
    expect(normalizeCompanyDomain("localhost")).toBeNull();
  });
  it("isCompanyEmailDomain gates on the same rule", () => {
    expect(isCompanyEmailDomain("jane@acme.com")).toBe(true);
    expect(isCompanyEmailDomain("jane@yahoo.com")).toBe(false);
  });
});

describe("nameSimilarity", () => {
  it("identical after normalization → 1", () => {
    expect(nameSimilarity("Acme Inc.", "ACME")).toBe(1);
  });
  it("close names score high", () => {
    expect(nameSimilarity("Anthropic", "Antropic")).toBeGreaterThan(0.7);
  });
  it("unrelated names score low", () => {
    expect(nameSimilarity("Anthropic", "Zebra Robotics")).toBeLessThan(0.3);
  });
  it("empty input scores 0", () => {
    expect(nameSimilarity("", "Acme")).toBe(0);
  });
});

describe("autoLinkThreshold", () => {
  it("short names can never auto-link on name alone", () => {
    expect(autoLinkThreshold("Box")).toBe(Infinity);
    expect(nameSimilarity("Box", "Box") >= autoLinkThreshold("Box")).toBe(false);
  });
  it("longer names get workable thresholds", () => {
    expect(autoLinkThreshold("Readable Cyber")).toBe(0.85);
    expect(autoLinkThreshold("Ramp!")).toBe(0.95);
  });
});

describe("isInternalEmail (forwarded-pitch guard)", () => {
  it("flags our own addresses", () => {
    expect(isInternalEmail("alex@example.com")).toBe(true);
    expect(isInternalEmail("Deals@EXAMPLE.COM")).toBe(true);
  });
  it("passes founders through", () => {
    expect(isInternalEmail("jane@atmee.ai")).toBe(false);
    expect(isInternalEmail("")).toBe(false);
    expect(isInternalEmail(null)).toBe(false);
  });
});
