import { describe, it, expect } from "vitest";
import {
  calendarNeedsFullResync,
  companyNameInTitle,
  dealCompanyNormalized,
  isExternalMeeting,
  matchEvidence,
  normalizeAttendeeEmail,
  type CalendarAttendee,
  type CalendarMatchDeal,
} from "../calendarPure";
import { INTERNAL_DOMAINS } from "../companiesPure";

function attendee(email: string, extra: Partial<CalendarAttendee> = {}): CalendarAttendee {
  return { email, name: "", status: "accepted", ...extra };
}

function deal(overrides: Partial<CalendarMatchDeal> = {}): CalendarMatchDeal {
  return {
    gid: "1001",
    name: "Alice Chen // Ramp",
    founderEmails: ["alice@ramp.com"],
    ...overrides,
  };
}

describe("isExternalMeeting", () => {
  it("excludes internal-only meetings", () => {
    expect(
      isExternalMeeting(
        [attendee("alex@example.com"), attendee("sam@example.com")],
        INTERNAL_DOMAINS
      )
    ).toBe(false);
  });

  it("excludes solo/one-attendee events even with an external address", () => {
    expect(isExternalMeeting([attendee("alice@ramp.com")], INTERNAL_DOMAINS)).toBe(false);
    expect(isExternalMeeting([], INTERNAL_DOMAINS)).toBe(false);
  });

  it("includes a meeting with at least one external attendee", () => {
    expect(
      isExternalMeeting(
        [attendee("alex@example.com"), attendee("Alice@Ramp.com")],
        INTERNAL_DOMAINS
      )
    ).toBe(true);
  });

  it("ignores attendees without a usable email", () => {
    expect(
      isExternalMeeting(
        [attendee(""), { name: "Room 4B" }, attendee("alice@ramp.com")],
        INTERNAL_DOMAINS
      )
    ).toBe(false); // only one real address → not a meeting
  });
});

describe("matchEvidence", () => {
  const event = (title: string, emails: string[]) => ({
    title,
    attendees: emails.map((e) => attendee(e)),
  });

  it("matches an exact founder-email attendee at 0.95", () => {
    const m = matchEvidence(event("Intro call", ["alex@example.com", "ALICE@ramp.com "]), [deal()]);
    expect(m).toEqual({
      dealGid: "1001",
      confidence: 0.95,
      evidence: [{ kind: "attendee_email", value: "alice@ramp.com" }],
    });
  });

  it("attendee match beats a title match on another deal", () => {
    const deals = [
      deal({ gid: "2002", name: "Bo Chen // Vanta", founderEmails: ["bo@vanta.com"] }),
      deal(), // Ramp, alice@ramp.com
    ];
    // Title mentions Vanta, but Ramp's founder is actually in the room.
    const m = matchEvidence(event("Vanta catch-up", ["alice@ramp.com", "alex@example.com"]), deals);
    expect(m?.dealGid).toBe("1001");
    expect(m?.confidence).toBe(0.95);
  });

  it("falls back to a title company mention at 0.75", () => {
    const m = matchEvidence(event("Acme Fund <> Ramp intro", ["alex@example.com", "someone@gmail.com"]), [deal()]);
    expect(m?.dealGid).toBe("1001");
    expect(m?.confidence).toBe(0.75);
    expect(m?.evidence).toEqual([{ kind: "title_company", value: "ramp" }]);
  });

  it("returns null when nothing matches", () => {
    const m = matchEvidence(event("Portfolio sync", ["alex@example.com", "someone@gmail.com"]), [deal()]);
    expect(m).toBeNull();
  });

  it("normalizes legal suffixes on both sides of the title match", () => {
    const d = deal({ name: "Jane Doe // Acme Technologies, Inc." });
    const m = matchEvidence(event("Acme: seed round discussion", ["a@b.com", "c@d.com"]), [d]);
    expect(m?.confidence).toBe(0.75);
    expect(m?.evidence[0].value).toBe("acme");
  });

  it("requires whole-word title mentions — no substring hits", () => {
    const d = deal({ name: "Jane Doe // Ramp" });
    const m = matchEvidence(event("Trampoline Ventures sync", ["a@b.com", "c@d.com"]), [d]);
    expect(m).toBeNull();
  });
});

describe("normalization edges", () => {
  it("dealCompanyNormalized takes the part after // and folds it", () => {
    expect(dealCompanyNormalized("Alice Chen // Acme Labs Inc")).toBe("acme");
    expect(dealCompanyNormalized("Plain Name")).toBe("plain name"); // no // → whole name
  });

  it("companyNameInTitle refuses names shorter than 2 chars", () => {
    expect(companyNameInTitle("X", "X sync")).toBe(false);
    expect(companyNameInTitle("", "anything")).toBe(false);
  });

  it("normalizeAttendeeEmail lowercases, trims, and rejects junk", () => {
    expect(normalizeAttendeeEmail("  Alice@Ramp.COM ")).toBe("alice@ramp.com");
    expect(normalizeAttendeeEmail("not-an-email")).toBeNull();
    expect(normalizeAttendeeEmail(null)).toBeNull();
  });
});

describe("calendarNeedsFullResync", () => {
  const now = Date.parse("2026-08-14T18:00:00Z");
  const day = 86_400_000;

  it("does not baseline just because last-full was never stamped", () => {
    expect(calendarNeedsFullResync(null, now, 90)).toBe(false);
  });

  it("baselines when the last full pull is older than the interval", () => {
    expect(calendarNeedsFullResync(new Date(now - 91 * day), now, 90)).toBe(true);
    expect(calendarNeedsFullResync(new Date(now - 10 * day), now, 90)).toBe(false);
  });
});
