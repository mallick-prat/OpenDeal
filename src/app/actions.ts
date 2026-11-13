"use server";

import { createHash, randomUUID } from "crypto";
import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { record } from "@/lib/perf";
import { fetchSections } from "@/lib/sections";
import { sql } from "@/lib/db";
import { canTouchDeal } from "@/lib/dealAccess";
import {
  currentAppUser,
  requireRole,
  realAppUser,
  logActivity,
  getAppUser,
  VIEW_AS_COOKIE,
  VIEW_AS_MARKER,
  type AppUser,
  type Role,
} from "@/lib/users";
import { makeMagicToken } from "@/lib/loginCode";
import { syncGoogle } from "@/lib/googleSync";
import { logEvent } from "@/lib/log";
import { companyFromDealName, foundersFromDeal } from "@/lib/founders";
import {
  normalizeLinkedInUrl,
  normalizeText,
  validatePersonInputs,
} from "@/lib/networkRules";
import type { DealDraft, StageKey } from "@/lib/types";
import type { NoteDetail } from "@/components/NoteTriage";
import type { DealMeeting, DealNote } from "@/lib/meetings";
import type { DealEmailHistory as DealHistory } from "@/lib/dealEmails";
import { etFullDate } from "@/lib/etDates";
import { appUrl, crm, emailFrom } from "@/config/crm.config";
import { escapeHtml } from "@/lib/emailHtml";
import { orgInitials } from "@/lib/brandPure";
import type {
  CandidateCore,
  CandidateExtras,
  CandidatePayload,
} from "@/lib/candidatePayload";

/**
 * The database is the source of truth: every action writes Postgres
 * synchronously.
 *
 * Every action re-checks membership + role against app_users, so removing
 * someone takes effect immediately even if their session cookie lives on.
 */

const GID = /^(\d{1,30}|local-[0-9a-f-]{36})$/;
const PERSON_ID = /^[0-9a-f-]{36}$/i;

const SIGNED_OUT = "You're signed out or your access was removed.";
const NOT_YOURS = "That deal isn't on your board.";

// Deal-level access lives in lib/dealAccess.ts so route handlers (e.g. the
// attachments upload) enforce the same rule — a "use server" file must not
// export non-action helpers, and every surface needs this check.

/**
 * R-01's version token: a hash of exactly the fields the Edit card can
 * change. synced_at was wrong for this — a sync stamps it on rows
 * it merely touches, so a modal held open across a sync cycle produced
 * "this deal changed" with no actual change. Content that hashes the same
 * IS the same, no matter how many bookkeeping writes happened in between.
 */
function dealContentHash(r: {
  name: string;
  notes: string;
  section_gid: string | null;
  schools: string[] | null;
  financing_amount: string | null;
  round: string | null;
}): string {
  return createHash("md5")
    .update(
      JSON.stringify([
        r.name,
        r.notes,
        r.section_gid ?? "",
        r.schools ?? [],
        r.financing_amount ?? "",
        r.round ?? "",
      ])
    )
    .digest("hex");
}

export interface SaveDealInput {
  gid: string;
  name: string;
  notes: string;
  sectionGid: string;
  /** The deal's final school list (names). */
  schools: string[];
  financingAmount?: string;
  round?: string;
  /** Founders added in this edit — each also joins the network. */
  newFounders?: { name: string; school: string; linkedin: string }[];
  /**
   * Optimistic concurrency (R-01): a hash of the editable fields as loaded.
   * When provided, a save against content someone else has since changed
   * returns { conflict: true } instead of silently clobbering. Bookkeeping
   * writes (sync stamps, cooldowns) don't trip it — only real edits do.
   */
  baselineHash?: string | null;
  /** Explicit override after a conflict prompt — last write wins, knowingly. */
  force?: boolean;
}

export interface CreateDealInput {
  name: string;
  notes: string;
  sectionGid: string;
  schools: string[];
  financingAmount?: string;
  round?: string;
  /** The company name alone (without founder prefix), for founder records. */
  company?: string;
  /** Founders on the deal — each is also added to the network. */
  founders?: { name: string; school: string; linkedin: string }[];
}

export interface ActionResult {
  ok: boolean;
  error?: string;
}

function cleanSchools(names: string[]): string[] {
  return [
    ...new Set(
      names.map((n) => n.trim()).filter((n) => n.length > 0 && n.length <= 80)
    ),
  ];
}

/** Load the deal for the edit form — straight from the database. */
export async function loadDealDraft(
  gid: string
): Promise<{ ok: true; draft: DealDraft } | { ok: false; error: string }> {
  if (!GID.test(gid)) return { ok: false, error: "Invalid deal id." };
  const user = await currentAppUser();
  if (!user) return { ok: false, error: SIGNED_OUT };
  if (!(await canTouchDeal(user, gid))) return { ok: false, error: NOT_YOURS };
  const rows = await sql<
    {
      gid: string;
      name: string;
      notes: string;
      section_gid: string | null;
      schools: string[];
      financing_amount: string | null;
      round: string | null;
    }[]
  >`
    select gid, name, notes, section_gid, schools, financing_amount, round
    from deals where gid = ${gid}
  `;
  if (rows.length === 0)
    return { ok: false, error: "That deal no longer exists." };
  const r = rows[0];
  const { fieldSourcesForDeal } = await import("@/lib/provenance");
  const claims = await fieldSourcesForDeal(gid).catch(() => ({}));
  const sources: NonNullable<DealDraft["sources"]> = {};
  for (const [field, c] of Object.entries(claims)) {
    sources[field] = { source: c.source, actor: c.actor, at: c.at };
  }
  return {
    ok: true,
    draft: {
      gid: r.gid,
      name: r.name,
      notes: r.notes,
      sectionGid: r.section_gid ?? "",
      schools: r.schools ?? [],
      financing: r.financing_amount,
      round: r.round,
      baselineHash: dealContentHash(r),
      sources,
    },
  };
}

/** Move a deal to another stage. */
export async function moveDealStage(
  gid: string,
  sectionGid: string
): Promise<ActionResult> {
  if (!GID.test(gid)) return { ok: false, error: "Invalid deal id." };
  if (!/^[a-z][a-z-]{0,40}$/.test(sectionGid))
    return { ok: false, error: "Invalid stage." };
  const user = await currentAppUser();
  if (!user) return { ok: false, error: SIGNED_OUT };
  if (!(await canTouchDeal(user, gid))) return { ok: false, error: NOT_YOURS };
  try {
    const sections = await fetchSections();
    const section = sections.find((s) => s.gid === sectionGid);
    if (!section) return { ok: false, error: "That stage no longer exists." };
    // Capture the stage we're leaving so the activity reads "from X to Y".
    const before = await sql<{ stage: string | null }[]>`
      select stage from deals where gid = ${gid}
    `;
    const from = before[0]?.stage ?? null;
    await sql`
      update deals set stage = ${section.stage}, section_gid = ${sectionGid},
        modified_on = current_date, synced_at = now()
      where gid = ${gid}
    `;
    void logActivity(user.email, "moved_deal", gid, { from, to: section.stage });
    revalidatePath("/");
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Couldn't move the deal.",
    };
  }
}

/** Of the given gids, the ones this user is allowed to change (admins: all). */
async function touchableGids(user: AppUser, gids: string[]): Promise<string[]> {
  if (user.role !== "user") return gids;
  const ownerName = user.owner_name || user.name;
  const rows = await sql<{ gid: string }[]>`
    select gid from deals d
    where d.gid = any(${gids})
      and (d.created_by = ${user.email}
           or (d.owner <> 'Unassigned' and d.owner = ${ownerName})
           or exists (
             select 1 from deal_owners o
             where o.deal_gid = d.gid and o.email = ${user.email}
           ))
  `;
  return rows.map((r) => r.gid);
}

// A bulk action touches many rows at once; cap the batch so one click can't
// issue an unbounded UPDATE. The Kanban selection is realistically dozens,
// not thousands.
const BULK_MAX = 200;

/**
 * Move many deals to one stage in a SINGLE statement, so a big multi-select
 * can't exhaust the DB pool the way N separate calls would.
 */
export async function bulkMoveDealsAction(
  gids: string[],
  sectionGid: string
): Promise<ActionResult & { moved?: number }> {
  if (!/^[a-z][a-z-]{0,40}$/.test(sectionGid)) return { ok: false, error: "Invalid stage." };
  const clean = [...new Set((gids ?? []).filter((g) => GID.test(g)))].slice(0, BULK_MAX);
  if (clean.length === 0) return { ok: false, error: "No valid deals selected." };
  const user = await currentAppUser();
  if (!user) return { ok: false, error: SIGNED_OUT };
  const allowed = await touchableGids(user, clean);
  if (allowed.length === 0) return { ok: false, error: NOT_YOURS };
  try {
    const sections = await fetchSections();
    const section = sections.find((s) => s.gid === sectionGid);
    if (!section) return { ok: false, error: "That stage no longer exists." };
    // Log from→to BEFORE the update (so `stage` is still the old value), and
    // only for deals actually changing stage.
    await sql`
      insert into activity_log (actor, action, target, detail)
      select ${user.email}, 'moved_deal', gid,
             jsonb_build_object('from', stage, 'to', ${section.stage}::text)
      from deals
      where gid = any(${allowed}) and stage is distinct from ${section.stage}
    `.catch(() => {});
    await sql`
      update deals set stage = ${section.stage}, section_gid = ${sectionGid},
        modified_on = current_date, synced_at = now()
      where gid = any(${allowed})
    `;
    revalidatePath("/");
    return { ok: true, moved: allowed.length };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Couldn't move the deals.",
    };
  }
}

/** Delete many deals in one statement. */
export async function bulkDeleteDealsAction(
  gids: string[]
): Promise<ActionResult & { deleted?: number }> {
  const clean = [...new Set((gids ?? []).filter((g) => GID.test(g)))].slice(0, BULK_MAX);
  if (clean.length === 0) return { ok: false, error: "No valid deals selected." };
  const user = await currentAppUser();
  if (!user) return { ok: false, error: SIGNED_OUT };
  const allowed = await touchableGids(user, clean);
  if (allowed.length === 0) return { ok: false, error: NOT_YOURS };
  try {
    await sql`delete from deals where gid = any(${allowed})`;
    await sql`
      insert into activity_log (actor, action, target, detail)
      select ${user.email}, 'deleted_deal', g, '{}'::jsonb from unnest(${allowed}::text[]) as g
    `.catch(() => {});
    revalidatePath("/");
    return { ok: true, deleted: allowed.length };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Couldn't delete the deals.",
    };
  }
}

/** Create a deal. */
export async function createDeal(
  input: CreateDealInput
): Promise<ActionResult & { gid?: string }> {
  const name = input.name.trim();
  if (!name || name.length > 500)
    return { ok: false, error: "Give the deal a name (1–500 characters)." };
  if (input.notes.length > 60000)
    return { ok: false, error: "Notes are too long." };
  if (input.sectionGid && !/^[a-z][a-z-]{0,40}$/.test(input.sectionGid))
    return { ok: false, error: "Invalid stage." };
  const user = await currentAppUser();
  if (!user) return { ok: false, error: SIGNED_OUT };

  try {
    // Idempotent by name: a retry storm, a double-fire, or two doors racing
    // converge on the ONE active deal with this name instead of forking. The
    // deals_active_name_unique index backstops the race at the data layer.
    const existing = await sql<{ gid: string }[]>`
      select gid from deals
       where lower(name) = ${name.toLowerCase()}
         and stage not in ('passed', 'to-pass')
       limit 1`;
    if (existing[0]) {
      return { ok: true, gid: existing[0].gid };
    }

    const sections = await fetchSections();
    const section = sections.find((s) => s.gid === input.sectionGid);
    const gid = `local-${randomUUID()}`;
    const schools = cleanSchools(input.schools);
    const today = new Date().toISOString().slice(0, 10);
    // Creating a deal makes you its owner: a deal_owners row plus the
    // display name, so it never shows as Unassigned.
    const owner = user.owner_name || user.name || "Unassigned";

    try {
      await sql`
        insert into deals (gid, name, notes, stage, section_gid, schools, owner,
          created_on, modified_on, completed, subtasks, followers, url,
          met_at_event, financing_amount, round, created_by)
        values (${gid}, ${name}, ${input.notes}, ${section?.stage ?? "to-meet"},
          ${input.sectionGid || null}, ${schools}, ${owner},
          ${today}, ${today}, false, 0, 0, ${""}, false,
          ${input.financingAmount?.trim() || null}, ${input.round?.trim() || null},
          ${user.email})
      `;
    } catch (err) {
      // Lost the race to a concurrent create of the same name: converge on
      // the winner instead of failing the click.
      if ((err as { code?: string })?.code === "23505") {
        const winner = await sql<{ gid: string }[]>`
          select gid from deals
           where lower(name) = ${name.toLowerCase()}
             and stage not in ('passed', 'to-pass')
           limit 1`;
        if (winner[0]) return { ok: true, gid: winner[0].gid };
      }
      throw err;
    }
    await sql`
      insert into deal_owners (deal_gid, email) values (${gid}, ${user.email})
      on conflict do nothing
    `;
    void logActivity(user.email, "created_deal", gid, { name });

    // Founders join the network automatically; the deal's company is where
    // they work. Duplicates are skipped quietly — never fail the deal.
    for (const f of input.founders ?? []) {
      if (!f.name.trim()) continue;
      const res = await insertNetworkPersonRecord(user.email, {
        name: f.name,
        school: f.school.trim() || "Unknown",
        company: input.company,
        linkedinUrl: f.linkedin,
      });
      if (res.ok && res.id) {
        void logActivity(user.email, "added_network_person", res.id, {
          name: f.name.trim(),
          from_deal: name,
        });
      } else if (!res.ok) {
        logEvent("info", "network", "founder skipped on deal create", {
          founder: f.name.trim(),
          reason: res.error ?? "unknown",
        });
      }
    }

    // Any Granola note that was waiting for THIS deal to exist (a meeting
    // held before boarding, a Calendly title with no evidence but its own
    // text) attaches the moment the deal is born — after the response, off
    // the click path.
    after(async () => {
      try {
        const { rematchNotesForDeal } = await import("@/lib/meetingNotes");
        const landed = await rematchNotesForDeal(gid);
        if (landed > 0) revalidatePath(`/deals/${gid}`);
      } catch {
        // The 15-minute sync is the backstop.
      }
    });

    revalidatePath("/");
    return { ok: true, gid };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Couldn't create the deal.",
    };
  }
}

/** Delete a deal. */
export async function deleteDeal(gid: string): Promise<ActionResult> {
  if (!GID.test(gid)) return { ok: false, error: "Invalid deal id." };
  const user = await currentAppUser();
  if (!user) return { ok: false, error: SIGNED_OUT };
  if (!(await canTouchDeal(user, gid))) return { ok: false, error: NOT_YOURS };
  try {
    const named = await sql<{ name: string }[]>`
      select name from deals where gid = ${gid}
    `;
    await sql`delete from deals where gid = ${gid}`;
    void logActivity(user.email, "deleted_deal", gid, {
      name: named[0]?.name ?? "",
    });
    revalidatePath("/");
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Couldn't delete the deal.",
    };
  }
}

