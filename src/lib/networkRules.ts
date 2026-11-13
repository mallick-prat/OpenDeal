/**
 * ── Network intelligence: deterministic rules ───────────────────────────────
 * The Identity and Verification "agents" are ordinary code, not LLMs.
 * Pure functions — no imports, fully unit-tested.
 */

/** Canonicalize a LinkedIn profile URL; null when it isn't one. */
export function normalizeLinkedInUrl(raw: string): string | null {
  const input = raw.trim();
  if (!input) return null;
  let url: URL;
  try {
    url = new URL(input.match(/^https?:\/\//) ? input : `https://${input}`);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  if (host !== "linkedin.com" && !host.endsWith(".linkedin.com")) return null;
  // Profile paths look like /in/<slug>; anything else isn't a person.
  const m = url.pathname.match(/\/in\/([^/]+)/);
  if (!m) return null;
  const slug = decodeURIComponent(m[1]).replace(/\/+$/, "");
  if (!slug) return null;
  return `https://www.linkedin.com/in/${slug.toLowerCase()}`;
}

/** Collapse whitespace and normalize casing-insensitive comparisons. */
export function normalizeText(s: string): string {
  return s.trim().replace(/\s+/g, " ");
}

export interface PersonInputs {
  name: string;
  school: string;
  /** Optional extras — validated only when provided. */
  gradYear?: number | null;
  linkedinUrl?: string;
}

/** Validate person inputs: name and school required, the rest optional. */
export function validatePersonInputs(p: PersonInputs): string | null {
  if (!normalizeText(p.name)) return "Name is required.";
  if (!normalizeText(p.school)) return "School is required.";
  if (p.gradYear != null) {
    const year = Number(p.gradYear);
    if (!Number.isInteger(year) || year < 1900 || year > 2100)
      return "Graduation year must be a real year.";
  }
  if (p.linkedinUrl?.trim() && !normalizeLinkedInUrl(p.linkedinUrl))
    return "That doesn't look like a LinkedIn profile URL (linkedin.com/in/…).";
  return null;
}

/* ── LinkedIn finder: deterministic search inputs and candidate scoring ── */

/** Short school names → the entity names LinkedIn-style search understands. */
export const SCHOOL_CANONICAL: Record<string, string> = {
  harvard: "Harvard University",
  stanford: "Stanford University",
  mit: "Massachusetts Institute of Technology",
  yale: "Yale University",
  columbia: "Columbia University",
  cmu: "Carnegie Mellon University",
  "carnegie mellon": "Carnegie Mellon University",
  berkeley: "University of California, Berkeley",
  penn: "University of Pennsylvania",
  upenn: "University of Pennsylvania",
  princeton: "Princeton University",
  georgetown: "Georgetown University",
  cornell: "Cornell University",
  dartmouth: "Dartmouth College",
  brown: "Brown University",
  duke: "Duke University",
  oxford: "University of Oxford",
  caltech: "California Institute of Technology",
  northwestern: "Northwestern University",
  chicago: "University of Chicago",
  utah: "University of Utah",
};

/** Values worth trying in a SCHOOL search filter for this school name. */
export function schoolSearchValues(school: string): string[] {
  const s = normalizeText(school);
  if (!s || s.toLowerCase() === "unknown") return [];
  const out = [s];
  const canon = SCHOOL_CANONICAL[s.toLowerCase()];
  if (canon && canon.toLowerCase() !== s.toLowerCase()) out.push(canon);
  else if (!canon && !/university|college|institute|school/i.test(s))
    out.push(`${s} University`);
  return out;
}

/**
 * Every name this school could plausibly appear under in search evidence.
 * A profile that says "Harvard '25" and a record that says "Harvard
 * University" are the same school; matching raw strings misses that.
 */
export function schoolVariants(school: string): string[] {
  const s = normalizeText(school);
  if (!s || s.toLowerCase() === "unknown") return [];
  const out = new Set<string>([s]);
  const canon = SCHOOL_CANONICAL[s.toLowerCase()];
  if (canon) out.add(canon);
  // Reverse: the record holds the long form, the evidence says "MIT".
  for (const [short, long] of Object.entries(SCHOOL_CANONICAL)) {
    if (long.toLowerCase() === s.toLowerCase()) out.add(short);
  }
  // Generic: "Yale University" → "Yale", "Dartmouth College" → "Dartmouth".
  const stripped = s.replace(/\s+(university|college)$/i, "").trim();
  if (stripped.length >= 3) out.add(stripped);
  return [...out];
}

/**
 * Whole-phrase match inside evidence text. Substring matching is wrong here:
 * "MIT" lives inside "Smith", and a company called "Cue" inside "rescue" —
 * both would score as confirmations of the wrong person.
 */
export function mentionsPhrase(haystack: string, phrase: string): boolean {
  const p = normalizeText(phrase).toLowerCase();
  if (p.length < 3) return false;
  const escaped = p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`).test(
    haystack.toLowerCase()
  );
}

/** "Jane Q. Doe" → { first: "Jane", last: "Doe" }; single names repeat. */
export function splitName(name: string): { first: string; last: string } {
  const tokens = normalizeText(name).split(" ").filter(Boolean);
  return { first: tokens[0] ?? "", last: tokens[tokens.length - 1] ?? "" };
}

/** Does the profile slug carry part of the person's name? (vanity URLs) */
export function slugMatchesName(url: string, name: string): boolean {
  const m = url.toLowerCase().match(/\/in\/([^/?#]+)/);
  if (!m) return false;
  const slug = m[1];
  const { first, last } = splitName(name);
  return [first, last]
    .filter((t) => t.length >= 3)
    .some((t) => slug.includes(t.toLowerCase()));
}

/** One search hit, normalized across providers, ready for scoring. */
export interface FoundProfile {
  url: string;
  name: string;
  /** Whatever descriptive text the search surfaced (headline, evidence). */
  headline: string;
  eduYears: number[];
}

/**
 * Deterministic candidate scoring — no LLM judges identity. Signals:
 * name agreement (mandatory), the school named in the evidence,
 * graduation-year match, company mentioned, name in the URL slug, and a
 * lone-candidate bonus. Two near-tied candidates are both capped below
 * the auto-adopt threshold so a human always picks between look-alikes.
 */
export function scoreLinkedInCandidates(
  person: {
    name: string;
    school?: string | null;
    degree?: string | null;
    gradYear: number | null;
    company: string | null;
  },
  found: FoundProfile[]
): { url: string; confidence: number }[] {
  const variants = person.school ? schoolVariants(person.school) : [];
  const scored = found
    .filter((f) => f.url && namesAgree(f.name, person.name))
    .map((f) => {
      const hay = `${f.name} ${f.headline}`.toLowerCase();
      let c = 0.35;
      // The school confirming is the core signal — a name + school hit is
      // what a person checks when they google someone themselves.
      if (variants.some((v) => mentionsPhrase(hay, v))) c += 0.3;
      if (person.gradYear && f.eduYears.includes(person.gradYear)) c += 0.2;
      if (person.company && mentionsPhrase(hay, person.company)) c += 0.2;
      // Degree is the weakest of the four — plenty of people share one — so
      // it only breaks ties between candidates the rest already rate evenly.
      if (person.degree && mentionsPhrase(hay, person.degree)) c += 0.08;
      if (slugMatchesName(f.url, person.name)) c += 0.15;
      // `raw` is uncapped on purpose: several strong signals saturate the 0.95
      // ceiling, and a capped score can no longer tell two candidates apart.
      // Ranking and the look-alike test read raw; only the answer is capped.
      return { url: f.url, raw: c };
    })
    .sort((a, b) => b.raw - a.raw)
    .slice(0, 3);
  if (scored.length === 1) scored[0].raw += 0.15;
  const capped = scored.map((s) => ({
    url: s.url,
    confidence: Math.min(0.95, s.raw),
  }));
  if (scored.length > 1 && scored[0].raw - scored[1].raw < 0.1) {
    // Look-alikes: never auto-adopt, make the human choose.
    capped[0].confidence = Math.min(0.75, capped[0].confidence);
    capped[1].confidence = Math.min(0.75, capped[1].confidence);
  }
  return capped;
}

/* ── Verification gate ─────────────────────────────────────────────────── */

export interface GateInputs {
  /** Crustdata matched the LinkedIn URL. */
  providerMatched: boolean;
  /** Name returned by the provider (empty when unknown). */
  providerName: string;
  /** Name the user entered (canonical). */
  enteredName: string;
  currentTitle: string | null;
  currentOrganization: string | null;
  /** Interest tags with confidences from classification. */
  interests: { tag: string; confidence: number }[];
  /** Organization suggested by web research, when it ran (else null). */
  webOrganization: string | null;
}

export type GateDecision =
  | { status: "ready"; reason: null }
  | { status: "partial"; reason: string }
  | { status: "needs_review"; reason: string };

/** Loose person-name agreement: shared surname or full containment. */
export function namesAgree(a: string, b: string): boolean {
  const na = normalizeText(a).toLowerCase();
  const nb = normalizeText(b).toLowerCase();
  if (!na || !nb) return true; // nothing to conflict with
  if (na === nb || na.includes(nb) || nb.includes(na)) return true;
  const lastA = na.split(" ").pop()!;
  const lastB = nb.split(" ").pop()!;
  return lastA === lastB;
}

/** Loose org agreement for provider-vs-web conflict detection. */
export function orgsAgree(a: string | null, b: string | null): boolean {
  if (!a || !b) return true;
  const na = normalizeText(a).toLowerCase();
  const nb = normalizeText(b).toLowerCase();
  return na === nb || na.includes(nb) || nb.includes(na);
}

export function verificationGate(g: GateInputs): GateDecision {
  // Conflicts first — they always demand eyes.
  if (g.providerMatched && !namesAgree(g.providerName, g.enteredName)) {
    return {
      status: "needs_review",
      reason: `LinkedIn profile says "${g.providerName}", you entered "${g.enteredName}".`,
    };
  }
  if (!orgsAgree(g.currentOrganization, g.webOrganization)) {
    return {
      status: "needs_review",
      reason: `Provider says ${g.currentOrganization}, web research says ${g.webOrganization}.`,
    };
  }

  const strongInterests = g.interests.filter((i) => i.confidence > 0.7).length;
  if (g.providerMatched && g.currentTitle && strongInterests >= 2) {
    return { status: "ready", reason: null };
  }
  if (!g.providerMatched) {
    return {
      status: "partial",
      reason: "No LinkedIn match found; showing what we know.",
    };
  }
  if (!g.currentTitle || !g.currentOrganization) {
    return { status: "partial", reason: "Current role is missing." };
  }
  return { status: "partial", reason: "Interests are low-confidence." };
}

/* ── Fallback trigger (Agent 6 conditions) ─────────────────────────────── */

export function shouldRunResearchFallback(g: {
  providerMatched: boolean;
  currentTitle: string | null;
  currentOrganization: string | null;
  interests: { tag: string; confidence: number }[];
}): boolean {
  if (!g.providerMatched) return true;
  if (!g.currentTitle || !g.currentOrganization) return true;
  const best = Math.max(0, ...g.interests.map((i) => i.confidence));
  return best < 0.65;
}
