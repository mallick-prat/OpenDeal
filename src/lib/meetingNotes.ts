import "server-only";
import { sql } from "./db";
import { loadDealEvidencePools } from "./identityEvidence";
import { logEvent } from "./log";
import { withRetry } from "./retry";
import {
  getNote,
  granolaConfigured,
  listNotes,
  type GranolaNoteDetail,
} from "./granola";
import {
  matchNoteToDeals,
  type MatchDeal,
  type MatchSuggestion,
} from "./meetingNotesPure";
import { isInternalEmail } from "@/config/crm.config";

/**
 * ── Meeting notes (Granola) ──────────────────────────────────────────────────
 * Sync pages the Granola API into meeting_notes, idempotently upserting on
 * provider_note_key, then proposes deal matches for unmatched notes. Matching
 * only ever reaches 'suggested' — a human confirms from the UI (later PR)
 * before a note attaches to a deal — and a re-sync refreshes content without
 * ever touching the match columns.
 */

let schemaReady = false;
export async function ensureMeetingNotesSchema(): Promise<void> {
  if (schemaReady) return;
  await sql`
    create table if not exists meeting_notes (
      id                 uuid primary key default gen_random_uuid(),
      provider           text not null default 'granola',
      provider_note_key  text not null unique,
      calendar_event_key text,
      owner_email        text,
      title              text,
      starts_at          timestamptz,
      ends_at            timestamptz,
      participants       jsonb not null default '[]',
      summary_md         text,
      notes_md           text,
      transcript_state   text not null default 'none',
      matched_deal_gid   text,
      match_confidence   numeric,
      match_evidence     jsonb,
      match_state        text not null default 'unmatched',
      visibility         text not null default 'private',
      imported_at        timestamptz not null default now(),
      refreshed_at       timestamptz
    )
  `;
  await sql`alter table meeting_notes add column if not exists note_url text`;
  await sql`
    create index if not exists meeting_notes_match_state_idx
      on meeting_notes (match_state)
  `;
  await sql`
    create index if not exists meeting_notes_deal_idx
      on meeting_notes (matched_deal_gid) where matched_deal_gid is not null
  `;
  schemaReady = true;
}

export interface MeetingNoteParticipant {
  name: string | null;
  email: string;
}

export interface GranolaSyncResult {
  ok: boolean;
  configured: boolean;
  imported: number;
  updated: number;
  suggested: number;
  errors: number;
}

/** Attendees + calendar invitees, deduped by email. */
function noteParticipants(note: GranolaNoteDetail): MeetingNoteParticipant[] {
  const byEmail = new Map<string, MeetingNoteParticipant>();
  for (const a of note.attendees) {
    const email = a.email.trim().toLowerCase();
    if (email) byEmail.set(email, { name: a.name, email });
  }
  for (const i of note.calendar_event?.invitees ?? []) {
    const email = i.email.trim().toLowerCase();
    if (email && !byEmail.has(email)) byEmail.set(email, { name: null, email });
  }
  return [...byEmail.values()];
}

function toTimestamp(iso: string | null): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Upsert one note; returns whether the row was newly inserted. */
/** Internal chatter never reaches the queue — decisions only. */
function allInternal(participants: { email?: string | null }[]): boolean {
  const emails = participants
    .map((p) => (p.email ?? "").toLowerCase())
    .filter(Boolean);
  // Solo notes (just the host) stay reviewable — only real team meetings skip.
  return participants.length >= 2 && emails.length > 0 && emails.every((e) => isInternalEmail(e));
}