/** Save edits to a deal. */
export async function saveDeal(
  input: SaveDealInput
): Promise<ActionResult & { conflict?: boolean }> {
  if (!GID.test(input.gid)) return { ok: false, error: "Invalid deal id." };
  const user = await currentAppUser();
  if (!user) return { ok: false, error: SIGNED_OUT };
  if (!(await canTouchDeal(user, input.gid)))
    return { ok: false, error: NOT_YOURS };
  const name = input.name.trim();
  if (!name || name.length > 500)
    return { ok: false, error: "Name must be 1–500 characters." };
  if (input.notes.length > 60000)
    return { ok: false, error: "Notes are too long." };
  if (input.sectionGid && !/^[a-z][a-z-]{0,40}$/.test(input.sectionGid))
    return { ok: false, error: "Invalid stage." };

  try {
    const schools = cleanSchools(input.schools);
    const sections = await fetchSections();
    const section = input.sectionGid
      ? sections.find((s) => s.gid === input.sectionGid)
      : undefined;

    const financing = input.financingAmount?.trim() || null;
    const round = input.round?.trim() || null;
    // One read serves two jobs: A-01 (claim provenance only for fields this
    // save actually changed) and R-01 (compare the CONTENT the editor loaded
    // against the content now in the row — sync stamps and cooldown writes
    // can't fake a conflict, only a real edit by someone else can).
    const beforeRows = await sql<
      {
        name: string;
        notes: string;
        section_gid: string | null;
        schools: string[] | null;
        financing_amount: string | null;
        round: string | null;
      }[]
    >`select name, notes, section_gid, schools, financing_amount, round
        from deals where gid = ${input.gid}`;
    if (beforeRows.length === 0)
      return { ok: false, error: "This deal no longer exists." };
    if (
      input.baselineHash != null &&
      !input.force &&
      dealContentHash(beforeRows[0]) !== input.baselineHash
    ) {
      return {
        ok: false,
        conflict: true,
        error:
          "This deal changed while you had it open. Reload to see the latest, or save anyway to overwrite.",
      };
    }
    if (section) {
      await sql`
        update deals set name = ${name}, notes = ${input.notes},
          schools = ${schools}, stage = ${section.stage},
          section_gid = ${section.gid},
          financing_amount = ${financing}, round = ${round},
          modified_on = current_date, synced_at = now()
        where gid = ${input.gid}
      `;
    } else {
      await sql`
        update deals set name = ${name}, notes = ${input.notes},
          schools = ${schools},
          financing_amount = ${financing}, round = ${round},
          modified_on = current_date, synced_at = now()
        where gid = ${input.gid}
      `;
    }
    void logActivity(user.email, "edited_deal", input.gid, { name });

    // A-01: hand-edited values claim "manual" provenance — only the fields
    // this save actually changed.
    {
      const { recordFieldSource } = await import("@/lib/provenance");
      const b = beforeRows[0];
      if (b) {
        if ((b.financing_amount ?? null) !== financing)
          recordFieldSource(input.gid, "financing", financing, "manual", null, user.email);
        if ((b.round ?? null) !== round)
          recordFieldSource(input.gid, "round", round, "manual", null, user.email);
        if (b.notes !== input.notes)
          recordFieldSource(input.gid, "notes", null, "manual", null, user.email);
      }
    }

    // R-02: a manual edit changes the ground truth pending Granola proposals
    // were diffed against. Re-propose in the background so every 'ready'
    // card's before/after reflects the deal as it NOW is — a proposal that
    // this edit just satisfied disappears instead of re-applying stale text.
    void (async () => {
      try {
        const stale = await sql<{ id: string }[]>`
          select id from meeting_notes
           where matched_deal_gid = ${input.gid} and review_state = 'ready'`;
        if (stale.length === 0) return;
        const { proposeNoteUpdates } = await import("@/lib/meetingNoteUpdates");
        for (const n of stale) await proposeNoteUpdates(n.id);
      } catch (err) {
        const { logError } = await import("@/lib/log");
        logError("granola", "re-propose after edit failed", err, { gid: input.gid });
      }
    })();

    // Founders added in this edit join the network, working at this company.
    const company = companyFromDealName(name);
    for (const f of input.newFounders ?? []) {
      if (!f.name.trim()) continue;
      const res = await insertNetworkPersonRecord(user.email, {
        name: f.name,
        school: f.school.trim() || "Unknown",
        company,
        linkedinUrl: f.linkedin,
      });
      if (res.ok && res.id) {
        void logActivity(user.email, "added_network_person", res.id, {
          name: f.name.trim(),
          from_deal: name,
        });
      } else if (!res.ok) {
        logEvent("info", "network", "founder skipped on deal edit", {
          founder: f.name.trim(),
          reason: res.error ?? "unknown",
        });
      }
    }

    // New founders are new matching evidence: any Granola note that was
    // waiting on exactly this person lands now, not at the next sweep.
    if ((input.newFounders ?? []).some((f) => f.name.trim())) {
      void import("@/lib/meetingNotes")
        .then((m) => m.rematchNotesForDeal(input.gid))
        .catch(() => 0);
    }
    revalidatePath("/");
    revalidatePath(`/deals/${input.gid}`);
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Couldn't save the deal.",
    };
  }
}

/* ── Deal owners ─────────────────────────────────────────────────────────── */

/** Add a member as an owner of a deal. */
export async function addDealOwner(
  gid: string,
  ownerEmail: string
): Promise<ActionResult> {
  if (!GID.test(gid)) return { ok: false, error: "Invalid deal id." };
  const user = await currentAppUser();
  if (!user) return { ok: false, error: SIGNED_OUT };
  if (!(await canTouchDeal(user, gid))) return { ok: false, error: NOT_YOURS };
  const target = ownerEmail.trim().toLowerCase();
  try {
    const member = await sql<{ name: string }[]>`
      select name from app_users where email = ${target}
    `;
    if (member.length === 0)
      return { ok: false, error: "That person isn't a member." };
    await sql`
      insert into deal_owners (deal_gid, email) values (${gid}, ${target})
      on conflict do nothing
    `;
    // First owner also becomes the display owner so lists read right.
    await sql`
      update deals set owner = ${member[0].name}
      where gid = ${gid} and (owner = 'Unassigned' or owner = '')
    `;
    void logActivity(user.email, "added_owner", gid, { owner: target });
    revalidatePath("/");
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Couldn't add the owner.",
    };
  }
}

/** Remove an owner from a deal. Zero owners is fine. */
export async function removeDealOwner(
  gid: string,
  ownerEmail: string
): Promise<ActionResult> {
  if (!GID.test(gid)) return { ok: false, error: "Invalid deal id." };
  const user = await currentAppUser();
  if (!user) return { ok: false, error: SIGNED_OUT };
  if (!(await canTouchDeal(user, gid))) return { ok: false, error: NOT_YOURS };
  const target = ownerEmail.trim().toLowerCase();
  try {
    await sql`
      delete from deal_owners where deal_gid = ${gid} and email = ${target}
    `;
    void logActivity(user.email, "removed_owner", gid, { owner: target });
    revalidatePath("/");
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Couldn't remove the owner.",
    };
  }
}

/* ── Network (people intelligence) ───────────────────────────────────────── */

export interface NetworkPersonInput {
  name: string;
  school: string;
  /** Where they work now, when known — manual entry wins over enrichment. */
  company?: string;
  linkedinUrl?: string;
  gradYear?: number | null;
  degree?: string;
}

/**
 * Shared identity step (deterministic): validate, normalize the LinkedIn
 * URL, dedupe, create the provisional record, then enrich in the background.
 * Used by the Network form and by new-deal founders.
 */
async function insertNetworkPersonRecord(
  addedBy: string,
  input: NetworkPersonInput,
  opts?: {
    /** Bulk import: silently skip anyone who already looks present. */
    skipDuplicates?: boolean;
    /** Bulk import: don't spend enrichment budget; leave as partial. */
    enrich?: boolean;
    reviewReason?: string | null;
  }
): Promise<ActionResult & { id?: string; skipped?: boolean }> {
  const enrich = opts?.enrich ?? true;
  const invalid = validatePersonInputs(input);
  if (invalid) return { ok: false, error: invalid };
  const linkedin = input.linkedinUrl?.trim()
    ? normalizeLinkedInUrl(input.linkedinUrl)
    : null;
  const name = normalizeText(input.name);
  const school = normalizeText(input.school);
  const company = normalizeText(input.company ?? "") || null;
  const degree = normalizeText(input.degree ?? "") || null;
  const gradYear = input.gradYear != null ? Number(input.gradYear) : null;
  try {
    // Duplicate rule 1: exact normalized LinkedIn URL.
    if (linkedin) {
      const dupUrl = await sql<{ id: string; name: string }[]>`
        select id, name from network_people where linkedin_url = ${linkedin}
      `;
      if (dupUrl.length > 0)
        return {
          ok: false,
          skipped: true,
          error: `${dupUrl[0].name} is already in the network with that LinkedIn URL.`,
        };
    }
    // Duplicate rule 2: same name (+ same school, or import mode where the
    // school guess may differ) → skip on import, flag on manual add.
    const dupPerson = await sql<{ id: string }[]>`
      select id from network_people
      where lower(name) = ${name.toLowerCase()}
        and (lower(school) = ${school.toLowerCase()} or ${opts?.skipDuplicates ?? false})
    `;
    if (dupPerson.length > 0 && opts?.skipDuplicates)
      return { ok: false, skipped: true, error: `${name} is already in the network.` };
    const inserted = await sql<{ id: string }[]>`
      insert into network_people (name, grad_year, linkedin_url, school, degree,
                                  current_organization, profile_status,
                                  review_reason, added_by)
      values (${name}, ${gradYear}, ${linkedin}, ${school}, ${degree},
              ${company}, 'ready',
              ${opts?.reviewReason ??
                (dupPerson.length > 0 ? "Possible duplicate: same name and school already exist." : null)},
              ${addedBy})
      returning id
    `;
    const id = inserted[0].id;
    return { ok: true, id };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Couldn't add the person.",
    };
  }
}

/** Sync the signed-in member's Gmail/Calendar index, then re-match everyone. */
export async function syncGoogleNow(): Promise<
  ActionResult & { calendar?: number; gmail?: number }
> {
  const user = await currentAppUser();
  if (!user) return { ok: false, error: SIGNED_OUT };
  try {
    const counts = await syncGoogle(user.email);
    void logActivity(user.email, "synced_google", "", {
      calendar: counts.calendar,
      gmail: counts.gmail,
    });
    return { ok: true, ...counts };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Sync didn't run.",
    };
  }
}

/* ── Member management (Settings → Members) ──────────────────────────────── */

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const ROLES: Role[] = ["super_admin", "admin", "user"];

async function superAdminCount(): Promise<number> {
  const rows = await sql<{ n: number }[]>`
    select count(*)::int as n from app_users where role = 'super_admin'
  `;
  return rows[0]?.n ?? 0;
}

/** Invite email: one line, one button, no fluff. */
async function sendInviteEmail(
  email: string,
  name: string,
  invitedByName: string
): Promise<boolean> {
  const link = `${appUrl()}/magic?token=${encodeURIComponent(
    makeMagicToken(email, process.env.AUTH_SECRET!)
  )}`;
  const font = "font-family:'IBM Plex Sans',Segoe UI,Arial,sans-serif;";
  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#f4f2ef;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f2ef;padding:40px 16px;">
    <tr><td align="center">
      <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px;width:100%;background:#ffffff;border:1px solid #e7e4df;">
        <tr><td style="background:${crm.brand.primary};padding:24px;" align="center">
          <table role="presentation" cellpadding="0" cellspacing="0"><tr>
            <td style="background:#ffffff;color:${crm.brand.primary};${font}font-weight:700;font-size:22px;line-height:1;padding:8px 12px;letter-spacing:-2px;">${escapeHtml(orgInitials(crm.org.name))}</td>
          </tr></table>
        </td></tr>
        <tr><td style="padding:32px 32px 8px;" align="center">
          <div style="${font}font-size:16px;color:#171717;">
            ${escapeHtml(invitedByName)} added you to <strong>${escapeHtml(crm.org.name)}</strong>'s deal pipeline.
          </div>
        </td></tr>
        <tr><td style="padding:20px 32px 12px;" align="center">
          <a href="${link}" style="display:inline-block;background:${crm.brand.primary};color:#ffffff;${font}font-size:15px;font-weight:600;padding:14px 36px;text-decoration:none;">Open the pipeline</a>
        </td></tr>
        <tr><td style="padding:0 32px 28px;" align="center">
          <div style="${font}font-size:12px;color:#8a837c;">
            Signs you in as ${escapeHtml(email)}. Link works for 7 days.
          </div>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: emailFrom(),
        to: [email],
        subject: `You've been added to the ${crm.org.name} pipeline`,
        html,
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Add a member and email them a sign-in link. Admins and super admins can
 * add; only a super admin can mint another super admin (no escalation).
 */
export async function addUser(input: {
  email: string;
  name?: string;
  role: Role;
}): Promise<ActionResult & { emailed?: boolean }> {
  const actor = await requireRole("admin");
  if (!actor) return { ok: false, error: "Only admins can add members." };
  const email = input.email.trim().toLowerCase();
  if (!EMAIL_RE.test(email) || email.length > 320)
    return { ok: false, error: "That doesn't look like an email address." };
  if (!ROLES.includes(input.role))
    return { ok: false, error: "Pick a role." };
  if (input.role === "super_admin" && actor.role !== "super_admin")
    return { ok: false, error: "Only a super admin can add a super admin." };
  const name = (input.name ?? "").trim().slice(0, 120);
  try {
    const inserted = await sql<{ email: string }[]>`
      insert into app_users (email, name, role, invited_by)
      values (${email}, ${name}, ${input.role}, ${actor.email})
      on conflict (email) do nothing
      returning email
    `;
    if (inserted.length === 0)
      return { ok: false, error: `${email} is already a member.` };
    const emailed = await sendInviteEmail(email, name, actor.name || actor.email);
    void logActivity(actor.email, "added_user", email, {
      role: input.role,
      invite_emailed: emailed,
    });
    revalidatePath("/settings");
    return { ok: true, emailed };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Couldn't add the member.",
    };
  }
}

/**
 * Mint a magic sign-in link for a member (admins+). Whoever opens the link
 * is signed in as that member for the next 7 days — treat it like a key.
 */
export async function createMagicLink(
  email: string
): Promise<ActionResult & { url?: string }> {
  const actor = await requireRole("admin");
  if (!actor)
    return { ok: false, error: "Only admins can create sign-in links." };
  const target = email.trim().toLowerCase();
  const rows = await sql<{ email: string }[]>`
    select email from app_users where email = ${target}
  `;
  if (rows.length === 0)
    return { ok: false, error: "That person isn't a member." };
  void logActivity(actor.email, "created_sign_in_link", target);
  return {
    ok: true,
    url: `${appUrl()}/magic?token=${encodeURIComponent(
      makeMagicToken(target, process.env.AUTH_SECRET!)
    )}`,
  };
}

/**
 * Email an existing member their sign-in link (for when the invite bounced
 * or they lost it). Admins and up; the recipient must already be a member.
 */
export async function emailSignInLink(email: string): Promise<ActionResult> {
  const actor = await requireRole("admin");
  if (!actor) return { ok: false, error: "Only admins can send sign-in links." };
  const target = email.trim().toLowerCase();
  const rows = await sql<{ name: string }[]>`
    select name from app_users where email = ${target}
  `;
  if (rows.length === 0)
    return { ok: false, error: "That person isn't a member." };
  const emailed = await sendInviteEmail(
    target,
    rows[0].name,
    actor.name || actor.email
  );
  if (!emailed)
    return {
      ok: false,
      error:
        "Couldn't send the email (the Resend domain is still unverified). Copy the link and share it directly.",
    };
  void logActivity(actor.email, "sent_sign_in_link", target);
  return { ok: true };
}

/** Change a member's role. Super admin only; the last super admin is safe. */
export async function setUserRole(
  email: string,
  role: Role
): Promise<ActionResult> {
  const actor = await requireRole("super_admin");
  if (!actor)
    return { ok: false, error: "Only a super admin can change roles." };
  const target = email.trim().toLowerCase();
  if (!ROLES.includes(role)) return { ok: false, error: "Pick a role." };
  try {
    const rows = await sql<{ role: Role }[]>`
      select role from app_users where email = ${target}
    `;
    if (rows.length === 0)
      return { ok: false, error: "That member no longer exists." };
    if (
      rows[0].role === "super_admin" &&
      role !== "super_admin" &&
      (await superAdminCount()) <= 1
    ) {
      return {
        ok: false,
        error:
          "That's the last super admin. Promote someone else first, then change this role.",
      };
    }
    await sql`update app_users set role = ${role} where email = ${target}`;
    void logActivity(actor.email, "changed_role", target, {
      from: rows[0].role,
      to: role,
    });
    revalidatePath("/settings");
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Couldn't change the role.",
    };
  }
}

/**
 * Remove a member: blocks their next sign-in and (because every page and
 * action re-checks membership) cuts off any session still alive. Their
 * tracked-deals list goes too, so they stop getting the digest.
 */
export async function removeUser(email: string): Promise<ActionResult> {
  const actor = await requireRole("super_admin");
  if (!actor)
    return { ok: false, error: "Only a super admin can remove members." };
  const target = email.trim().toLowerCase();
  if (target === actor.email)
    return { ok: false, error: "You can't remove yourself." };
  try {
    const rows = await sql<{ role: Role }[]>`
      select role from app_users where email = ${target}
    `;
    if (rows.length === 0) return { ok: true };
    if (rows[0].role === "super_admin" && (await superAdminCount()) <= 1)
      return { ok: false, error: "You can't remove the last super admin." };
    await sql`delete from app_users where email = ${target}`;
    await sql`delete from deal_owners where email = ${target}`;
    void logActivity(actor.email, "removed_user", target, {
      had_role: rows[0].role,
    });
    revalidatePath("/settings");
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Couldn't remove the member.",
    };
  }
}

/* ── Inbound deal queue (shared-mailbox ingestion) ───────────────────────── */

/** Promote a parsed inbound email into a private deal owned by the member. */
export async function createDealFromInboundAction(
  id: string
): Promise<ActionResult & { gid?: string }> {
  const user = await currentAppUser();
  if (!user) return { ok: false, error: SIGNED_OUT };
  try {
    const { createDealFromInbound } = await import("@/lib/inbound");
    const { gid } = await createDealFromInbound(id, user.email, user.name);
    revalidatePath("/inbound");
    revalidatePath("/");
    return { ok: true, gid };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Couldn't create the deal.",
    };
  }
}

export async function skipInboundAction(id: string): Promise<ActionResult> {
  const user = await currentAppUser();
  if (!user) return { ok: false, error: SIGNED_OUT };
  try {
    const { skipInbound } = await import("@/lib/inbound");
    await skipInbound(id);
    revalidatePath("/inbound");
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Couldn't update the item.",
    };
  }
}

