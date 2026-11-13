import { describe, expect, it } from "vitest";
import {
  currentValue,
  fieldConflict,
  groupClaims,
  isHumanClaim,
  jsonEqual,
  PROVENANCE_LABEL,
  type ClaimRow,
  type ClaimSourceType,
} from "../claimsPure";

let seq = 0;
function claim(overrides: Partial<ClaimRow> = {}): ClaimRow {
  seq += 1;
  return {
    id: `claim-${seq}`,
    subject_type: "candidate",
    subject_id: "cand-1",
    field: "raiseAmount",
    value: "$2M",
    source_type: "email_extracted",
    source_ref: null,
    source_span: null,
    confidence: 0.8,
    confirmed_by: null,
    superseded_at: null,
    created_at: "2026-07-01T10:00:00Z",
    ...overrides,
  };
}

describe("isHumanClaim", () => {
  it("team_confirmed and manual are human even without confirmed_by", () => {
    expect(isHumanClaim(claim({ source_type: "team_confirmed" }))).toBe(true);
    expect(isHumanClaim(claim({ source_type: "manual" }))).toBe(true);
  });
  it("any row with confirmed_by set is human", () => {
    expect(
      isHumanClaim(claim({ source_type: "email_extracted", confirmed_by: "alex@example.com" }))
    ).toBe(true);
  });
  it("machine extractions are not human", () => {
    expect(isHumanClaim(claim({ source_type: "email_extracted" }))).toBe(false);
    expect(isHumanClaim(claim({ source_type: "deck_extracted" }))).toBe(false);
    expect(isHumanClaim(claim({ source_type: "granola" }))).toBe(false);
  });
});

describe("currentValue", () => {
  it("empty ledger resolves to null", () => {
    expect(currentValue([])).toBeNull();
  });

  it("machine-only: the newest machine row wins", () => {
    const older = claim({ value: "$1M", created_at: "2026-07-01T10:00:00Z" });
    const newer = claim({ value: "$2M", created_at: "2026-07-02T10:00:00Z" });
    expect(currentValue([older, newer])).toBe(newer);
    expect(currentValue([newer, older])).toBe(newer);
  });

  it("a confirmed row overrides any machine row", () => {
    const machine = claim({ value: "$2M", created_at: "2026-07-01T10:00:00Z" });
    const human = claim({
      value: "$3M",
      source_type: "team_confirmed",
      confirmed_by: "alex@example.com",
      created_at: "2026-07-02T10:00:00Z",
    });
    expect(currentValue([machine, human])).toBe(human);
  });

  it("a NEWER machine row never beats an OLDER human row", () => {
    const human = claim({
      value: "$3M",
      source_type: "team_confirmed",
      confirmed_by: "alex@example.com",
      created_at: "2026-07-01T10:00:00Z",
    });
    const newerMachine = claim({ value: "$5M", created_at: "2026-07-10T10:00:00Z" });
    expect(currentValue([human, newerMachine])).toBe(human);
  });

  it("among human rows, the newest confirmation wins", () => {
    const first = claim({
      value: "$3M",
      source_type: "team_confirmed",
      confirmed_by: "a@example.com",
      created_at: "2026-07-01T10:00:00Z",
    });
    const second = claim({
      value: "$4M",
      source_type: "team_confirmed",
      confirmed_by: "b@example.com",
      created_at: "2026-07-02T10:00:00Z",
    });
    expect(currentValue([first, second])).toBe(second);
  });

  it("superseded rows never count — even when they are the newest", () => {
    const live = claim({ value: "$1M", created_at: "2026-07-01T10:00:00Z" });
    const retired = claim({
      value: "$9M",
      created_at: "2026-07-05T10:00:00Z",
      superseded_at: "2026-07-06T10:00:00Z",
    });
    expect(currentValue([live, retired])).toBe(live);
  });

  it("all rows superseded resolves to null", () => {
    expect(
      currentValue([claim({ superseded_at: "2026-07-06T10:00:00Z" })])
    ).toBeNull();
  });

  it("accepts Date objects for timestamps", () => {
    const older = claim({ created_at: new Date("2026-07-01T10:00:00Z") });
    const newer = claim({ created_at: new Date("2026-07-02T10:00:00Z") });
    expect(currentValue([older, newer])).toBe(newer);
  });
});

describe("jsonEqual", () => {
  it("compares structurally, ignoring key order", () => {
    expect(jsonEqual({ a: 1, b: [2, 3] }, { b: [2, 3], a: 1 })).toBe(true);
    expect(jsonEqual("$2M", "$2M")).toBe(true);
    expect(jsonEqual("$2M", "$3M")).toBe(false);
    expect(jsonEqual(null, "$2M")).toBe(false);
    expect(jsonEqual(2, "2")).toBe(false);
  });
});

describe("fieldConflict", () => {
  const human = () =>
    claim({
      value: "$3M",
      source_type: "team_confirmed",
      confirmed_by: "alex@example.com",
      created_at: "2026-07-02T10:00:00Z",
    });

  it("machine disagrees with the confirmed value → conflict with both rows", () => {
    const machine = claim({ value: "$2M" });
    const confirmed = human();
    const conflict = fieldConflict([machine, confirmed]);
    expect(conflict).not.toBeNull();
    expect(conflict!.machine).toBe(machine);
    expect(conflict!.confirmed).toBe(confirmed);
  });

  it("no conflict when machine and human agree", () => {
    expect(fieldConflict([claim({ value: "$3M" }), human()])).toBeNull();
  });

  it("no conflict without a confirmed row, or without a machine row", () => {
    expect(fieldConflict([claim()])).toBeNull();
    expect(fieldConflict([human()])).toBeNull();
  });

  it("superseded machine rows cannot raise a conflict", () => {
    const retired = claim({ value: "$9M", superseded_at: "2026-07-06T10:00:00Z" });
    expect(fieldConflict([retired, human()])).toBeNull();
  });
});

describe("groupClaims", () => {
  it("groups by field and resolves each field's current value", () => {
    const raise = claim({ field: "raiseAmount", value: "$2M" });
    const sectorOld = claim({
      field: "sector",
      value: "Fintech",
      created_at: "2026-07-01T10:00:00Z",
    });
    const sectorNew = claim({
      field: "sector",
      value: "Climate",
      created_at: "2026-07-03T10:00:00Z",
    });
    const grouped = groupClaims([raise, sectorOld, sectorNew]);
    expect(Object.keys(grouped).sort()).toEqual(["raiseAmount", "sector"]);
    expect(grouped.raiseAmount.current).toBe(raise);
    expect(grouped.sector.current).toBe(sectorNew);
    expect(grouped.sector.rows).toHaveLength(2);
  });

  it("empty input yields an empty map", () => {
    expect(groupClaims([])).toEqual({});
  });
});

describe("PROVENANCE_LABEL", () => {
  it("labels every source type with a short chip string", () => {
    const types: ClaimSourceType[] = [
      "email_extracted",
      "deck_extracted",
      "founder_claimed",
      "team_confirmed",
      "externally_verified",
      "granola",
      "manual",
    ];
    for (const t of types) {
      expect(PROVENANCE_LABEL[t]).toBeTruthy();
      expect(PROVENANCE_LABEL[t].length).toBeLessThanOrEqual(20);
    }
  });
});
