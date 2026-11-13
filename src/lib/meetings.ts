import "server-only";
import { sql } from "./db";
import { withRetry } from "./retry";
import { logError } from "./log";
import type { CalendarAttendee, CalendarMatchEvidence } from "./calendarPure";

/**
 * ── Matched calendar meetings, read side ────────────────────────────────────
 * calendarSync.ts writes calendar_events and stamps matched_deal_gid; this
 * module is the deal-facing read path (the modal's Meetings section) plus the
 * one write a user needs: clearing a wrong match. Every reader swallows
 * failures into an empty result — a missing calendar_events table (calendar
 * sync never ran) must never break a deal view.
 */

export interface DealNote {
  id: string;
  provider: string;
  noteKey: string;
  title: string | null;
  startsAt: string | null;
  summary: string | null;
  /** The full meeting notes document — the expandable transcript context. */
  transcript: string | null;
  /** The note's own page (Granola web_url). */
  url: string | null;
}

export interface DealMeeting {
  id: string;
  title: string;
  /** ISO timestamps; startsAt is never null (undated stubs aren't synced). */
  startsAt: string;
  endsAt: string | null;
  status: string;
  attendees: { email: string; name?: string }[];
  conferenceUrl: string | null;
  confidence: number | null;
  evidence: CalendarMatchEvidence[];
  /** The Granola note for this meeting, when one is matched. */
  granola?: DealNote | null;
}

interface MeetingRow {
  id: string;
  title: string | null;
  starts_at: Date | null;
  ends_at: Date | null;
  status: string | null;
  attendees: CalendarAttendee[] | null;
  conference_url: string | null;
  match_confidence: string | number | null; // numeric → string in postgres.js
  match_evidence: CalendarMatchEvidence[] | null;
  provider_event_key?: string | null;
}

function rowToMeeting(r: MeetingRow): DealMeeting {
  const attendees = (Array.isArray(r.attendees) ? r.attendees : [])
    .filter((a): a is CalendarAttendee & { email: string } => !!a?.email)
    .map((a) => (a.name ? { email: a.email, name: a.name } : { email: a.email }));
  return {
    id: r.id,
    title: r.title ?? "",
    startsAt: (r.starts_at ?? new Date(0)).toISOString(),
    endsAt: r.ends_at ? r.ends_at.toISOString() : null,
    status: r.status ?? "confirmed",
    attendees,
    conferenceUrl: r.conference_url ?? null,
    confidence:
      r.match_confidence === null || r.match_confidence === undefined
        ? null
        : Number(r.match_confidence),
    evidence: Array.isArray(r.match_evidence) ? r.match_evidence : [],
  };
}

/** The meetings matched to one deal, newest first. Never throws. */
export async function meetingsForDeal(gid: string): Promise<DealMeeting[]> {
  try {
    const rows = await withRetry(
      () => sql<MeetingRow[]>`
        select id, title, starts_at, ends_at, status, attendees,
               conference_url, match_confidence, match_evidence
        from calendar_events
        where matched_deal_gid = ${gid}
        order by starts_at desc
        limit 20
      `
    );
    return rows.map(rowToMeeting);
  } catch (err) {
    logError("calendar", "meetingsForDeal failed", err, { gid });
    return [];
  }
}

/**
 * Meetings + their Granola notes for one deal. Notes pair to a meeting by the
 * calendar event key, or by starting within 20 hours of it; notes matched to
 * the deal but to no particular meeting come back separately — they still
 * belong on the record. Never throws.
 */
