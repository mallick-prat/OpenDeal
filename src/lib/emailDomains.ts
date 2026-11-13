/**
 * ── Email domain classification (pure) ───────────────────────────────────────
 * Founders pitch from wherever they happen to live: a personal Gmail, a school
 * address, or a company domain. All three are perfectly good identities for
 * *that person* — matching their exact address is always safe.
 *
 * What is NOT safe is expanding a match to the whole domain. "Everyone at
 * luminalabs.io" is a useful question — it finds co-founders and staff we've
 * talked to. "Everyone at gmail.com" or "everyone at college.harvard.edu" is
 * not a question at all; it matches thousands of unrelated people.
 *
 * So: exact match always, domain expansion only for corporate domains.
 * Co-founders on a consumer or school address are recovered from the email
 * thread instead (see emailThread.ts), which is evidence rather than a guess.
 */

export type DomainKind = "consumer" | "academic" | "corporate";

/** Mailbox providers — an address here identifies a person, never an org. */
const CONSUMER_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "yahoo.com",
  "yahoo.co.uk",
  "ymail.com",
  "hotmail.com",
  "hotmail.co.uk",
  "outlook.com",
  "live.com",
  "msn.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
  "pm.me",
  "gmx.com",
  "gmx.de",
  "mail.com",
  "zoho.com",
  "yandex.com",
  "fastmail.com",
  "hey.com",
  "duck.com",
  "qq.com",
  "163.com",
  "126.com",
  "naver.com",
  "hanmail.net",
  "daum.net",
]);

/**
 * Academic suffixes. Deliberately suffix-based rather than an allowlist:
 * universities run endless subdomains (college.harvard.edu, g.ucla.edu,
 * alumni.stanford.edu, students.iit.ac.in) and we must catch all of them.
 */
const ACADEMIC_SUFFIXES = [
  ".edu",
  ".ac.uk",
  ".ac.jp",
  ".ac.in",
  ".ac.nz",
  ".ac.kr",
  ".ac.il",
  ".ac.za",
  ".edu.au",
  ".edu.cn",
  ".edu.sg",
  ".edu.hk",
  ".edu.in",
  ".edu.br",
  ".edu.mx",
  ".uni-heidelberg.de",
  ".ethz.ch",
  ".epfl.ch",
];

/** "Lydia Chang <Lydia@Lumina.IO>" → "lumina.io"; "" when unparseable. */
export function domainOf(email: string): string {
  const at = String(email ?? "").trim().toLowerCase().lastIndexOf("@");
  if (at < 0) return "";
  return email.trim().toLowerCase().slice(at + 1).replace(/[>\s,;]+$/, "");
}

export function classifyDomain(email: string): DomainKind {
  const d = domainOf(email);
  if (!d) return "consumer"; // unparseable is never safe to expand on
  if (CONSUMER_DOMAINS.has(d)) return "consumer";
  if (ACADEMIC_SUFFIXES.some((s) => d === s.slice(1) || d.endsWith(s))) {
    return "academic";
  }
  return "corporate";
}

/**
 * May we treat everyone at this domain as connected to the same company?
 * True only for corporate domains — the whole point of the classification.
 */
export function canExpandToDomain(email: string): boolean {
  return classifyDomain(email) === "corporate";
}

/**
 * The set of addresses to match a founder on, plus the company domain to
 * expand to when that's meaningful. Domain expansion is reported separately
 * so "4 with Lydia, 7 more with Lumina Labs" stays an honest distinction
 * rather than one inflated number.
 */
export function matchTargets(emails: string[]): {
  addresses: string[];
  domains: string[];
} {
  const addresses = Array.from(
    new Set(
      emails
        .map((e) => String(e ?? "").trim().toLowerCase())
        .filter((e) => e.includes("@"))
    )
  );
  const domains = Array.from(
    new Set(addresses.filter(canExpandToDomain).map(domainOf).filter(Boolean))
  );
  return { addresses, domains };
}

/**
 * Does an address's local part plausibly belong to this person?
 *
 * Display names are absent from ~94% of calendar attendees, so name-based
 * matching alone finds almost nothing. But once a founder is known at a
 * company domain, other addresses on that same domain are strong candidates —
 * and the local part usually says whose. "Ian Lee" covers ian@, ianlee@,
 * ian.lee@, ilee@, i.lee@, leei@ and lee@.
 *
 * Deliberately conservative: it must match a whole recognised form, not merely
 * contain a name, or "brian@" would match "Ian". This only ever produces a
 * suggestion for a human to accept, never a stored fact.
 */
export function localPartMatchesName(email: string, fullName: string): boolean {
  const local = String(email ?? "")
    .toLowerCase()
    .split("@")[0]
    // Gmail-style tags and separators carry no identity.
    .replace(/\+.*$/, "")
    .replace(/[._-]/g, "");
  if (!local) return false;

  const parts = String(fullName ?? "")
    .toLowerCase()
    .replace(/[^a-z\s'-]/g, " ")
    .split(/\s+/)
    .map((p) => p.replace(/['-]/g, ""))
    .filter((p) => p.length > 1);
  if (parts.length === 0) return false;

  const first = parts[0];
  const last = parts[parts.length - 1];
  const forms = new Set<string>([first, last]);
  if (parts.length > 1) {
    forms.add(first + last);
    forms.add(last + first);
    forms.add(first[0] + last);
    forms.add(last[0] + first);
    forms.add(first + last[0]);
  }
  return forms.has(local);
}
