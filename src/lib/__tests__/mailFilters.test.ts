import { describe, it, expect } from "vitest";
import { looksDealRelated, shouldExcludeMessage } from "../mailFilters";

const msg = (over: {
  headers?: Record<string, string>;
  from?: string;
  subject?: string;
}) => ({
  headers: over.headers ?? {},
  from: over.from ?? "Dana Founder <dana@startup.co>",
  subject: over.subject ?? "Seed round — our deck",
});

describe("shouldExcludeMessage", () => {
  it("excludes messages with a List-Id header as mailing list", () => {
    const r = shouldExcludeMessage(
      msg({ headers: { "List-Id": "<news.substack.com>" } })
    );
    expect(r).toEqual({ exclude: true, reason: "mailing list" });
  });

  it("excludes messages with a List-Unsubscribe header", () => {
    const r = shouldExcludeMessage(
      msg({ headers: { "List-Unsubscribe": "<mailto:u@x.com>" } })
    );
    expect(r).toEqual({ exclude: true, reason: "mailing list" });
  });

  it("matches header names case-insensitively", () => {
    const r = shouldExcludeMessage(msg({ headers: { "LIST-ID": "<x>" } }));
    expect(r.exclude).toBe(true);
  });

  it("excludes Precedence: bulk and Precedence: list as bulk", () => {
    expect(
      shouldExcludeMessage(msg({ headers: { Precedence: "Bulk" } }))
    ).toEqual({ exclude: true, reason: "bulk" });
    expect(
      shouldExcludeMessage(msg({ headers: { precedence: "list" } }))
    ).toEqual({ exclude: true, reason: "bulk" });
  });

  it("excludes no-reply / noreply senders as automated", () => {
    expect(
      shouldExcludeMessage(msg({ from: "GitHub <noreply@github.com>" }))
    ).toEqual({ exclude: true, reason: "automated" });
    expect(
      shouldExcludeMessage(msg({ from: "No-Reply <NO-REPLY@bank.com>" }))
    ).toEqual({ exclude: true, reason: "automated" });
  });

  it("excludes notifications@ and mailer-daemon senders", () => {
    expect(
      shouldExcludeMessage(msg({ from: "notifications@linear.app" }))
    ).toEqual({ exclude: true, reason: "automated" });
    expect(
      shouldExcludeMessage(msg({ from: "Mailer-Daemon@googlemail.com" }))
    ).toEqual({ exclude: true, reason: "automated" });
  });

  it("excludes calendar invites via a text/calendar content-type hint", () => {
    const r = shouldExcludeMessage(
      msg({
        headers: {
          "Content-Type": 'multipart/mixed; boundary="x"; text/calendar',
        },
      })
    );
    expect(r).toEqual({ exclude: true, reason: "calendar" });
  });

  it("excludes Invitation:/Accepted:/Declined: subjects as calendar", () => {
    for (const subject of [
      "Invitation: Coffee w/ Dana @ Tue Jul 28",
      "Accepted: Portfolio review",
      "declined: Board sync",
    ]) {
      expect(shouldExcludeMessage(msg({ subject }))).toEqual({
        exclude: true,
        reason: "calendar",
      });
    }
  });

  it("excludes receipt senders (receipts@ / billing@ / invoices@)", () => {
    for (const from of [
      "Uber Receipts <receipts@uber.com>",
      "billing@vercel.com",
      "Stripe <invoices@stripe.com>",
    ]) {
      expect(shouldExcludeMessage(msg({ from }))).toEqual({
        exclude: true,
        reason: "receipt",
      });
    }
  });

  it("excludes obvious receipt/invoice subjects", () => {
    expect(
      shouldExcludeMessage(msg({ subject: "Your receipt from Figma #123" }))
    ).toEqual({ exclude: true, reason: "receipt" });
    expect(
      shouldExcludeMessage(msg({ subject: "Invoice #2041 from AWS" }))
    ).toEqual({ exclude: true, reason: "receipt" });
  });

  it("keeps a real founder email with none of these markers", () => {
    const r = shouldExcludeMessage(
      msg({
        headers: {
          "Message-Id": "<abc@mail.gmail.com>",
          "Content-Type": "multipart/alternative",
        },
        from: "Dana Founder <dana@startup.co>",
        subject: "Seed round — our deck",
      })
    );
    expect(r).toEqual({ exclude: false, reason: null });
  });

  it("keeps a plain reply thread", () => {
    expect(
      shouldExcludeMessage(msg({ subject: "Re: intro to Acme Fund" }))
    ).toEqual({ exclude: false, reason: null });
  });

  it("does not treat 'reply@' or a passing 'invoice' mention as automated/receipt", () => {
    expect(
      shouldExcludeMessage(msg({ from: "Press Reply <reply@substack-writer.com>" }))
        .exclude
    ).toBe(false);
    expect(
      shouldExcludeMessage(
        msg({ subject: "Question about invoicing startups" })
      ).exclude
    ).toBe(false);
  });

  it("tolerates missing fields", () => {
    expect(
      shouldExcludeMessage({ headers: {}, from: "", subject: "" })
    ).toEqual({ exclude: false, reason: null });
  });
});

describe("looksDealRelated (AI-spend pre-gate)", () => {
  it("deck link is decisive on its own", () => {
    expect(looksDealRelated("hello", "nothing here", { hasDeckLink: true })).toBe(true);
  });
  it("raise language matches", () => {
    expect(looksDealRelated("Our pre-seed", "we are raising", {})).toBe(true);
    expect(looksDealRelated("Intro", "closing our seed round next month", {})).toBe(true);
  });
  it("ordinary mail stays ordinary", () => {
    expect(looksDealRelated("Lunch tomorrow?", "see you at noon", {})).toBe(false);
    expect(looksDealRelated("Re: contract", "signed copy attached", { hasAttachment: true })).toBe(false);
  });
  it("pdf attachment needs a raise-ish word too", () => {
    expect(looksDealRelated("Our deck", "attached as discussed", { hasAttachment: true })).toBe(true);
    expect(looksDealRelated("Photos", "from the offsite", { hasAttachment: true })).toBe(false);
  });
});