export async function meetingsWithNotesForDeal(
  gid: string
): Promise<{ meetings: DealMeeting[]; looseNotes: DealNote[] }> {
  try {
    const [rows, noteRows] = await Promise.all([
      withRetry(
        () => sql<MeetingRow[]>`
          select id, title, starts_at, ends_at, status, attendees,
                 conference_url, match_confidence, match_evidence,
                 provider_event_key
          from calendar_events
          where matched_deal_gid = ${gid}
          order by starts_at desc
          limit 20
        `
      ),
      withRetry(
        () => sql<
          {
            id: string;
            provider: string;
            provider_note_key: string;
            calendar_event_key: string | null;
            title: string | null;
            starts_at: Date | null;
            summary_md: string | null;
            notes_md: string | null;
            note_url: string | null;
          }[]
        >`
          select id, provider, provider_note_key, calendar_event_key,
                 title, starts_at, summary_md, notes_md, note_url
          from meeting_notes
          where matched_deal_gid = ${gid}
            and match_state in ('confirmed', 'attached')
          order by coalesce(starts_at, imported_at) desc
          limit 20
        `
      ).catch(() => []),
    ]);

    const toNote = (n: (typeof noteRows)[number]): DealNote => {
      const summary = (n.summary_md ?? n.notes_md)?.slice(0, 600) ?? null;
      // The full document, minus what the summary already shows when they
      // are the same text; bounded so twenty notes can't bloat the payload.
      const full = [n.summary_md, n.notes_md]
        .filter((p): p is string => !!p?.trim())
        .join("\n\n")
        .slice(0, 12_000);
      return {
        id: n.id,
        provider: n.provider,
        noteKey: n.provider_note_key,
        title: n.title,
        startsAt: n.starts_at ? n.starts_at.toISOString() : null,
        summary,
        transcript: full.length > (summary?.length ?? 0) ? full : null,
        url: n.note_url,
      };
    };

    const meetings = rows.map(rowToMeeting);
    const used = new Set<string>();
    for (let i = 0; i < meetings.length; i++) {
      const key = rows[i].provider_event_key;
      const at = rows[i].starts_at?.getTime();
      const hit = noteRows.find(
        (n) =>
          !used.has(n.id) &&
          ((key && n.calendar_event_key === key) ||
            (at !== undefined &&
              n.starts_at &&
              Math.abs(n.starts_at.getTime() - at) < 20 * 3_600_000))
      );
      if (hit) {
        used.add(hit.id);
        meetings[i] = { ...meetings[i], granola: toNote(hit) };
      }
    }
    const looseNotes = noteRows.filter((n) => !used.has(n.id)).map(toNote);
    return { meetings, looseNotes };
  } catch (err) {
    logError("calendar", "meetingsWithNotesForDeal failed", err, { gid });
    return { meetings: [], looseNotes: [] };
  }
}

/** The deal's next upcoming (non-cancelled) meeting, or null. Never throws. */
export async function nextMeetingForDeal(gid: string): Promise<DealMeeting | null> {
  try {
    const rows = await withRetry(
      () => sql<MeetingRow[]>`
        select id, title, starts_at, ends_at, status, attendees,
               conference_url, match_confidence, match_evidence
        from calendar_events
        where matched_deal_gid = ${gid}
          and status <> 'cancelled'
          and starts_at > now()
        order by starts_at asc
        limit 1
      `
    );
    return rows[0] ? rowToMeeting(rows[0]) : null;
  } catch (err) {
    logError("calendar", "nextMeetingForDeal failed", err, { gid });
    return null;
  }
}

/**
 * Undo a wrong match: detach the event from its deal. Clears the confidence
 * and evidence too, so the row reads as never-matched. Returns whether a row
 * changed; never throws.
 */
export async function clearMeetingMatch(eventId: string): Promise<boolean> {
  try {
    const rows = await withRetry(
      () => sql<{ id: string }[]>`
        update calendar_events
        set matched_deal_gid = null,
            match_confidence = null,
            match_evidence = null,
            updated_at = now()
        where id = ${eventId}
        returning id
      `
    );
    return rows.length > 0;
  } catch (err) {
    logError("calendar", "clearMeetingMatch failed", err, { eventId });
    return false;
  }
}

/**
 * Earliest upcoming matched meeting per deal, as gid → ISO start. Fuels the
 * board card's calendar glyph. Empty map on any failure — the board renders
 * regardless of calendar state.
 */
export async function upcomingMeetingStarts(): Promise<Map<string, string>> {
  try {
    const rows = await withRetry(
      () => sql<{ gid: string; starts_at: Date }[]>`
        select matched_deal_gid as gid, min(starts_at) as starts_at
        from calendar_events
        where matched_deal_gid is not null
          and status <> 'cancelled'
          and starts_at > now()
        group by matched_deal_gid
      `
    );
    const map = new Map<string, string>();
    for (const r of rows) map.set(r.gid, r.starts_at.toISOString());
    return map;
  } catch {
    return new Map(); // calendar_events absent — no glyphs, no failure
  }
}
