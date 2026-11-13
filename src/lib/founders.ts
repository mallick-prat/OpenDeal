/**
 * ── Founder block ↔ notes text ──────────────────────────────────────────────
 * Deals store founders as a plain-text block at the end of the notes:
 *
 *   Founders:
 *   • Jane Doe — Harvard — https://www.linkedin.com/in/janedoe
 *
 * These pure helpers turn that block into structured rows (so the edit card
 * can show the same founder UI as the create card) and back again.
 */

export interface FounderRow {
  name: string;
  school: string;
  linkedin: string;
  /** The address the deal's meeting + mail history is matched on. */
  email: string;
}

const BULLET = /^[•*-]\s*/;
const SEP = /\s+[—–-]\s+/; // any dash style, so hand-edited notes still parse

/** "Jane Doe — Harvard — jane@co.com — linkedin.com/in/janedoe" → a row. */
export function parseFounderLine(line: string): FounderRow | null {
  const parts = line
    .replace(BULLET, "")
    .split(SEP)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) return null;
  const [name, ...rest] = parts;
  // A bullet that leads with a URL is a link list, not a founder entry.
  if (/https?:\/\/|www\.|linkedin\.com|\.com\//i.test(name)) return null;
  let school = "";
  let linkedin = "";
  let email = "";
  for (const p of rest) {
    if (/linkedin\.com|^https?:\/\//i.test(p)) {
      if (!linkedin) linkedin = p;
    } else if (p.includes("@") && !/\s/.test(p)) {
      // An address is unmistakable, and order-independent — hand-edited notes
      // put it wherever they like.
      if (!email) email = p.toLowerCase();
    } else if (!school) {
      school = p;
    }
  }
  return { name, school, linkedin, email };
}

/** Split notes into the founders block (as rows) and everything else. */
export function extractFounders(notes: string): {
  founders: FounderRow[];
  rest: string;
} {
  const founders: FounderRow[] = [];
  const keep: string[] = [];
  let inBlock = false;
  for (const line of notes.split("\n")) {
    const t = line.trim();
    if (/^founders:?$/i.test(t)) {
      inBlock = true;
      continue;
    }
    if (inBlock) {
      if (BULLET.test(t)) {
        const row = parseFounderLine(t);
        // Unparseable bullets (link lists etc.) stay in the notes untouched.
        if (row) {
          founders.push(row);
          continue;
        }
        inBlock = false;
        keep.push("Founders:"); // the heading belongs with its list
        keep.push(line);
        continue;
      }
      inBlock = false;
      if (t === "") continue; // the blank line that separated the block
    }
    keep.push(line);
  }
  const rest = keep.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return { founders, rest };
}

/** Recompose notes: freeform text first, founders block last. */
export function composeNotes(rest: string, founders: FounderRow[]): string {
  const lines = founders
    .filter((f) => f.name.trim())
    .map(
      (f) =>
        `• ${[f.name.trim(), f.school.trim(), f.email.trim(), f.linkedin.trim()]
          .filter(Boolean)
          .join(" — ")}`
    );
  return [rest.trim(), lines.length ? `Founders:\n${lines.join("\n")}` : ""]
    .filter(Boolean)
    .join("\n\n");
}

const MONTH_NUM: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/**
 * LinkedIn's human date strings → the app's sortable ISO-ish form.
 * "Mar 2022" → "2022-03", "2022" → "2022", "Present" → null.
 */
export function linkedInDateToIso(raw?: string | null): string | null {
  if (!raw) return null;
  const t = raw.trim().toLowerCase();
  if (!t || /present|current|now/.test(t)) return null;
  const ym = t.match(/^([a-z]{3,9})\.?\s+(\d{4})$/);
  if (ym) {
    const m = MONTH_NUM[ym[1].slice(0, 3)];
    return m ? `${ym[2]}-${String(m).padStart(2, "0")}` : ym[2];
  }
  const y = t.match(/\b(19|20)\d{2}\b/);
  return y ? y[0] : null;
}

/** "Jane Doe, Bo Chen // Acme" → "Acme"; plain names pass through. */
export function companyFromDealName(name: string): string {
  const parts = name.split("//");
  return (parts.length > 1 ? parts[parts.length - 1] : name).trim();
}

/** Person-shaped: 2+ words of letters — no URLs, counts, or descriptors. */
const PERSON_NAME = /^[\p{L}][\p{L}.'-]*(\s+[\p{L}][\p{L}.'-]*)+$/u;

/** "Jane Doe, Bo Chen // Acme" → ["Jane Doe", "Bo Chen"]; no "//" → none. */
export function founderNamesFromDealName(name: string): string[] {
  const parts = name.split("//");
  if (parts.length < 2) return [];
  return parts[0]
    .split(/,|&| and /i)
    .map((n) => n.trim())
    .filter((n) => PERSON_NAME.test(n));
}

const LINKEDIN_URL = /https?:\/\/(?:www\.)?linkedin\.com\/in\/[^\s)\]}>,;]+/gi;

/**
 * Everything we can learn about a deal's founders from the card itself:
 * the structured notes block first, then names from the deal title,
 * a school tag when the deal has exactly one, and any LinkedIn profile
 * URL in the notes when it can be matched unambiguously.
 */
export function foundersFromDeal(deal: {
  name: string;
  notes: string;
  schools: string[];
}): FounderRow[] {
  const { founders } = extractFounders(deal.notes);
  const have = new Set(founders.map((f) => f.name.toLowerCase()));

  // Founders named in the title but not in the notes block.
  for (const n of founderNamesFromDealName(deal.name)) {
    if (!have.has(n.toLowerCase())) {
      founders.push({ name: n, school: "", linkedin: "", email: "" });
      have.add(n.toLowerCase());
    }
  }

  // One school tag on the deal → safe to assume for founders missing one.
  const soloSchool = deal.schools.length === 1 ? deal.schools[0].trim() : "";
  // LinkedIn URLs loose in the notes (outside the block), unclaimed ones only.
  const claimed = new Set(founders.map((f) => f.linkedin.toLowerCase()).filter(Boolean));
  const loose = [...new Set(deal.notes.match(LINKEDIN_URL) ?? [])].filter(
    (u) => !claimed.has(u.toLowerCase())
  );
  const missing = founders.filter((f) => !f.linkedin);

  return founders
    // Bulk imports only build rows for names that look like real people.
    .filter((f) => PERSON_NAME.test(f.name))
    .map((f) => ({
      name: f.name,
      school: f.school || soloSchool,
      // Only assign a loose URL when the match can't be wrong.
      linkedin:
        f.linkedin ||
        (missing.length === 1 && loose.length === 1 && !f.linkedin ? loose[0] : ""),
      email: "",
    }));
}
