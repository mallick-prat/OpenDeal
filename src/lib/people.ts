import "server-only";
import { sql } from "./db";
import { logEvent } from "./log";
import { logActivity } from "./users";
import { normalizeLinkedInUrl, normalizeText } from "./networkRules";
import { linkedInDateToIso } from "./founders";
import { STAGE_BY_KEY } from "./stages";
import type { StageKey } from "./types";

/**
 * ── People ──────────────────────────────────────────────────────────────────
 * A deal's founders are rows in `network_people` (the table's name is
 * historical; think "people"), joined to deals through `deal_founders`.
 * This module is the one place that creates and updates them.
 */

export interface Founder {
  linkedinUrl: string;
  fullName: string;
  headline?: string;
  location?: string;
  currentCompany?: string;
  currentTitle?: string;
  about?: string;
  experience: {
    companyName: string;
    title: string;
    startDate?: string;
    endDate?: string;
    location?: string;
    description?: string;
  }[];
  education: {
    schoolName: string;
    degree?: string;
    field?: string;
    startDate?: string;
    endDate?: string;
    description?: string;
  }[];
}

/**
 * Create or update a person from what we know about a founder (typically a
 * LinkedIn URL plus whatever the pitch said). Existing rows are only ever
 * filled in where empty: a human's edits always win over a later guess.
 */
export async function upsertPersonFromFounder(
  founder: Founder,
  schoolTag: string | null,
  addedBy: string,
  opts?: { rawProfileText?: string }
): Promise<{ id: string; existed: boolean }> {
  const linkedin = normalizeLinkedInUrl(founder.linkedinUrl);
  if (!linkedin) throw new Error("That is not a LinkedIn profile URL.");
  const name = normalizeText(founder.fullName);
  const school =
    normalizeText(schoolTag ?? "") ||
    normalizeText(founder.education[0]?.schoolName ?? "") ||
    "Unknown";
  const company = normalizeText(founder.currentCompany ?? "") || null;
  const title = normalizeText(founder.currentTitle ?? "") || null;
  const location = normalizeText(founder.location ?? "") || null;

  const employmentHistory = founder.experience.slice(0, 15).map((e) => ({
    company: e.companyName,
    title: e.title,
    start: linkedInDateToIso(e.startDate),
    end: linkedInDateToIso(e.endDate),
    description: (e.description ?? "").slice(0, 240),
    domain: null,
    current: !e.endDate || /present|current/i.test(e.endDate),
  }));
  const gradMatch = founder.education[0]?.endDate?.match(/(19|20)\d{2}/);
  const gradYear = gradMatch ? Number(gradMatch[0]) : null;
  const captureContext =
    [founder.headline, founder.about, opts?.rawProfileText]
      .filter(Boolean)
      .join("\n\n")
      .slice(0, 20_000) || null;

  const existing = await sql<{ id: string }[]>`
    select id from network_people where linkedin_url = ${linkedin}
  `;
  if (existing.length > 0) {
    const id = existing[0].id;
    await sql`
      update network_people set
        current_organization = coalesce(current_organization, ${company}),
        current_title = coalesce(current_title, ${title}),
        location = coalesce(location, ${location}),
        grad_year = coalesce(grad_year, ${gradYear}),
        school = case when school is null or school = '' or lower(school) = 'unknown'
                      then ${school} else school end,
        employment_history = case
          when jsonb_array_length(employment_history) = 0
               and ${employmentHistory.length} > 0
          then ${sql.json(employmentHistory as never)}
          else employment_history end,
        context_summary = coalesce(context_summary, ${founder.headline?.slice(0, 200) ?? null}),
        capture_context = coalesce(${captureContext}, capture_context),
        updated_at = now()
      where id = ${id}
    `;
    return { id, existed: true };
  }
  const inserted = await sql<{ id: string }[]>`
    insert into network_people (name, linkedin_url, school, current_organization,
                                current_title, location, grad_year,
                                employment_history, context_summary,
                                capture_context, profile_status, added_by)
    values (${name}, ${linkedin}, ${school}, ${company}, ${title}, ${location},
            ${gradYear}, ${sql.json(employmentHistory as never)},
            ${founder.headline?.slice(0, 200) ?? null}, ${captureContext},
            'ready', ${addedBy})
    returning id
  `;
  return { id: inserted[0].id, existed: false };
}

/**
 * Elevate a private deal to the shared team board, into the chosen stage.
 * (Private deals are visible only to their owner; elevating is how a draft
 * becomes everyone's.) A deal that's already team-visible is left alone.
 */
export async function elevateDeal(
  userEmail: string,
  gid: string,
  stage: StageKey = "elevate"
): Promise<void> {
  const stageKey: StageKey = STAGE_BY_KEY[stage] ? stage : "elevate";
  const rows = await sql<{ name: string; visibility: string }[]>`
    select name, visibility from deals where gid = ${gid}`;
  const deal = rows[0];
  if (!deal) throw new Error("That deal no longer exists.");
  if (deal.visibility === "team") return;
  await sql`
    update deals set visibility = 'team', elevated_by = ${userEmail},
      elevated_at = now(), modified_on = current_date,
      stage = ${stageKey}, section_gid = ${stageKey}
    where gid = ${gid}
  `;
  void logActivity(userEmail, "elevated_deal", gid, { name: deal.name });
  logEvent("info", "deals", "deal elevated", { gid, by: userEmail });
}

/* ── Duplicate detection ─────────────────────────────────────────────────── */

export interface DuplicateHit {
  id: string;
  name: string;
  school: string | null;
  reason: string;
}

/** Who might this already be? Same LinkedIn, same email, or same name. */
export async function findLikelyDuplicates(input: {
  name: string;
  linkedinUrl?: string | null;
  email?: string | null;
  school?: string | null;
}): Promise<DuplicateHit[]> {
  const linkedin = input.linkedinUrl ? normalizeLinkedInUrl(input.linkedinUrl) : null;
  const email = (input.email ?? "").trim().toLowerCase() || null;
  const name = input.name.trim();
  const school = (input.school ?? "").trim() || null;
  const rows = await sql<
    { id: string; name: string; school: string | null; li: boolean; em: boolean; ns: boolean }[]
  >`
    select p.id, p.name, p.school,
           (${linkedin}::text is not null and p.linkedin_url = ${linkedin}) as li,
           (${email}::text is not null and (lower(coalesce(p.email,'')) = ${email}
              or lower(coalesce(p.personal_email,'')) = ${email}
              or lower(coalesce(p.school_email,'')) = ${email}
              or ${email} = any(select lower(unnest(coalesce(p.alt_emails,'{}')))))) as em,
           (lower(p.name) = ${name.toLowerCase()}
              and ${school}::text is not null
              and lower(coalesce(p.school,'')) = ${school?.toLowerCase() ?? ""}) as ns
    from network_people p
    where (${linkedin}::text is not null and p.linkedin_url = ${linkedin})
       or (${email}::text is not null and (lower(coalesce(p.email,'')) = ${email}
              or lower(coalesce(p.personal_email,'')) = ${email}
              or lower(coalesce(p.school_email,'')) = ${email}))
       or lower(p.name) = ${name.toLowerCase()}
    limit 5
  `.catch(() => []);
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    school: r.school,
    reason: r.li ? "same LinkedIn" : r.em ? "same email" : r.ns ? "same name and school" : "same name",
  }));
}
