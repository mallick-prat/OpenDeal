import { describe, it, expect } from "vitest";
import {
  domainOf,
  classifyDomain,
  canExpandToDomain,
  matchTargets,
  localPartMatchesName,
} from "../emailDomains";

describe("classifyDomain", () => {
  it("treats mailbox providers as consumer", () => {
    for (const e of [
      "lydia@gmail.com",
      "x@icloud.com",
      "y@proton.me",
      "z@outlook.com",
      "q@qq.com",
    ]) {
      expect(classifyDomain(e)).toBe("consumer");
    }
  });

  it("catches university subdomains, not just bare .edu", () => {
    for (const e of [
      "alex@college.harvard.edu",
      "w@g.ucla.edu",
      "n@alumni.stanford.edu",
      "s@mit.edu",
      "u@ox.ac.uk",
      "v@students.ac.in",
    ]) {
      expect(classifyDomain(e)).toBe("academic");
    }
  });

  it("treats company domains as corporate", () => {
    for (const e of [
      "lydia.chang@luminalabs.io",
      "scott@cognition.ai",
      "brendan@mercor.com",
      "sean@offscriptvc.com",
    ]) {
      expect(classifyDomain(e)).toBe("corporate");
    }
  });

  it("never expands on an unparseable address", () => {
    expect(classifyDomain("not-an-email")).toBe("consumer");
    expect(canExpandToDomain("not-an-email")).toBe(false);
  });
});

describe("canExpandToDomain", () => {
  it("allows company domains only", () => {
    expect(canExpandToDomain("lydia.chang@luminalabs.io")).toBe(true);
    expect(canExpandToDomain("lydia@gmail.com")).toBe(false);
    expect(canExpandToDomain("alex@college.harvard.edu")).toBe(false);
  });
});

describe("domainOf", () => {
  it("lowercases and strips trailing punctuation", () => {
    expect(domainOf("Lydia@Lumina.IO")).toBe("lumina.io");
    expect(domainOf("a@b.com>")).toBe("b.com");
  });
  it("returns empty for junk", () => {
    expect(domainOf("nope")).toBe("");
    expect(domainOf("")).toBe("");
  });
});

describe("matchTargets", () => {
  it("matches every address exactly, but expands only corporate ones", () => {
    const { addresses, domains } = matchTargets([
      "lydia.chang@luminalabs.io", // corporate → expandable
      "lydia@gmail.com",           // personal → exact only
      "lydia@college.harvard.edu", // school   → exact only
    ]);
    expect(addresses).toHaveLength(3);
    expect(domains).toEqual(["luminalabs.io"]);
  });

  it("dedupes and normalises case", () => {
    const { addresses } = matchTargets(["A@B.com", "a@b.com", " A@B.COM "]);
    expect(addresses).toEqual(["a@b.com"]);
  });

  it("drops non-addresses", () => {
    expect(matchTargets(["", "nope", "ok@co.com"]).addresses).toEqual(["ok@co.com"]);
  });

  it("returns no domains when every founder is on personal or school mail", () => {
    const { domains } = matchTargets(["a@gmail.com", "b@g.ucla.edu"]);
    expect(domains).toEqual([]);
  });
});

describe("localPartMatchesName", () => {
  it("matches the forms people actually use", () => {
    for (const e of [
      "ian@pemberly.co",
      "ianlee@pemberly.co",
      "ian.lee@pemberly.co",
      "ian_lee@pemberly.co",
      "ilee@pemberly.co",
      "i.lee@pemberly.co",
      "leeian@pemberly.co",
      "lee@pemberly.co",
    ]) {
      expect(localPartMatchesName(e, "Ian Lee")).toBe(true);
    }
  });

  it("ignores plus-tags", () => {
    expect(localPartMatchesName("ian+deals@pemberly.co", "Ian Lee")).toBe(true);
  });

  it("won't match a name merely contained in the local part", () => {
    // The whole point: brian contains ian.
    expect(localPartMatchesName("brian@pemberly.co", "Ian Lee")).toBe(false);
    expect(localPartMatchesName("leeanne@pemberly.co", "Ian Lee")).toBe(false);
    expect(localPartMatchesName("team@pemberly.co", "Ian Lee")).toBe(false);
    expect(localPartMatchesName("hello@pemberly.co", "Ian Lee")).toBe(false);
  });

  it("handles apostrophes and hyphens in names", () => {
    expect(localPartMatchesName("marco@larkai.com", "Marco D'Amato")).toBe(true);
    expect(localPartMatchesName("mdamato@larkai.com", "Marco D'Amato")).toBe(true);
  });

  it("is safe on junk", () => {
    expect(localPartMatchesName("", "Ian Lee")).toBe(false);
    expect(localPartMatchesName("ian@x.com", "")).toBe(false);
  });
});