export async function reparseInboundAction(id: string): Promise<ActionResult> {
  const user = await currentAppUser();
  if (!user) return { ok: false, error: SIGNED_OUT };
  try {
    const { reparseInbound } = await import("@/lib/inbound");
    await reparseInbound(id);
    revalidatePath("/inbound");
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Couldn't re-parse the email.",
    };
  }
}

/* ── Candidate triage (/inbox — stable, addressable review queue) ────────── */

export type TriageOp =
  | { kind: "assign"; assignee: string | null }
  | { kind: "snooze"; untilIso: string }
  | { kind: "pass"; reason?: string }
  | { kind: "ignore" }
  | { kind: "reopen" }
  | { kind: "attach"; dealGid: string };

/**
 * One entry point for all candidate triage; each op logs to the activity
 * trail and returns the next open candidate so the session keeps moving.
 */
export async function triageCandidateAction(
  id: string,
  op: TriageOp
): Promise<ActionResult & { nextId?: string | null; remaining?: number }> {
  const user = await currentAppUser();
  if (!user) return { ok: false, error: SIGNED_OUT };
  try {
    const c = await import("@/lib/candidates");
    switch (op.kind) {
      case "assign":
        await c.assignCandidate(id, op.assignee, user.email);
        break;
      case "snooze": {
        const until = new Date(op.untilIso);
        if (Number.isNaN(until.getTime())) {
          return { ok: false, error: "Pick a valid snooze date." };
        }
        await c.snoozeCandidate(id, until, user.email);
        break;
      }
      case "pass": {
        // A pass is still a record: the deal lands in the board's To Pass
        // column carrying the (optional) why, so institutional memory keeps
        // the reason, not just the verdict.
        //
        // Verdict FIRST: createDealFromInbound ends by syncing the candidate
        // from its email, and email status 'created' maps to 'approved' for
        // machine states. Passing before filing pins the human state —
        // refreshCandidateFromInbound never clobbers 'passed' — so the card
        // reads passed (not boarded) and reopen keeps working. The e2e suite
        // caught the old order leaving passes stuck as 'approved'.
        const cand = await c.getCandidate(id, user.email);
        await c.passCandidate(id, user.email);
        if (cand?.source_email_id && !cand.promoted_deal_gid) {
          try {
            const { createDealFromInbound } = await import("@/lib/inbound");
            const reason = op.reason?.trim();
            const { gid } = await createDealFromInbound(
              cand.source_email_id,
              user.email,
              user.name,
              {
                stage: "to-pass",
                note: reason ? `Passed: ${reason}` : "Passed from the inbox.",
              }
            );
            await sql`
              update deal_candidates set promoted_deal_gid = ${gid} where id = ${id}
            `.catch(() => {});
          } catch {
            // The pass itself must never fail because boarding did.
          }
        }
        break;
      }
      case "ignore": {
        // Ignore means gone — delete the card and turn the page.
        const deleted = await c.deleteCandidate(id);
        if (!deleted) await c.ignoreCandidate(id, user.email);
        break;
      }
      case "reopen":
        await c.reopenCandidate(id, user.email);
        break;
      case "attach": {
        if (!/^(\d{1,30}|local-[0-9a-f-]{36})$/.test(op.dealGid)) {
          return { ok: false, error: "Invalid deal id." };
        }
        await c.attachCandidateToDeal(id, op.dealGid, user.email);
        // Attaching means the deal absorbs this email's whole context — the
        // meetings these people appear in, their addresses, the pitch facts.
        try {
          const src = await sql<
            { from_email: string | null; parsed: { founders?: { email?: string | null }[]; website?: string | null } | null }[]
          >`
            select e.from_email, e.parsed
              from inbound_emails e join deal_candidates dc on dc.source_email_id = e.id
             where dc.id = ${id}`;
          const parsed = src[0]?.parsed ?? null;
          const site = (parsed?.website ?? "")
            .toLowerCase()
            .replace(/^https?:\/\//, "")
            .replace(/^www\./, "")
            .split("/")[0];
          const seed = {
            emails: [src[0]?.from_email, ...(parsed?.founders ?? []).map((f) => f.email)].filter(
              (e): e is string => Boolean(e)
            ),
            domains: site ? [site] : [],
          };
          const { mergeDealContext } = await import("@/lib/dealContext");
          await mergeDealContext(op.dealGid, seed, user.email);
        } catch {
          // Context sync is additive; the attach itself already stands.
        }
        // The attach lands on the DEAL's timeline, not just the candidate's.
        void logActivity(user.email, "attached_candidate", op.dealGid, { candidate: id });
        break;
      }
    }
    void logActivity(user.email, "triaged_candidate", id, { op: op.kind, reason: op.kind === "pass" ? op.reason ?? null : null });
    const queue = await c.openCandidateQueue(user.email);
    const rest = queue.filter((q) => q !== id);
    revalidatePath("/inbox");
    revalidatePath(`/inbox/${id}`);
    return { ok: true, nextId: rest[0] ?? null, remaining: rest.length };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Couldn't update the candidate.",
    };
  }
}

/**
 * The triage miniapp's data feed: everything the candidate page computes for
 * one candidate, as one serializable object (assembled by the same lib
 * function the server page uses — no drift). Pure read: no revalidation, so
 * prefetching neighbours never re-renders the route.
 */
export async function getCandidatePayloadAction(
  id: string
): Promise<ActionResult & { payload?: CandidatePayload }> {
  const user = await currentAppUser();
  if (!user) return { ok: false, error: SIGNED_OUT };
  if (!/^[0-9a-f-]{36}$/.test(id)) return { ok: false, error: "Invalid candidate id." };
  try {
    const { buildCandidatePayload } = await import("@/lib/candidatePayload");
    const payload = await buildCandidatePayload(id, user.email);
    if (!payload) return { ok: false, error: "That candidate no longer exists." };
    return { ok: true, payload };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Couldn't load the candidate.",
    };
  }
}

/**
 * Stage 1 of the payload — the fast read a page turn actually waits on
 * (candidate + parsed + claims + prefill; no history, no documents).
 */
export async function getCandidateCoreAction(
  id: string
): Promise<ActionResult & { core?: CandidateCore }> {
  const user = await currentAppUser();
  if (!user) return { ok: false, error: SIGNED_OUT };
  if (!/^[0-9a-f-]{36}$/.test(id)) return { ok: false, error: "Invalid candidate id." };
  try {
    const { buildCandidateCore } = await import("@/lib/candidatePayload");
    const core = await buildCandidateCore(id, user.email);
    if (!core) return { ok: false, error: "That candidate no longer exists." };
    return { ok: true, core };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Couldn't load the candidate.",
    };
  }
}

/** How many stage-1 payloads one batched prefetch may assemble. */
const CORES_BATCH_MAX = 16;

/**
 * Batched stage 1: the triage session warms many queue slots in ONE round
 * trip (server actions dispatch sequentially per client — N single calls
 * would queue behind each other). Unknown/hidden ids are simply absent from
 * the result; the whole batch never fails because one candidate did.
 */
export async function getCandidateCoresAction(
  ids: string[]
): Promise<ActionResult & { cores?: Record<string, CandidateCore> }> {
  const user = await currentAppUser();
  if (!user) return { ok: false, error: SIGNED_OUT };
  const clean = [
    ...new Set((ids ?? []).filter((i) => /^[0-9a-f-]{36}$/.test(i))),
  ].slice(0, CORES_BATCH_MAX);
  if (clean.length === 0) return { ok: true, cores: {} };
  try {
    const { buildCandidateCores } = await import("@/lib/candidatePayload");
    return { ok: true, cores: await buildCandidateCores(clean, user.email) };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Couldn't load the candidates.",
    };
  }
}

/**
 * Stage 2 of the payload — team history + stored documents. Fetched in the
 * background after a turn renders; the sections fade in when this lands.
 */
export async function getCandidateExtrasAction(
  id: string
): Promise<ActionResult & { extras?: CandidateExtras }> {
  const user = await currentAppUser();
  if (!user) return { ok: false, error: SIGNED_OUT };
  if (!/^[0-9a-f-]{36}$/.test(id)) return { ok: false, error: "Invalid candidate id." };
  try {
    const { buildCandidateExtras } = await import("@/lib/candidatePayload");
    const extras = await buildCandidateExtras(id, user.email);
    if (!extras) return { ok: false, error: "That candidate no longer exists." };
    return { ok: true, extras };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Couldn't load the details.",
    };
  }
}

/**
 * The team's arrangement of the founder list (reorder/remove). The email
 * extraction stays read-only truth — order and removals live in the claims
 * ledger as one team-confirmed `foundersMeta` row, applied identically by
 * the workspace and the boarding prefill.
 */
export async function updateFoundersMetaAction(
  candidateId: string,
  meta: { order: string[]; removed: string[] }
): Promise<ActionResult> {
  const user = await currentAppUser();
  if (!user) return { ok: false, error: SIGNED_OUT };
  if (!/^[0-9a-f-]{36}$/.test(candidateId)) {
    return { ok: false, error: "Invalid candidate id." };
  }
  const cleanNames = (arr: unknown): string[] | null => {
    if (!Array.isArray(arr) || arr.length > 20) return null;
    const out: string[] = [];
    for (const n of arr) {
      if (typeof n !== "string") return null;
      const t = n.trim();
      if (!t || t.length > 200) return null;
      out.push(t);
    }
    return out;
  };
  const order = cleanNames(meta?.order);
  const removed = cleanNames(meta?.removed);
  if (order === null || removed === null) {
    return { ok: false, error: "Bad founder list." };
  }
  try {
    const c = await import("@/lib/candidates");
    const candidate = await c.getCandidate(candidateId, user.email);
    if (!candidate) return { ok: false, error: "That candidate no longer exists." };
    const { confirmClaim } = await import("@/lib/claims");
    await confirmClaim(
      "candidate",
      candidateId,
      "foundersMeta",
      { order, removed },
      user.email
    );
    void logActivity(user.email, "reordered_founders", candidateId, {
      ordered: order.length,
      removed: removed.length,
    });
    revalidatePath(`/inbox/${candidateId}`);
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Couldn't save the founder list.",
    };
  }
}

export interface BoardInput {
  companyName?: string;
  stage?: string;
  financing?: string;
  round?: string;
  note?: string;
}

/**
 * Board a candidate onto the pipeline — with the reviewer's tweaks, or as-is
 * when the agent handles it. Returns the next open candidate so the triage
 * session flows straight on: act, advance, clear the queue.
 */
export async function boardCandidateAction(
  id: string,
  overrides: BoardInput = {}
): Promise<ActionResult & { gid?: string; nextId?: string | null; remaining?: number }> {
  const user = await currentAppUser();
  if (!user) return { ok: false, error: SIGNED_OUT };
  try {
    const c = await import("@/lib/candidates");
    const candidate = await c.getCandidate(id, user.email);
    if (!candidate?.source_email_id) {
      return { ok: false, error: "This candidate has no source email to promote." };
    }

    // Already drafted (older agent path made private drafts): elevate the
    // existing deal onto the shared board instead of minting a duplicate.
    if (candidate.promoted_deal_gid) {
      const { elevateDeal } = await import("@/lib/people");
      await elevateDeal(user.email, candidate.promoted_deal_gid, (overrides.stage ?? "to-meet") as StageKey);
      const queuePrior = await c.openCandidateQueue(user.email);
      const restPrior = queuePrior.filter((q) => q !== id);
      revalidatePath("/inbox");
      revalidatePath(`/inbox/${id}`);
      revalidatePath("/");
      return {
        ok: true,
        gid: candidate.promoted_deal_gid,
        nextId: restPrior[0] ?? null,
        remaining: restPrior.length,
      };
    }

    // Agent boarding lands on the REAL board: the same create path the full
    // form uses (team-visible, founders attached) — not a
    // private draft only its creator can see.
    const parsed = (candidate.parsed ?? {}) as {
      companyName?: string | null; oneLiner?: string | null; summary?: string | null;
      traction?: string | null; sector?: string | null; website?: string | null;
      raiseAmount?: string | null; round?: string | null;
      founders?: { fullName?: string; email?: string; linkedinUrl?: string; school?: string | null }[];
    };
    const company =
      overrides.companyName?.trim() || parsed.companyName?.trim() ||
      candidate.subject?.trim() || "Untitled";
    // Confirmed hunts (LinkedIn + school claims) ride into the agent-boarded
    // deal exactly like the manual form — schools become board tags too.
    const { claimsFor } = await import("@/lib/claims");
    const claimMap = await claimsFor("candidate", id).catch(
      () => ({}) as Awaited<ReturnType<typeof claimsFor>>
    );
    const { isHumanClaim } = await import("@/lib/claimsPure");
    const founderRows = (parsed.founders ?? [])
      .filter((f) => f.fullName?.trim())
      .map((f) => {
        const fname = f.fullName!.trim();
        const li = claimMap[`founderLinkedin:${fname}`]?.current;
        const sch = claimMap[`founderSchool:${fname}`]?.current;
        return {
          name: fname,
          school: f.school ?? (typeof sch?.value === "string" ? sch.value : ""),
          linkedin:
            f.linkedinUrl ??
            (li && isHumanClaim(li) && typeof li.value === "string" ? li.value : ""),
        };
      })
      .concat(
        // Discovered founders board only once a human confirmed the profile.
        Object.keys(claimMap)
          .filter((k) => k.startsWith("founderDiscovered:"))
          .map((k) => k.slice("founderDiscovered:".length))
          .filter(
            (n) =>
              !(parsed.founders ?? []).some(
                (f) => (f.fullName ?? "").trim().toLowerCase() === n.toLowerCase()
              )
          )
          .flatMap((n) => {
            const li = claimMap[`founderLinkedin:${n}`]?.current;
            if (!li || !isHumanClaim(li) || typeof li.value !== "string" || !li.value) return [];
            const sch = claimMap[`founderSchool:${n}`]?.current;
            return [{
              name: n,
              school: typeof sch?.value === "string" ? sch.value : "",
              linkedin: li.value,
            }];
          })
      );
    const founderNames = founderRows.map((f) => f.name);
    const dealName = founderNames.length ? `${founderNames.join(", ")} // ${company}` : company;
    const notes = [
      overrides.note?.trim() || null,
      parsed.oneLiner, parsed.summary,
      parsed.traction ? `Traction: ${parsed.traction}` : null,
      parsed.sector ? `Sector: ${parsed.sector}` : null,
      parsed.website ? `Website: ${parsed.website}` : null,
      `Ingested from the inbox — "${candidate.subject ?? ""}" (${candidate.from_email ?? "unknown"})`,
    ].filter(Boolean).join("\n\n");
    const sections = await fetchSections().catch(() => []);
    const wantStage = overrides.stage ?? "to-meet";
    const sectionGid =
      sections.find((s) => s.stage === wantStage)?.gid ??
      sections.find((s) => s.stage === "to-meet")?.gid ?? "";
    const ROUNDS = ["Angel", "Pre-Seed", "Seed", "Series A"];
    const round =
      ROUNDS.find((r) => r.toLowerCase() === (overrides.round ?? parsed.round ?? "").toLowerCase()) ?? "";

    const created = await createDeal({
      name: dealName,
      notes,
      sectionGid,
      schools: [...new Set(founderRows.map((f) => f.school).filter(Boolean))],
      financingAmount: overrides.financing?.trim() || parsed.raiseAmount || "",
      round,
      company,
      founders: founderRows,
    });
    if (!created.ok || !created.gid) {
      return { ok: false, error: created.error ?? "Couldn't create the deal." };
    }
    const gid = created.gid;
    await c.markCandidatePromoted(id, gid, user.email);
    // A-01: the new deal's field values came from this pitch email.
    {
      const { recordFieldSource } = await import("@/lib/provenance");
      const fin = overrides.financing?.trim() || parsed.raiseAmount || null;
      if (fin) recordFieldSource(gid, "financing", fin, "email", id, user.email);
      if (round) recordFieldSource(gid, "round", round, "email", id, user.email);
      recordFieldSource(gid, "notes", null, "email", id, user.email);
    }
    void logActivity(user.email, "boarded_candidate", gid, {
      candidate: id,
      reviewed: Object.keys(overrides).length > 0,
    });
    const queue = await c.openCandidateQueue(user.email);
    const rest = queue.filter((q) => q !== id);
    revalidatePath("/inbox");
    revalidatePath(`/inbox/${id}`);
    revalidatePath("/");
    return { ok: true, gid, nextId: rest[0] ?? null, remaining: rest.length };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Couldn't create the deal.",
    };
  }
}

/** Back-compat alias for the pre-overrides promotion call. */
export async function createDealFromCandidateAction(
  id: string
): Promise<ActionResult & { gid?: string }> {
  return boardCandidateAction(id);
}

/**
 * Enrich-in-place: re-read the pitch (extraction + deck + claims) and push
 * every LinkedIn-bearing founder into the network enrichment pipeline. The
 * candidate stays open — this gathers more, it never triages.
 */
export interface DocsendOutcome {
  status: "ok" | "gated" | "verify" | "error" | "already";
  note: string;
  url: string;
}

