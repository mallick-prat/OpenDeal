import { describe, it, expect } from "vitest";
import {
  companyNameInTitle,
  matchNoteToDeals,
  normalizeEmail,
  type MatchDeal,
} from "../meetingNotesPure";

function deal(overrides: Partial<MatchDeal> = {}): MatchDeal {
  return {
    gid: "1001",
    name: "Ramp — Alice Chen (HBS)",
    companyName: "Ramp",
    founderEmails: ["alice@ramp.com"],
    founderNames: ["Alice Chen"],
    ...overrides,
  };
}

describe("normalizeEmail", () => {
  it("lowercases and trims", () => {
    expect(normalizeEmail("  Alice@Ramp.COM ")).toBe("alice@ramp.com");
  });
  it("rejects non-emails and non-strings", () => {
    expect(normalizeEmail("not-an-email")).toBeNull();
    expect(normalizeEmail("")).toBeNull();
    expect(normalizeEmail(null)).toBeNull();
    expect(normalizeEmail(42)).toBeNull();
  });
});

describe("companyNameInTitle", () => {
  it("matches whole words only — no substring false positives", () => {
    expect(companyNameInTitle("Ramp", "Intro call — Ramp")).toBe(true);
    expect(companyNameInTitle("Ramp", "Trampoline Ventures catch-up")).toBe(false);
    expect(companyNameInTitle("Ramp", "Tramp steamer logistics")).toBe(false);
  });
  it("is case-insensitive", () => {
    expect(companyNameInTitle("Ramp", "RAMP diligence sync")).toBe(true);
    expect(companyNameInTitle("ramp", "Ramp <> Acme Fund")).toBe(true);
  });
  it("treats punctuation as a boundary", () => {
    expect(companyNameInTitle("Ramp", "Ramp: seed discussion")).toBe(true);
    expect(companyNameInTitle("Ramp", "(Ramp) intro")).toBe(true);
  });
  it("escapes regex metacharacters in company names", () => {
    expect(companyNameInTitle("C++ Labs", "Intro to C++ Labs team")).toBe(true);
    expect(companyNameInTitle("A.I. Co", "Meeting with XAIYCo")).toBe(false);
  });
  it("ignores empty or one-character names", () => {
    expect(companyNameInTitle("", "Anything")).toBe(false);
    expect(companyNameInTitle("X", "X marks the spot")).toBe(false);
  });
});

describe("matchNoteToDeals", () => {
  it("CONFIRMS on an exact founder-email participant (0.95)", () => {
    const m = matchNoteToDeals(
      { participantEmails: ["alex@example.com", "alice@ramp.com"], title: "Weekly sync" },
      [deal()]
    );
    expect(m).toEqual({
      gid: "1001",
      confidence: 0.95,
      evidence: { kind: "attendee_email", value: "alice@ramp.com" },
      matchState: "confirmed",
    });
  });

  it("email matching is case-insensitive on both sides", () => {
    const m = matchNoteToDeals(
      { participantEmails: ["Alice@RAMP.com"], title: null },
      [deal({ founderEmails: ["ALICE@ramp.COM"] })]
    );
    expect(m?.confidence).toBe(0.95);
  });

  it("freemail participants still match on exact equality", () => {
    const m = matchNoteToDeals(
      { participantEmails: ["alicefounder@gmail.com"], title: "Coffee chat" },
      [deal({ founderEmails: ["alicefounder@gmail.com"] })]
    );
    expect(m?.evidence).toEqual({
      kind: "attendee_email",
      value: "alicefounder@gmail.com",
    });
  });

  it("suggests on a whole-word company mention in the title (0.8)", () => {
    const m = matchNoteToDeals(
      { participantEmails: ["someone@example.com"], title: "Ramp — partner meeting" },
      [deal({ founderEmails: [] })]
    );
    expect(m).toEqual({
      gid: "1001",
      confidence: 0.8,
      evidence: { kind: "title_company", value: "Ramp" },
      matchState: "suggested",
    });
  });

  it("does NOT suggest on a substring title hit", () => {
    const m = matchNoteToDeals(
      { participantEmails: [], title: "Trampoline Ventures catch-up" },
      [deal({ founderEmails: [] })]
    );
    expect(m).toBeNull();
  });

  it("returns null with no evidence", () => {
    const m = matchNoteToDeals(
      { participantEmails: ["stranger@nowhere.io"], title: "1:1 with Bob" },
      [deal()]
    );
    expect(m).toBeNull();
  });

  it("prefers the email match over a title match on another deal", () => {
    const m = matchNoteToDeals(
      { participantEmails: ["bob@acme.dev"], title: "Ramp intro" },
      [
        deal(), // "Ramp" appears in the title
        deal({ gid: "2002", companyName: "Acme", founderEmails: ["bob@acme.dev"] }),
      ]
    );
    expect(m?.gid).toBe("2002");
    expect(m?.confidence).toBe(0.95);
  });

  it("first deal in pipeline order wins an equal-confidence tie", () => {
    const m = matchNoteToDeals(
      { participantEmails: [], title: "Ramp x Acme joint call" },
      [
        deal({ founderEmails: [] }),
        deal({ gid: "2002", companyName: "Acme", founderEmails: [] }),
      ]
    );
    expect(m?.gid).toBe("1001");
  });

  it("handles empty company names, empty deals, and null titles safely", () => {
    expect(
      matchNoteToDeals(
        { participantEmails: ["a@b.co"], title: null },
        [deal({ companyName: "", founderEmails: [] })]
      )
    ).toBeNull();
    expect(matchNoteToDeals({ participantEmails: [], title: "Ramp" }, [])).toBeNull();
  });

  it("never matches on empty-string emails even if recorded on the deal", () => {
    const m = matchNoteToDeals(
      { participantEmails: [""], title: "" },
      [deal({ companyName: "", founderEmails: [""] })]
    );
    expect(m).toBeNull();
  });
});

