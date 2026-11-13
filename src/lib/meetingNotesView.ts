import "server-only";
import { sql } from "./db";
import type { CandidateCard } from "@/components/CandidateQueue";
import { withRetry } from "./retry";
import { ensureMeetingNotesSchema } from "./meetingNotes";
import type { ProposedUpdate } from "./meetingNoteUpdates";
import { isInternalEmail } from "@/config/crm.config";

/**
 * Read models for the Meetings page and Home: which notes are waiting on a
 * human, what state each meeting's note is in, and plain-language match
 * suggestions for the Unmatched queue. Read-only — all writes live in
 * meetingNoteUpdates.ts and meetingNotes.ts.
 */

export interface NoteForReview {
  id: string;
  title: string | null;
  startsAt: string | null;
  dealGid: string;
  dealName: string | null;
  updates: ProposedUpdate[];
  state: "ready" | "applied";
  appliedAt: string | null;
}

/** Notes with proposed updates waiting (or recently applied, for undo). */
export async function notesForReview(limit = 12): Promise<NoteForReview[]> {
  await ensureMeetingNotesSchema();
  const rows = await withRetry(
    () => sql<
      {
        id: string;
        title: string | null;
        starts_at: Date | null;
        matched_deal_gid: string;
        deal_name: string | null;
        proposed_updates: ProposedUpdate[] | null;
        review_state: string;
        applied_at: Date | null;
      }[]
    >`
      select n.id, n.title, n.starts_at, n.matched_deal_gid,
             d.name as deal_name, n.proposed_updates, n.review_state, n.applied_at
        from meeting_notes n
        left join deals d on d.gid = n.matched_deal_gid
       where n.matched_deal_gid is not null
         and n.match_state in ('confirmed', 'attached')
         and coalesce(d.visibility, 'team') <> 'private'
         and (
           n.review_state = 'ready'
           or (n.review_state = 'applied' and n.applied_at > now() - interval '3 days')
         )
       order by n.review_state = 'ready' desc, coalesce(n.starts_at, n.imported_at) desc
       limit ${limit}`
  ).catch(() => []);
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    startsAt: r.starts_at ? new Date(r.starts_at).toISOString() : null,
    dealGid: r.matched_deal_gid,
    dealName: r.deal_name,
    updates: r.proposed_updates ?? [],
    state: r.review_state === "applied" ? "applied" : "ready",
    appliedAt: r.applied_at ? new Date(r.applied_at).toISOString() : null,
  }));
}

export interface UnmatchedNote {
  id: string;
  title: string | null;
  startsAt: string | null;
  participants: { name: string | null; email: string | null }[];
  /** Plain-language deal suggestions, best first. */
  suggestions: { gid: string; name: string; reason: string }[];
}

/** Granola notes with no confirmed deal — the Unmatched queue's note half. */
export async function unmatchedNotes(limit = 20): Promise<UnmatchedNote[]> {
  await ensureMeetingNotesSchema();
  const rows = await withRetry(
    () => sql<
      {
        id: string;
        title: string | null;
        starts_at: Date | null;
        participants: { name?: string | null; email?: string | null }[];
        matched_deal_gid: string | null;
        deal_name: string | null;
        match_evidence: { kind?: string; value?: string } | null;
      }[]
    >`
      select n.id, n.title, n.starts_at, n.participants,
             n.matched_deal_gid, d.name as deal_name, n.match_evidence
        from meeting_notes n
        left join deals d on d.gid = n.matched_deal_gid
       where n.match_state in ('unmatched', 'suggested')
       order by coalesce(n.starts_at, n.imported_at) desc
       limit ${limit}`
  ).catch(() => []);
  return rows.map((r) => {
    // Translate the matcher's stored evidence into one plain sentence.
    const suggestions: UnmatchedNote["suggestions"] = [];
    if (r.matched_deal_gid && r.deal_name) {
      const ev = r.match_evidence;
      const reason =
        ev?.kind === "attendee_email"
          ? `Because ${ev.value} is on the note's attendee list.`
          : ev?.kind === "attendee_domain"
            ? `Because someone from @${ev.value} was in the meeting.`
            : ev?.kind === "attendee_name"
              ? `Because ${ev.value}, a founder on the deal, was in the meeting.`
              : ev?.kind === "title_company"
                ? `Because the note title mentions “${ev.value}”.`
                : ev?.kind === "title_founder"
                  ? `Because the note title names ${ev.value}.`
                  : "Best available match from attendees and title.";
      suggestions.push({ gid: r.matched_deal_gid, name: r.deal_name, reason });
    }
    return {
      id: r.id,
      title: r.title,
      startsAt: r.starts_at ? new Date(r.starts_at).toISOString() : null,
      participants: (r.participants ?? []).map((p) => ({
        name: p.name ?? null,
        email: p.email ?? null,
      })),
      suggestions,
    };
  });
}

