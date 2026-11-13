import { describe, it, expect } from "vitest";
import {
  pickField,
  normalizeAddress,
  normalizeJsonPayload,
  bodyTextOf,
  isResendReceivedEvent,
  isResendUrl,
  decodeDataUriHtml,
} from "../inboundEmailWebhook";

describe("pickField", () => {
  it("returns the first non-empty field by name priority", () => {
    expect(pickField({ text: "", plain: "hi" }, ["text", "plain"])).toBe("hi");
    expect(pickField({ Subject: "Seed" }, ["subject", "Subject"])).toBe("Seed");
    expect(pickField({}, ["nope"])).toBe("");
  });
});

describe("normalizeAddress", () => {
  it("parses a raw From string", () => {
    expect(normalizeAddress("Ada <ada@x.com>")).toEqual({ name: "Ada", email: "ada@x.com" });
  });
  it("reads an object with email/name", () => {
    expect(normalizeAddress({ Email: "b@y.com", Name: "Bob" })).toEqual({ name: "Bob", email: "b@y.com" });
  });
  it("takes the first of an array", () => {
    expect(normalizeAddress([{ address: "c@z.io" }, { address: "d@z.io" }])).toEqual({
      name: "",
      email: "c@z.io",
    });
  });
  it("is safe on null", () => {
    expect(normalizeAddress(null)).toEqual({ name: "", email: "" });
  });
});

describe("normalizeJsonPayload", () => {
  it("maps a Postmark-style payload", () => {
    const n = normalizeJsonPayload({
      FromFull: { Email: "dana@startup.co", Name: "Dana" },
      Subject: "Our seed round",
      TextBody: "We're raising. Deck: https://docsend.com/view/x1",
      HtmlBody: "<p>ignored if text present</p>",
      MessageID: "pm-123",
      Attachments: [
        { Name: "deck.pdf", ContentType: "application/pdf", Content: "QUJD" },
        { Name: "logo.png", ContentType: "image/png", Content: "AA==" },
      ],
    });
    expect(n.from).toEqual({ name: "Dana", email: "dana@startup.co" });
    expect(n.subject).toBe("Our seed round");
    expect(n.messageId).toBe("pm-123");
    expect(bodyTextOf(n)).toContain("raising");
    expect(n.attachments).toHaveLength(2);
    expect(n.attachments[0]).toMatchObject({ filename: "deck.pdf", mimeType: "application/pdf", base64: "QUJD" });
  });

  it("maps a SendGrid/Mailgun-ish JSON payload with body-plain and array from", () => {
    const n = normalizeJsonPayload({
      from: "Eve Founder <eve@co.com>",
      subject: "pitch",
      "body-plain": "text body here",
      attachments: [{ filename: "d.pdf", type: "application/pdf", url: "https://files.example.com/d.pdf" }],
    });
    expect(n.from.email).toBe("eve@co.com");
    expect(bodyTextOf(n)).toBe("text body here");
    expect(n.attachments[0]).toMatchObject({ filename: "d.pdf", url: "https://files.example.com/d.pdf" });
    expect(n.attachments[0].base64).toBeUndefined();
  });

  it("falls back to stripped HTML when there is no text body", () => {
    const n = normalizeJsonPayload({
      from: { email: "f@g.com" },
      subject: "x",
      HtmlBody: "<p>Hello <b>deck</b></p>",
    });
    expect(bodyTextOf(n)).toContain("Hello");
    expect(bodyTextOf(n)).toContain("deck");
  });

  it("drops attachments that carry neither content nor url", () => {
    const n = normalizeJsonPayload({
      from: "a@b.com",
      subject: "s",
      text: "t",
      attachments: [{ filename: "empty.pdf", contentType: "application/pdf" }],
    });
    expect(n.attachments).toHaveLength(0);
  });
});

describe("Resend helpers", () => {
  it("recognizes an email.received envelope", () => {
    expect(
      isResendReceivedEvent({ type: "email.received", data: { email_id: "abc-123" } })
    ).toBe(true);
    expect(isResendReceivedEvent({ type: "email.sent", data: { email_id: "x" } })).toBe(false);
    expect(isResendReceivedEvent({ type: "email.received", data: {} })).toBe(false);
    expect(isResendReceivedEvent(null)).toBe(false);
  });

  it("only trusts https URLs on resend.com hosts", () => {
    expect(isResendUrl("https://inbound-cdn.resend.com/id/attachments/a?sig=x")).toBe(true);
    expect(isResendUrl("https://api.resend.com/x")).toBe(true);
    expect(isResendUrl("https://evil.com/resend.com/x")).toBe(false);
    expect(isResendUrl("https://notresend.com/x")).toBe(false);
    expect(isResendUrl("http://inbound-cdn.resend.com/x")).toBe(false);
    expect(isResendUrl("not a url")).toBe(false);
  });

  it("decodes data-URI html and passes plain html through", () => {
    const b64 = Buffer.from("<p>Hi</p>", "utf8").toString("base64");
    expect(decodeDataUriHtml(`data:text/html;base64,${b64}`)).toBe("<p>Hi</p>");
    expect(decodeDataUriHtml("data:text/html,%3Cb%3Ex%3C%2Fb%3E")).toBe("<b>x</b>");
    expect(decodeDataUriHtml("<div>plain</div>")).toBe("<div>plain</div>");
    expect(decodeDataUriHtml(null)).toBe("");
  });
});