describe("matchNoteToDeals — calendar and content tiers", () => {
  it("calendar linkage wins everything and confirms (0.98)", () => {
    const m = matchNoteToDeals(
      { participantEmails: [], title: "30 Minute Meeting", calendarDealGid: "1001" },
      [deal({ founderEmails: [] })]
    );
    expect(m).toEqual({
      gid: "1001",
      confidence: 0.98,
      evidence: { kind: "calendar_event", value: "1001" },
      matchState: "confirmed",
    });
  });

  it("a founder's full name in the body SUGGESTS when unique (the Calendly case)", () => {
    const m = matchNoteToDeals(
      {
        participantEmails: ["alex@example.com"],
        title: "30 Minute Meeting",
        body: "Met with Kavya Rao about the synthetic data platform. Strong ML background and a working prototype already deployed.",
      },
      [
        deal({
          gid: "prism",
          companyName: "Prism Intelligence",
          founderEmails: [],
          founderNames: ["Kavya Rao"],
        }),
        deal({ gid: "other", companyName: "Ramp", founderNames: ["Alice Chen"], founderEmails: [] }),
      ]
    );
    expect(m).toEqual({
      gid: "prism",
      confidence: 0.6,
      evidence: { kind: "content_founder", value: "Kavya Rao" },
      matchState: "suggested",
    });
  });

  it("a company name in the body SUGGESTS when unique", () => {
    const m = matchNoteToDeals(
      {
        participantEmails: [],
        title: "Intro chat",
        body: "Long discussion about how Prism Intelligence positions against incumbents in the space today.",
      },
      [
        deal({ gid: "prism", companyName: "Prism Intelligence", founderEmails: [], founderNames: [] }),
      ]
    );
    expect(m?.matchState).toBe("suggested");
    expect(m?.evidence.kind).toBe("content_company");
  });

  it("ambiguous body evidence never confirms — two deals, same founder name", () => {
    const pool = [
      deal({ gid: "a", companyName: "Alpha", founderNames: ["Jordan Lee"], founderEmails: [] }),
      deal({ gid: "b", companyName: "Beta", founderNames: ["Jordan Lee"], founderEmails: [] }),
    ];
    const m = matchNoteToDeals(
      { participantEmails: [], title: "Catch up", body: "Great chat with Jordan Lee about their new fund and hiring plans going into the fall." },
      pool
    );
    expect(m?.matchState ?? null).not.toBe("confirmed");
  });

  it("short bodies and short names never trigger content matching", () => {
    const m = matchNoteToDeals(
      { participantEmails: [], title: "Sync", body: "Ramp" },
      [deal({ founderEmails: [] })]
    );
    expect(m).toBeNull();
  });
});