export type GranolaChip =
  | "processing"
  | "ready"
  | "applied"
  | "uncertain"
  | "none";

/**
 * Note state per calendar event, for the meeting-row chips. Keyed by the
 * Google event key AND by (title-lowered + day) as a fallback for notes whose
 * calendar linkage didn't survive the provider.
 */
export async function noteStateByEvent(): Promise<Map<string, { chip: GranolaChip; noteId: string }>> {
  await ensureMeetingNotesSchema();
  const rows = await withRetry(
    () => sql<
      {
        id: string;
        calendar_event_key: string | null;
        title: string | null;
        starts_at: Date | null;
        transcript_state: string;
        match_state: string;
        review_state: string | null;
      }[]
    >`
      select id, calendar_event_key, title, starts_at,
             transcript_state, match_state, coalesce(review_state, 'none') as review_state
        from meeting_notes
       where coalesce(starts_at, imported_at) > now() - interval '60 days'`
  ).catch(() => []);

  const chipOf = (r: (typeof rows)[number]): GranolaChip => {
    if (r.review_state === "ready") return "ready";
    if (r.review_state === "applied") return "applied";
    if (r.transcript_state === "pending") return "processing";
    if (r.match_state === "suggested" || r.match_state === "unmatched") return "uncertain";
    return "none";
  };

  const map = new Map<string, { chip: GranolaChip; noteId: string }>();
  for (const r of rows) {
    const v = { chip: chipOf(r), noteId: r.id };
    if (r.calendar_event_key) map.set(`key:${r.calendar_event_key}`, v);
    if (r.title && r.starts_at) {
      map.set(
        `day:${r.title.trim().toLowerCase()}:${new Date(r.starts_at).toISOString().slice(0, 10)}`,
        v
      );
    }
  }
  return map;
}

export interface MeetingNoteDetail {
  noteId: string;
  chip: GranolaChip;
  title: string | null;
  url: string | null;
  summary: string | null;
  updates: ProposedUpdate[];
  reviewState: string;
  appliedAt: string | null;
}

/**
 * Note content per calendar event for the Meetings detail panel: summary,
 * link, proposed/applied updates. Same keying as noteStateByEvent (event key
 * plus title+day fallback).
 */
