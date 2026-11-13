/**
 * ── Meeting-note ↔ deal matching (pure) ─────────────────────────────────────
 * Given a Granola note (participants, title, body, calendar linkage) and the
 * open pipeline, propose at most one deal. Evidence tiers, strongest first:
 *
 *   confirmed — the note's calendar event is already matched to a deal;
 *               a participant is a recorded founder; or the body names the
 *               deal's company or a founder's full name UNIQUELY across the
 *               pipeline. These attach programmatically (the Calendly-titled
 *               "30 Minute Meeting" where Granola only captured the host has
 *               no other evidence than its own text).
 *   suggested — the company name appears in the title, or body evidence was
 *               ambiguous. A human decides.
 *
 * Rules stay deterministic: exact email equality, whole-word phrase matches,
 * no fuzzy scoring.
 */
import { INTERNAL_DOMAIN_SET } from "@/config/crm.config";


export interface MatchDeal {
  gid: string;
  name: string;
  companyName: string;
  founderEmails: string[];
  founderNames: string[];
  /** Corporate email domains tied to the deal (company domain, founders'
   *  work domains). Never freemail or .edu — those are shared by strangers. */
  domains?: string[];
  /** False for passed deals: strong evidence still CONFIRMS onto them (a
   * meeting about a passed deal is still its context), but weak evidence
   * never SUGGESTS toward a dead deal. Absent means active. */
  active?: boolean;
}

export interface MatchEvidence {
  kind:
    | "attendee_email"
    | "attendee_domain"
    | "attendee_name"
    | "title_company"
    | "title_founder"
    | "calendar_event"
    | "content_company"
    | "content_founder";
  value: string;
}

/** Mailbox providers and schools: a shared domain says nothing about a deal. */
const SHARED_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "outlook.com", "hotmail.com", "live.com",
  "msn.com", "icloud.com", "me.com", "mac.com", "aol.com", "protonmail.com", "proton.me",
  "pm.me", "hey.com", "fastmail.com", "zoho.com", "gmx.com", "mail.com", "yandex.com",
  "qq.com", "163.com",
  // Our own domains say nothing about a deal either.
  ...INTERNAL_DOMAIN_SET,
]);

export function corporateDomainOf(email: string | null | undefined): string | null {
  const e = normalizeEmail(email);
  if (!e) return null;
  const domain = e.split("@")[1] ?? "";
  if (!domain || SHARED_DOMAINS.has(domain)) return null;
  if (/\.edu$|\.ac\.[a-z]{2}$|\.edu\.[a-z]{2}$/.test(domain)) return null;
  return domain;
}