async function upsertNote(note: GranolaNoteDetail): Promise<{ inserted: boolean }> {
  const participants = noteParticipants(note);
  const skipReview = allInternal(participants);
  const startsAt =
    toTimestamp(note.calendar_event?.scheduled_start_time ?? null) ??
    toTimestamp(note.created_at || null);
  const endsAt = toTimestamp(note.calendar_event?.scheduled_end_time ?? null);
  const transcriptState =
    note.transcript && note.transcript.length > 0 ? "available" : "none";
  const rows = await withRetry(
    () => sql<{ inserted: boolean }[]>`
      insert into meeting_notes
        (provider, provider_note_key, calendar_event_key, owner_email, title,
         starts_at, ends_at, participants, summary_md, notes_md,
         transcript_state, note_url, review_state, refreshed_at)
      values
        ('granola', ${note.id},
         ${note.calendar_event?.calendar_event_id ?? null},
         ${note.owner?.email?.toLowerCase() ?? null},
         ${note.title},
         ${startsAt}, ${endsAt},
         ${sql.json(participants as never)},
         ${note.summary_markdown},
         ${note.summary_text},
         ${transcriptState}, ${note.web_url},
         ${skipReview ? "skipped" : "none"}, now())
      on conflict (provider_note_key) do update set
        note_url = coalesce(excluded.note_url, meeting_notes.note_url),
        calendar_event_key = excluded.calendar_event_key,
        owner_email = excluded.owner_email,
        title = excluded.title,
        starts_at = excluded.starts_at,
        ends_at = excluded.ends_at,
        participants = excluded.participants,
        summary_md = excluded.summary_md,
        notes_md = excluded.notes_md,
        -- An already-imported transcript never regresses to 'available'.
        transcript_state = case
          when meeting_notes.transcript_state = 'imported'
            then meeting_notes.transcript_state
          else excluded.transcript_state
        end,
        refreshed_at = now()
      returning (xmax = 0) as inserted
    `
  );
  return { inserted: rows[0]?.inserted === true };
}

/**
 * Open-pipeline deals with founder identity, from the ONE evidence service
 * (identityEvidence.ts). This matcher must never grow a private copy again —
 * private copies are how the alt_emails bug and the internal-sender
 * poisoning each hit every matcher at once.
 */
async function listOpenDealsForMatching(): Promise<MatchDeal[]> {
  // Closed deals ride along flagged inactive: strong evidence still lands a
  // note on a passed deal (its meeting is its context), weak never suggests.
  return loadDealEvidencePools({ includeClosed: true });
}

/** Propose matches for every unmatched note; returns how many got one. */
interface MatchableNoteRow {
  id: string;
  title: string | null;
  participants: MeetingNoteParticipant[];
  match_state: string;
  matched_deal_gid: string | null;
  calendar_event_key: string | null;
  body: string | null;
}

const MATCHABLE_NOTES = sql`
  select id, title, participants, match_state, matched_deal_gid,
         calendar_event_key,
         left(coalesce(summary_md, '') || ' ' || coalesce(notes_md, ''), 16000) as body
  from meeting_notes
`;

/** Deals already matched to these notes' calendar events — tier-0 evidence. */
async function calendarDealsByEventKey(
  notes: MatchableNoteRow[]
): Promise<Map<string, string>> {
  const keys = [...new Set(notes.map((n) => n.calendar_event_key).filter((k): k is string => !!k))];
  if (keys.length === 0) return new Map();
  const rows = await withRetry(
    () => sql<{ provider_event_key: string; matched_deal_gid: string }[]>`
      select provider_event_key, matched_deal_gid
      from calendar_events
      where provider_event_key = any(${sql.array(keys)})
        and matched_deal_gid is not null
    `
  ).catch(() => [] as { provider_event_key: string; matched_deal_gid: string }[]);
  return new Map(rows.map((r) => [r.provider_event_key, r.matched_deal_gid]));
}

/**
 * Run one note through the matcher and persist the outcome. Confirmed
 * matches attach programmatically and get their update proposals right
 * away; suggestions wait for a human. A concurrent human decision always
 * wins (state-guarded UPDATE). Returns what happened.
 */