export async function notesForMeetings(): Promise<Map<string, MeetingNoteDetail>> {
  await ensureMeetingNotesSchema();
  const rows = await withRetry(
    () => sql<
      {
        id: string;
        calendar_event_key: string | null;
        title: string | null;
        starts_at: Date | null;
        note_url: string | null;
        summary_md: string | null;
        notes_md: string | null;
        transcript_state: string;
        match_state: string;
        review_state: string | null;
        proposed_updates: ProposedUpdate[] | null;
        applied_at: Date | null;
      }[]
    >`
      select id, calendar_event_key, title, starts_at, note_url,
             summary_md, notes_md, transcript_state, match_state,
             coalesce(review_state, 'none') as review_state,
             proposed_updates, applied_at
        from meeting_notes
       where coalesce(starts_at, imported_at) > now() - interval '90 days'`
  ).catch(() => []);

  const chipOf = (r: (typeof rows)[number]): GranolaChip => {
    if (r.review_state === "ready") return "ready";
    if (r.review_state === "applied") return "applied";
    if (r.transcript_state === "pending") return "processing";
    if (r.match_state === "suggested" || r.match_state === "unmatched") return "uncertain";
    return "none";
  };

  const map = new Map<string, MeetingNoteDetail>();
  for (const r of rows) {
    const v: MeetingNoteDetail = {
      noteId: r.id,
      chip: chipOf(r),
      title: r.title,
      url: r.note_url,
      summary: (r.summary_md ?? r.notes_md)?.slice(0, 2400) ?? null,
      updates: r.proposed_updates ?? [],
      reviewState: r.review_state ?? "none",
      appliedAt: r.applied_at ? r.applied_at.toISOString() : null,
    };
    if (r.calendar_event_key) map.set(`key:${r.calendar_event_key}`, v);
    if (r.title && r.starts_at) {
      map.set(
        `day:${r.title.trim().toLowerCase()}:${new Date(r.starts_at).toISOString().slice(0, 10)}`,
        v
      );
    }
  }
  return map;
}

/* ── The Inbox adapter ─────────────────────────────────────────────────────
 * Granola notes that need a HUMAN DECISION, shaped for the one triage queue:
 *   ready      a matched note with proposed deal updates waiting
 *   unmatched  an external meeting note with no confirmed deal home
 * Internal-only notes and dismissed/skipped notes never appear.
 */

export interface GranolaInboxItem {
  id: string;
  kind: "ready" | "unmatched" | "reviewed";
  /** For reviewed rows: how the note was resolved. */
  resolution: "attached" | "ignored" | "handled" | null;
  title: string | null;
  startsAt: string | null;
  dealGid: string | null;
  dealName: string | null;
  updateCount: number;
  /** First external participant — the human face of the row. */
  participant: string | null;
  suggestionText: string | null;
  confidence: number | null;
}

function firstExternal(parts: { name?: string | null; email?: string | null }[] | null): string | null {
  for (const p of parts ?? []) {
    const email = (p.email ?? "").toLowerCase();
    if (email && !isInternalEmail(email)) return p.name?.trim() || email;
  }
  return null;
}

/** Hide only REAL internal meetings: two or more people, every email ours.
 * Solo notes and notes without captured emails stay — the human decides. */
function looksInternalOnly(parts: { email?: string | null }[] | null): boolean {
  const emails = (parts ?? [])
    .map((p) => (p.email ?? "").toLowerCase())
    .filter(Boolean);
  return (parts ?? []).length >= 2 && emails.length > 0 && emails.every((e) => isInternalEmail(e));
}

