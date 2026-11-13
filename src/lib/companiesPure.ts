import { getDomain } from "tldts";

/**
 * ── Company identity, pure ──────────────────────────────────────────────────
 * The durable Company sits above deals: one row per real-world company,
 * surviving renames, pivots, and repeat financings. These helpers produce
 * the two match keys everything else relies on:
 *
 *   normalized_domain — strongest evidence (eTLD+1, never a freemail host)
 *   name_normalized   — legal-suffix-stripped fold for exact + trigram match
 *
 * Matching POLICY (who may auto-link) lives with the callers; this module
 * only answers "what does this string normalize to".
 */

/** Legal/entity suffixes that don't distinguish companies. Order-insensitive. */
const LEGAL_SUFFIXES = new Set([
  "inc", "incorporated", "llc", "ltd", "limited", "corp", "corporation",
  "co", "company", "gmbh", "sas", "bv", "ab", "oy", "plc", "pbc", "pte",
  "labs", "lab", "technologies", "technology", "tech", "ai", "hq", "app",
]);

/** Freemail + provider hosts that must never become a company's domain. */
const NON_COMPANY_HOSTS = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "outlook.com", "hotmail.com",
  "live.com", "icloud.com", "me.com", "mac.com", "aol.com", "proton.me",
  "protonmail.com", "pm.me", "hey.com", "fastmail.com", "zoho.com",
  "gmx.com", "gmx.net", "mail.com", "yandex.com", "msn.com", "comcast.net",
  "verizon.net", "att.net", "sbcglobal.net", "duck.com", "tutanota.com",
]);

/**
 * Lowercased, NFKC-folded, punctuation-stripped company name with trailing
 * legal suffixes removed. "Acme Technologies, Inc." → "acme".
 * Suffix stripping never empties the name ("Labs" stays "labs").
 */
export function normalizeCompanyName(raw: string): string {
  const folded = raw
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!folded) return "";
  const words = folded.split(" ");
  while (words.length > 1 && LEGAL_SUFFIXES.has(words[words.length - 1])) {
    words.pop();
  }
  return words.join(" ");
}

/**
 * Registrable domain (eTLD+1) from a URL, bare host, or email address —
 * or null when there isn't a usable company domain (freemail, invalid,
 * IP literals, etc.). "https://www.acme.co.uk/about" → "acme.co.uk".
 */
export function normalizeCompanyDomain(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let host = raw.trim().toLowerCase();
  if (!host) return null;
  // Email → host part.
  const at = host.lastIndexOf("@");
  if (at !== -1) host = host.slice(at + 1);
  const domain = getDomain(host, { allowPrivateDomains: false });
  if (!domain) return null;
  if (NON_COMPANY_HOSTS.has(domain)) return null;
  return domain;
}

/** True when this email's domain is safe to use as company evidence. */
export function isCompanyEmailDomain(email: string): boolean {
  return normalizeCompanyDomain(email) !== null;
}

/**
 * Dice coefficient over character bigrams — mirrors pg_trgm semantics
 * closely enough that JS re-ranking agrees with SQL recall. 0..1.
 */
export function nameSimilarity(a: string, b: string): number {
  const na = normalizeCompanyName(a);
  const nb = normalizeCompanyName(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const bigrams = (s: string) => {
    const m = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2);
      m.set(g, (m.get(g) ?? 0) + 1);
    }
    return m;
  };
  const ba = bigrams(na);
  const bb = bigrams(nb);
  let overlap = 0;
  let total = 0;
  for (const [, n] of ba) total += n;
  for (const [, n] of bb) total += n;
  if (total === 0) return 0;
  for (const [g, n] of ba) {
    const other = bb.get(g);
    if (other) overlap += Math.min(n, other);
  }
  return (2 * overlap) / total;
}

/**
 * Short names make trigram scores noisy ("Box" matches "Boxed", "Dropbox").
 * Auto-link thresholds scale up as names get shorter; ≤3 chars never
 * auto-links on name evidence alone.
 */
export function autoLinkThreshold(name: string): number {
  const n = normalizeCompanyName(name);
  if (n.length <= 3) return Infinity;
  if (n.length <= 5) return 0.95;
  if (n.length <= 8) return 0.9;
  return 0.85;
}

/**
 * Our own mail must never read as "history with this company": a pitch
 * forwarded by a teammate arrives FROM your own domain, and matching on that
 * would proudly report five emails with ourselves. Which domains count as
 * yours is configured (NEXT_PUBLIC_TEAM_DOMAINS), see src/config/crm.config.ts.
 */
export { INTERNAL_DOMAIN_SET as INTERNAL_DOMAINS, isInternalEmail } from "@/config/crm.config";
