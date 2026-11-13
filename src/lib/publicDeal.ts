import "server-only";
import { sql } from "./db";
import { withRetry } from "./retry";
import { isoDate } from "./db";
import { splitDealName } from "./nameParts";
import { schoolColor } from "./stages";
import { extractFounders, type FounderRow } from "./founders";

/** A short, clean "what the company does" line (for the OG thumbnail): the
 *  founders block and any Raising/valuation lines removed, then clamped. */
function publicSummary(rest: string): string | null {
  const cleaned = rest
    .split("\n")
    .filter((l) => !/^\s*(raising|round|valuation|raise|check)\s*:/i.test(l))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return null;
  return cleaned.length > 160 ? `${cleaned.slice(0, 157)}…` : cleaned;
}

/** The full entered description (notes minus the founders block), tidied of
 *  runaway blank lines and clamped to a sane length. Line breaks preserved. */
function publicDescription(rest: string): string | null {
  const text = rest.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!text) return null;
  return text.length > 4000 ? `${text.slice(0, 3997)}…` : text;
}

/**
 * ── Public (read-only) deal view ─────────────────────────────────────────────
 * Everything ENTERED on the deal, shown read-only to anyone with the link:
 * company, founders (name/school/LinkedIn), schools, financing, round, the full
 * description, and date. Internal-only signals (comments, decisions, owners,
 * activity, board stage) are NEVER exposed. Public-leaning: anyone with the
 * share link can read the entered fields, including deals that started life
 * as private (inbound / extension). Team-only surfaces still honor visibility.
 */
export interface PublicDeal {
  gid: string;
  company: string;
  founder: string; // single line, for the compact card / OG
  founders: FounderRow[]; // structured list, for the full page
  summary: string | null; // short one-liner for the OG thumbnail
  description: string | null; // the full entered description
  school: string | null; // first school (card accent)
  schools: string[]; // all schools
  schoolColor: string;
  financing: string | null;
  round: string | null;
  created: string; // YYYY-MM-DD
}

export async function getPublicDeal(gid: string): Promise<PublicDeal | null> {
  // Real (synced) gids and local- gids are both shareable — a deal born
  // in-app has a working link immediately.
  if (!/^(\d{1,30}|local-[0-9a-f-]{36})$/.test(gid)) return null;
  const rows = await withRetry(
    () => sql<
      {
        gid: string;
        name: string | null;
        schools: string[] | null;
        financing_amount: string | null;
        round: string | null;
        created_on: Date | null;
        visibility: string | null;
        notes: string | null;
      }[]
    >`
      select gid, name, schools, financing_amount, round, created_on, visibility,
             left(notes, 8000) as notes
      from deals where gid = ${gid}
    `
  );
  const r = rows[0];
  if (!r) return null;
  // Link is the capability. Visibility still gates the team board / search;
  // the share page itself is public-leaning so a copied /deals/[gid] works.

  const { founder, company } = splitDealName(r.name ?? "");
  const { founders, rest } = extractFounders(String(r.notes ?? ""));
  const schools = (r.schools ?? []).filter(Boolean);
  const school = schools[0] ?? null;
  return {
    gid: r.gid,
    company,
    // Prefer the structured founder names; fall back to the name prefix.
    founder: founders.length ? founders.map((f) => f.name).join(", ") : founder,
    founders,
    summary: publicSummary(rest),
    description: publicDescription(rest),
    school,
    schools,
    schoolColor: school ? schoolColor(school) : "#101828",
    financing: r.financing_amount ?? null,
    round: r.round ?? null,
    created: isoDate(r.created_on),
  };
}
