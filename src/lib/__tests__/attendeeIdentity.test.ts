import { describe, expect, it } from "vitest";
import {
  attendeeIdentity,
  cleanDisplayName,
  nameFromLocalPart,
  clusterByCompany,
  looksLikeInvestorDomain,
} from "../attendeeIdentity";

describe("cleanDisplayName", () => {
  it("passes ordinary names through", () => {
    expect(cleanDisplayName("Mira Kapoor")).toBe("Mira Kapoor");
  });
  it("un-inverts 'Last, First'", () => {
    expect(cleanDisplayName("Kapoor, Mira")).toBe("Mira Kapoor");
  });
  it("rejects addresses posing as names and empty strings", () => {
    expect(cleanDisplayName("remy@larkai.com")).toBeNull();
    expect(cleanDisplayName("")).toBeNull();
    expect(cleanDisplayName("  ")).toBeNull();
  });
});

describe("nameFromLocalPart", () => {
  it("derives from dotted and underscored locals", () => {
    expect(nameFromLocalPart("remy.rosado@larkai.com")).toBe("Remy Rosado");
    expect(nameFromLocalPart("casey_morgan@college.harvard.edu")).toBe("Casey Morgan");
  });
  it("treats hyphens as separators, keeps apostrophes", () => {
    // '-' is a separator as often as it's part of a name; for a SUGGESTED
    // name the flattened form is fine, and matches localPartMatchesName.
    expect(nameFromLocalPart("mary-jane.o'hara@acme.com")).toBe("Mary Jane O'Hara");
  });
  it("refuses single tokens and initials — ambiguous forward", () => {
    expect(nameFromLocalPart("remy@larkai.com")).toBeNull();
    expect(nameFromLocalPart("rrosado@larkai.com")).toBeNull();
    expect(nameFromLocalPart("r.rosado@larkai.com")).toBeNull();
  });
  it("refuses role addresses outright", () => {
    for (const e of ["info@x.com", "hello.team@x.com", "no-reply@x.com"]) {
      expect(nameFromLocalPart(e)).toBeNull();
    }
  });
  it("drops numeric tokens", () => {
    expect(nameFromLocalPart("jane.doe99@x.com")).toBe("Jane Doe");
    expect(nameFromLocalPart("jlee22@gmail.com")).toBeNull();
  });
});

describe("attendeeIdentity", () => {
  it("display name outranks derivation", () => {
    const a = attendeeIdentity({ email: "rrosado@larkai.com", name: "Remy Rosado" });
    expect(a).toMatchObject({ name: "Remy Rosado", nameSource: "display", kind: "corporate" });
  });
  it("derives when the invite has no display name", () => {
    const a = attendeeIdentity({ email: "remy.rosado@larkai.com", name: "" });
    expect(a).toMatchObject({ name: "Remy Rosado", nameSource: "derived" });
  });
  it("a role address never becomes a person, even with a display name", () => {
    const a = attendeeIdentity({ email: "team@corvia.dev", name: "Team Corvia" });
    expect(a).toMatchObject({ name: null, nameSource: "none" });
  });
  it("rejects junk", () => {
    expect(attendeeIdentity({ email: "not-an-email" })).toBeNull();
  });
});

describe("clusterByCompany", () => {
  it("groups corporate attendees, ignores school and personal", () => {
    const ids = [
      { email: "a@corvia.dev", name: "A" },
      { email: "b@corvia.dev", name: "B" },
      { email: "c@gmail.com", name: "C" },
      { email: "d@college.harvard.edu", name: "D" },
    ].map((x) => attendeeIdentity(x)!);
    const clusters = clusterByCompany(ids);
    expect([...clusters.keys()]).toEqual(["corvia.dev"]);
    expect(clusters.get("corvia.dev")).toHaveLength(2);
  });
});

describe("looksLikeInvestorDomain", () => {
  it("flags funds by TLD and by name", () => {
    for (const d of [
      "boldstart.vc", "glasswing.vc", "neverlift.vc",
      "fprimecapital.com", "commonwealventures.com", "maxventures.vc",
    ]) {
      expect(looksLikeInvestorDomain(d)).toBe(true);
    }
  });
  it("leaves startups alone", () => {
    for (const d of ["larkai.com", "pemberly.co", "corvia.dev", "launchyard.xyz"]) {
      expect(looksLikeInvestorDomain(d)).toBe(false);
    }
  });
});
