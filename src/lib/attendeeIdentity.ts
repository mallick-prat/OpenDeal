import { classifyDomain, domainOf } from "./emailDomains";

/**
 * ── Who is this attendee? (pure) ─────────────────────────────────────────────
 * A calendar invite is often the FIRST contact with a founder — the meeting
 * happens before any pitch email exists. But an attendee row is usually just
 * an address: only ~6% carry a display name. This module squeezes an identity
 * out of what's there, deterministically — no AI, no external lookups — so the
 * result is explainable and instant.
 *
 * Identity comes from, in order of trust:
 *   1. The display name on the invite ("Kapoor, Mira" → "Mira Kapoor").
 *   2. The address's local part ("remy.rosado@larkai.com" → "Remy Rosado").
 * The domain then says where they work (corporate) or studies (academic) —
 * consumer domains carry no affiliation at all.
 */

export interface AttendeeIdentity {
  email: string;
  domain: string;
  kind: "consumer" | "academic" | "corporate";
  /** Best-effort person name; null when nothing trustworthy can be derived. */
  name: string | null;
  /** How the name was obtained — display names outrank derivations. */
  nameSource: "display" | "derived" | "none";
}

/**
 * Role addresses — a mailbox for a function, not a person. Deriving "Info"
 * or "Team Corvia" as human names would poison the network table.
 */
const GENERIC_LOCALS = new Set([
  "info", "hello", "hi", "team", "contact", "admin", "office", "support",
  "sales", "press", "media", "jobs", "careers", "events", "invites", "invite",
  "noreply", "no-reply", "notifications", "calendar", "scheduling", "founders",
  "partners", "investors", "ir", "legal", "finance", "ops", "hq", "mail",
]);

function titleCase(word: string): string {
  if (!word) return word;
  // "o'brien" → "O'Brien", "smith-jones" → "Smith-Jones"
  return word
    .split(/([-'])/)
    .map((part, i) =>
      i % 2 === 0 && part
        ? part[0].toUpperCase() + part.slice(1)
        : part
    )
    .join("");
}

/** "Kapoor, Mira" → "Mira Kapoor"; trims stray quotes and whitespace. */
export function cleanDisplayName(raw: string): string | null {
  const s = String(raw ?? "").replace(/["']/g, "").trim();
  if (!s || s.includes("@")) return null; // an address masquerading as a name
  const comma = s.match(/^([^,]+),\s*(.+)$/);
  const name = comma ? `${comma[2].trim()} ${comma[1].trim()}` : s;
  // At least one letter, and not obviously an organisation string.
  if (!/\p{L}/u.test(name)) return null;
  return name.replace(/\s+/g, " ");
}

/**
 * "remy.rosado" → "Remy Rosado". Only multi-token locals produce a name —
 * a bare "raul" could be anyone, and initials-style locals ("rrosado",
 * "r.rosado") are ambiguous in the forward direction, so both return null.
 * (Matching an ambiguous local AGAINST a known name is the job of
 * localPartMatchesName in emailDomains.ts — that direction is safe.)
 */
export function nameFromLocalPart(email: string): string | null {
  const local = String(email ?? "")
    .toLowerCase()
    .split("@")[0]
    .replace(/\+.*$/, "");
  if (!local || GENERIC_LOCALS.has(local)) return null;

  const tokens = local
    .split(/[._-]/)
    // "doe99" → "doe": trailing digits are the year-suffix convention. Digits
    // ANYWHERE else make a token untrustworthy, so it's dropped whole.
    .map((t) => t.replace(/\d+$/, ""))
    .filter((t) => t.length > 0 && !/\d/.test(t));
  // Two real word-tokens or nothing: "jane.doe" yes; "jane", "jdoe", "jd" no.
  if (tokens.length < 2 || tokens.some((t) => t.length < 2)) return null;
  if (tokens.some((t) => GENERIC_LOCALS.has(t))) return null;
  return tokens.map(titleCase).join(" ");
}

/** Everything derivable about one attendee, offline and deterministic. */
export function attendeeIdentity(a: {
  email?: string | null;
  name?: string | null;
}): AttendeeIdentity | null {
  const email = String(a.email ?? "").trim().toLowerCase();
  if (!email.includes("@")) return null;
  const local = email.split("@")[0].replace(/\+.*$/, "");

  const display = cleanDisplayName(a.name ?? "");
  const derived = nameFromLocalPart(email);
  const generic = GENERIC_LOCALS.has(local);

  return {
    email,
    domain: domainOf(email),
    kind: classifyDomain(email),
    // A role address gets no name even if the invite decorates it with one.
    name: generic ? null : display ?? derived,
    nameSource: generic ? "none" : display ? "display" : derived ? "derived" : "none",
  };
}

/**
 * Group a meeting's external attendees by corporate domain — the shape a
 * sourcing eye actually reads an invite in: "two people from corvia.dev".
 */
export function clusterByCompany(
  attendees: AttendeeIdentity[]
): Map<string, AttendeeIdentity[]> {
  const clusters = new Map<string, AttendeeIdentity[]>();
  for (const a of attendees) {
    if (a.kind !== "corporate") continue;
    const list = clusters.get(a.domain) ?? [];
    list.push(a);
    clusters.set(a.domain, list);
  }
  return clusters;
}


/**
 * A VC's calendar is half other VCs. A fund's domain is a company, but it is
 * never a DEAL — offering "Create deal" for boldstart.vc on every weekly
 * would bury the real suggestions in noise. Evidence: the .vc TLD, or a fund
 * word in the domain itself. Imperfect by design; Dismiss covers the tail.
 */
export function looksLikeInvestorDomain(domain: string): boolean {
  const d = String(domain ?? "").toLowerCase();
  if (d.endsWith(".vc")) return true;
  const base = d.split(".")[0];
  return /(capital|ventures?|partners|holdings|invest|angels?$|\bfund$|funds$)/.test(base);
}
