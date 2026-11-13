import { normalizeCompanyName } from "./companiesPure";
import { companyFromDealName } from "./founders";

/**
 * ── Calendar ↔ deal matching (pure) ─────────────────────────────────────────
 * Two questions, no I/O:
 *
 *   isExternalMeeting — is this event a meeting with someone outside the
 *   firm (vs. an internal standup / solo block)?
 *
 *   matchEvidence — which deal, if any, does an external meeting belong to?
 *   A conservative two-rung ladder, mirroring meetingNotesPure: exact
 *   founder-email attendee (0.95) beats the deal's company name appearing
 *   as a whole word in the title (0.75). Anything weaker returns null —
 *   writing a wrong deal onto a calendar row is worse than writing nothing.
 */

export interface CalendarAttendee {
  email?: string | null;
  name?: string | null;
  status?: string | null;
  organizer?: boolean;
}

/** What the matcher needs to know about a deal. Deal names follow the
 *  "Jane Doe, Bo Chen // Acme" convention — company is the part after "//". */
export interface CalendarMatchDeal {
  gid: string;
  name: string;
  /** Senders of the inbound pitches that created the deal (see calendarSync). */
  founderEmails: string[];
}

export interface CalendarMatchEvidence {
  kind: "attendee_email" | "title_company";
  value: string;
}

export interface CalendarMatch {
  dealGid: string;
  confidence: number;
  evidence: CalendarMatchEvidence[];
}

/** Lowercased, trimmed email — or null when it doesn't look like one. */
export function normalizeAttendeeEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const email = raw.trim().toLowerCase();
  if (!email || !email.includes("@") || email.length > 320) return null;
  return email;
}

function emailDomain(email: string): string {
  return email.slice(email.lastIndexOf("@") + 1);
}

/**
 * External meeting = at least 2 attendees with real addresses, at least one
 * of them outside the internal domains. Solo focus blocks (≤1 attendee) and
 * internal-only meetings never reach the deal matcher.
 */
export function isExternalMeeting(
  attendees: CalendarAttendee[],
  internalDomains: ReadonlySet<string>
): boolean {
  const emails = attendees
    .map((a) => normalizeAttendeeEmail(a?.email))
    .filter((e): e is string => e !== null);
  if (emails.length < 2) return false;
  return emails.some((e) => !internalDomains.has(emailDomain(e)));
}

/**
 * Same fold normalizeCompanyName applies (NFKC, lowercase, punctuation →
 * spaces) so a normalized company name can be matched word-for-word.
 */
function foldText(raw: string): string {
  return raw
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Whole-word company mention in a title: "acme" must match "Acme <> YourFund"
 * but never "Acmezilla". Both sides are folded identically, so punctuation
 * and legal suffixes ("Acme, Inc.") don't break the comparison.
 */
export function companyNameInTitle(companyName: string, title: string): boolean {
  const name = normalizeCompanyName(companyName);
  if (name.length < 2 || !title) return false;
  const folded = ` ${foldText(title)} `;
  return folded.includes(` ${name} `);
}

/** The deal's company name for matching: the part after "//", normalized. */
export function dealCompanyNormalized(dealName: string): string {
  return normalizeCompanyName(companyFromDealName(dealName));
}

/**
 * Best deal for one event, or null. Attendee-email equality (0.95) always
 * beats a title mention (0.75); the first deal in input order wins a tie.
 * Every matching founder email lands in `evidence` so the UI can show why.
 */
export function matchEvidence(
  event: { title: string | null; attendees: CalendarAttendee[] },
  deals: CalendarMatchDeal[]
): CalendarMatch | null {
  const attendeeEmails = new Set(
    event.attendees
      .map((a) => normalizeAttendeeEmail(a?.email))
      .filter((e): e is string => e !== null)
  );
  const title = event.title ?? "";

  let best: CalendarMatch | null = null;
  for (const deal of deals) {
    // HIGH: a recorded founder of the deal is in the room.
    const hits: CalendarMatchEvidence[] = [];
    for (const founderEmail of deal.founderEmails) {
      const normalized = normalizeAttendeeEmail(founderEmail);
      if (normalized && attendeeEmails.has(normalized)) {
        hits.push({ kind: "attendee_email", value: normalized });
      }
    }
    if (hits.length > 0) {
      if (!best || best.confidence < 0.95) {
        best = { dealGid: deal.gid, confidence: 0.95, evidence: hits };
      }
      continue;
    }

    // MEDIUM: the deal's company name appears verbatim in the title.
    if (
      (!best || best.confidence < 0.75) &&
      companyNameInTitle(companyFromDealName(deal.name), title)
    ) {
      best = {
        dealGid: deal.gid,
        confidence: 0.75,
        evidence: [
          { kind: "title_company", value: dealCompanyNormalized(deal.name) },
        ],
      };
    }
  }
  return best;
}

/**
 * Whether the next calendar pull should drop the incremental syncToken and
 * re-read the window. A NULL last-full timestamp must NOT force a baseline —
 * that used to throw away a working token every 15 minutes and re-upsert
 * years of events (which then looked "changed" to reverse-enrich).
 *
 * No token → caller baselines. Token + no last-full → incremental.
 * Token + last-full older than `everyDays` → baseline.
 */
export function calendarNeedsFullResync(
  lastFullSyncAt: Date | null,
  nowMs: number,
  everyDays: number
): boolean {
  if (lastFullSyncAt == null) return false;
  return nowMs - lastFullSyncAt.getTime() > everyDays * 86_400_000;
}
