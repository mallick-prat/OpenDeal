/**
 * ── Granola review: pure extraction shaping ─────────────────────────────────
 * Everything here is deterministic and testable: seeding people from the
 * attendee list, validating what the model claims against the note text,
 * refusing to call a grant a financing round, and keeping ranges verbatim.
 * The LLM call itself lives in meetingReview.ts — this file decides what of
 * its output is allowed to survive.
 */

/** Bump when extraction rules change — stamped into meeting_notes.extracted. */
export const REVIEW_EXTRACT_VERSION = "review-v2";

export interface XPerson {
  /** Stable key for UI state + enrichment slots: email, else name slug. */
  key: string;
  name: string;
  email: string | null;
  title: string | null;
  company: string | null;
  school: string | null;
  gradYear: string | null;
  city: string | null;
  linkedin: string | null;
  role: "founder" | "advisor" | "investor" | "customer" | "team" | "unknown";
  /** Verbatim supporting span from the note (null for pure calendar seeds). */
  evidence: string | null;
  fromCalendar: boolean;
}

export interface XFinancing {
  /** Verbatim amount — "$3M–$5M" stays a range, never collapsed. */
  amount: string | null;
  security: string | null;
  round: string | null;
  valuation: string | null;
  status: "current" | "planned" | "historical" | "discussed";
  targetClose: string | null;
  investors: string[];
  evidence: string | null;
}

export interface XCompany {
  name: string | null;
  domain: string | null;
  description: string | null;
  location: string | null;
  evidence: string | null;
}

export interface NoteExtraction {
  version: string;
  company: XCompany | null;
  financing: XFinancing | null;
  people: XPerson[];
}

const SERVICE_RE =
  /noreply|no-reply|donotreply|calendar-notification|@resource\.calendar\.google\.com$|@group\.calendar\.google\.com$|@zoom\.us$|@calendly\.com$|assistant@|scheduler@/i;
const GENERIC_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "yahoo.com",
  "icloud.com", "me.com", "aol.com", "proton.me", "protonmail.com", "hey.com",
]);
/**
 * Money that is NOT venture financing: grants, awards, contracts, revenue.
 * A "$34M NIST CRDP award" must never become the round size.
 */
const GRANT_RE =
  /\b(grant|award|awarded|nist|nsf|sbir|sttr|darpa|dod|contract|crdp|revenue|arr|bookings|customers? paying|purchase order)\b/i;
const AMOUNT_RE = /[$€£]\s?\d|[\d.]+\s?(m|k|b|million|billion|thousand)\b/i;

export function isServiceAccount(email: string): boolean {
  return SERVICE_RE.test(email);
}

export function domainOf(email: string | null | undefined): string | null {
  if (!email) return null;
  const at = email.lastIndexOf("@");
  return at > 0 ? email.slice(at + 1).toLowerCase() : null;
}

export function isGenericDomain(domain: string | null): boolean {
  return !domain || GENERIC_DOMAINS.has(domain.toLowerCase());
}

export function looksLikeGrant(text: string | null | undefined): boolean {
  return !!text && GRANT_RE.test(text);
}

/**
 * Whitespace/case-insensitive containment: the model must quote the note.
 * Curly quotes and long dashes normalize too — "Onyxite’s" must match a
 * model quote written with a straight apostrophe.
 */
export function spanInSource(span: string, source: string): boolean {
  const norm = (s: string) =>
    s
      .toLowerCase()
      .replace(/[’‘]/g, "'")
      .replace(/[“”]/g, '"')
      .replace(/[–—]/g, "-")
      .replace(/\s+/g, " ")
      .trim();
  const needle = norm(span);
  if (needle.length < 4) return false;
  return norm(source).includes(needle);
}

/** "avery.stone" → "Avery Stone"; a bare token still gets its capital. */
export function prettyLocalPart(local: string): string {
  return local
    .split(/[._-]+/)
    .filter(Boolean)
    .map((t) => t.charAt(0).toUpperCase() + t.slice(1))
    .join(" ");
}