export async function enrichCandidateAction(
  id: string,
  opts?: { docsendPasscode?: string }
): Promise<ActionResult & { founders?: number; docsend?: DocsendOutcome }> {
  const user = await currentAppUser();
  if (!user) return { ok: false, error: SIGNED_OUT };
  try {
    const c = await import("@/lib/candidates");
    const candidate = await c.getCandidate(id, user.email);
    if (!candidate) return { ok: false, error: "That candidate no longer exists." };

    // DocSend first: a detected deck link becomes a stored PDF so the deck
    // re-read below has real pages to chew on. Passcodes come from the email
    // itself (mined) or from the member via the prompt in the Enrich button.
    let docsend: DocsendOutcome | undefined;
    const deckLink =
      (candidate.deck_links ?? []).find((l) => l.kind === "docsend")?.url ??
      (await import("@/lib/docsendPure")).findDocsendUrls(candidate.body_text)[0];
    if (deckLink) {
      const existing = await sql<{ id: string }[]>`
        select id from documents
         where original_url = ${deckLink} and source_type = 'docsend' limit 1`.catch(() => []);
      if (existing.length > 0) {
        docsend = { status: "already", note: "Deck already converted and attached.", url: deckLink };
      } else {
        const { captureDeck } = await import("@/lib/docsend");
        const { minePasscodes } = await import("@/lib/docsendPure");
        const tries: (string | undefined)[] = opts?.docsendPasscode
          ? [opts.docsendPasscode]
          : [undefined, ...minePasscodes(candidate.body_text)];
        let last: Awaited<ReturnType<typeof captureDeck>> | null = null;
        for (const passcode of tries.slice(0, 3)) {
          last = await captureDeck(deckLink, { passcode, budgetMs: 40_000 });
          if (last.status !== "gated") break; // only a wrong passcode earns another try
        }
        if (last?.status === "ok" && last.pdf) {
          const { saveDocument } = await import("@/lib/documents");
          await saveDocument({
            bytes: last.pdf,
            filename: "docsend-deck.pdf",
            mime: "application/pdf",
            sourceEmailId: candidate.source_email_id ?? null,
            sourceType: "docsend",
            originalUrl: deckLink,
          });
          docsend = { status: "ok", note: last.note, url: deckLink };
          // Digest what we just converted: the deck re-read runs the full
          // extraction over the thread's corpus and merges new facts in.
          if (candidate.source_email_id) {
            const { reparseInbound } = await import("@/lib/inbound");
            await reparseInbound(candidate.source_email_id).catch(() => "error");
          }
        } else if (last) {
          docsend = { status: last.status === "unavailable" ? "error" : last.status, note: last.note, url: deckLink };
        }
      }
    }

    // External sources only — the email and its extraction stay untouched.
    const parsed = (candidate.parsed ?? {}) as {
      companyName?: string | null;
      website?: string | null;
      founders?: { fullName?: string; linkedinUrl?: string; title?: string }[];
    };
    const { enrichCandidateExternal } = await import("@/lib/candidateEnrich");
    const summary = await enrichCandidateExternal({
      candidateId: id,
      company: parsed.companyName?.trim() || candidate.subject?.trim() || "",
      website: parsed.website ?? null,
      founders: parsed.founders ?? [],
      location: (parsed as { location?: string | null }).location ?? null,
      userEmail: user.email,
    });
    void logActivity(user.email, "enriched_candidate", id, { ...summary, docsend: docsend?.status ?? "none" });
    revalidatePath(`/inbox/${id}`);
    return { ok: true, founders: summary.foundersLinked, ...summary, docsend };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Enrichment didn't go through.",
    };
  }
}

/**
 * Human verdict on a suggested school: confirm writes team truth, tags the
 * boarded deal, and updates the person; reject buries the suggestion.
 */
export async function confirmFounderSchoolAction(
  candidateId: string,
  founderName: string,
  school: string | null
): Promise<ActionResult> {
  const user = await currentAppUser();
  if (!user) return { ok: false, error: SIGNED_OUT };
  const name = founderName.trim();
  if (!name || name.length > 200) return { ok: false, error: "Bad founder name." };
  if (school !== null && (!school.trim() || school.length > 120)) {
    return { ok: false, error: "Bad school." };
  }
  try {
    const c = await import("@/lib/candidates");
    const candidate = await c.getCandidate(candidateId, user.email);
    if (!candidate) return { ok: false, error: "That candidate no longer exists." };
    const { confirmClaim } = await import("@/lib/claims");
    await confirmClaim(
      "candidate",
      candidateId,
      `founderSchool:${name}`,
      school?.trim() ?? "",
      user.email
    );
    if (school && candidate.promoted_deal_gid) {
      await sql`
        update deals set schools = array_append(schools, ${school.trim()}),
          modified_on = ${new Date().toISOString().slice(0, 10)}
        where gid = ${candidate.promoted_deal_gid}
          and not (${school.trim()} = any(schools))
      `.catch(() => {});
      revalidatePath("/");
    }
    void logActivity(
      user.email,
      school ? "confirmed_founder_school" : "denied_founder_school",
      candidateId,
      { name, school }
    );
    revalidatePath(`/inbox/${candidateId}`);
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Couldn't save the school.",
    };
  }
}

/**
 * Record a founder's email address and mark it human-verified.
 *
 * Email is the identity spine: it's the only key that joins a founder to
 * synced mail and calendar invites, which is what makes "when did we last
 * connect" answerable. Claude extracts these from the pitch already, so the
 * UI pre-fills and this just records the human's yes.
 *
 * Writes to network_people — the canonical founder record the history join
 * reads — not to the notes text block, which is only a display convenience.
 */
export async function confirmFounderEmailAction(
  candidateId: string,
  founderName: string,
  email: string
): Promise<ActionResult> {
  const user = await currentAppUser();
  if (!user) return { ok: false, error: SIGNED_OUT };
  const name = founderName.trim();
  const addr = email.trim().toLowerCase();
  if (!name || name.length > 200) return { ok: false, error: "Bad founder name." };
  // Deliberately permissive — real addresses are stranger than any regex.
  if (!addr || addr.length > 320 || !/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(addr)) {
    return { ok: false, error: "That doesn't look like an email address." };
  }
  try {
    const c = await import("@/lib/candidates");
    const candidate = await c.getCandidate(candidateId, user.email);
    if (!candidate) return { ok: false, error: "That candidate no longer exists." };

    // Find the person by name among this deal's founders, falling back to a
    // name match in the network so a founder added elsewhere still resolves.
    const rows = await sql<{ id: string }[]>`
      select p.id
        from network_people p
        left join deal_founders f on f.person_id = p.id
       where lower(p.name) = ${name.toLowerCase()}
         and (${candidate.promoted_deal_gid ?? null}::text is null
              or f.deal_gid = ${candidate.promoted_deal_gid ?? null})
       order by (f.deal_gid is not null) desc
       limit 1
    `;
    const personId = rows[0]?.id;
    if (!personId) return { ok: false, error: "No founder record to attach that to yet." };

    // One address per person. If it's already someone else's, keep it there
    // and record ours as an alternate rather than fighting the unique index.
    const taken = await sql<{ id: string }[]>`
      select id from network_people where lower(email) = ${addr} and id <> ${personId}
    `;
    if (taken.length > 0) {
      await sql`
        update network_people
           set alt_emails = (select array_agg(distinct e)
                               from unnest(array_append(alt_emails, ${addr})) e)
         where id = ${personId}
      `;
    } else {
      await sql`
        update network_people
           set email = ${addr}, email_confirmed = true, updated_at = now()
         where id = ${personId}
      `;
    }

    void logActivity(user.email, "confirmed_founder_email", candidateId, {
      name,
      email: addr,
    });
    revalidatePath(`/inbox/${candidateId}`);
    revalidatePath("/");
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Couldn't save the email.",
    };
  }
}

/**
 * Human verdict on a hunted LinkedIn: confirm links the profile to the
 * founder (network person + team-confirmed claim); deny buries the
 * suggestion. Either way the hunt stops asking.
 */
export async function resolveFounderLinkedinAction(
  candidateId: string,
  founderName: string,
  url: string | null
): Promise<ActionResult> {
  const user = await currentAppUser();
  if (!user) return { ok: false, error: SIGNED_OUT };
  const name = founderName.trim();
  if (!name || name.length > 200) return { ok: false, error: "Bad founder name." };
  if (url !== null && !/^https:\/\/([a-z]+\.)?linkedin\.com\//i.test(url.trim())) {
    return { ok: false, error: "That doesn't look like a LinkedIn URL." };
  }
  try {
    const c = await import("@/lib/candidates");
    const candidate = await c.getCandidate(candidateId, user.email);
    if (!candidate) return { ok: false, error: "That candidate no longer exists." };
    const { confirmClaim } = await import("@/lib/claims");
    await confirmClaim(
      "candidate",
      candidateId,
      `founderLinkedin:${name}`,
      url ?? "",
      user.email
    );
    if (url) {
      const { upsertPersonFromFounder } = await import("@/lib/people");
      const person = await upsertPersonFromFounder(
        { linkedinUrl: url.trim(), fullName: name, experience: [], education: [] },
        null,
        user.email
      );

      // School rides along automatically: known now → claim + deal tag now;
      // otherwise enrichment fills network_people and the next confirm-free
      // sweep picks it up. Confirmed founders also attach straight onto the
      // boarded deal — nobody retypes a LinkedIn into the deal card.
      const personRow = await sql<{ id: string; school: string | null }[]>`
        select id, school from network_people where id = ${person.id}`;
      let school = personRow[0]?.school?.trim() || null;
      if (!school) {
        // Grounded lookup on the just-confirmed URL — accurate now, not
        // whenever background enrichment gets around to it.
        const { lookupFounderSchool } = await import("@/lib/candidateEnrich");
        const parsedC = (candidate.parsed ?? {}) as { companyName?: string | null };
        const found = await lookupFounderSchool(
          name,
          url.trim(),
          parsedC.companyName ?? candidate.subject ?? ""
        );
        if (found) {
          school = found.school;
          await sql`
            update network_people set school = ${found.school}
            where id = ${person.id} and (school is null or school = '')
          `.catch(() => {});
        }
      }
      if (school) {
        const { recordClaims } = await import("@/lib/claims");
        await recordClaims("candidate", candidateId, [
          {
            field: `founderSchool:${name}`,
            value: school,
            sourceType: "externally_verified",
            sourceRef: `person:${person.id}`,
            sourceSpan: null,
            confidence: 0.7,
          },
        ]).catch(() => {});
      }
      if (candidate.promoted_deal_gid) {
        const gid = candidate.promoted_deal_gid;
        await sql`
          insert into deal_founders (deal_gid, person_id, founder_role, created_by)
          values (${gid}, ${person.id}, 'Founder', ${user.email})
          on conflict (deal_gid, person_id) do nothing
        `.catch(() => {});
        if (school) {
          await sql`
            update deals set schools = array_append(schools, ${school}),
              modified_on = ${new Date().toISOString().slice(0, 10)}
            where gid = ${gid} and not (${school} = any(schools))
          `.catch(() => {});
          revalidatePath("/");
        }
      }
    }
    void logActivity(user.email, url ? "confirmed_founder_linkedin" : "denied_founder_linkedin", candidateId, { name });
    revalidatePath(`/inbox/${candidateId}`);
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Enrichment didn't go through.",
    };
  }
}

/**
 * After the full deal form created a REGULAR deal (createDeal),
 * stamp the candidate + source email as promoted and hand back the next
 * candidate so the triage session keeps flowing.
 */
export async function finalizeCandidatePromotionAction(
  candidateId: string,
  dealGid: string
): Promise<ActionResult & { nextId?: string | null; remaining?: number }> {
  const user = await currentAppUser();
  if (!user) return { ok: false, error: SIGNED_OUT };
  if (!/^(\d{1,30}|local-[0-9a-f-]{36})$/.test(dealGid)) {
    return { ok: false, error: "Invalid deal id." };
  }
  const t0 = performance.now();
  try {
    const c = await import("@/lib/candidates");
    const candidate = await c.getCandidate(candidateId, user.email);
    if (!candidate) return { ok: false, error: "Candidate not found." };
    if (candidate.source_email_id) {
      const { sql } = await import("@/lib/db");
      await sql`
        update inbound_emails
        set status = 'created', deal_gid = ${dealGid}, processed_at = now()
        where id = ${candidate.source_email_id} and deal_gid is null`;
    }
    await c.markCandidatePromoted(candidateId, dealGid, user.email);
    // A-01: the boarded deal's initial values trace back to this pitch.
    {
      const { recordFieldSource } = await import("@/lib/provenance");
      recordFieldSource(dealGid, "financing", null, "email", candidateId, user.email);
      recordFieldSource(dealGid, "round", null, "email", candidateId, user.email);
      recordFieldSource(dealGid, "notes", null, "email", candidateId, user.email);
    }
    // Fold in the rest of the thread: a reply that landed as its own open
    // candidate (it arrived before this deal existed) attaches now instead
    // of floating in the queue next to a deal that already covers it.
    try {
      if (candidate.source_email_id) {
        await sql`
          update deal_candidates dc
             set status = 'attached', promoted_deal_gid = ${dealGid},
                 reviewed_at = now(), reviewed_by = ${user.email}
            from inbound_emails e, inbound_emails src
           where e.id = dc.source_email_id
             and src.id = ${candidate.source_email_id}
             and dc.id <> ${candidateId}
             and dc.status in ('detected', 'parsing', 'ready', 'assigned', 'snoozed')
             and e.gmail_thread_id is not null
             and e.gmail_thread_id = src.gmail_thread_id`;
        await sql`
          update inbound_emails e
             set deal_gid = ${dealGid}
            from inbound_emails src
           where src.id = ${candidate.source_email_id}
             and e.gmail_thread_id is not null
             and e.gmail_thread_id = src.gmail_thread_id
             and e.deal_gid is null`;
      }
    } catch {
      // Sweep is hygiene — boarding already succeeded.
    }
    // Claim what the other channels know for the new deal: canonical founder
    // links WITH emails, every meeting with these people (past and future),
    // any other open pitch for the company. Runs AFTER the response — this
    // block reaches into Gmail (deep search) and must never hold the Create
    // button hostage; the reviewer advances in DB-time, context lands within
    // seconds behind them. Best-effort as before.
    if (candidate.source_email_id) {
      const srcEmailId = candidate.source_email_id;
      const actorEmail = user.email;
      after(async () => {
        try {
          const { sql } = await import("@/lib/db");
          const src = await sql<
            { from_email: string | null; parsed: { founders?: { fullName?: string; email?: string | null }[]; website?: string | null } | null }[]
          >`select from_email, parsed from inbound_emails where id = ${srcEmailId}`;
          const parsed = src[0]?.parsed ?? null;
          const founders = (parsed?.founders ?? []).filter(
            (f) => f.fullName && f.email
          );
          const { linkFounder } = await import("@/lib/calendarEnrich");
          for (const f of founders) {
            await linkFounder(dealGid, f.fullName as string, f.email as string).catch(
              () => {}
            );
          }
          const site = (parsed?.website ?? "")
            .toLowerCase()
            .replace(/^https?:\/\//, "")
            .replace(/^www\./, "")
            .split("/")[0];
          const { mergeDealContext } = await import("@/lib/dealContext");
          await mergeDealContext(
            dealGid,
            {
              emails: [src[0]?.from_email, ...founders.map((f) => f.email)].filter(
                (e): e is string => Boolean(e)
              ),
              domains: site ? [site] : [],
            },
            actorEmail
          );
        } catch {
          // Context stamping is additive; the deal itself is already created.
        }
      });
    }
    void logActivity(user.email, "boarded_candidate", dealGid, {
      candidate: candidateId,
      reviewed: true,
    });
    const queue = await c.openCandidateQueue(user.email);
    const rest = queue.filter((q) => q !== candidateId);
    revalidatePath("/inbox");
    revalidatePath(`/inbox/${candidateId}`);
    // The blocking part of boarding — Gmail context runs after the response.
    record("action.board_finalize", performance.now() - t0);
    return { ok: true, nextId: rest[0] ?? null, remaining: rest.length };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Couldn't finish the promotion.",
    };
  }
}

/** Re-run extraction for a candidate's source email. */
export async function reparseCandidateAction(id: string): Promise<ActionResult> {
  const user = await currentAppUser();
  if (!user) return { ok: false, error: SIGNED_OUT };
  try {
    const c = await import("@/lib/candidates");
    const candidate = await c.getCandidate(id, user.email);
    if (candidate?.source_email_id) {
      // A calendar-minted row has no real email behind it — "re-parsing" the
      // synthetic digest would let the classifier junk a live triage item.
      const { sql } = await import("@/lib/db");
      const src = await sql<{ mailbox: string }[]>`
        select mailbox from inbound_emails where id = ${candidate.source_email_id}`;
      if (src[0]?.mailbox === "calendar") {
        return {
          ok: false,
          error: "This item was minted from a meeting — there's no email to re-parse.",
        };
      }
    }
    if (!candidate?.source_email_id) {
      return { ok: false, error: "This candidate has no source email." };
    }
    const { reparseInbound } = await import("@/lib/inbound");
    await reparseInbound(candidate.source_email_id);
    revalidatePath("/inbox");
    revalidatePath(`/inbox/${id}`);
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Couldn't re-parse the email.",
    };
  }
}

