import { describe, expect, it } from "vitest";
import {
  assembleContextBudget,
  defaultPassBody,
  isThinContext,
  missingContextFields,
  parseCcList,
  passLengthBand,
  defaultPassSubject,
  passDraftProblem,
  scrubPassDraft,
  selectPassDecision,
  unresolvedPlaceholders,
} from "../passEmailPure";

describe("default pass note", () => {
  it("fills name, company, and sender when known", () => {
    const body = defaultPassBody({
      founderName: "Kavya",
      companyName: "Prism Intelligence",
      senderFirstName: "Alex",
    });
    expect(body).toContain("Hi Kavya,");
    expect(body).toContain("building at Prism Intelligence.");
    expect(body).toContain("Rooting for you,\nAlex");
    expect(unresolvedPlaceholders(body)).toEqual([]);
  });
  it("keeps placeholders visible when uncertain — never guesses", () => {
    const body = defaultPassBody({
      founderName: null,
      companyName: null,
      senderFirstName: "Alex",
    });
    expect(body).toContain("Hi [Name],");
    expect(unresolvedPlaceholders(body)).toEqual(["[Name]", "[Company]"]);
    expect(defaultPassSubject(null)).toBe("Following up on [Company]");
  });
});

describe("send validation", () => {
  const good = {
    to: "jane@acme.dev",
    subject: "Following up on Acme",
    body: "Hi Jane,\n\nThanks. We're passing.\n\nBest,\nAlex",
  };
  it("a complete draft passes", () => {
    expect(passDraftProblem(good)).toBeNull();
  });
  it("blocks missing or invalid recipients and names the broken piece", () => {
    expect(passDraftProblem({ ...good, to: "" })).toMatch(/recipient/i);
    expect(passDraftProblem({ ...good, to: "not-an-email" })).toContain("not-an-email");
  });
  it("accepts several recipients, caps at five", () => {
    expect(
      passDraftProblem({ ...good, to: "a@b.co, c@d.co, e@f.co" })
    ).toBeNull();
    expect(
      passDraftProblem({
        ...good,
        to: "a@b.co, c@d.co, e@f.co, g@h.co, i@j.co, k@l.co",
      })
    ).toMatch(/more than 5/i);
  });
  it("blocks empty subject and body", () => {
    expect(passDraftProblem({ ...good, subject: " " })).toMatch(/subject/i);
    expect(passDraftProblem({ ...good, body: "" })).toMatch(/empty/i);
  });
  it("blocks unresolved placeholders and names them", () => {
    const p = passDraftProblem({ ...good, body: "Hi [Name], we pass." });
    expect(p).toContain("[Name]");
  });
});

describe("scrub", () => {
  it("removes em and en dashes", () => {
    expect(scrubPassDraft("bold vision — strong team – onward")).toBe(
      "bold vision, strong team, onward"
    );
  });
  it("drops lines that leak internal addresses", () => {
    const out = scrubPassDraft("Hi Jane,\nAs ajordan@example.com noted internally, weak metrics.\nBest,\nAlex");
    expect(out).not.toContain("example.com");
    expect(out).toContain("Hi Jane,");
  });
  it("strips unknown bracket tokens but keeps the two placeholders", () => {
    const out = scrubPassDraft("Hi [Name], [internal: score 3/10] welcome to [Company].");
    expect(out).toContain("[Name]");
    expect(out).toContain("[Company]");
    expect(out).not.toContain("score 3/10");
  });

  it("strips banned house-style words mid-sentence", () => {
    expect(scrubPassDraft("It's genuinely hard to evaluate this early.")).toBe(
      "It's hard to evaluate this early."
    );
    expect(scrubPassDraft("We were incredibly impressed by the demo.")).toBe(
      "We were impressed by the demo."
    );
  });

  it("re-capitalizes when the removed word opened a sentence — no dangling comma", () => {
    expect(scrubPassDraft("Hi Jane,\n\nTruly, we admire the effort.")).toBe(
      "Hi Jane,\n\nWe admire the effort."
    );
    expect(scrubPassDraft("Genuinely, this is a hard market.")).toBe(
      "This is a hard market."
    );
  });

  it("a banned word at the very end of the text is just dropped", () => {
    expect(scrubPassDraft("The team seemed excited")).toBe("The team seemed");
  });

  it("is a real regression case: caught a live model output using a banned word anyway", () => {
    // Verified against an actual Claude response during Step 7 testing —
    // the prompt's own ban and self-check still let this through once.
    const out = scrubPassDraft(
      "Consumer and community social mechanics are genuinely hard to evaluate early, and we may be the wrong investors for this moment."
    );
    expect(out).not.toContain("genuinely");
    expect(out).toBe(
      "Consumer and community social mechanics are hard to evaluate early, and we may be the wrong investors for this moment."
    );
  });
});