async function applyMatch(
  note: MatchableNoteRow,
  deals: MatchDeal[],
  calendarByKey: Map<string, string>
): Promise<"confirmed" | "suggested" | "none"> {
  let match: MatchSuggestion | null = null;
  try {
    const people = Array.isArray(note.participants) ? note.participants : [];
    const emails = people
      .map((p) => p?.email)
      .filter((e): e is string => typeof e === "string");
    // Names count only for OUTSIDE attendees: a team member's name on the
    // invite is never evidence of a deal (every meeting has one).
    const names = people
      .filter((p) => !p?.email || !isInternalEmail(p.email))
      .map((p) => p?.name)
      .filter((n): n is string => typeof n === "string");
    match = matchNoteToDeals(
      {
        participantEmails: emails,
        participantNames: names,
        title: note.title,
        body: note.body,
        calendarDealGid: note.calendar_event_key
          ? (calendarByKey.get(note.calendar_event_key) ?? null)
          : null,
      },
      deals
    );
  } catch {
    return "none"; // one malformed row never stops the pass
  }
  if (!match) return "none";
  const m = match;

  // A suggestion never overwrites another suggestion, and an upgrade to
  // confirmed only happens for the SAME deal a human hasn't rejected —
  // a confirmed match for a DIFFERENT deal than the pending suggestion
  // stays a human call.
  if (note.match_state === "suggested") {
    if (m.matchState !== "confirmed") return "none";
    if (note.matched_deal_gid && note.matched_deal_gid !== m.gid) return "none";
  }

  try {
    const updated = await withRetry(
      () => sql`
        update meeting_notes set
          match_state = ${m.matchState},
          matched_deal_gid = ${m.gid},
          match_confidence = ${m.confidence},
          match_evidence = ${sql.json(m.evidence as never)}
        where id = ${note.id} and match_state in ('unmatched', 'suggested')
      `
    );
    if (updated.count === 0) return "none";
  } catch {
    return "none";
  }
  if (m.matchState === "confirmed") {
    // Proposals ride the attach — the deal card shows the note NOW.
    try {
      const { proposeNoteUpdates } = await import("./meetingNoteUpdates");
      await proposeNoteUpdates(note.id);
    } catch {
      // The 15-minute cron proposes on the next pass.
    }
    logEvent("info", "granola", "note auto-attached", {
      note: note.id,
      deal: m.gid,
      kind: m.evidence.kind,
    });
  }
  return m.matchState;
}

/** Propose matches for every unmatched note (and upgrade suggestions when
 * strong evidence arrives); returns how many got one. */
async function suggestMatches(): Promise<number> {
  const notes = await withRetry(
    () => sql<MatchableNoteRow[]>`
      ${MATCHABLE_NOTES}
      where match_state in ('unmatched', 'suggested')
      order by imported_at desc
      limit 500
    `
  );
  if (notes.length === 0) return 0;
  const deals = await listOpenDealsForMatching();
  if (deals.length === 0) return 0;
  const calendarByKey = await calendarDealsByEventKey(notes);

  let landed = 0;
  for (const note of notes) {
    if ((await applyMatch(note, deals, calendarByKey)) !== "none") landed++;
  }
  return landed;
}

/**
 * Targeted rematch the moment a deal is born (any door): every unmatched or
 * suggested note from the last 90 days gets one pass against JUST this
 * deal's evidence, so a note that predates its deal lands the instant the
 * deal exists instead of waiting to be noticed.
 */
export async function rematchNotesForDeal(gid: string): Promise<number> {
  await ensureMeetingNotesSchema();
  const deals = (await listOpenDealsForMatching()).filter((d) => d.gid === gid);
  if (deals.length === 0) return 0;
  const notes = await withRetry(
    () => sql<MatchableNoteRow[]>`
      ${MATCHABLE_NOTES}
      where match_state in ('unmatched', 'suggested')
        and coalesce(starts_at, imported_at) > now() - interval '90 days'
      order by imported_at desc
      limit 300
    `
  ).catch(() => [] as MatchableNoteRow[]);
  if (notes.length === 0) return 0;
  const calendarByKey = await calendarDealsByEventKey(notes);
  let landed = 0;
  for (const note of notes) {
    if ((await applyMatch(note, deals, calendarByKey)) === "confirmed") landed++;
  }
  return landed;
}

/**
 * The deal's Granola knowledge as one bounded text block — meeting titles
 * and summaries for every attached note. Feeds enrichment so the agent
 * reasons from what was actually said in the room.
 */
export async function granolaContextForDeal(gid: string, maxChars = 3000): Promise<string> {
  await ensureMeetingNotesSchema();
  const rows = await withRetry(
    () => sql<{ title: string | null; summary_md: string | null; notes_md: string | null }[]>`
      select title, summary_md, notes_md
      from meeting_notes
      where matched_deal_gid = ${gid}
        and match_state in ('confirmed', 'attached')
      order by coalesce(starts_at, imported_at) desc
      limit 5
    `
  ).catch(() => []);
  const parts = rows
    .map((r) => {
      const body = (r.summary_md ?? r.notes_md ?? "").trim();
      if (!body) return null;
      return `${r.title ?? "Meeting"}:\n${body}`;
    })
    .filter((p): p is string => p !== null);
  return parts.join("\n\n").slice(0, maxChars);
}

