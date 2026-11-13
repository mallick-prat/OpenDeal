import { describe, it, expect } from "vitest";
import {
  parseFrom,
  htmlToText,
  findDeckLinks,
  parseGmailMessage,
} from "../emailParse";

const b64url = (s: string) =>
  Buffer.from(s, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_");

describe("parseFrom", () => {
  it("splits name and email", () => {
    expect(parseFrom("Ada Lovelace <ada@x.com>")).toEqual({
      name: "Ada Lovelace",
      email: "ada@x.com",
    });
  });
  it("handles a bare address and lowercases it", () => {
    expect(parseFrom("Bob@Y.COM")).toEqual({ name: "", email: "bob@y.com" });
  });
  it("strips surrounding quotes on the display name", () => {
    expect(parseFrom('"Carol, CEO" <carol@z.io>')).toEqual({
      name: "Carol, CEO",
      email: "carol@z.io",
    });
  });
});

describe("htmlToText", () => {
  it("strips tags, scripts, and decodes entities", () => {
    const html =
      "<style>x{}</style><p>Hi &amp; welcome</p><script>bad()</script><div>Line<br>break</div>";
    const out = htmlToText(html);
    expect(out).toContain("Hi & welcome");
    expect(out).toContain("Line");
    expect(out).toContain("break");
    expect(out).not.toContain("bad()");
    expect(out).not.toContain("<");
  });
});

describe("findDeckLinks", () => {
  it("classifies known deck hosts and dedupes", () => {
    const text = `Deck: https://docsend.com/view/abc123 and again https://docsend.com/view/abc123
      also https://pitch.com/public/deck-xyz`;
    const links = findDeckLinks(text);
    expect(links).toHaveLength(2);
    expect(links[0]).toEqual({ url: "https://docsend.com/view/abc123", kind: "docsend" });
    expect(links.some((l) => l.kind === "pitch")).toBe(true);
  });
  it("trims trailing punctuation off a URL", () => {
    const links = findDeckLinks("see https://docsend.com/view/xyz.");
    expect(links[0].url).toBe("https://docsend.com/view/xyz");
  });
  it("requires a real Drive file path, not a bare drive link", () => {
    expect(findDeckLinks("https://drive.google.com/")).toHaveLength(0);
    expect(
      findDeckLinks("https://drive.google.com/file/d/123/view")
    ).toHaveLength(1);
  });
  it("ignores non-deck links", () => {
    expect(findDeckLinks("visit https://example.com/pricing")).toHaveLength(0);
  });
});

describe("parseGmailMessage", () => {
  it("extracts sender, plain-text body, deck links, and attachments", () => {
    const bigPdf = 100 * 1024;
    const msg = {
      snippet: "fallback snippet",
      payload: {
        headers: [
          { name: "From", value: "Dana Founder <dana@startup.co>" },
          { name: "Subject", value: "Seed round — our deck" },
        ],
        mimeType: "multipart/mixed",
        parts: [
          {
            mimeType: "text/plain",
            body: { data: b64url("We're raising a seed round.\nDeck: https://docsend.com/view/deck1") },
          },
          {
            mimeType: "application/pdf",
            filename: "pitch.pdf",
            body: { attachmentId: "att-1", size: bigPdf },
          },
          {
            // Tiny inline logo — below the min size, must be skipped.
            mimeType: "application/pdf",
            filename: "logo.pdf",
            body: { attachmentId: "att-2", size: 2000 },
          },
        ],
      },
    };
    const parsed = parseGmailMessage(msg);
    expect(parsed.from).toEqual({ name: "Dana Founder", email: "dana@startup.co" });
    expect(parsed.subject).toBe("Seed round — our deck");
    expect(parsed.bodyText).toContain("raising a seed round");
    expect(parsed.deckLinks).toEqual([
      { url: "https://docsend.com/view/deck1", kind: "docsend" },
    ]);
    expect(parsed.attachments).toHaveLength(1);
    expect(parsed.attachments[0]).toMatchObject({
      filename: "pitch.pdf",
      attachmentId: "att-1",
    });
  });

  it("falls back to HTML body when there's no text/plain part", () => {
    const msg = {
      snippet: "",
      payload: {
        headers: [{ name: "From", value: "x@y.com" }, { name: "Subject", value: "Hi" }],
        mimeType: "text/html",
        body: { data: b64url("<p>Hello <b>world</b></p>") },
      },
    };
    const parsed = parseGmailMessage(msg);
    expect(parsed.bodyText).toContain("Hello");
    expect(parsed.bodyText).toContain("world");
  });
});
