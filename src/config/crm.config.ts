import type { StageKey } from "@/lib/types";
import { normalizeHex } from "@/lib/brandPure";

/**
 * ── Make this CRM yours ─────────────────────────────────────────────────────
 * This is the ONE file you edit to customize the product. Everything the app
 * says about "who we are" lives here; no other file hardcodes an org name,
 * domain, timezone, or stage label.
 *
 * Four things can be set WITHOUT editing code, via environment variables
 * (set them in Vercel → Settings → Environment Variables, or in .env.local):
 *
 *   NEXT_PUBLIC_ORG_NAME      Your fund / team name         (default "Your Fund")
 *   NEXT_PUBLIC_TEAM_DOMAINS  Comma-separated email domains  (default "example.com")
 *                             that belong to YOUR team. Anyone at these
 *                             domains is "internal", never mistaken for a
 *                             founder, and meetings with only them are skipped.
 *   NEXT_PUBLIC_TIMEZONE      IANA timezone for every date    (default "America/New_York")
 *   NEXT_PUBLIC_BRAND_COLOR   Your brand hex, e.g. #0e7c66   (default #0f62fe, blue)
 *
 * They're NEXT_PUBLIC_* because the browser renders dates and names too.
 * The pipeline stages and tag labels below are code, because they're
 * structure, not secrets.
 */

function list(raw: string | undefined, fallback: string[]): string[] {
  const out = (raw ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return out.length > 0 ? out : fallback;
}

export const crm = {
  org: {
    name: process.env.NEXT_PUBLIC_ORG_NAME?.trim() || "Your Fund",
    /** Email domains that are YOUR team. */
    domains: list(process.env.NEXT_PUBLIC_TEAM_DOMAINS, ["example.com"]),
    /** Every date in the product renders in this zone, regardless of where
     *  the reader sits, so "added Jul 8" means the same day for everyone. */
    timezone: process.env.NEXT_PUBLIC_TIMEZONE?.trim() || "America/New_York",
    locale: "en-US",
  },

  brand: {
    /**
     * Your color. One hex drives the whole theme: buttons, links, focus
     * rings, the logo mark, charts, and emails. (Set NEXT_PUBLIC_BRAND_COLOR,
     * or edit the fallback here. The shade ramp is derived: lib/brandPure.ts.)
     */
    primary: normalizeHex(process.env.NEXT_PUBLIC_BRAND_COLOR, "#0f62fe"),
  },

  /** Heading above the board. */
  pipelineName: "Pipeline",

  /** Financing rounds offered in the deal form and accepted from AI extraction. */
  rounds: ["Angel", "Pre-Seed", "Seed", "Series A", "Series B", "Later"] as string[],

  inbound: {
    /**
     * The shared mailbox founders (or your team, forwarding) send pitches to.
     * Optional: with none set, the inbox simply stays empty. Set it to
     * deals@yourfund.com (or whatever) via NEXT_PUBLIC_INBOUND_MAILBOX.
     */
    address:
      (process.env.NEXT_PUBLIC_INBOUND_MAILBOX ?? process.env.INBOUND_MAILBOX ?? "")
        .trim()
        .toLowerCase(),
  },

  /**
   * The funnel. The `key`s are INTERNAL ids stored in the database and
   * referenced by logic (passing a deal moves it to "passed", a new deal
   * starts at "to-meet"), so don't rename or remove a key. Everything
   * else (label, short label, color, order, whether it counts as live
   * pipeline) is yours to change. Reorder by moving entries.
   *
   * `active: true` means "live pipeline" (counted in funnel stats); the two
   * pass stages and anything you mark inactive are excluded.
   */
  stages: [
    { key: "to-meet", label: "To Meet", short: "To Meet", color: "#d0e2ff", active: true },
    { key: "first-meeting", label: "First Meeting", short: "1st Meeting", color: "#78a9ff", active: true },
    { key: "cultivate", label: "Following", short: "Following", color: "#4589ff", active: true },
    { key: "elevate", label: "Partner Review", short: "Review", color: "#0f62fe", active: true },
    { key: "diligence", label: "Diligence", short: "Diligence", color: "#0043ce", active: true },
    { key: "offered", label: "Offered", short: "Offered", color: "#002d9c", active: true },
    { key: "to-pass", label: "To Pass", short: "To Pass", color: "#c6c6c6", active: false },
    { key: "passed", label: "Passed/Dead", short: "Passed", color: "#e0e0e0", active: false },
  ] satisfies {
    key: StageKey;
    label: string;
    short: string;
    color: string;
    active: boolean;
  }[],

  /**
   * Deals carry free-form tags. We call them "schools" internally (the
   * original use case was university-network investing) but the label is
   * yours: "Sector", "Source", "Vertical", "Cohort", anything.
   */
  tags: {
    singular: "Tag",
    plural: "Tags",
    /** Pinned at the top of the tag filter. */
    quickFilters: [] as string[],
    /** Optional chip colors by lowercase tag name; unlisted tags are gray. */
    colors: {} as Record<string, string>,
  },
} as const;

export type CrmConfig = typeof crm;

/** The domain part of an address, lowercased ("" when there isn't one). */
export function emailDomain(email: string | null | undefined): string {
  const e = (email ?? "").trim().toLowerCase();
  const at = e.lastIndexOf("@");
  return at < 0 ? "" : e.slice(at + 1);
}

/**
 * Domains that are YOURS: your team's, plus the inbound mailbox's (mail we
 * forward or CC to ourselves arrives FROM there and must not read as a founder).
 */
export const INTERNAL_DOMAIN_SET: ReadonlySet<string> = new Set(
  [...crm.org.domains, emailDomain(crm.inbound.address)].filter(Boolean)
);

/** Is this address someone on YOUR team (per NEXT_PUBLIC_TEAM_DOMAINS)? */
export function isInternalEmail(email: string | null | undefined): boolean {
  return INTERNAL_DOMAIN_SET.has(emailDomain(email));
}

/**
 * Where this app lives, for links in emails. Server-side only (reads
 * non-public env). Set APP_URL in production; falls back to AUTH_URL.
 */
export function appUrl(): string {
  return (
    process.env.APP_URL?.trim() ||
    process.env.NEXT_PUBLIC_APP_URL?.trim() ||
    process.env.AUTH_URL?.trim() ||
    "http://localhost:3000"
  ).replace(/\/+$/, "");
}

/** The From header for outgoing app email (sign-in codes, invites). */
export function emailFrom(): string {
  return process.env.EMAIL_FROM?.trim() || `${crm.org.name} <onboarding@resend.dev>`;
}