const PAGE_DELAY_MS = 300; // ≤ ~3 req/s against Granola's 5 req/s sustained cap
const MAX_PAGES = 40;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Pull the Granola window into meeting_notes, then propose deal matches.
 * Idempotent; a single bad note is counted and skipped, never fatal.
 */
export async function syncGranolaNotes(
  opts: { lookbackDays?: number } = {}
): Promise<GranolaSyncResult> {
  if (!granolaConfigured()) {
    return { ok: true, configured: false, imported: 0, updated: 0, suggested: 0, errors: 0 };
  }
  await ensureMeetingNotesSchema();

  const lookbackDays = opts.lookbackDays ?? 30;
  const since = new Date(Date.now() - lookbackDays * 86_400_000).toISOString();
  const lastRows = await withRetry(
    () => sql<{ t: Date | null }[]>`select max(refreshed_at) as t from meeting_notes`
  ).catch(() => [] as { t: Date | null }[]);
  const lastRefresh = lastRows[0]?.t ?? null;
  const updatedAfter = lastRefresh
    ? new Date(lastRefresh.getTime() - 120_000).toISOString()
    : null;

  let imported = 0;
  let updated = 0;
  let errors = 0;
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const list = updatedAfter
      ? await listNotes({ updatedAfter, cursor })
      : await listNotes({ since, cursor });
    const keys = list.notes.map((n) => n.id);
    const known = keys.length
      ? await withRetry(
          () => sql<{ provider_note_key: string; refreshed_at: Date | null }[]>`
            select provider_note_key, refreshed_at
              from meeting_notes
             where provider_note_key = any(${keys})
          `
        ).catch(() => [] as { provider_note_key: string; refreshed_at: Date | null }[])
      : [];
    const knownAt = new Map(
      known.map((k) => [k.provider_note_key, k.refreshed_at?.getTime() ?? 0])
    );
    for (const summary of list.notes) {
      try {
        const prevAt = knownAt.get(summary.id);
        const updatedMs = summary.updated_at ? Date.parse(summary.updated_at) : NaN;
        if (prevAt != null && Number.isFinite(updatedMs) && updatedMs <= prevAt) {
          continue;
        }
        await sleep(PAGE_DELAY_MS);
        const detail = await getNote(summary.id, { includeTranscript: prevAt == null });
        const { inserted } = await upsertNote(detail);
        if (inserted) imported++;
        else updated++;
      } catch {
        errors++; // one bad note never stops the sync
      }
    }
    if (!list.hasMore || !list.cursor) break;
    cursor = list.cursor;
    await sleep(PAGE_DELAY_MS);
  }

  let suggested = 0;
  if (imported > 0 || updated > 0) {
    try {
      suggested = await suggestMatches();
    } catch {
      // matching is additive — the import still stands
    }
  }

  return { ok: true, configured: true, imported, updated, suggested, errors };
}

export interface MeetingNotesOverview {
  configured: boolean;
  lastSyncedAt: string | null;
  counts: { total: number; suggested: number; unmatched: number; attached: number };
}

/** Settings/status readout. Never throws — a fresh DB reads as zeros. */
export async function meetingNotesOverview(): Promise<MeetingNotesOverview> {
  const configured = granolaConfigured();
  try {
    await ensureMeetingNotesSchema();
    const rows = await withRetry(
      () => sql<
        {
          total: number;
          suggested: number;
          unmatched: number;
          attached: number;
          last: Date | null;
        }[]
      >`
        select count(*)::int as total,
               (count(*) filter (where match_state = 'suggested'))::int as suggested,
               (count(*) filter (where match_state = 'unmatched'))::int as unmatched,
               (count(*) filter (where match_state in ('confirmed', 'attached')))::int as attached,
               max(coalesce(refreshed_at, imported_at)) as last
        from meeting_notes
      `
    );
    const r = rows[0];
    return {
      configured,
      lastSyncedAt: r?.last ? r.last.toISOString() : null,
      counts: {
        total: r?.total ?? 0,
        suggested: r?.suggested ?? 0,
        unmatched: r?.unmatched ?? 0,
        attached: r?.attached ?? 0,
      },
    };
  } catch {
    return {
      configured,
      lastSyncedAt: null,
      counts: { total: 0, suggested: 0, unmatched: 0, attached: 0 },
    };
  }
}
