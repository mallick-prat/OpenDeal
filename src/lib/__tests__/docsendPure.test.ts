import { describe, expect, it } from "vitest";
import { extractVerificationLink, findDocsendUrls, minePasscodes } from "../docsendPure";

describe("findDocsendUrls", () => {
  it("finds, dedupes, strips trailing punctuation, caps", () => {
    const text =
      "Deck: https://docsend.com/view/abc123. Also https://www.docsend.com/view/abc123 and https://docsend.com/view/xyz/extra),";
    expect(findDocsendUrls(text)).toEqual([
      "https://docsend.com/view/abc123",
      "https://www.docsend.com/view/abc123", // www variant is a distinct string; capture handles both
      "https://docsend.com/view/xyz/extra",
    ]);
    expect(findDocsendUrls(null)).toEqual([]);
    expect(findDocsendUrls("no links here")).toEqual([]);
  });
});

describe("minePasscodes", () => {
  it("mines common phrasings near the link", () => {
    const text =
      'Here is our deck https://docsend.com/view/abc — password: Acme2026! and if that fails the passcode is "leonidas".';
    expect(minePasscodes(text)).toEqual(["Acme2026!", "leonidas"]);
  });
  it("filters junk words and handles pw/pwd variants", () => {
    expect(minePasscodes("password: required, pw - deck2026")).toEqual(["deck2026"]);
    expect(minePasscodes("The password is below")).toEqual([]);
    expect(minePasscodes(null)).toEqual([]);
  });
});

describe("extractVerificationLink", () => {
  it("takes the docsend verification link, never the deck link", () => {
    const body = `
      <a href="https://docsend.com/view/abc123">your deck</a>
      Please verify: https://docsend.com/e/verify?token=abc-def-123 to continue.`;
    expect(extractVerificationLink(body)).toBe("https://docsend.com/e/verify?token=abc-def-123");
  });
  it("accepts token-bearing query links and rejects unrelated hosts", () => {
    expect(extractVerificationLink("go https://docsend.com/access/x?code=99.")).toBe(
      "https://docsend.com/access/x?code=99"
    );
    expect(extractVerificationLink("https://evil.com/verify?token=1")).toBeNull();
    expect(extractVerificationLink("only a deck https://docsend.com/view/abc")).toBeNull();
    expect(extractVerificationLink(null)).toBeNull();
  });
});
