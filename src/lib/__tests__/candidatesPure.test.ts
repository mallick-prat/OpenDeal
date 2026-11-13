import { describe, expect, it } from "vitest";
import {
  applyFoundersMeta,
  compareCandidates,
  entitySignature,
  isOpen,
  missingSlots,
  parseFoundersMeta,
  priorityBand,
  sameEntity,
  snoozeLapsed,
  statusFromInbound,
  type RankableCandidate,
} from "../candidatesPure";

const base: RankableCandidate = {
  status: "ready",
  assignedTo: null,
  classification: "pitch",
  confidence: 0.9,
  meetingScheduled: false,
  receivedAt: "2026-07-20T10:00:00Z",
  snoozedUntil: null,
};

describe("statusFromInbound", () => {
  it("maps every legacy status", () => {
    expect(statusFromInbound("pending")).toEqual({ status: "parsing", reviewed: false });
    expect(statusFromInbound("parsed")).toEqual({ status: "ready", reviewed: false });
    expect(statusFromInbound("created")).toEqual({ status: "approved", reviewed: true });
    expect(statusFromInbound("skipped")).toEqual({ status: "ignored", reviewed: true });
    expect(statusFromInbound("error")).toEqual({ status: "parse_failed", reviewed: false });
  });
  it("unknown statuses fall back to ready, unreviewed", () => {
    expect(statusFromInbound("bogus")).toEqual({ status: "ready", reviewed: false });
  });
});

describe("priorityBand ordering (PRD §9.2)", () => {
  const me = "alex@example.com";
  it("meeting scheduled outranks everything", () => {
    expect(priorityBand({ ...base, meetingScheduled: true }, me)).toBe(0);
    expect(
      priorityBand({ ...base, meetingScheduled: true, classification: "other" }, me)
    ).toBe(0);
  });
  it("referral beats assigned; assigned beats confident pitch", () => {
    expect(priorityBand({ ...base, classification: "referral" }, me)).toBe(1);
    expect(priorityBand({ ...base, assignedTo: "ALEX@example.com" }, me)).toBe(2);
    expect(priorityBand(base, me)).toBe(3);
  });
  it("assignment to someone else does not jump the queue", () => {
    expect(priorityBand({ ...base, assignedTo: "other@example.com" }, me)).toBe(3);
  });
  it("low-confidence pitch drops to the bottom band", () => {
    expect(priorityBand({ ...base, confidence: 0.4 }, me)).toBe(5);
  });
  it("updates sit between confident pitches and the rest", () => {
    expect(priorityBand({ ...base, classification: "update" }, me)).toBe(4);
  });
});

describe("compareCandidates", () => {
  it("same band → newest first", () => {
    const older = { ...base, receivedAt: "2026-07-01T00:00:00Z" };
    expect(compareCandidates(base, older, "x@example.com")).toBeLessThan(0);
  });
});

describe("snoozeLapsed", () => {
  const now = new Date("2026-07-25T12:00:00Z");
  it("lapses only past-due snoozes", () => {
    expect(
      snoozeLapsed({ ...base, status: "snoozed", snoozedUntil: "2026-07-24T00:00:00Z" }, now)
    ).toBe(true);
    expect(
      snoozeLapsed({ ...base, status: "snoozed", snoozedUntil: "2026-08-01T00:00:00Z" }, now)
    ).toBe(false);
  });
  it("non-snoozed candidates never lapse", () => {
    expect(snoozeLapsed({ ...base, snoozedUntil: "2026-07-01T00:00:00Z" }, now)).toBe(false);
  });
});

describe("missingSlots (triage doctrine: facts, not errors)", () => {
  it("full candidate → nothing missing", () => {
    expect(
      missingSlots(
        {
          companyName: "Acme",
          raiseAmount: "$2M",
          founders: [{ fullName: "Jane Doe" }],
        },
        true
      )
    ).toEqual([]);
  });
  it("empty pre-pitch reports every gap honestly", () => {
    expect(missingSlots(null, false)).toEqual([
      "No company name",
      "No deck yet",
      "No raise stated",
      "No founders named",
    ]);
  });
  it("round alone satisfies the raise slot", () => {
    expect(
      missingSlots({ companyName: "Acme", round: "Seed", founders: [{ fullName: "J D" }] }, true)
    ).toEqual([]);
  });
});

describe("isOpen", () => {
  it("open vs terminal states", () => {
    expect(isOpen("ready")).toBe(true);
    expect(isOpen("snoozed")).toBe(true);
    expect(isOpen("approved")).toBe(false);
    expect(isOpen("ignored")).toBe(false);
  });
});