export function personKey(name: string, email: string | null): string {
  return (email ?? name).toLowerCase().replace(/[^a-z0-9@._-]+/g, "-").slice(0, 80);
}

/** External attendees become people rows before any model runs. */
export function seedPeople(
  participants: { name: string | null; email: string | null }[],
  internalRe: RegExp
): XPerson[] {
  const out: XPerson[] = [];
  const seen = new Set<string>();
  for (const p of participants) {
    const email = p.email?.trim().toLowerCase() || null;
    if (email && (internalRe.test(email) || isServiceAccount(email))) continue;
    if (!email && !p.name?.trim()) continue;
    const name = p.name?.trim() || (email ? prettyLocalPart(email.split("@")[0]) : "");
    const key = personKey(name, email);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      key, name, email,
      title: null, company: null, school: null, gradYear: null, city: null,
      linkedin: null, role: "unknown",
      evidence: null, fromCalendar: true,
    });
  }
  return out;
}

const ROLES = new Set(["founder", "advisor", "investor", "customer", "team", "unknown"]);
const STATUSES = new Set(["current", "planned", "historical", "discussed"]);

function str(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t ? t.slice(0, max) : null;
}

/**
 * Take the model's raw JSON and keep only what the note can prove.
 * - company/financing facts need a verbatim evidence span from the source;
 * - financing that reads like a grant/award/contract/revenue is dropped;
 * - amounts must actually contain money;
 * - people not on the invite need evidence; invitees merge by email/name.
 */
export function validateExtraction(
  raw: unknown,
  source: string,
  seeds: XPerson[]
): NoteExtraction {
  const r = (raw ?? {}) as Record<string, unknown>;
  const out: NoteExtraction = {
    version: REVIEW_EXTRACT_VERSION,
    company: null,
    financing: null,
    people: [...seeds],
  };

  const rc = r.company as Record<string, unknown> | null | undefined;
  if (rc && typeof rc === "object") {
    const evidence = str(rc.evidence, 240);
    const proven = !!evidence && spanInSource(evidence, source);
    const name = str(rc.name, 120);
    if (name && proven) {
      out.company = {
        name,
        domain: str(rc.domain, 120)?.toLowerCase().replace(/^www\./, "") ?? null,
        description: str(rc.description, 300),
        location: str(rc.location, 120),
        evidence,
      };
    }
  }

  const rf = r.financing as Record<string, unknown> | null | undefined;
  if (rf && typeof rf === "object") {
    const evidence = str(rf.evidence, 240);
    const amount = str(rf.amount, 60);
    const statusRaw = str(rf.status, 20)?.toLowerCase();
    const ok =
      !!evidence &&
      spanInSource(evidence, source) &&
      !looksLikeGrant(evidence) &&
      !looksLikeGrant(amount) &&
      (!amount || AMOUNT_RE.test(amount));
    if (ok && (amount || str(rf.round, 60) || str(rf.security, 40))) {
      out.financing = {
        amount,
        security: str(rf.security, 40),
        round: str(rf.round, 60),
        valuation: str(rf.valuation, 60),
        status: (STATUSES.has(statusRaw ?? "") ? statusRaw : "discussed") as XFinancing["status"],
        targetClose: str(rf.targetClose, 60),
        investors: (Array.isArray(rf.investors) ? rf.investors : [])
          .map((i) => str(i, 80))
          .filter((i): i is string => !!i)
          .slice(0, 6),
        evidence,
      };
    }
  }

  const people = Array.isArray(r.people) ? r.people : [];
  for (const rp of people.slice(0, 8)) {
    const p = rp as Record<string, unknown>;
    const name = str(p.name, 120);
    if (!name) continue;
    const email = str(p.email, 200)?.toLowerCase() ?? null;
    const evidence = str(p.evidence, 240);
    const roleRaw = str(p.role, 20)?.toLowerCase();
    // Merge into an existing row when the email or the name lines up. A bare
    // first name ("Adam") merges into a full-named invitee ("Adam Smith"),
    // but two different full-named Adams stay two people.
    const nameNorm = name.toLowerCase();
    const first = nameNorm.split(/\s+/)[0];
    const seedIdx = out.people.findIndex((s) => {
      if (email && s.email === email) return true;
      const sNorm = s.name.toLowerCase();
      if (sNorm === nameNorm) return true;
      const sFirst = sNorm.split(/\s+/)[0];
      const oneIsBare = !nameNorm.includes(" ") || !sNorm.includes(" ");
      return oneIsBare && sFirst === first;
    });
    const li = str(p.linkedin, 300);
    const yr = str(p.gradYear, 12);
    const fields = {
      title: str(p.title, 120),
      company: str(p.company, 120),
      school: str(p.school, 120),
      gradYear: yr && /\b(19|20)\d{2}\b/.test(yr) ? (yr.match(/\b(19|20)\d{2}\b/) ?? [null])[0] : null,
      city: str(p.city, 120),
      linkedin: li && /linkedin\.com\//i.test(li) ? li : null,
      role: (ROLES.has(roleRaw ?? "") ? roleRaw : "unknown") as XPerson["role"],
    };
    if (seedIdx >= 0) {
      const s = out.people[seedIdx];
      out.people[seedIdx] = {
        ...s,
        name: s.name.length >= name.length ? s.name : name,
        email: s.email ?? email,
        title: s.title ?? fields.title,
        company: s.company ?? fields.company,
        school: s.school ?? fields.school,
        gradYear: s.gradYear ?? fields.gradYear,
        city: s.city ?? fields.city,
        linkedin: s.linkedin ?? fields.linkedin,
        role: s.role === "unknown" ? fields.role : s.role,
        evidence: s.evidence ?? evidence,
      };
    } else {
      // Not on the invite: the note itself must name them.
      if (!evidence || !spanInSource(evidence, source)) continue;
      out.people.push({
        key: personKey(name, email),
        name, email,
        ...fields,
        evidence,
        fromCalendar: false,
      });
    }
  }
  return out;
}

