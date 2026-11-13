import { describe, expect, it } from "vitest";
import {
  mentionsPhrase,
  namesAgree,
  normalizeLinkedInUrl,
  schoolSearchValues,
  schoolVariants,
  scoreLinkedInCandidates,
  shouldRunResearchFallback,
  slugMatchesName,
  splitName,
  validatePersonInputs,
  verificationGate,
} from "../networkRules";

describe("normalizeLinkedInUrl (Identity Agent)", () => {
  it("canonicalizes variants to one form", () => {
    const want = "https://www.linkedin.com/in/maya-chen";
    expect(normalizeLinkedInUrl("https://www.linkedin.com/in/maya-chen/")).toBe(want);
    expect(normalizeLinkedInUrl("http://linkedin.com/in/Maya-Chen?utm=x&ref=y")).toBe(want);
    expect(normalizeLinkedInUrl("linkedin.com/in/maya-chen#about")).toBe(want);
    expect(normalizeLinkedInUrl("  www.linkedin.com/in/maya-chen  ")).toBe(want);
  });

  it("rejects non-profile and non-linkedin URLs", () => {
    expect(normalizeLinkedInUrl("https://linkedin.com/company/anduril")).toBeNull();
    expect(normalizeLinkedInUrl("https://twitter.com/in/maya")).toBeNull();
    expect(normalizeLinkedInUrl("not a url at all")).toBeNull();
    expect(normalizeLinkedInUrl("")).toBeNull();
  });
});

describe("validatePersonInputs", () => {
  const good = {
    name: "Maya Chen",
    school: "Harvard",
    gradYear: 2027,
    linkedinUrl: "linkedin.com/in/maya-chen",
  };
  it("accepts a complete record", () => {
    expect(validatePersonInputs(good)).toBeNull();
  });
  it("accepts the minimal record: name and school only", () => {
    expect(validatePersonInputs({ name: "Maya Chen", school: "Harvard" })).toBeNull();
    expect(
      validatePersonInputs({
        name: "Maya Chen",
        school: "Harvard",
        gradYear: null,
        linkedinUrl: "",
      })
    ).toBeNull();
  });
  it("rejects missing mandatory fields", () => {
    expect(validatePersonInputs({ ...good, name: " " })).toContain("Name");
    expect(validatePersonInputs({ ...good, school: "" })).toContain("School");
  });
  it("validates the optional fields only when provided", () => {
    expect(validatePersonInputs({ ...good, gradYear: 27 })).toContain("year");
    expect(validatePersonInputs({ ...good, linkedinUrl: "x.com/a" })).toContain("LinkedIn");
  });
});

describe("verificationGate (Agent 7, deterministic)", () => {
  const base = {
    providerMatched: true,
    providerName: "Maya Chen",
    enteredName: "Maya Chen",
    currentTitle: "Engineer",
    currentOrganization: "Anduril",
    interests: [
      { tag: "AI", confidence: 0.9 },
      { tag: "Defense", confidence: 0.8 },
    ],
    webOrganization: null,
  };

  it("approves the clean case", () => {
    expect(verificationGate(base).status).toBe("ready");
  });

  it("flags a name conflict for review", () => {
    const g = verificationGate({ ...base, providerName: "Someone Else" });
    expect(g.status).toBe("needs_review");
  });

  it("tolerates name variations (maiden/married/middle)", () => {
    expect(
      verificationGate({ ...base, providerName: "Maya R. Chen" }).status
    ).toBe("ready");
  });

  it("flags provider-vs-web org disagreement", () => {
    const g = verificationGate({ ...base, webOrganization: "Palantir" });
    expect(g.status).toBe("needs_review");
  });

  it("marks partial when the role is missing", () => {
    const g = verificationGate({ ...base, currentTitle: null });
    expect(g.status).toBe("partial");
  });

  it("marks partial with weak interests", () => {
    const g = verificationGate({
      ...base,
      interests: [{ tag: "AI", confidence: 0.5 }],
    });
    expect(g.status).toBe("partial");
  });

  it("marks partial (not review) when the provider had no match", () => {
    const g = verificationGate({
      ...base,
      providerMatched: false,
      providerName: "",
    });
    expect(g.status).toBe("partial");
  });
});

describe("research fallback trigger (Agent 6 conditions)", () => {
  it("runs when the provider missed", () => {
    expect(
      shouldRunResearchFallback({
        providerMatched: false,
        currentTitle: null,
        currentOrganization: null,
        interests: [],
      })
    ).toBe(true);
  });
  it("runs when interests are weak", () => {
    expect(
      shouldRunResearchFallback({
        providerMatched: true,
        currentTitle: "Engineer",
        currentOrganization: "Anduril",
        interests: [{ tag: "AI", confidence: 0.5 }],
      })
    ).toBe(true);
  });
  it("skips when the profile is solid", () => {
    expect(
      shouldRunResearchFallback({
        providerMatched: true,
        currentTitle: "Engineer",
        currentOrganization: "Anduril",
        interests: [{ tag: "AI", confidence: 0.9 }],
      })
    ).toBe(false);
  });
});

describe("LinkedIn finder inputs (schoolSearchValues, splitName, slug)", () => {
  it("expands short school names to search entities", () => {
    expect(schoolSearchValues("Harvard")).toEqual(["Harvard", "Harvard University"]);
    expect(schoolSearchValues("MIT")).toContain("Massachusetts Institute of Technology");
    expect(schoolSearchValues("Unknown")).toEqual([]);
    expect(schoolSearchValues("Stanford University")).toEqual(["Stanford University"]);
  });
  it("splits names into first and last", () => {
    expect(splitName("Jane Q. Doe")).toEqual({ first: "Jane", last: "Doe" });
    expect(splitName("Cher")).toEqual({ first: "Cher", last: "Cher" });
  });
  it("recognizes names in vanity slugs", () => {
    expect(slugMatchesName("https://www.linkedin.com/in/ninayeechen", "Nina Chen")).toBe(true);
    expect(slugMatchesName("https://www.linkedin.com/in/acwaadqr-x9", "Nina Chen")).toBe(false);
  });
});