export async function granolaInboxItems(limit = 150): Promise<GranolaInboxItem[]> {
  await ensureMeetingNotesSchema();
  const rows = await withRetry(
    () => sql<
      {
        id: string;
        title: string | null;
        starts_at: Date | null;
        participants: { name?: string | null; email?: string | null }[] | null;
        matched_deal_gid: string | null;
        deal_name: string | null;
        match_state: string;
        review_state: string;
        match_confidence: number | null;
        match_evidence: { kind?: string; value?: string } | null;
        proposed_updates: unknown[] | null;
      }[]
    >`
      select n.id, n.title, n.starts_at, n.participants, n.matched_deal_gid,
             d.name as deal_name, n.match_state, n.review_state,
             n.match_confidence, n.match_evidence, n.proposed_updates
        from meeting_notes n
        left join deals d on d.gid = n.matched_deal_gid
       where (
               -- decisions, not a dump: proposals waiting on a matched note…
               (n.match_state in ('confirmed', 'attached')
                 and n.review_state = 'ready'
                 and coalesce(d.visibility, 'team') <> 'private')
               -- …or an external meeting with no confirmed home yet
               or (n.match_state in ('unmatched', 'suggested')
                 and n.review_state is distinct from 'skipped')
               -- …or a decided note: reviewed meetings stay reachable
               or n.review_state in ('skipped', 'applied', 'dismissed')
               or n.match_state = 'dismissed'
             )
       order by coalesce(n.starts_at, n.imported_at) desc
       limit ${limit}`
  ).catch(() => []);

  const out: GranolaInboxItem[] = [];
  for (const r of rows) {
    const ready = r.match_state === "confirmed" || r.match_state === "attached";
    if (!ready && looksInternalOnly(r.participants)) continue; // internal chatter stays out
    const decided =
      r.review_state === "skipped" ||
      r.review_state === "applied" ||
      r.review_state === "dismissed" ||
      r.match_state === "dismissed";
    const open =
      (ready && r.review_state === "ready") ||
      ((r.match_state === "unmatched" || r.match_state === "suggested") &&
        r.review_state !== "skipped" && !decided);
    if (decided && !open) {
      out.push({
        id: r.id,
        kind: "reviewed",
        resolution:
          r.match_state === "dismissed"
            ? "ignored"
            : r.matched_deal_gid
              ? "attached"
              : "handled",
        title: r.title,
        startsAt: r.starts_at ? r.starts_at.toISOString() : null,
        dealGid: r.matched_deal_gid,
        dealName: r.deal_name,
        updateCount: 0,
        participant: firstExternal(r.participants),
        suggestionText: null,
        confidence: r.match_confidence == null ? null : Number(r.match_confidence),
      });
      continue;
    }
    const ev = r.match_evidence;
    const reason =
      ev?.kind === "attendee_email"
        ? `${ev.value} is on the attendee list`
        : ev?.kind === "attendee_domain"
          ? `someone from @${ev.value} attended`
          : ev?.kind === "attendee_name"
            ? `founder ${ev.value} attended`
            : ev?.kind === "title_company"
              ? `the title mentions "${ev.value}"`
              : ev?.kind === "title_founder"
                ? `the title names ${ev.value}`
                : null;
    out.push({
      id: r.id,
      kind: ready ? "ready" : "unmatched",
      resolution: null,
      title: r.title,
      startsAt: r.starts_at ? new Date(r.starts_at).toISOString() : null,
      dealGid: r.matched_deal_gid,
      dealName: r.deal_name,
      updateCount: Array.isArray(r.proposed_updates) ? r.proposed_updates.length : 0,
      participant: firstExternal(r.participants),
      suggestionText: ready
        ? null
        : r.matched_deal_gid && r.deal_name
          ? `Looks like ${r.deal_name.split("//").pop()?.trim()}${reason ? ` — ${reason}` : ""}`
          : "No deal match — attach, create, or ignore",
      confidence: r.match_confidence === null ? null : Number(r.match_confidence),
    });
  }
  return out;
}

/** Granola items shaped as Inbox rail cards — ONE mapping for every surface. */
export function granolaToCards(items: GranolaInboxItem[]): CandidateCard[] {
  return items.map((n) => ({
    id: n.id,
    status: (n.kind === "reviewed"
      ? n.resolution === "ignored"
        ? "ignored"
        : "attached"
      : "ready") as CandidateCard["status"],
    assignedTo: null,
    classification: "meeting",
    confidence: n.confidence,
    receivedAt: n.startsAt,
    snoozedUntil: null,
    companyName: n.dealName ? (n.dealName.split("//").pop()?.trim() ?? n.dealName) : n.title,
    oneLiner:
      n.kind === "reviewed"
        ? n.resolution === "attached" && n.dealName
          ? `Attached to ${n.dealName.split("//").pop()?.trim() ?? n.dealName}`
          : n.resolution === "ignored"
            ? "Ignored"
            : "Reviewed"
        : n.kind === "ready"
          ? `${n.updateCount} proposed update${n.updateCount === 1 ? "" : "s"} from the meeting — review and apply`
          : n.suggestionText,
    fromName: n.participant,
    fromEmail: null,
    subject: n.title,
    round: null,
    raiseAmount: null,
    deckCount: 0,
    attachmentCount: 0,
    missing: [],
    promotedDealGid: null,
    source: "granola" as const,
    href: `/inbox/note/${n.id}`,
  }));
}
