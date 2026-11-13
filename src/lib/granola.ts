import "server-only";

/**
 * ── Granola public API adapter ───────────────────────────────────────────────
 * Raw fetch against https://public-api.granola.ai/v1 (no SDK). Auth is a
 * Bearer API key (grn_…) from GRANOLA_API_KEY; a missing key reports
 * {configured:false} rather than throwing so settings and status pages render
 * on an unconfigured deploy.
 *
 * Confirmed shapes (docs.granola.ai/api-reference):
 *   GET /v1/notes?created_after&updated_after&cursor&page_size(≤30)
 *     → { notes: [{id, object, title, owner{name,email}, created_at,
 *          updated_at}], hasMore, cursor }
 *   GET /v1/notes/{id}?include=transcript
 *     → note + web_url, calendar_event{invitees[{email}], organiser,
 *          calendar_event_id, scheduled_start_time, scheduled_end_time},
 *        attendees[{name,email}], summary_text, summary_markdown,
 *        transcript[{speaker, text, start_time, end_time}] | null
 *
 * Rate limits: 25-request burst / 5s window, 5 req/s sustained — callers
 * space paged requests out (see meetingNotes.ts).
 */

const BASE_URL = "https://public-api.granola.ai/v1";
const TIMEOUT_MS = 15_000;

export interface GranolaOwner {
  name: string | null;
  email: string;
}

/** The slim note object returned by the list endpoint. */
export interface GranolaNoteSummary {
  id: string;
  title: string | null;
  owner: GranolaOwner | null;
  created_at: string;
  updated_at: string;
}

export interface GranolaAttendee {
  name: string | null;
  email: string;
}

export interface GranolaCalendarEvent {
  event_title: string | null;
  invitees: { email: string }[];
  organiser: string | null;
  calendar_event_id: string | null;
  scheduled_start_time: string | null;
  scheduled_end_time: string | null;
}

export interface GranolaTranscriptSegment {
  speaker: { source?: string; diarization_label?: string; name?: string } | null;
  text: string;
  start_time: string | null;
  end_time: string | null;
}

/** The full note from GET /notes/{id}. */
export interface GranolaNoteDetail extends GranolaNoteSummary {
  web_url: string | null;
  calendar_event: GranolaCalendarEvent | null;
  attendees: GranolaAttendee[];
  summary_text: string | null;
  summary_markdown: string | null;
  /** Present only when requested with includeTranscript. */
  transcript: GranolaTranscriptSegment[] | null;
}

export interface GranolaListResult {
  notes: GranolaNoteSummary[];
  hasMore: boolean;
  cursor: string | null;
}

function apiKey(): string | null {
  const key = process.env.GRANOLA_API_KEY?.trim();
  return key ? key : null;
}

/** Whether the integration has an API key at all — never throws. */
export function granolaConfigured(): boolean {
  return apiKey() !== null;
}

export function granolaStatus(): { configured: boolean } {
  return { configured: granolaConfigured() };
}

/* eslint-disable @typescript-eslint/no-explicit-any */
async function granolaGet(path: string): Promise<any> {
  const key = apiKey();
  if (!key) throw new Error("GRANOLA_API_KEY is not configured");
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(
      `Granola API ${res.status} for ${path.split("?")[0]}: ${(await res.text()).slice(0, 150)}`
    );
  }
  return res.json();
}

function asString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function parseOwner(raw: any): GranolaOwner | null {
  if (!raw || typeof raw !== "object") return null;
  const email = asString(raw.email);
  if (!email) return null;
  return { name: asString(raw.name), email };
}

function parseSummary(raw: any): GranolaNoteSummary | null {
  const id = asString(raw?.id);
  if (!id) return null;
  return {
    id,
    title: asString(raw.title),
    owner: parseOwner(raw.owner),
    created_at: asString(raw.created_at) ?? "",
    updated_at: asString(raw.updated_at) ?? "",
  };
}

/**
 * One page of notes, newest window first. `updatedAfter` maps to
 * updated_after (incremental); `since` maps to created_after (first fill).
 */
export async function listNotes(opts: {
  since?: string;
  updatedAfter?: string;
  cursor?: string;
  pageSize?: number;
} = {}): Promise<GranolaListResult> {
  const qs = new URLSearchParams();
  if (opts.updatedAfter) qs.set("updated_after", opts.updatedAfter);
  else if (opts.since) qs.set("created_after", opts.since);
  if (opts.cursor) qs.set("cursor", opts.cursor);
  qs.set("page_size", String(Math.min(Math.max(opts.pageSize ?? 30, 1), 30)));
  const data = await granolaGet(`/notes?${qs.toString()}`);
  const notes: GranolaNoteSummary[] = [];
  for (const raw of Array.isArray(data?.notes) ? data.notes : []) {
    const parsed = parseSummary(raw);
    if (parsed) notes.push(parsed);
  }
  return {
    notes,
    hasMore: data?.hasMore === true,
    cursor: asString(data?.cursor),
  };
}

/** Full note detail; includeTranscript adds ?include=transcript. */
export async function getNote(
  id: string,
  opts: { includeTranscript?: boolean } = {}
): Promise<GranolaNoteDetail> {
  const qs = opts.includeTranscript ? "?include=transcript" : "";
  const data = await granolaGet(`/notes/${encodeURIComponent(id)}${qs}`);
  const base = parseSummary(data);
  if (!base) throw new Error(`Granola note ${id}: malformed response`);

  const attendees: GranolaAttendee[] = [];
  for (const a of Array.isArray(data.attendees) ? data.attendees : []) {
    const email = asString(a?.email);
    if (email) attendees.push({ name: asString(a?.name), email });
  }

  let calendarEvent: GranolaCalendarEvent | null = null;
  const ce = data.calendar_event;
  if (ce && typeof ce === "object") {
    calendarEvent = {
      event_title: asString(ce.event_title),
      invitees: (Array.isArray(ce.invitees) ? ce.invitees : [])
        .map((i: any) => ({ email: asString(i?.email) ?? "" }))
        .filter((i: { email: string }) => i.email),
      organiser: asString(ce.organiser),
      calendar_event_id: asString(ce.calendar_event_id),
      scheduled_start_time: asString(ce.scheduled_start_time),
      scheduled_end_time: asString(ce.scheduled_end_time),
    };
  }

  let transcript: GranolaTranscriptSegment[] | null = null;
  if (Array.isArray(data.transcript)) {
    transcript = data.transcript
      .filter((t: any) => t && typeof t === "object")
      .map((t: any) => ({
        speaker: t.speaker && typeof t.speaker === "object" ? t.speaker : null,
        text: asString(t.text) ?? "",
        start_time: asString(t.start_time),
        end_time: asString(t.end_time),
      }));
  }

  return {
    ...base,
    web_url: asString(data.web_url),
    calendar_event: calendarEvent,
    attendees,
    summary_text: asString(data.summary_text),
    summary_markdown: asString(data.summary_markdown),
    transcript,
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */
