import { describe, expect, it } from "vitest";
import {
  companyFromDealName,
  composeNotes,
  extractFounders,
  founderNamesFromDealName,
  foundersFromDeal,
  linkedInDateToIso,
  parseFounderLine,
} from "../founders";

describe("linkedInDateToIso", () => {
  it("converts LinkedIn month-year strings", () => {
    expect(linkedInDateToIso("Mar 2022")).toBe("2022-03");
    expect(linkedInDateToIso("september 2019")).toBe("2019-09");
    expect(linkedInDateToIso("2021")).toBe("2021");
  });
  it("Present and empty mean an open-ended date", () => {
    expect(linkedInDateToIso("Present")).toBeNull();
    expect(linkedInDateToIso("")).toBeNull();
    expect(linkedInDateToIso(null)).toBeNull();
  });
  it("salvages a year from noisy text, else null", () => {
    expect(linkedInDateToIso("Jun 2020 · 2 yrs")).toBe("2020");
    expect(linkedInDateToIso("gibberish")).toBeNull();
  });
});

describe("parseFounderLine", () => {
  it("parses name — school — linkedin", () => {
    expect(
      parseFounderLine("• Jane Doe — Harvard — https://www.linkedin.com/in/janedoe")
    ).toEqual({
      name: "Jane Doe",
      school: "Harvard",
      linkedin: "https://www.linkedin.com/in/janedoe",
      email: "",
    });
  });
  it("handles missing school or linkedin in any order", () => {
    expect(parseFounderLine("• Jane Doe — linkedin.com/in/janedoe")).toEqual({
      name: "Jane Doe",
      school: "",
      linkedin: "linkedin.com/in/janedoe",
      email: "",
    });
    expect(parseFounderLine("• Jane Doe — MIT")).toEqual({
      name: "Jane Doe",
      school: "MIT",
      linkedin: "",
      email: "",
    });
    expect(parseFounderLine("• Jane Doe")).toEqual({
      name: "Jane Doe",
      school: "",
      linkedin: "",
      email: "",
    });
  });
  it("tolerates hyphen separators from hand-edited notes", () => {
    expect(parseFounderLine("- Jane Doe - Yale")).toEqual({
      name: "Jane Doe",
      school: "Yale",
      linkedin: "",
      email: "",
    });
  });
  it("keeps hyphenated names intact", () => {
    expect(parseFounderLine("• Mary-Kate Olsen — Penn")).toEqual({
      name: "Mary-Kate Olsen",
      school: "Penn",
      linkedin: "",
      email: "",
    });
  });
  it("rejects link-list bullets that lead with a URL", () => {
    expect(parseFounderLine("• http://www.linkedin.com/in/acshi/ (CTO)")).toBeNull();
    expect(parseFounderLine("• www.example.com/team")).toBeNull();
  });
});

describe("extractFounders / composeNotes round-trip", () => {
  const notes = [
    "Raising: $1M (Pre-Seed)",
    "",
    "Great team, met at demo day.",
    "",
    "Founders:",
    "• Jane Doe — Harvard — https://www.linkedin.com/in/janedoe",
    "• Bo Chen — MIT",
  ].join("\n");

  it("splits the block from the freeform text", () => {
    const { founders, rest } = extractFounders(notes);
    expect(founders).toHaveLength(2);
    expect(founders[0].name).toBe("Jane Doe");
    expect(founders[1]).toEqual({ name: "Bo Chen", school: "MIT", linkedin: "", email: "" });
    expect(rest).toBe("Raising: $1M (Pre-Seed)\n\nGreat team, met at demo day.");
  });

  it("round-trips without duplicating the block", () => {
    const { founders, rest } = extractFounders(notes);
    const recomposed = composeNotes(rest, founders);
    const again = extractFounders(recomposed);
    expect(again.founders).toEqual(founders);
    expect(again.rest).toBe(rest);
  });

  it("handles notes with no founders block", () => {
    const { founders, rest } = extractFounders("Just some notes.");
    expect(founders).toEqual([]);
    expect(rest).toBe("Just some notes.");
    expect(composeNotes(rest, [])).toBe("Just some notes.");
  });

  it("drops empty-name rows when composing", () => {
    expect(
      composeNotes("x", [{ name: " ", school: "Harvard", linkedin: "", email: "" }])
    ).toBe("x");
  });

  it("leaves link-list 'Founders:' blocks in the notes untouched", () => {
    const linkList =
      "Cohort intros.\n\nFounders:\n• http://linkedin.com/in/a (CEO)\n• http://linkedin.com/in/b (CTO)";
    const { founders, rest } = extractFounders(linkList);
    expect(founders).toEqual([]);
    expect(rest).toContain("Founders:");
    expect(rest).toContain("http://linkedin.com/in/a (CEO)");
    expect(rest).toContain("http://linkedin.com/in/b (CTO)");
  });
});

describe("companyFromDealName", () => {
  it("takes the part after //", () => {
    expect(companyFromDealName("Jane Doe, Bo Chen // Acme")).toBe("Acme");
  });
  it("passes plain names through", () => {
    expect(companyFromDealName("Acme")).toBe("Acme");
  });
});

describe("founderNamesFromDealName", () => {
  it("splits multi-founder titles on comma, &, and 'and'", () => {
    expect(founderNamesFromDealName("Jane Doe, Bo Chen // Acme")).toEqual([
      "Jane Doe",
      "Bo Chen",
    ]);
    expect(founderNamesFromDealName("Jane Doe & Bo Chen // Acme")).toEqual([
      "Jane Doe",
      "Bo Chen",
    ]);
    expect(founderNamesFromDealName("Jane Doe and Bo Chen // Acme")).toEqual([
      "Jane Doe",
      "Bo Chen",
    ]);
  });
  it("returns nothing without the // convention", () => {
    expect(founderNamesFromDealName("Acme")).toEqual([]);
  });
  it("rejects single words and non-name junk", () => {
    expect(founderNamesFromDealName("Stealth // Acme")).toEqual([]);
    expect(founderNamesFromDealName("Team of 5 // Acme")).toEqual([]);
  });
});

describe("foundersFromDeal (the deal-card helper)", () => {
  it("prefers the structured notes block", () => {
    const rows = foundersFromDeal({
      name: "Jane Doe // Acme",
      notes: "Notes.\n\nFounders:\n• Jane Doe — Harvard — https://www.linkedin.com/in/janedoe",
      schools: ["Yale"],
    });
    expect(rows).toEqual([
      {
        name: "Jane Doe",
        school: "Harvard",
        linkedin: "https://www.linkedin.com/in/janedoe",
        email: "",
      },
    ]);
  });

  it("falls back to title names + solo school tag + lone LinkedIn URL", () => {
    const rows = foundersFromDeal({
      name: "Jane Doe // Acme",
      notes: "Met at demo day. https://www.linkedin.com/in/janedoe is her profile.",
      schools: ["Harvard"],
    });
    expect(rows).toEqual([
      {
        name: "Jane Doe",
        school: "Harvard",
        linkedin: "https://www.linkedin.com/in/janedoe",
        email: "",
      },
    ]);
  });

  it("gives one row per founder and never guesses ambiguous fields", () => {
    const rows = foundersFromDeal({
      name: "Jane Doe, Bo Chen // Acme",
      notes: "Only one URL here: https://www.linkedin.com/in/janedoe",
      schools: ["Harvard", "MIT"],
    });
    expect(rows).toHaveLength(2);
    // Two founders, one URL → can't know whose; two schools → can't know whose.
    expect(rows.every((r) => r.linkedin === "" && r.school === "")).toBe(true);
  });

  it("merges title names with a partial notes block", () => {
    const rows = foundersFromDeal({
      name: "Jane Doe, Bo Chen // Acme",
      notes: "Founders:\n• Jane Doe — Harvard",
      schools: [],
    });
    expect(rows.map((r) => r.name)).toEqual(["Jane Doe", "Bo Chen"]);
    expect(rows[0].school).toBe("Harvard");
    expect(rows[1].school).toBe("");
  });
});