/** "jane doe" for "Jane  Doe" — two or more tokens, seven or more characters. */
function fullNameKey(raw: string | null | undefined): string | null {
  const n = (raw ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  return n.length >= 7 && /\s/.test(n) ? n : null;
}

export interface MatchSuggestion {
  gid: string;
  confidence: number;
  evidence: MatchEvidence;
  matchState: "suggested" | "confirmed";
}

/** Lowercased, trimmed email — or null if it doesn't look like one at all. */
export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const email = raw.trim().toLowerCase();
  if (!email || !email.includes("@") || email.length > 320) return null;
  return email;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Whole-word, case-insensitive company mention in a note title. "Ramp" must
 * match "Intro call — Ramp" but never "Trampoline Ventures" — the name is
 * bounded by non-alphanumerics (or the string edge) on both sides.
 */
export function companyNameInTitle(companyName: string, title: string): boolean {
  const name = companyName.trim();
  if (name.length < 2 || !title) return false;
  const re = new RegExp(
    `(^|[^a-z0-9])${escapeRegExp(name.toLowerCase())}($|[^a-z0-9])`,
    "i"
  );
  return re.test(title.toLowerCase());
}

/** Whole-word phrase match against a body of text (same bounding rule). */
function phraseInBody(phrase: string, bodyLower: string): boolean {
  const p = phrase.trim().toLowerCase();
  if (p.length < 5 || !bodyLower) return false;
  const re = new RegExp(`(^|[^a-z0-9])${escapeRegExp(p)}($|[^a-z0-9])`);
  return re.test(bodyLower);
}

/**
 * Best match for one note, or null when the evidence isn't strong enough.
 * Calendar linkage (0.98) beats founder-email (0.95) beats unique body
 * evidence (0.85) beats a title mention (0.8, suggestion only). The first
 * deal in pipeline order wins a tie. Freemail addresses are fine — equality
 * with a recorded founder email is exact either way.
 */
export function matchNoteToDeals(
  note: {
    participantEmails: string[];
    /** Display names from the calendar/Granola, for founders without a known address. */
    participantNames?: string[];
    title: string | null;
    /** summary_md + notes_md, for content evidence. */
    body?: string | null;
    /** The deal already matched to this note's calendar event, if any. */
    calendarDealGid?: string | null;
  },
  deals: MatchDeal[]
): MatchSuggestion | null {
  // Tier 0: the calendar event this note came from is already matched.
  if (note.calendarDealGid) {
    const cal = deals.find((d) => d.gid === note.calendarDealGid);
    if (cal) {
      return {
        gid: cal.gid,
        confidence: 0.98,
        evidence: { kind: "calendar_event", value: note.calendarDealGid },
        matchState: "confirmed",
      };
    }
  }

  const participantSet = new Set(
    note.participantEmails
      .map((e) => normalizeEmail(e))
      .filter((e): e is string => e !== null)
  );
  const participantDomains = [
    ...new Set(
      note.participantEmails
        .map((e) => corporateDomainOf(e))
        .filter((d): d is string => d !== null)
    ),
  ];
  const participantNameKeys = (note.participantNames ?? [])
    .map(fullNameKey)
    .filter((k): k is string => k !== null);
  const title = note.title ?? "";

  let best: MatchSuggestion | null = null;
  for (const deal of deals) {
    // Tier 1: a meeting participant is a recorded founder of the deal.
    for (const founderEmail of deal.founderEmails) {
      const normalized = normalizeEmail(founderEmail);
      if (normalized && participantSet.has(normalized)) {
        const candidate: MatchSuggestion = {
          gid: deal.gid,
          confidence: 0.95,
          evidence: { kind: "attendee_email", value: normalized },
          matchState: "confirmed",
        };
        if (!best || candidate.confidence > best.confidence) best = candidate;
        break;
      }
    }
    if (best && best.confidence >= 0.95) continue;

    // Tier 1b: an attendee's full name is a recorded founder's. A name alone
    // suggests; a name plus the company in the title confirms.
    const founderKeys = new Set(
      deal.founderNames.map(fullNameKey).filter((k): k is string => k !== null)
    );
    const nameHit = participantNameKeys.find((k) => founderKeys.has(k));
    if (nameHit) {
      const inTitle = companyNameInTitle(deal.companyName, title);
      const candidate: MatchSuggestion = {
        gid: deal.gid,
        confidence: inTitle ? 0.92 : 0.82,
        evidence: { kind: "attendee_name", value: nameHit },
        matchState: inTitle ? "confirmed" : "suggested",
      };
      if (!best || candidate.confidence > best.confidence) best = candidate;
      if (candidate.matchState === "confirmed") continue;
    }

    // Tier 3 (suggestion): the company name, or a founder's full name,
    // appears verbatim in the title. Never toward a passed deal —
    // suggestions are for live decisions.
    if (deal.active !== false && (!best || best.confidence < 0.8)) {
      if (companyNameInTitle(deal.companyName, title)) {
        best = {
          gid: deal.gid,
          confidence: 0.8,
          evidence: { kind: "title_company", value: deal.companyName.trim() },
          matchState: "suggested",
        };
      } else {
        const titleLower = title.toLowerCase();
        const named = deal.founderNames.find((n) => {
          const k = fullNameKey(n);
          return k !== null && titleLower.includes(k);
        });
        if (named) {
          best = {
            gid: deal.gid,
            confidence: 0.8,
            evidence: { kind: "title_founder", value: named.trim() },
            matchState: "suggested",
          };
        }
      }
    }
  }
  if (best && best.matchState === "confirmed") return best;

  // Tier 1c: an attendee writes from a company's own domain. One deal on
  // that domain confirms (a colleague of the founder is still the company);
  // several deals on one domain — a re-raise across cycles — suggest the
  // live one and let a human pick.
  for (const domain of participantDomains) {
    const onDomain = deals.filter((d) => (d.domains ?? []).includes(domain));
    if (onDomain.length === 0) continue;
    const active = onDomain.filter((d) => d.active !== false);
    const pick = onDomain.length === 1 ? onDomain[0] : active.length === 1 ? active[0] : null;
    if (pick) {
      return {
        gid: pick.gid,
        confidence: 0.9,
        evidence: { kind: "attendee_domain", value: domain },
        matchState: "confirmed",
      };
    }
    const fallback = active[0] ?? onDomain[0];
    if (!best || best.confidence < 0.7) {
      best = {
        gid: fallback.gid,
        confidence: 0.7,
        evidence: { kind: "attendee_domain", value: domain },
        matchState: "suggested",
      };
    }
  }

  // Tier 2: the note BODY names exactly one deal's company or founder.
  // Body evidence only confirms when it is unambiguous across the pipeline;
  // two deals hit means a human decides (keep any title suggestion instead).
  const bodyLower = (note.body ?? "").toLowerCase();
  if (bodyLower.length >= 40) {
    const companyHits: { deal: MatchDeal; value: string }[] = [];
    const founderHits: { deal: MatchDeal; value: string }[] = [];
    for (const deal of deals) {
      if (phraseInBody(deal.companyName, bodyLower)) {
        companyHits.push({ deal, value: deal.companyName.trim() });
      }
      for (const founderName of deal.founderNames) {
        // Full names only: two or more tokens, seven or more characters.
        const n = founderName.trim();
        if (n.length >= 7 && /\s/.test(n) && phraseInBody(n, bodyLower)) {
          founderHits.push({ deal, value: n });
          break;
        }
      }
    }
    const uniqueCompany =
      companyHits.length === 1 && new Set(companyHits.map((h) => h.deal.gid)).size === 1
        ? companyHits[0]
        : null;
    const uniqueFounder =
      new Set(founderHits.map((h) => h.deal.gid)).size === 1 && founderHits.length >= 1
        ? founderHits[0]
        : null;
    const content = uniqueCompany ?? uniqueFounder;
    if (
      content &&
      // Company and founder evidence must not point at DIFFERENT deals.
      (!uniqueCompany || !uniqueFounder || uniqueCompany.deal.gid === uniqueFounder.deal.gid)
    ) {
      // Content-only evidence SUGGESTS — it never auto-confirms. Company
      // names collide (two startups named "Spectrum"), and a passed deal
      // mentioned in passing must not swallow a fresh meeting. A human
      // click, or attendee-email evidence, is what confirms.
      return {
        gid: content.deal.gid,
        confidence: 0.6,
        evidence: {
          kind: content === uniqueCompany ? "content_company" : "content_founder",
          value: content.value,
        },
        matchState: "suggested",
      };
    }
  }
  return best;
}