describe("scoreLinkedInCandidates (deterministic identity scoring)", () => {
  const nina = { name: "Nina Chen", school: "Harvard", gradYear: 2025, company: null };
  const hits = [
    { url: "https://www.linkedin.com/in/ninayeechen", name: "Nina Chen", headline: "Harvard '25", eduYears: [2025, 2021] },
    { url: "https://www.linkedin.com/in/ninaalisachen", name: "Nina Chen", headline: "Corp Dev at ServiceNow", eduYears: [2023] },
    { url: "https://www.linkedin.com/in/nina-chen-440424364", name: "Nina Chen", headline: "Student at Harvard University", eduYears: [2028] },
  ];

  it("grad-year match separates look-alikes and reaches auto-adopt", () => {
    const scored = scoreLinkedInCandidates(nina, hits);
    expect(scored[0].url).toBe("https://www.linkedin.com/in/ninayeechen");
    expect(scored[0].confidence).toBeGreaterThanOrEqual(0.8);
    expect(scored[0].confidence - scored[1].confidence).toBeGreaterThanOrEqual(0.1);
  });

  it("near-tied look-alikes are capped below auto-adopt", () => {
    const twins = scoreLinkedInCandidates(nina, [
      { ...hits[0] },
      { ...hits[0], url: "https://www.linkedin.com/in/nina-chen-2" },
    ]);
    expect(twins[0].confidence).toBeLessThan(0.8);
    expect(twins[1].confidence).toBeLessThan(0.8);
  });

  it("a lone candidate gets a bonus; wrong names are dropped", () => {
    const lone = scoreLinkedInCandidates(nina, [
      hits[0],
      { url: "https://www.linkedin.com/in/john-harvard", name: "John Harvard", headline: "", eduYears: [2025] },
    ]);
    expect(lone).toHaveLength(1);
    expect(lone[0].confidence).toBeGreaterThanOrEqual(0.9);
  });

  it("company in the headline counts as evidence", () => {
    const scored = scoreLinkedInCandidates(
      { name: "Nina Chen", gradYear: null, company: "ServiceNow" },
      hits
    );
    expect(scored[0].url).toBe("https://www.linkedin.com/in/ninaalisachen");
  });

  it("matches the school across its long and short names", () => {
    const evidence = [
      { url: "https://www.linkedin.com/in/arjun-mehta", name: "Arjun Mehta", headline: "Yale '26", eduYears: [2026] },
    ];
    // Record holds the long form, the profile shows the short one.
    const long = scoreLinkedInCandidates(
      { name: "Arjun Mehta", school: "Yale University", gradYear: null, company: null },
      evidence
    );
    // ...and the reverse, via the canonical map.
    const short = scoreLinkedInCandidates(
      { name: "Arjun Mehta", school: "MIT", gradYear: null, company: null },
      [{ ...evidence[0], headline: "Massachusetts Institute of Technology, 2026" }]
    );
    expect(long[0].confidence).toBeGreaterThanOrEqual(0.8);
    expect(short[0].confidence).toBeGreaterThanOrEqual(0.8);
  });

  it("does not accept a school or company hiding inside a longer word", () => {
    const smith = scoreLinkedInCandidates(
      { name: "Arjun Mehta", school: "MIT", gradYear: null, company: null },
      [{ url: "https://www.linkedin.com/in/x1", name: "Arjun Mehta", headline: "Smith College", eduYears: [] }]
    );
    const rescue = scoreLinkedInCandidates(
      { name: "Arjun Mehta", school: null, gradYear: null, company: "Cue" },
      [{ url: "https://www.linkedin.com/in/x2", name: "Arjun Mehta", headline: "Works on rescue robotics", eduYears: [] }]
    );
    // 0.35 base + 0.15 slug + 0.15 lone-candidate, and nothing else.
    expect(smith[0].confidence).toBeLessThan(0.8);
    expect(rescue[0].confidence).toBeLessThan(0.8);
  });

  it("degree breaks a tie between otherwise identical classmates", () => {
    const twins = [
      { url: "https://www.linkedin.com/in/arjun-mehta-1", name: "Arjun Mehta", headline: "Yale University, BA Economics", eduYears: [2026] },
      { url: "https://www.linkedin.com/in/arjun-mehta-2", name: "Arjun Mehta", headline: "Yale University, BS Computer Science", eduYears: [2026] },
    ];
    const scored = scoreLinkedInCandidates(
      { name: "Arjun Mehta", school: "Yale", degree: "BS Computer Science", gradYear: 2026, company: null },
      twins
    );
    expect(scored[0].url).toBe("https://www.linkedin.com/in/arjun-mehta-2");
  });
});

describe("schoolVariants", () => {
  it("expands short names, contracts long ones, ignores unknown", () => {
    expect(schoolVariants("Yale University")).toContain("Yale");
    expect(schoolVariants("mit")).toContain("Massachusetts Institute of Technology");
    expect(schoolVariants("unknown")).toEqual([]);
  });
});

describe("mentionsPhrase", () => {
  it("matches whole phrases only", () => {
    expect(mentionsPhrase("student at Yale '26", "Yale")).toBe(true);
    expect(mentionsPhrase("Smith College", "MIT")).toBe(false);
    expect(mentionsPhrase("rescue robotics", "Cue")).toBe(false);
    expect(mentionsPhrase("Corp Dev at ServiceNow.", "ServiceNow")).toBe(true);
  });
});

describe("namesAgree", () => {
  it("shares surname → agree", () => {
    expect(namesAgree("Maya Chen", "Maya R. Chen")).toBe(true);
  });
  it("different people → disagree", () => {
    expect(namesAgree("Maya Chen", "John Harvard")).toBe(false);
  });
});
