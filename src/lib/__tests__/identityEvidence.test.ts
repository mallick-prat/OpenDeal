import { describe, expect, it } from "vitest";
import {
  EVIDENCE_REASONS,
  EVIDENCE_STRENGTH,
  nameBaseOf,
  normalizeEvidenceEmail,
  reasonText,
} from "../identityEvidencePure";

/**
 * The identity service's pure rules. Two of these are regression pins on
 * real production incidents: internal senders must never be founder
 * evidence (the Terranova/Carter calendar poisoning), and the name_base
 * rule must match the deals.name_base generated column expression
 * (regexp_replace(lower(regexp_replace(name, e-dot-star-slash-slash, '')),
 * non-alphanumerics, '', 'g')).
 */

describe("normalizeEvidenceEmail", () => {
  it("lowers and trims plausible external addresses", () => {
    expect(normalizeEvidenceEmail("  Porter@CarterIntro.com ")).toBe("porter@carterintro.com");
  });

  it("NEVER admits internal addresses — the matcher-poisoning class", () => {
    expect(normalizeEvidenceEmail("alex@example.com")).toBeNull();
    expect(normalizeEvidenceEmail("ALEX@EXAMPLE.COM")).toBeNull();
    expect(normalizeEvidenceEmail("bot@example.com")).toBeNull();
  });

  it("rejects empties and non-addresses", () => {
    expect(normalizeEvidenceEmail(null)).toBeNull();
    expect(normalizeEvidenceEmail(undefined)).toBeNull();
    expect(normalizeEvidenceEmail("")).toBeNull();
    expect(normalizeEvidenceEmail("not-an-email")).toBeNull();
    expect(normalizeEvidenceEmail("a".repeat(320) + "@x.com")).toBeNull();
  });
});

describe("nameBaseOf — parity with the deals.name_base generated column", () => {
  // Each case documents what the SQL expression must also produce.
  const cases: [string, string][] = [
    ["Jane Doe, Bo Chen // Acme", "acme"],
    ["Eli Brandt // Honest Pebble", "honestpebble"],
    ["Honest Pebble / Acme", "honestpebble/acme".replace(/[^a-z0-9]/g, "")],
    ["Acme", "acme"],
    ["A // B // C-Labs", "clabs"],
    ["Nina Chen // OpenToken ", "opentoken"],
    ["  // Weird Left Empty", "weirdleftempty"],
  ];
  it.each(cases)("%s → %s", (name, base) => {
    expect(nameBaseOf(name)).toBe(base);
  });

  it("keeps only ascii alphanumerics, lowered", () => {
    expect(nameBaseOf("X // Café.AI!")).toBe("cafai");
  });
});

describe("reason ladder", () => {
  it("covers every reason with a strength and a sentence", () => {
    for (const r of EVIDENCE_REASONS) {
      expect(EVIDENCE_STRENGTH[r]).toBeGreaterThan(0);
      expect(reasonText(r, "Sam")).toBeTruthy();
    }
  });

  it("orders founder email above name above company row above name-base above thread", () => {
    expect(EVIDENCE_STRENGTH.founder_email).toBeGreaterThan(EVIDENCE_STRENGTH.founder_name);
    expect(EVIDENCE_STRENGTH.founder_name).toBeGreaterThan(EVIDENCE_STRENGTH.company_row);
    expect(EVIDENCE_STRENGTH.company_row).toBeGreaterThan(EVIDENCE_STRENGTH.name_base_company);
    expect(EVIDENCE_STRENGTH.name_base_company).toBeGreaterThan(EVIDENCE_STRENGTH.thread);
  });
});