/* ── Extracted-claims provenance ledger (PR-06) ──────────────────────────── */

const CLAIM_FIELD = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/;

/**
 * A member vouches for a field's value: append a team_confirmed claim.
 * Append-only — the machine's row stays in the ledger, so a disagreement
 * surfaces as a conflict instead of silently vanishing.
 */
export async function confirmClaimAction(
  subjectType: string,
  subjectId: string,
  field: string,
  value: string
): Promise<ActionResult> {
  const user = await currentAppUser();
  if (!user) return { ok: false, error: SIGNED_OUT };
  if (!["candidate", "deal", "company"].includes(subjectType)) {
    return { ok: false, error: "Invalid subject." };
  }
  if (!CLAIM_FIELD.test(field)) return { ok: false, error: "Invalid field." };
  const v = value.trim();
  if (!v || v.length > 500) {
    return { ok: false, error: "Give the field a value (1–500 characters)." };
  }
  try {
    // Candidates carry visibility rules — confirm only what the member can see.
    if (subjectType === "candidate") {
      const c = await import("@/lib/candidates");
      const candidate = await c.getCandidate(subjectId, user.email);
      if (!candidate) return { ok: false, error: "Candidate not found." };
    }
    const { confirmClaim } = await import("@/lib/claims");
    await confirmClaim(
      subjectType as "candidate" | "deal" | "company",
      subjectId,
      field,
      v,
      user.email
    );
    void logActivity(user.email, "confirmed_claim", subjectId, { field });
    if (subjectType === "candidate") revalidatePath(`/inbox/${subjectId}`);
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Couldn't confirm the field.",
    };
  }
}

/** Admin: run the mailbox poll on demand (the cron does this every 15 min). */
export async function pollInboundNowAction(): Promise<
  ActionResult & { fetched?: number; parsed?: number; skipped?: number; connected?: boolean }
> {
  const user = await requireRole("admin");
  if (!user) return { ok: false, error: "Admins only." };
  try {
    const { ingestInbound } = await import("@/lib/inbound");
    const r = await ingestInbound();
    void logActivity(user.email, "inbound_poll", "", { fetched: r.fetched, parsed: r.parsed });
    revalidatePath("/inbound");
    return { ok: true, connected: r.connected, fetched: r.fetched, parsed: r.parsed, skipped: r.skipped };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Poll didn't run.",
    };
  }
}

/** Admin: disconnect the shared sourcing mailbox. */
export async function disconnectInboundMailboxAction(): Promise<ActionResult> {
  const user = await requireRole("admin");
  if (!user) return { ok: false, error: "Admins only." };
  try {
    const { deleteInboundMailbox } = await import("@/lib/inboundMailbox");
    const { stopWatch } = await import("@/lib/inbound");
    await stopWatch().catch(() => {});
    await deleteInboundMailbox();
    void logActivity(user.email, "inbound_mailbox_disconnected", "");
    revalidatePath("/settings");
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Couldn't disconnect.",
    };
  }
}

/* ── Deal comments ───────────────────────────────────────────────────────── */

export async function getDealComments(gid: string) {
  if (!GID.test(gid)) return { ok: false as const, error: "Invalid deal id." };
  const user = await currentAppUser();
  if (!user) return { ok: false as const, error: SIGNED_OUT };
  const { listDealComments } = await import("@/lib/comments");
  return { ok: true as const, comments: await listDealComments(gid) };
}

export async function addDealCommentAction(
  gid: string,
  body: string,
  parentId?: string | null,
  mentions?: string[]
): Promise<ActionResult & { id?: string }> {
  if (!GID.test(gid)) return { ok: false, error: "Invalid deal id." };
  const user = await currentAppUser();
  if (!user) return { ok: false, error: SIGNED_OUT };
  const { addDealComment } = await import("@/lib/comments");
  const res = await addDealComment(
    gid,
    { email: user.email, name: user.name, image: user.image },
    body,
    parentId ?? null,
    Array.isArray(mentions) ? mentions.slice(0, 20) : []
  );
  if (!res.ok) return { ok: false, error: res.error };
  revalidatePath("/");
  return { ok: true, id: res.id };
}

/* ── Notifications ───────────────────────────────────────────────────────── */

export async function getNotifications() {
  const user = await currentAppUser();
  if (!user) return { ok: false as const, error: SIGNED_OUT };
  const { listNotifications, unreadNotificationCount } = await import("@/lib/notifications");
  const [items, unread] = await Promise.all([
    listNotifications(user.email),
    unreadNotificationCount(user.email),
  ]);
  return {
    ok: true as const,
    unread,
    items: items.map((n) => ({
      id: n.id,
      type: n.type,
      dealGid: n.deal_gid,
      dealName: n.deal_name,
      actorName: n.actor_name,
      actorImage: n.actor_image,
      actorEmail: n.actor_email,
      excerpt: n.excerpt,
      read: n.read_at != null,
      createdAt: n.created_at.toISOString(),
    })),
  };
}

export async function unreadNotificationsAction(): Promise<{ ok: boolean; unread?: number }> {
  const user = await currentAppUser();
  if (!user) return { ok: false };
  const { unreadNotificationCount } = await import("@/lib/notifications");
  return { ok: true, unread: await unreadNotificationCount(user.email) };
}

export async function markNotificationsReadAction(ids?: string[]): Promise<ActionResult> {
  const user = await currentAppUser();
  if (!user) return { ok: false, error: SIGNED_OUT };
  const { markNotificationsRead } = await import("@/lib/notifications");
  await markNotificationsRead(user.email, ids);
  revalidatePath("/");
  return { ok: true };
}

export async function deleteDealCommentAction(id: string): Promise<ActionResult> {
  const user = await currentAppUser();
  if (!user) return { ok: false, error: SIGNED_OUT };
  const { deleteDealComment } = await import("@/lib/comments");
  const res = await deleteDealComment(id, { email: user.email, role: user.role });
  if (!res.ok) return { ok: false, error: res.error };
  revalidatePath("/");
  return { ok: true };
}

/* ── Deal attachments (list / open / remove) ─────────────────────────────── */

export interface DealAttachmentView {
  gid: string;
  name: string;
  /** Link that opens the file (a fresh signed URL is minted on click). */
  url: string | null;
  /** Direct file URL (temporary) — used to thumbnail images. */
  downloadUrl: string | null;
  isImage: boolean;
}

export async function getDealAttachments(
  gid: string
): Promise<{ ok: true; items: DealAttachmentView[] } | { ok: false; error: string }> {
  if (!GID.test(gid)) return { ok: false, error: "Invalid deal id." };
  const user = await currentAppUser();
  if (!user) return { ok: false, error: SIGNED_OUT };
  const { listDocumentsForDeal } = await import("@/lib/documents");
  const docs = await listDocumentsForDeal(gid).catch(() => []);
  return {
    ok: true,
    items: docs.map((d) => ({
      gid: d.id,
      name: d.filename,
      url: `/api/documents/${d.id}`,
      downloadUrl: null,
      isImage: /\.(png|jpe?g|gif|webp|heic|bmp|svg)$/i.test(d.filename),
    })),
  };
}

export async function removeDealAttachmentAction(
  gid: string,
  attachmentId: string
): Promise<ActionResult> {
  if (!GID.test(gid)) return { ok: false, error: "Invalid deal id." };
  if (!/^[0-9a-f-]{36}$/i.test(attachmentId))
    return { ok: false, error: "Invalid attachment." };
  const user = await currentAppUser();
  if (!user) return { ok: false, error: SIGNED_OUT };
  if (!(await canTouchDeal(user, gid))) return { ok: false, error: NOT_YOURS };
  try {
    const { getDocument, deleteDocument } = await import("@/lib/documents");
    // The id must belong to THIS deal, or anyone could delete any file.
    const doc = await getDocument(attachmentId);
    if (!doc || doc.deal_gid !== gid) return { ok: false, error: "Invalid attachment." };
    await deleteDocument(attachmentId);
    await sql`
      update deals set attachment_count = greatest(attachment_count - 1, 0) where gid = ${gid}
    `.catch(() => {});
    void logActivity(user.email, "removed_attachment", gid, {});
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Couldn't remove the attachment.",
    };
  }
}

/* ── Deal decisions (verdict + rationale, separate from board stage) ──────── */

export interface DealDecisionView {
  decision: string;
  rationale: string;
  actorName: string;
  actorEmail: string;
  at: string; // ISO
}

/** Current decision + full history for a deal. */
export async function getDealDecisions(
  gid: string
): Promise<
  | { ok: true; current: DealDecisionView | null; history: DealDecisionView[] }
  | { ok: false; error: string }
> {
  if (!GID.test(gid)) return { ok: false, error: "Invalid deal id." };
  const user = await currentAppUser();
  if (!user) return { ok: false, error: SIGNED_OUT };
  const { listDealDecisions } = await import("@/lib/decisions");
  const rows = await listDealDecisions(gid);
  const history: DealDecisionView[] = rows.map((r) => ({
    decision: r.decision,
    rationale: r.rationale,
    actorName: r.actor_name,
    actorEmail: r.actor_email,
    at: r.created_at.toISOString(),
  }));
  return { ok: true, current: history[0] ?? null, history };
}

/* ── Deal activity (edit history for the Activity panel) ──────────────────── */

export interface DealActivityView {
  actorName: string;
  actorImage: string | null;
  action: string;
  detail: Record<string, unknown>;
  at: string; // ISO
}

/** The audit trail for one deal, newest first, with actor names resolved. */
export async function getDealActivity(
  gid: string
): Promise<
  | { ok: true; items: DealActivityView[]; createdOn: string | null }
  | { ok: false; error: string }
> {
  if (!GID.test(gid)) return { ok: false, error: "Invalid deal id." };
  const user = await currentAppUser();
  if (!user) return { ok: false, error: SIGNED_OUT };
  const created = await sql<{ created_on: Date | null }[]>`
    select created_on from deals where gid = ${gid}
  `;
  const rows = await sql<
    {
      action: string;
      detail: Record<string, unknown> | null;
      created_at: Date;
      actor_name: string;
      actor_image: string | null;
    }[]
  >`
    select a.action, a.detail, a.created_at,
           coalesce(u.name, a.actor) as actor_name, u.image as actor_image
    from activity_log a
    left join app_users u on lower(u.email) = lower(a.actor)
    where a.target = ${gid}
    order by a.created_at desc
    limit 100
  `;
  return {
    ok: true,
    createdOn: created[0]?.created_on ? created[0].created_on.toISOString() : null,
    items: rows.map((r) => ({
      actorName: r.actor_name,
      actorImage: r.actor_image,
      action: r.action,
      detail: r.detail ?? {},
      at: r.created_at.toISOString(),
    })),
  };
}

/* ── Deal meetings (matched calendar events) ──────────────────────────────── */

const EVENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Calendar meetings matched to a deal, for the modal's Meetings section. */
export async function getDealMeetingsAction(
  gid: string
): Promise<
  | { ok: true; items: DealMeeting[]; looseNotes: DealNote[] }
  | { ok: false; error: string }
> {
  if (!GID.test(gid)) return { ok: false, error: "Invalid deal id." };
  const user = await currentAppUser();
  if (!user) return { ok: false, error: SIGNED_OUT };
  const { meetingsWithNotesForDeal } = await import("@/lib/meetings");
  const { meetings, looseNotes } = await meetingsWithNotesForDeal(gid);
  return { ok: true, items: meetings, looseNotes };
}

/**
 * Merge two deals for the same company into one. The server picks the
 * survivor (deeper stage, tie → older); the duplicate's history repoints and
 * the row is deleted . Explicit-confirm only.
 */
export async function mergeDealsAction(
  gidA: string,
  gidB: string
): Promise<ActionResult & { keptGid?: string; keptName?: string; absorbedName?: string }> {
  if (!GID.test(gidA) || !GID.test(gidB)) return { ok: false, error: "Invalid deal id." };
  const user = await currentAppUser();
  if (!user) return { ok: false, error: SIGNED_OUT };
  if (!(await canTouchDeal(user, gidA)) || !(await canTouchDeal(user, gidB))) {
    return { ok: false, error: "You don't have access to one of those deals." };
  }
  try {
    const { mergeDeals } = await import("@/lib/dealMerge");
    const res = await mergeDeals(gidA, gidB, user.email);
    if ("error" in res) return { ok: false, error: res.error };
    void logActivity(user.email, "merged_deal", res.keptGid, {
      absorbed: res.absorbedName,
    });
    revalidatePath("/");
    revalidatePath(`/deals/${res.keptGid}`);
    return { ok: true, ...res };
  } catch (err) {
    const { logError } = await import("@/lib/log");
    logError("pipeline", "merge action failed", err, { gidA, gidB });
    return { ok: false, error: "Couldn't merge those deals." };
  }
}

/** The deal's normalized email history + the documents it carried. */
export async function getDealEmailsAction(
  gid: string
): Promise<{ ok: true; history: DealHistory } | { ok: false; error: string }> {
  if (!GID.test(gid)) return { ok: false, error: "Invalid deal id." };
  const user = await currentAppUser();
  if (!user) return { ok: false, error: SIGNED_OUT };
  const { emailHistoryForDeal } = await import("@/lib/dealEmails");
  const history = await emailHistoryForDeal(gid);
  // Freshen the founders' mail trail in the background; the next open (or
  // merge) reads a deeper store. Never blocks this response, and never runs
  // more than once per deal per 6 hours — claimDeepSearch is the atomic
  // cooldown, so browsing a deal card repeatedly costs zero provider calls.
  if (history.foundersKnown) {
    void (async () => {
      try {
        const { claimDeepSearch, deepSearchMail } = await import("@/lib/mailSync");
        if (!(await claimDeepSearch(gid))) return;
        const { founderEmailsForDeal } = await import("@/lib/identityEvidence");
        const addrs = await founderEmailsForDeal(gid);
        if (addrs.length > 0) {
          await deepSearchMail(addrs, {
            domain: addrs[0]?.split("@")[1] ?? null,
            maxPerConnection: 40,
          });
        }
      } catch {
        // background dig only
      }
    })();
  }
  return { ok: true, history };
}

/** Detach a wrongly-matched calendar event from a deal (one-click undo).
 *  When the meeting carries a Granola note, pass its id so the note leaves
 *  with the meeting instead of resurfacing as a loose card. */
export async function unmatchMeetingAction(
  eventId: string,
  dealGid: string,
  noteId?: string
): Promise<ActionResult> {
  if (!EVENT_ID.test(eventId)) return { ok: false, error: "Invalid meeting." };
  if (!GID.test(dealGid)) return { ok: false, error: "Invalid deal id." };
  if (noteId && !EVENT_ID.test(noteId)) return { ok: false, error: "Invalid note." };
  const user = await currentAppUser();
  if (!user) return { ok: false, error: SIGNED_OUT };
  const { clearMeetingMatch } = await import("@/lib/meetings");
  const changed = await clearMeetingMatch(eventId);
  if (!changed) return { ok: false, error: "Couldn't unmatch that meeting." };
  if (noteId) {
    // Best-effort: the meeting is already detached either way.
    await sql`
      update meeting_notes
         set match_state = 'dismissed',
             match_evidence = ${sql.json({ via: "removed-with-meeting", by: user.email } as never)},
             review_state = 'skipped',
             proposed_updates = null,
             undo_snapshot = null
       where id = ${noteId} and matched_deal_gid = ${dealGid}`.catch(() => undefined);
  }
  void logActivity(user.email, "unmatched_meeting", dealGid, { eventId });
  revalidatePath("/");
  return { ok: true };
}

/** Remove a Granola note from a deal — remembered as dismissed, never re-suggested. */
export async function detachNoteFromDealAction(
  noteId: string,
  dealGid: string
): Promise<ActionResult> {
  if (!EVENT_ID.test(noteId)) return { ok: false, error: "Invalid note." };
  if (!/^(\d{1,30}|local-[0-9a-f-]{36})$/.test(dealGid)) {
    return { ok: false, error: "Invalid deal id." };
  }
  const user = await currentAppUser();
  if (!user) return { ok: false, error: SIGNED_OUT };
  try {
    if (!(await canTouchDeal(user, dealGid))) {
      return { ok: false, error: "You don't have access to that deal." };
    }
    const removed = await sql`
      update meeting_notes
         set match_state = 'dismissed',
             match_evidence = ${sql.json({ via: "removed-from-deal", by: user.email } as never)},
             review_state = 'skipped',
             proposed_updates = null,
             undo_snapshot = null
       where id = ${noteId}
         and matched_deal_gid = ${dealGid}
         and match_state in ('confirmed', 'attached', 'suggested')`;
    if (removed.count === 0) return { ok: false, error: "That note isn't on this deal." };
    void logActivity(user.email, "granola_removed", dealGid, { note: noteId });
    revalidatePath("/");
    return { ok: true };
  } catch {
    return { ok: false, error: "Couldn't remove the note." };
  }
}