describe("applyFoundersMeta (foundersMeta claim)", () => {
  const list = [
    { name: "Ada Lovelace", role: "CEO" },
    { name: "Grace Hopper", role: "CTO" },
    { name: "Alan Turing", role: "CSO" },
  ];
  const names = (out: { name: string }[]) => out.map((f) => f.name);

  it("null/absent meta leaves the natural extraction order untouched", () => {
    expect(applyFoundersMeta(list, null)).toEqual(list);
    expect(applyFoundersMeta(list, undefined)).toEqual(list);
  });
  it("removed names drop out of the working list", () => {
    expect(
      names(applyFoundersMeta(list, { order: [], removed: ["Grace Hopper"] }))
    ).toEqual(["Ada Lovelace", "Alan Turing"]);
  });
  it("order rearranges; the rest of each item rides along", () => {
    const out = applyFoundersMeta(list, {
      order: ["Alan Turing", "Ada Lovelace", "Grace Hopper"],
      removed: [],
    });
    expect(names(out)).toEqual(["Alan Turing", "Ada Lovelace", "Grace Hopper"]);
    expect(out[0].role).toBe("CSO");
  });
  it("names missing from order append at the end in natural order", () => {
    expect(
      names(applyFoundersMeta(list, { order: ["Alan Turing"], removed: [] }))
    ).toEqual(["Alan Turing", "Ada Lovelace", "Grace Hopper"]);
  });
  it("unknown names in order/removed are ignored harmlessly", () => {
    expect(
      names(
        applyFoundersMeta(list, {
          order: ["Nobody Here", "Grace Hopper"],
          removed: ["Also Nobody"],
        })
      )
    ).toEqual(["Grace Hopper", "Ada Lovelace", "Alan Turing"]);
  });
  it("matching is case- and whitespace-insensitive", () => {
    expect(
      names(
        applyFoundersMeta(list, {
          order: ["  alan turing  "],
          removed: ["ADA LOVELACE"],
        })
      )
    ).toEqual(["Alan Turing", "Grace Hopper"]);
  });
});

describe("parseFoundersMeta", () => {
  it("reads a well-formed claim value", () => {
    expect(parseFoundersMeta({ order: ["A"], removed: ["B"] })).toEqual({
      order: ["A"],
      removed: ["B"],
    });
  });
  it("bad shapes read as null; non-strings are filtered", () => {
    expect(parseFoundersMeta(null)).toBeNull();
    expect(parseFoundersMeta("nope")).toBeNull();
    expect(parseFoundersMeta(["nope"])).toBeNull();
    expect(parseFoundersMeta({ order: [1, "A"], removed: "x" })).toEqual({
      order: ["A"],
      removed: [],
    });
  });
});

describe("entity identity across sends", () => {
  const airnova = entitySignature({
    fromEmail: "jgarner@college.harvard.edu",
    companyName: "Nova (AirNova)",
    founders: [
      { fullName: "Jon Garner", email: "jgarner@college.harvard.edu" },
      { fullName: "Elise Laurent", email: null },
      { fullName: "Max Becker", email: null },
    ],
  });

  it("re-send from the same founder address is the same entity", () => {
    const resend = entitySignature({
      fromEmail: "jgarner@college.harvard.edu",
      companyName: "Nova (AirNova)",
      founders: [{ fullName: "Jon Garner", email: "jgarner@college.harvard.edu" }],
    });
    expect(sameEntity(airnova, resend)).toBe(true);
  });

  it("renamed company with the same founders is the same entity", () => {
    // The live case: "Nova AI" from a third address, founders by first name.
    const novaAi = entitySignature({
      fromEmail: "theo.nguyen05@gmail.com",
      companyName: "Nova AI",
      founders: [{ fullName: "Elise" }, { fullName: "Jon" }],
    });
    // Jon + Elise both appear in the AirNova founder names, and "novaai"
    // is contained in "novaairnova" — two shared tokens + compatible
    // company names merge the rename into one inbox row.
    expect(sameEntity(airnova, novaAi)).toBe(true);
  });

  it("internal forwarder is never identity evidence", () => {
    const fwd = entitySignature({
      fromEmail: "alex@example.com",
      companyName: "Totally Different Co",
      founders: [],
    });
    expect(fwd.senderEmail).toBeNull();
    expect(sameEntity(airnova, fwd)).toBe(false);
  });

  it("unrelated startups sharing one founder first name do not merge", () => {
    const other = entitySignature({
      fromEmail: "sam@acme.dev",
      companyName: "Acme Robotics",
      founders: [{ fullName: "Jon Patel" }, { fullName: "Sam Osei" }],
    });
    expect(sameEntity(airnova, other)).toBe(false);
  });
});
