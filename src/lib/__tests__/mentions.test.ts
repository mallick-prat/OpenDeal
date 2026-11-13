import { describe, it, expect } from "vitest";
import {
  activeMentionQuery,
  matchMembers,
  splitMentions,
  escapeRegExp,
  type MentionMember,
} from "../mentions";

const members: MentionMember[] = [
  { email: "ann@x.com", name: "Ann Lee", image: null },
  { email: "bob@x.com", name: "Bob Ng", image: null },
  { email: "annie@x.com", name: "Annie Hart", image: null },
];

describe("activeMentionQuery", () => {
  it("returns the query when the caret sits in an @token", () => {
    expect(activeMentionQuery("hi @ann", 7)).toBe("ann");
    expect(activeMentionQuery("@ann", 4)).toBe("ann");
    expect(activeMentionQuery("(@bo", 4)).toBe("bo");
  });

  it("supports spaces in the query (full names)", () => {
    expect(activeMentionQuery("hey @Ann Le", 11)).toBe("Ann Le");
  });

  it("returns '' right after a lone @", () => {
    expect(activeMentionQuery("hi @", 4)).toBe("");
  });

  it("is null when not in a mention", () => {
    expect(activeMentionQuery("hello world", 11)).toBeNull();
    expect(activeMentionQuery("email a@b.com", 13)).toBeNull(); // @ not token-start
    expect(activeMentionQuery("plain text no at", 16)).toBeNull();
  });

  it("stops the query at a newline (a mention doesn't span lines)", () => {
    expect(activeMentionQuery("@ann\nmore", 9)).toBeNull();
  });

  it("only considers text up to the caret", () => {
    expect(activeMentionQuery("@ann more", 4)).toBe("ann");
  });
});

describe("matchMembers", () => {
  it("matches by substring, earliest-index first", () => {
    expect(matchMembers(members, "ann").map((m) => m.name)).toEqual([
      "Ann Lee",
      "Annie Hart",
    ]);
  });

  it("is case-insensitive and matches inside the name", () => {
    expect(matchMembers(members, "ng").map((m) => m.email)).toEqual(["bob@x.com"]);
  });

  it("returns all (alphabetical) for an empty query", () => {
    expect(matchMembers(members, "").map((m) => m.name)).toEqual([
      "Ann Lee",
      "Annie Hart",
      "Bob Ng",
    ]);
  });

  it("respects the limit", () => {
    expect(matchMembers(members, "", 1)).toHaveLength(1);
  });

  it("returns [] when nothing matches", () => {
    expect(matchMembers(members, "zzz")).toEqual([]);
  });
});

describe("splitMentions", () => {
  it("splits @Name runs out of the plain text", () => {
    const parts = splitMentions("hey @Ann Lee look", ["Ann Lee"]);
    expect(parts).toEqual([
      { text: "hey ", mention: false },
      { text: "@Ann Lee", mention: true },
      { text: " look", mention: false },
    ]);
  });

  it("prefers the longest name when one is a prefix of another", () => {
    const parts = splitMentions("@Annie Hart", ["Ann Lee", "Annie Hart"]);
    expect(parts).toEqual([{ text: "@Annie Hart", mention: true }]);
  });

  it("returns the whole body as plain when there are no names", () => {
    expect(splitMentions("no mentions", [])).toEqual([
      { text: "no mentions", mention: false },
    ]);
  });

  it("is case-insensitive on the @Name", () => {
    const parts = splitMentions("yo @ann lee", ["Ann Lee"]);
    expect(parts.some((p) => p.mention && p.text.toLowerCase() === "@ann lee")).toBe(true);
  });
});

describe("escapeRegExp", () => {
  it("escapes regex metacharacters", () => {
    expect(escapeRegExp("a.b(c)+")).toBe("a\\.b\\(c\\)\\+");
  });
});
