import { describe, expect, it } from "vitest";
import {
  companyNameFromDomain,
  isServiceAccount,
  isGenericDomain,
  domainOf,
  looksLikeGrant,
  spanInSource,
  seedPeople,
  validateExtraction,
  summaryLine,
  REVIEW_EXTRACT_VERSION,
  type XPerson,
} from "../meetingReviewPure";

const INTERNAL = /@example\.com$/i;

// Representative of the Onyxite meeting, not hardcoded to it.
const SOURCE = [
  "Erik walked through Onyxite's semiconductor authentication platform.",
  "They won a $34M NIST CRDP award last year for counterfeit detection.",
  "Now raising $3M–$5M in SAFEs targeting mid-October to bridge to the CRDP program.",
  "Adam runs GTM; Ari Stone advises on government sales.",
].join("\n");

const seeds = () =>
  seedPeople(
    [
      { name: "Erik Holden", email: "erik@onyxitesemi.com" },
      { name: "Alex Morgan", email: "alex@example.com" },
      { name: null, email: "calendar-notification@group.calendar.google.com" },
    ],
    INTERNAL
  );

describe("seedPeople", () => {
  it("keeps externals, drops internals and service accounts", () => {
    const s = seeds();
    expect(s).toHaveLength(1);
    expect(s[0].name).toBe("Erik Holden");
    expect(s[0].fromCalendar).toBe(true);
  });
});

describe("helpers", () => {
  it("classifies domains and services", () => {
    expect(domainOf("a@b.co")).toBe("b.co");
    expect(isGenericDomain("gmail.com")).toBe(true);
    expect(isGenericDomain("onyxitesemi.com")).toBe(false);
    expect(isServiceAccount("noreply@zoom.us")).toBe(true);
  });
  it("prettifies email localparts into names", async () => {
    const { prettyLocalPart } = await import("../meetingReviewPure");
    expect(prettyLocalPart("avery.stone")).toBe("Avery Stone");
    expect(prettyLocalPart("jane_doe-x")).toBe("Jane Doe X");
    expect(prettyLocalPart("armaansethi")).toBe("Armaansethi");
    const seeded = seedPeople([{ name: null, email: "avery.stone@college.harvard.edu" }], INTERNAL);
    expect(seeded[0].name).toBe("Avery Stone");
  });
  it("flags grant-like money", () => {
    expect(looksLikeGrant("$34M NIST CRDP award")).toBe(true);
    expect(looksLikeGrant("raising $3M–$5M in SAFEs")).toBe(false);
  });
  it("matches spans loosely on whitespace and case", () => {
    expect(spanInSource("RAISING  $3M–$5M in safes", SOURCE)).toBe(true);
    expect(spanInSource("raising $50M priced round", SOURCE)).toBe(false);
  });
  it("normalizes curly quotes and dashes both directions", () => {
    expect(spanInSource("Onyxite's problem statement", "the origin of Onyxite’s problem statement")).toBe(true);
    expect(spanInSource("raising $3M-$5M in SAFEs", SOURCE)).toBe(true);
  });
});

describe("validateExtraction", () => {
  it("keeps a real raise verbatim as a range and drops nothing silently", () => {
    const x = validateExtraction(
      {
        company: {
          name: "Onyxite",
          domain: "onyxitesemi.com",
          description: "Semiconductor authentication",
          evidence: "Onyxite's semiconductor authentication platform",
        },
        financing: {
          amount: "$3M–$5M",
          security: "SAFE",
          status: "planned",
          targetClose: "mid-October",
          evidence: "raising $3M–$5M in SAFEs targeting mid-October",
        },
        people: [],
      },
      SOURCE,
      seeds()
    );
    expect(x.version).toBe(REVIEW_EXTRACT_VERSION);
    expect(x.company?.name).toBe("Onyxite");
    expect(x.financing?.amount).toBe("$3M–$5M");
    expect(x.financing?.status).toBe("planned");
  });

  it("refuses to turn a government award into a financing round", () => {
    const x = validateExtraction(
      {
        financing: {
          amount: "$34M",
          round: "Grant",
          status: "historical",
          evidence: "$34M NIST CRDP award last year",
        },
      },
      SOURCE,
      []
    );
    expect(x.financing).toBeNull();
  });

  it("drops facts whose evidence is not in the note", () => {
    const x = validateExtraction(
      {
        company: { name: "Onyxite", evidence: "totally invented sentence" },
        financing: { amount: "$3M–$5M", evidence: "another invention" },
      },
      SOURCE,
      []
    );
    expect(x.company).toBeNull();
    expect(x.financing).toBeNull();
  });

  it("merges a bare first name into the invitee, keeps distinct people apart", () => {
    const x = validateExtraction(
      {
        people: [
          { name: "Erik", title: "CEO", role: "founder" },
          { name: "Adam", role: "team", evidence: "Adam runs GTM" },
          { name: "Ari Stone", role: "advisor", evidence: "Ari Stone advises on government sales" },
          { name: "Ghost Person", role: "founder" }, // no evidence, not invited
        ],
      },
      SOURCE,
      seeds()
    );
    const names = x.people.map((p: XPerson) => p.name);
    expect(names).toContain("Erik Holden");
    expect(names).toContain("Adam");
    expect(names).toContain("Ari Stone");
    expect(names).not.toContain("Ghost Person");
    const erik = x.people.find((p) => p.name === "Erik Holden")!;
    expect(erik.title).toBe("CEO");
    expect(erik.role).toBe("founder");
    expect(erik.email).toBe("erik@onyxitesemi.com");
  });

  it("requires money to look like money", () => {
    const x = validateExtraction(
      {
        financing: {
          amount: "a bunch",
          evidence: "raising $3M–$5M in SAFEs targeting mid-October",
        },
      },
      SOURCE,
      []
    );
    expect(x.financing).toBeNull();
  });
});

describe("summaryLine", () => {
  it("reads naturally at each shape", () => {
    const base = validateExtraction(
      {
        company: { name: "Onyxite", evidence: "Onyxite's semiconductor authentication platform" },
        financing: {
          amount: "$3M–$5M",
          security: "SAFE",
          evidence: "raising $3M–$5M in SAFEs targeting mid-October",
        },
        people: [{ name: "Adam", evidence: "Adam runs GTM" }],
      },
      SOURCE,
      seeds()
    );
    expect(summaryLine(base)).toBe("Found Onyxite, 2 people and a possible $3M–$5M SAFE.");
    expect(summaryLine({ version: "v", company: null, financing: null, people: [] })).toBe(
      "Nothing structured found."
    );
  });
});

describe("companyNameFromDomain", () => {
  it("names a company from its work domain", () => {
    expect(companyNameFromDomain("gentle.xyz")).toBe("Gentle");
    expect(companyNameFromDomain("acme-robotics.com")).toBe("Acme Robotics");
    expect(companyNameFromDomain("www.getgentle.com")).toBe("Gentle");
  });
  it("never names anyone from mail providers or schools", () => {
    expect(companyNameFromDomain("gmail.com")).toBeNull();
    expect(companyNameFromDomain("stanford.edu")).toBeNull();
    expect(companyNameFromDomain(null)).toBeNull();
  });
});