/** Set (append) a decision. Rationale is required. */
export async function setDealDecisionAction(
  gid: string,
  decision: string,
  rationale: string
): Promise<ActionResult> {
  if (!GID.test(gid)) return { ok: false, error: "Invalid deal id." };
  const { isDecisionKey, normalizeRationale } = await import("@/lib/decisionsPure");
  if (!isDecisionKey(decision)) return { ok: false, error: "Pick a valid decision." };
  const reason = normalizeRationale(rationale);
  if (!reason) return { ok: false, error: "Add a short reason for this decision." };

  const user = await currentAppUser();
  if (!user) return { ok: false, error: SIGNED_OUT };
  if (!(await canTouchDeal(user, gid))) return { ok: false, error: NOT_YOURS };

  const { setDealDecision } = await import("@/lib/decisions");
  await setDealDecision(gid, { email: user.email, name: user.name }, decision, reason);
  void logActivity(user.email, "set_decision", gid, { decision });
  revalidatePath("/");
  return { ok: true };
}

/* ── Triage from the calendar ─────────────────────────────────────────────── */

/**
 * Turn a meeting into a deal. The invite already knows the company (the
 * attendees' domain) and usually the founders (named attendees at it) — so
 * one click creates the same private draft the inbox path would, founders
 * networked and linked, and the meeting itself becomes the deal's first
 * matched touchpoint. The enrichment is recomputed server-side from the
 * event; nothing from the client is trusted beyond the two ids.
 */
/**
 * The calendar door into the inbox triage flow: resolve this meeting company
 * to a candidate (reuse an open one, reopen a reviewed one, or mint one from
 * the meeting + prior email) and hand back its id. The client routes to
 * /inbox/<id> — the exact same session the email door uses.
 */
/**
 * ── Granola review actions ───────────────────────────────────────────────────
 * Apply / dismiss / undo for a note's proposed deal updates, and manual
 * attachment for the Unmatched queue. Everything is explicit and reversible;
 * the deal is only written by applyNoteUpdates after a human clicked Apply.
 */
export async function applyGranolaUpdatesAction(
  noteId: string,
  picks: number[] | "all"
): Promise<ActionResult & { applied?: number; dealGid?: string }> {
  const user = await currentAppUser();
  if (!user) return { ok: false, error: SIGNED_OUT };
  try {
    const gate = await sql<{ matched_deal_gid: string | null }[]>`
      select matched_deal_gid from meeting_notes where id = ${noteId}`;
    const dealGid = gate[0]?.matched_deal_gid;
    if (!dealGid || !(await canTouchDeal(user, dealGid))) {
      return { ok: false, error: "You don't have access to that deal." };
    }
    const { applyNoteUpdates } = await import("@/lib/meetingNoteUpdates");
    const res = await applyNoteUpdates(noteId, picks, user.email);
    if ("error" in res) return { ok: false, error: res.error };
    void logActivity(user.email, "granola_applied", res.dealGid, { note: noteId, applied: res.applied });
    revalidatePath("/meetings");
    revalidatePath(`/deals/${res.dealGid}`);
    return { ok: true, applied: res.applied, dealGid: res.dealGid };
  } catch (err) {
    const { logError } = await import("@/lib/log");
    logError("granola", "apply action failed", err, { noteId });
    return { ok: false, error: "Couldn't apply the updates." };
  }
}

export async function dismissGranolaUpdatesAction(noteId: string): Promise<ActionResult> {
  const user = await currentAppUser();
  if (!user) return { ok: false, error: SIGNED_OUT };
  try {
    const gate = await sql<{ matched_deal_gid: string | null }[]>`
      select matched_deal_gid from meeting_notes where id = ${noteId}`;
    if (gate[0]?.matched_deal_gid && !(await canTouchDeal(user, gate[0].matched_deal_gid))) {
      return { ok: false, error: "You don't have access to that deal." };
    }
    const { dismissNoteUpdates } = await import("@/lib/meetingNoteUpdates");
    await dismissNoteUpdates(noteId, user.email);
    revalidatePath("/meetings");
    return { ok: true };
  } catch {
    return { ok: false, error: "Couldn't dismiss." };
  }
}

export async function undoGranolaApplyAction(noteId: string): Promise<ActionResult> {
  const user = await currentAppUser();
  if (!user) return { ok: false, error: SIGNED_OUT };
  try {
    const gate = await sql<{ matched_deal_gid: string | null }[]>`
      select matched_deal_gid from meeting_notes where id = ${noteId}`;
    const gid = gate[0]?.matched_deal_gid;
    if (!gid || !(await canTouchDeal(user, gid))) {
      return { ok: false, error: "You don't have access to that deal." };
    }
    const { undoNoteApply } = await import("@/lib/meetingNoteUpdates");
    const res = await undoNoteApply(noteId);
    if (!res.ok) return { ok: false, error: "Nothing to undo." };
    void logActivity(user.email, "granola_undone", res.dealGid ?? "", { note: noteId });
    revalidatePath("/meetings");
    if (res.dealGid) revalidatePath(`/deals/${res.dealGid}`);
    return { ok: true };
  } catch {
    return { ok: false, error: "Couldn't undo." };
  }
}

/** Attach an unmatched note to a deal, then propose its updates. */
/** The freshest live deals — the picker's first screen before anyone types. */
export async function recentDealsAction(
  limit = 8
): Promise<{ ok: boolean; deals?: { gid: string; name: string; stage: string }[] }> {
  const user = await currentAppUser();
  if (!user) return { ok: false };
  const rows = await sql<{ gid: string; name: string; stage: string }[]>`
    select gid, name, stage from deals
    where stage not in ('passed', 'to-pass') and name <> ''
    order by modified_on desc nulls last, synced_at desc nulls last
    limit ${Math.min(Math.max(limit, 1), 20)}
  `.catch(() => []);
  return { ok: true, deals: rows };
}

export async function attachNoteToDealAction(
  noteId: string,
  dealGid: string,
  opts: { repoint?: boolean } = {}
): Promise<ActionResult> {
  const user = await currentAppUser();
  if (!user) return { ok: false, error: SIGNED_OUT };
  if (!/^(\d{1,30}|local-[0-9a-f-]{36})$/.test(dealGid)) {
    return { ok: false, error: "Invalid deal id." };
  }
  try {
    if (!(await canTouchDeal(user, dealGid))) {
      return { ok: false, error: "You don't have access to that deal." };
    }
    const attached = await sql`
      update meeting_notes
         set matched_deal_gid = ${dealGid},
             match_state = 'confirmed',
             match_confidence = 1.0,
             match_evidence = ${sql.json({ via: "manual", by: user.email } as never)},
             review_state = 'none',
             proposed_updates = null,
             undo_snapshot = null,
             applied_at = null
       where id = ${noteId}
         and (${opts.repoint === true} or match_state in ('unmatched', 'suggested'))`;
    if (attached.count === 0) {
      return { ok: false, error: "That note was already matched." };
    }
    revalidatePath(`/deals/${dealGid}`);
    revalidatePath(`/inbox/note/${noteId}`);
    const { proposeNoteUpdates } = await import("@/lib/meetingNoteUpdates");
    await proposeNoteUpdates(noteId).catch(() => 0);
    void logActivity(user.email, "granola_attached", dealGid, { note: noteId });
    revalidatePath("/meetings");
    return { ok: true };
  } catch {
    return { ok: false, error: "Couldn't attach the note." };
  }
}

/** "Not a deal" for a Granola note — remembered, never re-suggested. */
export async function dismissNoteAction(noteId: string): Promise<ActionResult> {
  const user = await currentAppUser();
  if (!user) return { ok: false, error: SIGNED_OUT };
  try {
    await sql`
      update meeting_notes
         set match_state = 'dismissed',
             match_evidence = ${sql.json({ via: "not-a-deal", by: user.email } as never)}
       where id = ${noteId}`;
    revalidatePath("/meetings");
    return { ok: true };
  } catch {
    return { ok: false, error: "Couldn't dismiss." };
  }
}

/** Undo a meeting dismissal: the company suggestion comes back. */
export async function undoDismissMeetingAction(
  eventId: string,
  domain: string
): Promise<ActionResult> {
  const user = await currentAppUser();
  if (!user) return { ok: false, error: SIGNED_OUT };
  const dom = domain.trim().toLowerCase();
  try {
    await sql`
      update calendar_events
         set triage_dismissed = array_remove(coalesce(triage_dismissed, '{}'), ${dom})
       where id = ${eventId}`;
    revalidatePath("/meetings");
    return { ok: true };
  } catch {
    return { ok: false, error: "Could not undo." };
  }
}

export async function triageMeetingAction(
  eventId: string,
  domain: string
): Promise<ActionResult & { candidateId?: string; dealGid?: string }> {
  const user = await currentAppUser();
  if (!user) return { ok: false, error: SIGNED_OUT };
  const dom = domain.trim().toLowerCase();
  if (!/^[a-z0-9.-]{4,253}$/.test(dom)) return { ok: false, error: "Bad domain." };
  try {
    const { mintCandidateFromMeeting } = await import("@/lib/meetingCandidate");
    const res = await mintCandidateFromMeeting(eventId, dom, user.email);
    if (!res.ok) return res;
    revalidatePath("/meetings");
    revalidatePath("/inbox");
    if (res.how === "deal") return { ok: true, dealGid: res.dealGid };
    return { ok: true, candidateId: res.id };
  } catch (err) {
    const { logError } = await import("@/lib/log");
    logError("pipeline", "meeting triage mint failed", err, { eventId, domain: dom });
    return { ok: false, error: "Couldn't open triage for that meeting." };
  }
}

export async function createDealFromMeetingAction(
  eventId: string,
  domain: string
): Promise<ActionResult & { gid?: string }> {
  const user = await currentAppUser();
  if (!user) return { ok: false, error: SIGNED_OUT };
  const dom = domain.trim().toLowerCase();
  if (!/^[a-z0-9.-]{4,253}$/.test(dom)) return { ok: false, error: "Bad domain." };

  try {
    const { enrichEventById, companyNameFromDomain, linkFounder } = await import(
      "@/lib/calendarEnrich"
    );
    const ev = await enrichEventById(eventId);
    if (!ev) return { ok: false, error: "That meeting no longer exists." };
    const company = ev.companies.find((c) => c.domain === dom);
    if (!company) return { ok: false, error: "Nobody from that company is on the invite." };
    if (company.dealGid) {
      // Already on the board: don't fork and don't dead-end — claim this
      // meeting (and any other loose context) for the existing deal.
      const { stampDealContext } = await import("@/lib/dealContext");
      await stampDealContext(
        company.dealGid,
        { emails: company.attendees.map((a) => a.email), domains: [dom] },
        user.email
      );
      await sql`
        update calendar_events
           set matched_deal_gid = ${company.dealGid},
               match_confidence = 1.0,
               match_evidence = ${sql.json({ via: "meeting-triage", by: user.email } as never)},
               enriched_at = now()
         where id = ${eventId} and matched_deal_gid is null
      `.catch(() => {});
      revalidatePath("/meetings");
      return { ok: true, gid: company.dealGid };
    }

    const companyName = companyNameFromDomain(dom);
    const named = company.attendees.filter((a) => a.name);
    const dealName =
      named.length > 0
        ? `${named.map((a) => a.name).join(", ")} // ${companyName}`
        : companyName;

    const when = ev.startsAt
      ? etFullDate(ev.startsAt)
      : "an unscheduled meeting";
    const attendeeLines = company.attendees
      .map((a) => `• ${a.name ?? "(name unknown)"} — ${a.email}`)
      .join("\n");
    const notes = `Sourced from the calendar: ${ev.upcoming ? "meeting scheduled" : "met"} "${ev.title}" (${when}).\n\nFounders\n${attendeeLines}`;

    // A meeting already taken starts at First Meeting; one on the books
    // starts at To Meet. Same section objects the create modal uses.
    const sections = await fetchSections().catch(() => []);
    const wantStage = ev.upcoming ? "to-meet" : "first-meeting";
    const section =
      sections.find((sec) => sec.stage === wantStage) ?? sections[0] ?? null;

    const created = await createDeal({
      name: dealName,
      notes,
      sectionGid: section?.gid ?? "",
      schools: [],
      company: companyName,
      founders: named.map((a) => ({ name: a.name!, school: "", linkedin: "" })),
    });
    if (!created.ok || !created.gid) return created;

    // The canonical founder links, emails attached — what History joins on.
    for (const a of named) {
      await linkFounder(created.gid, a.name!, a.email).catch(() => {});
    }
    // Claim everything the other channels know: every other meeting with
    // these people (past and future), and any pitch for this company still
    // sitting open in the inbox — one company, one queue item, one deal.
    const { stampDealContext, absorbPitchContent } = await import(
      "@/lib/dealContext"
    );
    const seed = {
      emails: company.attendees.map((a) => a.email),
      domains: [dom],
    };
    const stamped = await stampDealContext(created.gid, seed, user.email);
    // And the email channel's CONTENT, not just links: raise, round and the
    // one-liner from any pitch we hold (even one skipped back when it wasn't
    // actionable), plus a note that prior correspondence exists.
    await absorbPitchContent(created.gid, seed, user.email);
    await sql`
      update calendar_events
         set matched_deal_gid = ${created.gid},
             match_confidence = 1.0,
             match_evidence = ${sql.json({ via: "meeting-triage", by: user.email } as never)},
             enriched_at = now()
       where id = ${eventId}
    `.catch(() => {});

    void logActivity(user.email, "created_deal_from_meeting", created.gid, {
      title: ev.title,
      domain: dom,
      meetings_claimed: stamped.meetingsStamped,
      pitch_attached: stamped.candidatesAttached,
    });
    revalidatePath("/meetings");
    revalidatePath("/");
    return created;
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Couldn't create the deal.",
    };
  }
}

/** "Not a deal" — remember the verdict so the suggestion stays gone. */
export async function dismissMeetingSuggestionAction(
  eventId: string,
  domain: string
): Promise<ActionResult> {
  const user = await currentAppUser();
  if (!user) return { ok: false, error: SIGNED_OUT };
  const dom = domain.trim().toLowerCase();
  try {
    await sql`
      update calendar_events
         set triage_dismissed = (
           select array_agg(distinct d) from unnest(array_append(triage_dismissed, ${dom})) d
         )
       where id = ${eventId}
    `;
    void logActivity(user.email, "dismissed_meeting_suggestion", eventId, { domain: dom });
    revalidatePath("/meetings");
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Couldn't dismiss that.",
    };
  }
}

/* ── The thoughtful pass ───────────────────────────────────────────────────── */

/**
 * Draft (or improve) a pass note from everything the system knows about the
 * deal. Never sends anything; the composer stays in charge.
 */
export async function draftPassEmailAction(
  gid: string,
  opts: { mode: "replace" | "improve"; currentDraft?: string | null }
): Promise<
  ActionResult & {
    subject?: string;
    body?: string;
    needsMoreContext?: boolean;
    missingContext?: string[];
  }
> {
  const user = await currentAppUser();
  if (!user) return { ok: false, error: SIGNED_OUT };
  if (!(await canTouchDeal(user, gid))) return { ok: false, error: NOT_YOURS };
  try {
    const { draftPassEmail } = await import("@/lib/passEmail");
    const draft = await draftPassEmail(gid, {
      mode: opts.mode === "improve" ? "improve" : "replace",
      currentDraft: opts.currentDraft?.slice(0, 4000) ?? null,
      senderFirstName: (user.name || user.email).split(/[\s@]+/)[0],
    });
    if (!draft) {
      return {
        ok: false,
        error: "Couldn't draft from the deal context. The default note is still yours to edit.",
      };
    }
    return {
      ok: true,
      subject: draft.subject,
      body: draft.body,
      needsMoreContext: draft.needsMoreContext,
      missingContext: draft.missingContext,
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Drafting didn't go through.",
    };
  }
}

/**
 * Send the pass note through the deals@ mailbox, record it into the deal's
 * email history, set the pass decision, and move the stage. Validation
 * mirrors the composer: no recipient, empty body, or unresolved
 * placeholders ever leave the building.
 */
export async function sendPassEmailAction(
  gid: string,
  input: { to: string; cc?: string; subject: string; body: string }
): Promise<ActionResult> {
  const user = await currentAppUser();
  if (!user) return { ok: false, error: SIGNED_OUT };
  if (!(await canTouchDeal(user, gid))) return { ok: false, error: NOT_YOURS };
  const { passDraftProblem, parseCcList } = await import("@/lib/passEmailPure");
  const draft = {
    to: input.to.trim(),
    subject: input.subject.trim().slice(0, 140),
    body: input.body.trim().slice(0, 8000),
  };
  const problem = passDraftProblem(draft);
  if (problem) return { ok: false, error: problem };
  const toParsed = parseCcList(draft.to);
  const ccParsed = parseCcList(input.cc ?? "");
  if (ccParsed.invalid.length > 0) {
    return { ok: false, error: `CC has an invalid address: ${ccParsed.invalid[0]}` };
  }
  if (ccParsed.emails.length > 10) {
    return { ok: false, error: "That's more than 10 CC addresses." };
  }
  try {
    const { sendPassEmail } = await import("@/lib/passEmail");
    const res = await sendPassEmail(gid, {
      to: toParsed.emails,
      subject: draft.subject,
      body: draft.body,
      cc: ccParsed.emails,
      sender: { email: user.email, name: user.name || user.email },
    });
    if (!res.ok) return res;
    void logActivity(user.email, "sent_pass_email", gid, {
      to: draft.to,
      cc: ccParsed.emails.join(", "),
    });
    revalidatePath("/");
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "The send didn't go through.",
    };
  }
}
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/* ── Member analytics + view-as (Settings → Members) ─────────────────────── */