describe("selectPassDecision (context priority — Case 6, conflicting context)", () => {
  it("the most recent pass decision is authoritative", () => {
    const { current } = selectPassDecision([
      { decision: "diligence", rationale: "excited about the wedge", createdAt: "2026-06-01T00:00:00Z" },
      { decision: "pass", rationale: "valuation doesn't work at this stage", createdAt: "2026-07-01T00:00:00Z" },
    ]);
    expect(current?.rationale).toBe("valuation doesn't work at this stage");
  });

  it("earlier enthusiasm is demoted to superseded, never treated as current", () => {
    const { current, superseded } = selectPassDecision([
      { decision: "pass", rationale: "market too early", createdAt: "2026-07-01T00:00:00Z" },
      { decision: "diligence", rationale: "loved the team", createdAt: "2026-06-01T00:00:00Z" },
      { decision: "watch", rationale: "keep an eye on traction", createdAt: "2026-05-01T00:00:00Z" },
    ]);
    expect(current?.decision).toBe("pass");
    expect(superseded.map((d) => d.decision)).toEqual(["diligence", "watch"]);
  });

  it("caps superseded history at 2 even with a long tail", () => {
    const { superseded } = selectPassDecision([
      { decision: "pass", rationale: "no fit", createdAt: "2026-07-04T00:00:00Z" },
      { decision: "watch", rationale: "a", createdAt: "2026-07-03T00:00:00Z" },
      { decision: "watch", rationale: "b", createdAt: "2026-07-02T00:00:00Z" },
      { decision: "watch", rationale: "c", createdAt: "2026-07-01T00:00:00Z" },
    ]);
    expect(superseded).toHaveLength(2);
  });

  it("no pass decision yet: falls back to recent history as background only", () => {
    const { current, superseded } = selectPassDecision([
      { decision: "diligence", rationale: "interested", createdAt: "2026-07-01T00:00:00Z" },
    ]);
    expect(current).toBeNull();
    expect(superseded).toHaveLength(1);
  });

  it("no decisions at all", () => {
    expect(selectPassDecision([])).toEqual({ current: null, superseded: [] });
  });

  it("a send flow's own auto-logged record is never treated as a real reason", () => {
    // The exact string sendPassEmail() writes after sending — confirmed
    // against production data, where every single recorded 'pass' decision
    // is this bookkeeping string, never a human-typed rationale.
    const { current, superseded } = selectPassDecision([
      { decision: "pass", rationale: "Pass note sent to founder@acme.com.", createdAt: "2026-07-01T00:00:00Z" },
    ]);
    expect(current).toBeNull();
    expect(superseded).toHaveLength(1);
  });

  it("falls through an auto-logged pass to find an older real reason", () => {
    const { current } = selectPassDecision([
      { decision: "pass", rationale: "Pass note sent to founder@acme.com.", createdAt: "2026-07-02T00:00:00Z" },
      { decision: "pass", rationale: "valuation got ahead of the traction", createdAt: "2026-07-01T00:00:00Z" },
    ]);
    expect(current?.rationale).toBe("valuation got ahead of the traction");
  });
});

describe("passLengthBand (Cases 1 and 2, length calibration)", () => {
  it("an introductory call gets the short band", () => {
    const band = passLengthBand({ meetingCount: 1, emailCount: 2, extensiveDiligence: false });
    expect(band).toEqual({ min: 140, max: 230, label: "an introductory call" });
  });

  it("extensive diligence gets the long band", () => {
    const band = passLengthBand({ meetingCount: 4, emailCount: 10, extensiveDiligence: true });
    expect(band.min).toBe(350);
    expect(band.max).toBe(550);
  });

  it("a brief or out-of-scope inbound gets the shortest band", () => {
    const band = passLengthBand({ meetingCount: 0, emailCount: 0, extensiveDiligence: false });
    expect(band).toEqual({ min: 80, max: 140, label: "a brief or out-of-scope interaction" });
  });

  it("multiple meetings without a formal diligence flag still gets the mid band", () => {
    const band = passLengthBand({ meetingCount: 2, emailCount: 3, extensiveDiligence: false });
    expect(band.min).toBe(220);
    expect(band.max).toBe(350);
  });
});