/** "Found Onyxite, 3 people, and a possible $3M–$5M SAFE." */
export function summaryLine(x: NoteExtraction): string {
  const bits: string[] = [];
  if (x.company?.name) bits.push(x.company.name);
  if (x.people.length > 0)
    bits.push(`${x.people.length} ${x.people.length === 1 ? "person" : "people"}`);
  if (x.financing) {
    const f = [x.financing.amount, x.financing.security ?? x.financing.round]
      .filter(Boolean)
      .join(" ");
    bits.push(`a possible ${f || "financing"}`);
  }
  if (bits.length === 0) return "Nothing structured found.";
  if (bits.length === 1) return `Found ${bits[0]}.`;
  return `Found ${bits.slice(0, -1).join(", ")} and ${bits[bits.length - 1]}.`;
}

/**
 * A readable company name from a work domain when the note itself never
 * says one: "gentle.xyz" → "Gentle", "acme-robotics.com" → "Acme Robotics",
 * "getgentle.com" → "Gentle" (marketing prefixes stripped). Null for mail
 * providers and schools, which name nobody.
 */
export function companyNameFromDomain(domain: string | null | undefined): string | null {
  if (!domain) return null;
  const d = domain.toLowerCase().trim();
  if (isGenericDomain(d) || /\.edu$|\.ac\.[a-z]{2}$/.test(d)) return null;
  let label = d.replace(/^www\./, "").split(".")[0] ?? "";
  if (!label) return null;
  const m = label.match(/^(get|try|use|join|hello|go|my|the|with)([a-z0-9-]{4,})$/);
  if (m) label = m[2];
  const words = label.split(/[-_]+/).filter(Boolean);
  if (words.length === 0) return null;
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}