describe("passed deals in the pool", () => {
  it("unique content only SUGGESTS onto a passed deal — collisions are real", () => {
    const m = matchNoteToDeals(
      {
        participantEmails: ["alex@example.com"],
        title: "30 Minute Meeting",
        body: "Debrief after passing: Kavya Rao walked through the updated data pipeline and the new pilot.",
      },
      [
        deal({
          gid: "prism",
          companyName: "Prism Intelligence",
          founderEmails: [],
          founderNames: ["Kavya Rao"],
          active: false,
        }),
      ]
    );
    expect(m?.matchState).toBe("suggested");
    expect(m?.gid).toBe("prism");
  });

  it("a title mention never SUGGESTS toward a passed deal", () => {
    const m = matchNoteToDeals(
      { participantEmails: [], title: "Ramp catch-up", body: "" },
      [deal({ founderEmails: [], active: false })]
    );
    expect(m).toBeNull();
  });
});

describe("matchNoteToDeals — domain, attendee-name, and title-founder tiers", () => {
  const acme = {
    gid: "100",
    name: "Jane Doe // Acme Robotics",
    companyName: "Acme Robotics",
    founderEmails: ["jane@acme.dev"],
    founderNames: ["Jane Doe"],
    domains: ["acme.dev"],
    active: true,
  };
  const acmeOld = { ...acme, gid: "99", name: "Jane Doe // Acme Robotics (2025)", active: false };
  const beta = {
    gid: "200",
    name: "Raj Patel // Beta Labs",
    companyName: "Beta Labs",
    founderEmails: ["raj@betalabs.io"],
    founderNames: ["Raj Patel"],
    domains: ["betalabs.io"],
    active: true,
  };

  it("a colleague on the company's domain confirms the one deal on that domain", () => {
    const m = matchNoteToDeals({ participantEmails: ["cto@acme.dev"], title: "Catch-up" }, [acme, beta]);
    expect(m?.gid).toBe("100");
    expect(m?.matchState).toBe("confirmed");
    expect(m?.evidence).toEqual({ kind: "attendee_domain", value: "acme.dev" });
  });

  it("two deals on one domain: the live one confirms when the other is closed", () => {
    const m = matchNoteToDeals({ participantEmails: ["ops@acme.dev"], title: "Sync" }, [acme, acmeOld]);
    expect(m?.gid).toBe("100");
    expect(m?.matchState).toBe("confirmed");
  });

  it("two live deals on one domain only suggest", () => {
    const twin = { ...acme, gid: "101", name: "Jane Doe // Acme Robotics II" };
    const m = matchNoteToDeals({ participantEmails: ["ops@acme.dev"], title: "Sync" }, [acme, twin]);
    expect(m?.matchState).toBe("suggested");
    expect(m?.confidence).toBe(0.7);
  });

  it("freemail and school domains never match anything", () => {
    const gmail = { ...acme, domains: [] };
    expect(matchNoteToDeals({ participantEmails: ["jane.doe@gmail.com"], title: "Hi" }, [gmail])).toBeNull();
    expect(matchNoteToDeals({ participantEmails: ["someone@stanford.edu"], title: "Hi" }, [gmail])).toBeNull();
  });

  it("a founder attending by name, with the company in the title, confirms", () => {
    const m = matchNoteToDeals(
      { participantEmails: [], participantNames: ["Jane Doe"], title: "Acme Robotics x Acme Fund" },
      [acme, beta]
    );
    expect(m?.gid).toBe("100");
    expect(m?.matchState).toBe("confirmed");
    expect(m?.evidence.kind).toBe("attendee_name");
  });

  it("a founder attending by name alone suggests", () => {
    const m = matchNoteToDeals(
      { participantEmails: [], participantNames: ["Raj Patel"], title: "Tuesday chat" },
      [acme, beta]
    );
    expect(m?.gid).toBe("200");
    expect(m?.matchState).toBe("suggested");
    expect(m?.confidence).toBe(0.82);
  });

  it("the founder's full name in the title suggests the deal", () => {
    const m = matchNoteToDeals({ participantEmails: [], title: "Intro: Raj Patel" }, [acme, beta]);
    expect(m?.gid).toBe("200");
    expect(m?.evidence).toEqual({ kind: "title_founder", value: "Raj Patel" });
  });

  it("a recorded founder address still outranks a domain match", () => {
    const m = matchNoteToDeals({ participantEmails: ["jane@acme.dev", "x@betalabs.io"], title: "" }, [acme, beta]);
    expect(m?.gid).toBe("100");
    expect(m?.evidence.kind).toBe("attendee_email");
  });
});