describe("isThinContext and missingContextFields (Case 5, thin context)", () => {
  const richSignals = {
    hasPassReason: true,
    hasCompanyFacts: true,
    hasMeetings: true,
    hasEmailHistory: true,
    hasFounderName: true,
    hasCompanyName: true,
  };

  it("company name and founder name only, nothing else: thin", () => {
    expect(
      isThinContext({
        hasPassReason: false,
        hasCompanyFacts: false,
        hasMeetings: false,
        hasEmailHistory: false,
        hasFounderName: true,
        hasCompanyName: true,
      })
    ).toBe(true);
  });

  it("a recorded pass reason alone is enough, even with nothing else", () => {
    expect(
      isThinContext({
        hasPassReason: true,
        hasCompanyFacts: false,
        hasMeetings: false,
        hasEmailHistory: false,
        hasFounderName: true,
        hasCompanyName: true,
      })
    ).toBe(false);
  });

  it("company facts alone, without a formal decision, is enough to ground a note", () => {
    expect(
      isThinContext({
        hasPassReason: false,
        hasCompanyFacts: true,
        hasMeetings: false,
        hasEmailHistory: false,
        hasFounderName: true,
        hasCompanyName: true,
      })
    ).toBe(false);
  });

  it("missing the founder or company name is always thin, regardless of everything else", () => {
    expect(isThinContext({ ...richSignals, hasFounderName: false })).toBe(true);
    expect(isThinContext({ ...richSignals, hasCompanyName: false })).toBe(true);
  });

  it("a fully rich context is never thin", () => {
    expect(isThinContext(richSignals)).toBe(false);
  });

  it("missing fields are named in the spec's own order", () => {
    const missing = missingContextFields({
      hasPassReason: false,
      hasCompanyFacts: false,
      hasMeetings: false,
      hasEmailHistory: false,
      hasFounderName: false,
      hasCompanyName: false,
    });
    expect(missing).toEqual([
      "primary pass reason",
      "evidence supporting the reason",
      "founder name",
      "company name",
      "relationship stage",
    ]);
  });

  it("a rich context has nothing missing", () => {
    expect(missingContextFields(richSignals)).toEqual([]);
  });
});

describe("assembleContextBudget", () => {
  it("keeps everything when it all fits", () => {
    const out = assembleContextBudget(
      [
        { label: "decision", text: "the decision", priority: 0 },
        { label: "company", text: "company facts", priority: 5 },
      ],
      1000
    );
    expect(out).toContain("the decision");
    expect(out).toContain("company facts");
  });

  it("drops the lowest-priority sections first under pressure", () => {
    const sections = [
      { label: "decision", text: "D".repeat(50), priority: 0 },
      { label: "company", text: "C".repeat(50), priority: 5 },
      { label: "research", text: "R".repeat(50), priority: 1 },
    ];
    const out = assembleContextBudget(sections, 120);
    expect(out).toContain("D".repeat(50));
    expect(out).toContain("C".repeat(50));
    expect(out).not.toContain("R".repeat(50));
  });

  it("never drops the decision even when it alone exceeds the budget", () => {
    const out = assembleContextBudget(
      [
        { label: "decision", text: "D".repeat(200), priority: 0 },
        { label: "company", text: "C".repeat(50), priority: 5 },
      ],
      50
    );
    expect(out).toContain("D".repeat(200));
  });

  it("empty sections are skipped without affecting the budget", () => {
    const out = assembleContextBudget(
      [
        { label: "decision", text: "kept", priority: 0 },
        { label: "empty", text: "   ", priority: 5 },
      ],
      1000
    );
    expect(out.trim()).toBe("kept");
  });
});

describe("parseCcList", () => {
  it("splits, trims, lowers, dedupes", () => {
    const { emails, invalid } = parseCcList("deals@example.com, Ajordan@example.com; deals@example.com");
    expect(emails).toEqual(["deals@example.com", "ajordan@example.com"]);
    expect(invalid).toEqual([]);
  });
  it("names the broken pieces and keeps the good ones", () => {
    const { emails, invalid } = parseCcList("deals@example.com, not-an-address");
    expect(emails).toEqual(["deals@example.com"]);
    expect(invalid).toEqual(["not-an-address"]);
  });
  it("empty input is fine", () => {
    expect(parseCcList("")).toEqual({ emails: [], invalid: [] });
  });
});