export async function getMemberStatsAction(
  email: string
): Promise<{ ok: boolean; stats?: import("@/lib/memberStats").MemberStats; error?: string }> {
  const user = await requireRole("admin");
  if (!user) return { ok: false, error: "Admins only." };
  try {
    const { loadMemberStats } = await import("@/lib/memberStats");
    const stats = await loadMemberStats(email);
    if (!stats) return { ok: false, error: "No such member." };
    return { ok: true, stats };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Couldn't load member stats." };
  }
}

/**
 * View as a member. Super admin only, checked against the REAL session (the
 * cookie is re-validated on every request in currentAppUser, so it is inert
 * for anyone else). One hour, then it expires on its own.
 */
export async function startViewAsAction(email: string): Promise<ActionResult> {
  const real = await realAppUser();
  if (!real || real.role !== "super_admin")
    return { ok: false, error: "Only the super admin can view as someone else." };
  const target = await getAppUser(email);
  if (!target) return { ok: false, error: "No such member." };
  if (target.email === real.email) return { ok: false, error: "That's already you." };
  const { cookies } = await import("next/headers");
  const jar = await cookies();
  const opts = { sameSite: "lax" as const, secure: true, path: "/", maxAge: 3600 };
  jar.set(VIEW_AS_COOKIE, target.email, { ...opts, httpOnly: true });
  jar.set(VIEW_AS_MARKER, encodeURIComponent(target.name || target.email), opts);
  void logActivity(real.email, "view_as_started", target.email, {});
  return { ok: true };
}

export async function stopViewAsAction(): Promise<ActionResult> {
  const real = await realAppUser();
  const { cookies } = await import("next/headers");
  const jar = await cookies();
  const target = jar.get(VIEW_AS_COOKIE)?.value ?? "";
  jar.delete(VIEW_AS_COOKIE);
  jar.delete(VIEW_AS_MARKER);
  if (real && target) void logActivity(real.email, "view_as_stopped", target, {});
  return { ok: true };
}

/** Ignore a Granola note: it leaves the Inbox for good, data preserved. */
export async function ignoreGranolaNoteAction(noteId: string): Promise<ActionResult> {
  const user = await currentAppUser();
  if (!user) return { ok: false, error: SIGNED_OUT };
  try {
    await sql`
      update meeting_notes
         set match_state = 'dismissed', review_state = 'skipped',
             reviewed_by = ${user.email}, reviewed_at = now()
       where id = ${noteId} and match_state in ('unmatched', 'suggested')`;
    // A note already on a deal: ignoring means "nothing to apply", not
    // "not a deal" — the match stays, the note leaves the desk.
    await sql`
      update meeting_notes
         set review_state = 'skipped', reviewed_by = ${user.email}, reviewed_at = now()
       where id = ${noteId} and match_state in ('confirmed', 'attached')
         and review_state <> 'applied'`;
    void logActivity(user.email, "granola_ignored", noteId, {});
    revalidatePath("/inbox");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Couldn't ignore the note." };
  }
}

/** One note's triage card, for the session's prefetch. */
export async function getNoteDetailAction(
  id: string
): Promise<{ ok: boolean; note?: NoteDetail | null; error?: string }> {
  if (!EVENT_ID.test(id)) return { ok: false, error: "Invalid note." };
  const user = await currentAppUser();
  if (!user) return { ok: false, error: SIGNED_OUT };
  if (user.role === "user") return { ok: false, error: "Not found." };
  const { loadNoteDetail } = await import("@/lib/noteDetail");
  return { ok: true, note: await loadNoteDetail(id) };
}

/**
 * Bulk ignore from the inbox rail (cmd-click selection): email candidates
 * and Granola notes alike, one round trip. Each row is its own statement so
 * one bad id never blocks the rest.
 */
export async function bulkIgnoreInboxAction(
  items: { kind: "email" | "granola"; id: string }[]
): Promise<ActionResult & { ignored?: number }> {
  const user = await currentAppUser();
  if (!user) return { ok: false, error: SIGNED_OUT };
  if (user.role === "user") return { ok: false, error: "Not found." };
  let ignored = 0;
  for (const item of items.slice(0, 200)) {
    if (!EVENT_ID.test(item.id)) continue;
    try {
      if (item.kind === "granola") {
        const r = await ignoreGranolaNoteAction(item.id);
        if (r.ok) ignored++;
      } else {
        const r = await triageCandidateAction(item.id, { kind: "ignore" });
        if (r.ok) ignored++;
      }
    } catch {
      // next
    }
  }
  revalidatePath("/inbox");
  return { ok: true, ignored };
}

/**
 * Pass, straight from the meeting: the deal (the one it's on, the one picked,
 * or one minted from the note) lands in To Pass with a pass decision and the
 * reason; a note with no company at all is simply filed away. One click.
 */
export async function passNoteAction(
  noteId: string,
  input: {
    reason?: string;
    company:
      | { mode: "attach"; dealGid: string }
      | { mode: "create"; name: string; round?: string; financingAmount?: string; description?: string }
      | { mode: "none" };
  }
): Promise<ActionResult & { dealGid?: string | null }> {
  if (!EVENT_ID.test(noteId)) return { ok: false, error: "Invalid note." };
  const user = await currentAppUser();
  if (!user) return { ok: false, error: SIGNED_OUT };
  try {
    const rows = await sql<
      { matched_deal_gid: string | null; match_state: string; starts_at: Date | null; summary_md: string | null; note_url: string | null }[]
    >`select matched_deal_gid, match_state, starts_at, summary_md, note_url from meeting_notes where id = ${noteId}`;
    const note = rows[0];
    if (!note) return { ok: false, error: "That note no longer exists." };
    const sections = await fetchSections().catch(() => [] as Awaited<ReturnType<typeof fetchSections>>);
    const toPass = sections.find((s) => s.stage === "to-pass")?.gid ?? "";

    let dealGid: string | null =
      note.match_state === "confirmed" || note.match_state === "attached" ? note.matched_deal_gid : null;
    let minted = false;
    if (!dealGid && input.company.mode === "attach" && GID.test(input.company.dealGid)) {
      dealGid = input.company.dealGid;
    }
    if (!dealGid && input.company.mode === "create" && input.company.name.trim()) {
      const c = input.company;
      const created = await createDeal({
        name: c.name.trim(),
        notes: [
          c.description?.trim() || "",
          `Met ${note.starts_at ? new Date(note.starts_at).toISOString().slice(0, 10) : "recently"} (Granola note).`,
          (note.summary_md ?? "").replace(/\s+/g, " ").trim().slice(0, 800),
          note.note_url ?? "",
        ]
          .filter(Boolean)
          .join("\n\n"),
        sectionGid: toPass,
        schools: [],
        financingAmount: c.financingAmount?.trim() || undefined,
        round: c.round?.trim() || undefined,
        company: c.name.trim(),
      });
      if (created.ok && created.gid) {
        dealGid = created.gid;
        minted = true;
      }
    }

    const rationale = (input.reason ?? "").trim().slice(0, 1000) || "Passed after a meeting.";
    if (dealGid) {
      if (toPass && !minted) await moveDealStage(dealGid, toPass).catch(() => null);
      await setDealDecisionAction(dealGid, "pass", rationale).catch(() => null);
      await sql`
        update meeting_notes
           set matched_deal_gid = ${dealGid},
               match_state = case when match_state in ('confirmed', 'attached') then match_state else 'confirmed' end,
               match_evidence = case when match_state in ('confirmed', 'attached') then match_evidence
                                     else ${sql.json({ via: "manual", by: user.email } as never)} end,
               review_state = 'skipped', reviewed_by = ${user.email}, reviewed_at = now()
         where id = ${noteId}`;
    } else {
      await sql`
        update meeting_notes
           set match_state = case when match_state in ('unmatched', 'suggested') then 'dismissed' else match_state end,
               review_state = 'skipped', reviewed_by = ${user.email}, reviewed_at = now()
         where id = ${noteId}`;
    }
    void logActivity(user.email, "granola_passed", dealGid ?? noteId, {
      note: noteId,
      reason: rationale.slice(0, 200),
    });
    revalidatePath("/inbox");
    revalidatePath("/");
    return { ok: true, dealGid };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Couldn't pass this one." };
  }
}

/* ── Granola review workspace ─────────────────────────────────────────────── */

const NOTE_ID = /^[0-9a-f-]{36}$/i;
const DEAL_GID = /^(\d{1,30}|local-[0-9a-f-]{36})$/;

/**
 * Everything the review screen needs on open, for free: calendar seeds (or
 * the cached extraction when Enrich already ran), CRM matches, prior
 * enrichment. No model call ever happens here — ignoring a note costs
 * nothing.
 */
export async function noteReviewBootstrapAction(noteId: string): Promise<{
  ok: boolean;
  error?: string;
  extraction?: import("@/lib/meetingReviewPure").NoteExtraction;
  matches?: import("@/lib/meetingReview").NoteMatches;
  enrich?: import("@/lib/meetingReview").NoteEnrichment;
  extracted?: boolean;
}> {
  const user = await currentAppUser();
  if (!user || user.role === "user") return { ok: false, error: SIGNED_OUT };
  if (!NOTE_ID.test(noteId)) return { ok: false, error: "Invalid note." };
  try {
    const { extractForNote, matchForNote } = await import("@/lib/meetingReview");
    const extraction = await extractForNote(noteId, { llm: false });
    if (!extraction) return { ok: false, error: "That note no longer exists." };
    const matches = await matchForNote(noteId, extraction);
    const rows = await sql<{ enrich: import("@/lib/meetingReview").NoteEnrichment | null }[]>`
      select enrich from meeting_notes where id = ${noteId}`;
    return {
      ok: true, extraction, matches,
      enrich: rows[0]?.enrich ?? {},
      extracted: extraction.llmRan === true,
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Couldn't read the note." };
  }
}

/** The model pass, on the Enrich click only: extract facts, refresh matches. */
export async function extractNoteReviewAction(noteId: string): Promise<{
  ok: boolean;
  error?: string;
  extraction?: import("@/lib/meetingReviewPure").NoteExtraction;
  matches?: import("@/lib/meetingReview").NoteMatches;
}> {
  const user = await currentAppUser();
  if (!user || user.role === "user") return { ok: false, error: SIGNED_OUT };
  if (!NOTE_ID.test(noteId)) return { ok: false, error: "Invalid note." };
  try {
    const { extractForNote, matchForNote } = await import("@/lib/meetingReview");
    const extraction = await extractForNote(noteId, { llm: true });
    if (!extraction) return { ok: false, error: "That note no longer exists." };
    const matches = await matchForNote(noteId, extraction);
    return { ok: true, extraction, matches };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Extraction failed." };
  }
}

export async function enrichNoteCompanyAction(noteId: string): Promise<{
  ok: boolean;
  error?: string;
  slot?: import("@/lib/meetingReview").EnrichSlot;
}> {
  const user = await currentAppUser();
  if (!user || user.role === "user") return { ok: false, error: SIGNED_OUT };
  if (!NOTE_ID.test(noteId)) return { ok: false, error: "Invalid note." };
  const { enrichCompanyForNote } = await import("@/lib/meetingReview");
  const slot = await enrichCompanyForNote(noteId);
  void logActivity(user.email, "note_enriched_company", noteId, {});
  return { ok: slot.status === "done", error: slot.status === "error" ? slot.note : undefined, slot };
}

export async function enrichNotePersonAction(
  noteId: string,
  key: string
): Promise<{ ok: boolean; error?: string; slot?: import("@/lib/meetingReview").EnrichSlot }> {
  const user = await currentAppUser();
  if (!user || user.role === "user") return { ok: false, error: SIGNED_OUT };
  if (!NOTE_ID.test(noteId) || key.length > 80) return { ok: false, error: "Invalid note." };
  const { enrichPersonForNote } = await import("@/lib/meetingReview");
  const slot = await enrichPersonForNote(noteId, key);
  return { ok: slot.status === "done", error: slot.status === "error" ? slot.note : undefined, slot };
}

export interface NoteReviewCommit {
  company: {
    mode: "create" | "attach" | "none";
    dealGid?: string;
    name?: string;
    round?: string;
    financingAmount?: string;
    sectionGid?: string;
    description?: string;
    applyFinancingToExisting?: boolean;
  };
  people: {
    key: string;
    mode: "create" | "update" | "attach" | "skip";
    personId?: string;
    name?: string;
    email?: string;
    school?: string;
    gradYear?: string;
    linkedinUrl?: string;
    city?: string;
    title?: string;
    org?: string;
    founderOnDeal?: boolean;
    /** Field names the user actually typed — these overwrite; others fill empty. */
    edited?: string[];
  }[];
}

export interface CommitStep {
  label: string;
  ok: boolean;
  href?: string;
  error?: string;
}

/**
 * One coordinated save for the review screen: deal, people, relationships,
 * meeting record, review state. Each step reports individually; retries are
 * idempotent (deal converges by name, people by email, links by unique key),
 * and the note is only marked reviewed when its own step succeeds.
 */
export async function commitNoteReviewAction(
  noteId: string,
  payload: NoteReviewCommit
): Promise<{ ok: boolean; error?: string; results: CommitStep[]; dealGid?: string | null }> {
  const user = await requireRole("admin");
  if (!user) return { ok: false, error: "Only admins can save CRM updates.", results: [] };
  if (!NOTE_ID.test(noteId)) return { ok: false, error: "Invalid note.", results: [] };
  if (!Array.isArray(payload.people) || payload.people.length > 12)
    return { ok: false, error: "Too many people in one save.", results: [] };

  const results: CommitStep[] = [];
  const clamp = (v: string | undefined, n: number) => (v ?? "").trim().slice(0, n);

  const notes = await sql<
    {
      title: string | null;
      starts_at: Date | null;
      participants: { name?: string | null; email?: string | null }[];
      summary_md: string | null;
      notes_md: string | null;
      note_url: string | null;
      matched_deal_gid: string | null;
    }[]
  >`
    select title, starts_at, participants, summary_md, notes_md, note_url, matched_deal_gid
      from meeting_notes where id = ${noteId}`;
  const note = notes[0];
  if (!note) return { ok: false, error: "That note no longer exists.", results: [] };

  const when = note.starts_at
    ? etFullDate(note.starts_at)
    : "date unknown";
  const gist = (note.summary_md ?? note.notes_md ?? "").replace(/\s+/g, " ").trim();

  /* 1 — the deal */
  let dealGid: string | null = null;
  let dealName: string | null = null;
  if (payload.company.mode === "create") {
    const name = clamp(payload.company.name, 300);
    if (!name) {
      results.push({ label: "Create deal", ok: false, error: "The deal needs a name." });
    } else {
      const composed = [
        `Met ${when} (Granola note).`,
        clamp(payload.company.description, 400),
        gist.slice(0, 800),
        note.note_url ?? "",
      ]
        .filter(Boolean)
        .join("\n\n");
      const res = await createDeal({
        name,
        notes: composed,
        sectionGid: clamp(payload.company.sectionGid, 30),
        schools: [],
        financingAmount: clamp(payload.company.financingAmount, 120) || undefined,
        round: clamp(payload.company.round, 60) || undefined,
        founders: [],
      });
      if (res.ok && res.gid) {
        dealGid = res.gid;
        dealName = name;
        results.push({ label: `Created ${name}`, ok: true, href: `/deals/${res.gid}` });
      } else {
        results.push({ label: `Create ${name}`, ok: false, error: res.error ?? "Couldn't create it." });
      }
    }
  } else if (payload.company.mode === "attach") {
    const gid = clamp(payload.company.dealGid, 60);
    if (!DEAL_GID.test(gid)) {
      results.push({ label: "Attach to deal", ok: false, error: "Pick a deal first." });
    } else if (!(await canTouchDeal(user, gid))) {
      results.push({ label: "Attach to deal", ok: false, error: "You don't have access to that deal." });
    } else {
      const deal = await sql<{ gid: string; name: string; financing_amount: string | null; round: string | null }[]>`
        select gid, name, financing_amount, round from deals where gid = ${gid}`;
      if (!deal[0]) {
        results.push({ label: "Attach to deal", ok: false, error: "That deal no longer exists." });
      } else {
        dealGid = deal[0].gid;
        dealName = deal[0].name;
        results.push({ label: `Attached to ${deal[0].name}`, ok: true, href: `/deals/${gid}` });
        if (payload.company.applyFinancingToExisting) {
          const amount = clamp(payload.company.financingAmount, 120) || null;
          const round = clamp(payload.company.round, 60) || null;
          try {
            const { recordFieldSource } = await import("@/lib/provenance");
            if (amount && amount !== deal[0].financing_amount) {
              await sql`update deals set financing_amount = ${amount}, modified_on = current_date where gid = ${gid}`;
              recordFieldSource(gid, "financing", amount, "granola", noteId, user.email);
            }
            if (round && round !== deal[0].round) {
              await sql`update deals set round = ${round}, modified_on = current_date where gid = ${gid}`;
              recordFieldSource(gid, "round", round, "granola", noteId, user.email);
            }
            if (amount || round) results.push({ label: "Updated financing on the deal", ok: true });
          } catch {
            results.push({ label: "Update financing on the deal", ok: false, error: "Field update failed." });
          }
        }
      }
    }
  }

  // A matched note already knows its deal — founder links and notes-block
  // founders land there even when no company card was in play.
  if (!dealGid && note.matched_deal_gid && (await canTouchDeal(user, note.matched_deal_gid).catch(() => false))) {
    dealGid = note.matched_deal_gid;
  }

  /* 2 — people (sequential: dupes recheck + fill-empty writes) */
  const savedPeople: { id: string; name: string; founderOnDeal: boolean }[] = [];
  for (const p of payload.people) {
    if (p.mode === "skip") continue;
    const name = clamp(p.name, 120);
    const email = clamp(p.email, 200).toLowerCase() || null;
    let personId = p.personId && PERSON_ID.test(p.personId) ? p.personId : null;
    let label = name || "person";
    try {
      if (p.mode === "create") {
        if (!name) {
          results.push({ label: "Add person", ok: false, error: "A person needs a name." });
          continue;
        }
        // Idempotent retry: if the email already belongs to someone, update them.
        if (email) {
          const hit = await sql<{ id: string; name: string }[]>`
            select id, name from network_people
             where lower(email) = ${email} or ${email} = any(coalesce(alt_emails, '{}'))
             limit 1`;
          if (hit[0]) personId = hit[0].id;
        }
        if (!personId) {
          // The form is the source of truth — no background name-guess
          // enrichment that can write a stranger's title onto the record.
          const res = await insertNetworkPersonRecord(
            user.email,
            {
              name,
              school: clamp(p.school, 120) || "Unknown",
              company: clamp(p.org, 120),
              linkedinUrl: clamp(p.linkedinUrl, 300),
              gradYear: clamp(p.gradYear, 8) ? Number(clamp(p.gradYear, 8)) : null,
              degree: "",
            },
            { enrich: false }
          );
          if (!res.ok || !res.id) {
            results.push({ label: `Add ${name}`, ok: false, error: res.error ?? "Couldn't add them." });
            continue;
          }
          personId = res.id;
        }
        label = name;
      }
      if (!personId) {
        results.push({ label: `Save ${label}`, ok: false, error: "No matching person." });
        continue;
      }
      // The user's typed fields overwrite; everything else fills empty only.
      const edited = new Set((p.edited ?? []).filter((f) => typeof f === "string"));
      const val = (field: string, v: string | null) =>
        edited.has(field) ? v : null; // hard-set value (null = not edited)
      const cityV = clamp(p.city, 120) || null;
      const titleV = clamp(p.title, 120) || null;
      const orgV = clamp(p.org, 120) || null;
      const liV = clamp(p.linkedinUrl, 300) || null;
      const schoolV = clamp(p.school, 120) || null;
      const yearV = clamp(p.gradYear, 8) ? Number(clamp(p.gradYear, 8)) : null;
      await sql`
        update network_people
           set name = case when ${edited.has("name")} and ${name || null}::text is not null
                           then ${name || null} else name end,
               email = case when ${edited.has("email")} and ${email}::text is not null
                            then ${email} else coalesce(nullif(email, ''), ${email}) end,
               location = case when ${edited.has("city")} then coalesce(${val("city", cityV)}, location)
                               else coalesce(nullif(location, ''), ${cityV}) end,
               current_title = case when ${edited.has("title")} then coalesce(${val("title", titleV)}, current_title)
                                    else coalesce(nullif(current_title, ''), ${titleV}) end,
               current_organization = case when ${edited.has("org")} then coalesce(${val("org", orgV)}, current_organization)
                                           else coalesce(nullif(current_organization, ''), ${orgV}) end,
               linkedin_url = case when ${edited.has("linkedinUrl")} then coalesce(${val("linkedinUrl", liV)}, linkedin_url)
                                   else coalesce(nullif(linkedin_url, ''), ${liV}) end,
               school = case when ${edited.has("school")} and ${schoolV}::text is not null then ${schoolV}
                             when school is null or school = '' or school = 'Unknown'
                             then coalesce(${schoolV}, school) else school end,
               grad_year = case when ${edited.has("gradYear")} and ${yearV}::int is not null then ${yearV}
                                else coalesce(grad_year, ${yearV}) end,
               updated_at = now()
         where id = ${personId}`;
      const existing = await sql<{ name: string }[]>`
        select name from network_people where id = ${personId}`;
      label = existing[0]?.name ?? label;
      savedPeople.push({
        id: personId,
        name: label,
        founderOnDeal: !!p.founderOnDeal,
      });
      results.push({
        label:
          p.mode === "create"
            ? `Added ${label}`
            : p.mode === "update"
              ? `Updated ${label}`
              : `Saved meeting to ${label}`,
        ok: true,
      });
    } catch (err) {
      results.push({
        label: `Save ${label}`,
        ok: false,
        error: err instanceof Error ? err.message : "Person save failed.",
      });
    }
  }

  /* 3 — founders onto the deal */
  for (const sp of savedPeople) {
    try {
      if (dealGid && sp.founderOnDeal) {
        await sql`
          insert into deal_founders (deal_gid, person_id, founder_role, created_by)
          values (${dealGid}, ${sp.id}, 'founder', ${user.email})
          on conflict (deal_gid, person_id) do nothing`;
      }
    } catch {
      results.push({ label: `Link ${sp.name}`, ok: false, error: "Relationship save failed." });
    }
  }
  // Approved founders also join the deal's notes founders block — that block
  // is what the deal form renders, so the details must port there.
  if (dealGid && savedPeople.some((sp) => sp.founderOnDeal)) {
    try {
      const { extractFounders, composeNotes } = await import("@/lib/founders");
      const dealRows = await sql<{ notes: string | null }[]>`
        select notes from deals where gid = ${dealGid}`;
      if (dealRows[0]) {
        const split = extractFounders(dealRows[0].notes ?? "");
        const have = new Set(split.founders.map((f) => f.name.trim().toLowerCase()));
        let added = 0;
        for (const sp of savedPeople) {
          if (!sp.founderOnDeal || have.has(sp.name.trim().toLowerCase())) continue;
          const det = await sql<
            { school: string | null; linkedin_url: string | null; email: string | null }[]
          >`select school, linkedin_url, email from network_people where id = ${sp.id}`;
          split.founders.push({
            name: sp.name,
            school: det[0]?.school && det[0].school !== "Unknown" ? det[0].school : "",
            linkedin: det[0]?.linkedin_url ?? "",
            email: det[0]?.email ?? "",
          });
          have.add(sp.name.trim().toLowerCase());
          added++;
        }
        if (added > 0) {
          await sql`
            update deals set notes = ${composeNotes(split.rest, split.founders)},
                   modified_on = current_date
             where gid = ${dealGid}`;
          const { recordFieldSource } = await import("@/lib/provenance");
          recordFieldSource(dealGid, "notes", null, "granola", noteId, user.email);
          results.push({ label: "Founders added to the deal record", ok: true, href: `/deals/${dealGid}` });
        }
      }
    } catch {
      results.push({ label: "Add founders to the deal record", ok: false, error: "Notes update failed." });
    }
  }

  /* 4 — the meeting record itself */
  let reviewedOk = true;
  try {
    await sql`
      update meeting_notes
         set matched_deal_gid = coalesce(${dealGid}, matched_deal_gid),
             match_state = case when ${dealGid}::text is not null then 'attached' else match_state end,
             match_evidence = case when ${dealGid}::text is not null
               then ${sql.json({ via: "review", by: user.email } as never)} else match_evidence end,
             review_state = 'skipped',
             reviewed_by = ${user.email},
             reviewed_at = now()
       where id = ${noteId}`;
    results.push({ label: "Meeting saved", ok: true });
  } catch (err) {
    reviewedOk = false;
    results.push({
      label: "Mark meeting reviewed",
      ok: false,
      error: err instanceof Error ? err.message : "Couldn't mark it reviewed.",
    });
  }

  void logActivity(user.email, "granola_review_saved", noteId, {
    deal: dealGid ?? "",
    people: savedPeople.length,
  });
  revalidatePath("/");
  revalidatePath("/inbox");
  revalidatePath("/people");
  const ok = reviewedOk && results.every((r) => r.ok);
  return { ok, results, dealGid, ...(ok ? {} : { error: "Some steps need attention." }) };
}

/**
 * Deal suggestions for an unmatched Granola note. Deterministic name-token
 * matching does the work; ONE small Haiku call runs only when tokens find
 * nothing (minimal AI, clamped to the provided candidates).
 */
export async function suggestDealsForNoteAction(noteId: string): Promise<{
  ok: boolean;
  suggestions?: { gid: string; name: string; why: string }[];
  error?: string;
}> {
  const user = await currentAppUser();
  if (!user) return { ok: false, error: SIGNED_OUT };
  try {
    const notes = await sql<
      { title: string | null; participants: { name?: string | null; email?: string | null }[] | null; summary_md: string | null }[]
    >`
      select title, participants, summary_md from meeting_notes where id = ${noteId}`;
    const note = notes[0];
    if (!note) return { ok: false, error: "No such note." };
    const deals = await sql<{ gid: string; name: string; stage: string }[]>`
      select gid, name, stage from deals
       where stage not in ('passed')
       order by modified_on desc nulls last limit 250`;

    // Tokens: external participant names + meaningful title words.
    const STOP = new Set(["and", "meeting", "min", "call", "sync", "catch", "chat", "with", "zoom", "intro", "the"]);
    const tokens = new Set<string>();
    for (const p of note.participants ?? []) {
      for (const w of (p.name ?? "").toLowerCase().split(/[^a-z]+/)) {
        if (w.length > 2 && !STOP.has(w)) tokens.add(w);
      }
    }
    for (const w of (note.title ?? "").toLowerCase().split(/[^a-z]+/)) {
      if (w.length > 3 && !STOP.has(w)) tokens.add(w);
    }
    const scored = deals
      .map((d) => {
        const hay = d.name.toLowerCase();
        const hits = [...tokens].filter((t) => hay.includes(t));
        return { d, score: hits.length, hits };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);
    if (scored.length > 0) {
      return {
        ok: true,
        suggestions: scored.map((x) => ({
          gid: x.d.gid,
          name: x.d.name,
          why: `matches "${x.hits.join('", "')}"`,
        })),
      };
    }

    // Nothing deterministic — one cheap, clamped Haiku pass.
    const { callClaude, modelJson, fenceUntrusted, UNTRUSTED_NOTICE, rejectAndLog } = await import("@/lib/llm");
    const list = deals.slice(0, 200).map((d, i) => `${i}. ${d.name}`).join("\n");
    const text = await callClaude({
      job: "note_deal_suggest",
      model: "claude-haiku-4-5-20251001",
      maxTokens: 150,
      system: `A venture CRM meeting note needs a home. Given the note context and a numbered list of existing deals, reply ONLY JSON {"matches":[{"i":<number>,"why":"<short reason>"}]} with at most 2 entries, or {"matches":[]} when nothing plausibly refers to the same company or founder. Never invent numbers.\n\n${UNTRUSTED_NOTICE}`,
      content: `NOTE TITLE: ${fenceUntrusted(note.title ?? "", 200)}\nPARTICIPANTS: ${fenceUntrusted((note.participants ?? []).map((p) => p.name ?? p.email ?? "").join(", "), 200)}\nSUMMARY EXCERPT:\n${fenceUntrusted((note.summary_md ?? "").slice(0, 500), 600)}\n\nDEALS:\n${list}`,
      timeoutMs: 15_000,
    });
    if (text === null) return { ok: true, suggestions: [] };
    const parsed = modelJson(text) as { matches?: { i?: unknown; why?: unknown }[] } | null;
    if (!parsed || !Array.isArray(parsed.matches)) {
      rejectAndLog("note_deal_suggest", text);
      return { ok: true, suggestions: [] };
    }
    const suggestions = parsed.matches
      .filter((m) => Number.isInteger(m.i) && (m.i as number) >= 0 && (m.i as number) < Math.min(200, deals.length))
      .slice(0, 2)
      .map((m) => ({
        gid: deals[m.i as number].gid,
        name: deals[m.i as number].name,
        why: typeof m.why === "string" ? m.why.slice(0, 120) : "possible match",
      }));
    return { ok: true, suggestions };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Couldn't suggest deals." };
  }
}

/* ── Scheduling (composer "Schedule" panel) ──────────────────────────────── */

export async function scheduleRosterAction(): Promise<{
  ok: boolean;
  roster?: import("@/lib/schedule").ScheduleRosterEntry[];
  error?: string;
}> {
  const user = await currentAppUser();
  if (!user) return { ok: false, error: SIGNED_OUT };
  try {
    const { scheduleRoster } = await import("@/lib/schedule");
    return { ok: true, roster: await scheduleRoster() };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Couldn't load calendars." };
  }
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const YMD = /^\d{4}-\d{2}-\d{2}$/;

/** Conflict-free time suggestions. Every input is clamped server-side and
 * participants are validated against the roster — client ids are untrusted. */
export async function scheduleSuggestAction(
  input: {
    durationMinutes: number;
    dateStart: string;
    dateEnd: string;
    allowedWeekdays: number[];
    dailyStartTime: string;
    dailyEndTime: string;
    suggestionCount: number;
    minimumNoticeMinutes: number;
    calendarParticipantIds: string[];
  },
  exclude: string[] = []
): Promise<import("@/lib/schedule").SuggestResult> {
  const user = await currentAppUser();
  if (!user) return { ok: false, error: SIGNED_OUT };
  try {
    if (!YMD.test(input.dateStart) || !YMD.test(input.dateEnd) || input.dateEnd < input.dateStart)
      return { ok: false, error: "Pick a valid date range." };
    const spanMs = new Date(input.dateEnd).getTime() - new Date(input.dateStart).getTime();
    if (spanMs > 62 * 86_400_000) return { ok: false, error: "Keep the range under two months." };
    if (!HHMM.test(input.dailyStartTime) || !HHMM.test(input.dailyEndTime) || input.dailyEndTime <= input.dailyStartTime)
      return { ok: false, error: "Pick a valid daily window." };
    const weekdays = [...new Set(input.allowedWeekdays)].filter((d) => Number.isInteger(d) && d >= 1 && d <= 7);
    if (weekdays.length === 0) return { ok: false, error: "Allow at least one weekday." };

    const { scheduleRoster, scheduleSuggestions } = await import("@/lib/schedule");
    const roster = await scheduleRoster();
    const allowed = new Set(roster.filter((r) => r.hasCalendar).map((r) => r.email.toLowerCase()));
    const participants = [...new Set(input.calendarParticipantIds.map((e) => e.toLowerCase()))]
      .filter((e) => allowed.has(e))
      .slice(0, 6);
    if (participants.length === 0) return { ok: false, error: "Select at least one calendar." };

    return await scheduleSuggestions(
      {
        durationMinutes: Math.min(240, Math.max(10, Math.round(input.durationMinutes) || 30)),
        dateStart: input.dateStart,
        dateEnd: input.dateEnd,
        allowedWeekdays: weekdays,
        dailyStartTime: input.dailyStartTime,
        dailyEndTime: input.dailyEndTime,
        timezone: crm.org.timezone,
        suggestionCount: Math.min(8, Math.max(1, Math.round(input.suggestionCount) || 3)),
        minimumNoticeMinutes: Math.min(7 * 24 * 60, Math.max(0, Math.round(input.minimumNoticeMinutes) || 120)),
        bufferBeforeMinutes: 0,
        bufferAfterMinutes: 0,
        calendarParticipantIds: participants,
      },
      exclude.filter((x) => typeof x === "string").slice(0, 32)
    );
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Couldn't check availability." };
  }
}

/* ── Scratchpad (owner-only; see src/lib/scratchpad.ts for the entitlement) ── */

const NOT_FOUND = { ok: false as const, error: "Not found." };

/** Type-to-search over people, for attaching a meeting to someone we already have. */
export async function searchPeopleAction(
  q: string
): Promise<{ ok: boolean; people?: { id: string; name: string; line: string }[]; error?: string }> {
  const user = await currentAppUser();
  if (!user) return { ok: false, error: SIGNED_OUT };
  const needle = q.trim().slice(0, 80);
  if (needle.length < 2) return { ok: true, people: [] };
  try {
    const rows = await sql<
      { id: string; name: string; school: string | null; company: string | null }[]
    >`
      select p.id, p.name, p.school, p.current_organization as company
        from network_people p
       where p.name ilike ${"%" + needle + "%"}
          or p.school ilike ${"%" + needle + "%"}
          or p.current_organization ilike ${"%" + needle + "%"}
          or p.email ilike ${"%" + needle + "%"}
       order by p.name limit 8`;
    return {
      ok: true,
      people: rows.map((r) => ({
        id: r.id,
        name: r.name,
        line: [r.company, r.school].filter(Boolean).join(" · "),
      })),
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Search failed." };
  }
}
