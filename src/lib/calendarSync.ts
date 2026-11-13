import "server-only";
import { sql } from "./db";
import { withRetry } from "./retry";
import { logError, logEvent } from "./log";
import { getGoogleConnection, type GoogleConnection } from "./googleSync";
import { INTERNAL_DOMAINS } from "./companiesPure";
import { loadDealEvidencePools } from "./identityEvidence";
import {
  calendarNeedsFullResync,
  isExternalMeeting,
  matchEvidence,
  type CalendarAttendee,
  type CalendarMatchDeal,
} from "./calendarPure";

/**
 * ── Google Calendar sync + deal matching (PR-10) ────────────────────────────
 * Per-member calendar events land in `calendar_events` and get matched to
 * pipeline deals (calendarPure). Tokens come from the LEGACY google_connections
 * table (googleSync.ts) — those grants already carry calendar.readonly; the
 * newer mailbox_connections rows are gmail-scope only, so they can't serve
 * calendar reads.
 *
 * Incremental sync via Google's nextSyncToken (calendar_sync_state); a 410
 * GONE wipes the token and re-baselines a -30d..+120d window. Reschedules
 * update rows in place (upsert on the event id); cancellations flip status
 * and KEEP the row, so cancelled meetings remain visible history.
 */

// All of it. The point of syncing history is to answer "when did we last meet
// this founder", and any cutoff silently hides exactly the meetings worth
// finding — the old 30-day window put Lark AI's intro call 37 days out of
// reach, so the deal looked like a cold contact. Ten years is effectively all
// time here and keeps a lower bound the API is happy with.
const CAL_WINDOW_PAST_DAYS = Number(process.env.CAL_WINDOW_PAST_DAYS ?? 3650);
const CAL_WINDOW_FUTURE_DAYS = 120;
// Bounded per run. An all-time first sync is thousands of events and would
// blow past the platform's 300s function ceiling in one go; Google's syncToken
// makes the next run resume exactly where this one stopped, so a small page
// budget backfills over several runs instead of dying halfway through one.
const MAX_PAGES = Number(process.env.CAL_MAX_PAGES ?? 6);
/** How often to throw away the sync token and re-read everything. */
const FULL_RESYNC_EVERY_DAYS = Number(process.env.CAL_FULL_RESYNC_DAYS ?? 90);

/* ── Schema ────────────────────────────────────────────────────────────────── */

let schemaReady = false;
/** Mirrors sql/016_calendar.sql; kept in-sync by review. */
export async function ensureCalendarSchema(): Promise<void> {
  if (schemaReady) return;
  await sql`
    create table if not exists calendar_events (
      id                 uuid primary key default gen_random_uuid(),
      provider_event_key text not null unique,
      series_key         text,
      owner_email        text not null,
      title              text,
      starts_at          timestamptz,
      ends_at            timestamptz,
      attendees          jsonb default '[]',
      status             text default 'confirmed',
      conference_url     text,
      matched_deal_gid   text,
      match_confidence   numeric,
      match_evidence     jsonb,
      sync_token_owner   text,
      created_at         timestamptz default now(),
      updated_at         timestamptz default now()
    )
  `;
  await sql`
    create index if not exists calendar_events_owner_starts_idx
      on calendar_events (owner_email, starts_at desc)
  `;
  await sql`
    create table if not exists calendar_sync_state (
      owner_email text primary key,
      sync_token  text,
      updated_at  timestamptz default now()
    )
  `;
  // When the last FULL re-baseline happened, as opposed to an incremental
  // pass. Incremental sync only ever reports changes Google chooses to tell us
  // about, so history can quietly drift — a periodic full pass re-reads
  // everything and repairs it.
  await sql`
    alter table calendar_sync_state
      add column if not exists last_full_sync_at timestamptz
  `;
  // Resume token for a windowed baseline that didn't finish in one run.
  await sql`
    alter table calendar_sync_state
      add column if not exists full_sync_page_token text
  `;
  // Per-deal meeting lookups (meetings.ts, interactions.ts) were seq-scanning
  // all events on every deal render; this matches their exact access pattern.
  // Also applied by hand in prod — mirrored here so a rebuilt environment
  // doesn't silently regress to seq scans.
  // Company-domain suggestions the reviewer dismissed on /meetings.
  await sql`
    alter table calendar_events
      add column if not exists triage_dismissed text[] not null default '{}'
  `;
  // Reverse enrichment's incremental watermark (calendarEnrich.ts).
  await sql`
    alter table calendar_events add column if not exists enriched_at timestamptz
  `;
  await sql`
    create index if not exists calendar_events_matched_deal_starts_idx
      on calendar_events (matched_deal_gid, starts_at desc)
      where matched_deal_gid is not null
  `;
  schemaReady = true;
}

/* ── Google Calendar REST ──────────────────────────────────────────────────── */

/**
 * Short-lived access token for a legacy google_connections grant. Mirrors
 * googleSync.ts's accessTokenFor — that helper is module-private and this
 * PR may not edit existing files, so the (four-line) exchange is restated
 * here rather than exported from there.
 */
async function calendarAccessTokenFor(conn: GoogleConnection): Promise<string> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.AUTH_GOOGLE_ID!,
      client_secret: process.env.AUTH_GOOGLE_SECRET!,
      refresh_token: conn.refresh_token,
      grant_type: "refresh_token",
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok)
    throw new Error(
      `Google token refresh ${res.status}: ${(await res.text()).slice(0, 150)}`
    );
  const data = (await res.json()) as { access_token?: string };
  if (!data.access_token) throw new Error("No access token returned.");
  return data.access_token;
}

/** Thrown when Google says the sync token is stale (410 GONE). */
class SyncTokenGoneError extends Error {}

/* eslint-disable @typescript-eslint/no-explicit-any */
async function calendarList(token: string, qs: URLSearchParams): Promise<any> {
  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events?${qs.toString()}`,
    {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(20_000),
    }
  );
  if (res.status === 410) throw new SyncTokenGoneError("sync token expired");
  if (!res.ok) throw new Error(`Calendar API ${res.status} for events.list`);
  return res.json();
}

/**
 * All event pages for one run. With a syncToken Google returns only changes
 * (including cancellations) and forbids time filters; without one we baseline
 * a -30d..+120d window. Returns the nextSyncToken to persist.
 */
async function listEvents(
  token: string,
  syncToken: string | null,
  resumePageToken: string | null = null
): Promise<{ items: any[]; nextSyncToken: string | null; nextPageToken: string | null }> {
  const items: any[] = [];
  let pageToken = resumePageToken ?? "";
  let nextSyncToken: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const qs = new URLSearchParams({
      maxResults: "250",
      singleEvents: "true",
    });
    if (syncToken) {
      qs.set("syncToken", syncToken);
    } else {
      qs.set(
        "timeMin",
        new Date(Date.now() - CAL_WINDOW_PAST_DAYS * 86400_000).toISOString()
      );
      qs.set(
        "timeMax",
        new Date(Date.now() + CAL_WINDOW_FUTURE_DAYS * 86400_000).toISOString()
      );
    }
    if (pageToken) qs.set("pageToken", pageToken);
    const data = await calendarList(token, qs);
    items.push(...(data.items ?? []));
    if (data.nextSyncToken) nextSyncToken = String(data.nextSyncToken);
    pageToken = data.nextPageToken ?? "";
    if (!pageToken) break;
  }
  return { items, nextSyncToken, nextPageToken: pageToken || null };
}

/* ── Persistence ───────────────────────────────────────────────────────────── */

function eventTime(t: any): string | null {
  if (t?.dateTime) return String(t.dateTime);
  if (t?.date) return `${t.date}T12:00:00Z`; // all-day: noon UTC, as googleSync does
  return null;
}

function conferenceUrl(ev: any): string | null {
  if (ev.hangoutLink) return String(ev.hangoutLink).slice(0, 500);
  const video = (ev.conferenceData?.entryPoints ?? []).find(
    (e: any) => e?.entryPointType === "video" && e?.uri
  );
  return video ? String(video.uri).slice(0, 500) : null;
}

function attendeesOf(ev: any): CalendarAttendee[] {
  return ((ev.attendees ?? []) as any[])
    .map((a) => ({
      email: String(a?.email ?? "").toLowerCase(),
      name: String(a?.displayName ?? ""),
      status: String(a?.responseStatus ?? ""),
      organizer: a?.organizer === true,
    }))
    .filter((a) => a.email)
    .slice(0, 60);
}

/**
 * Upsert one event; returns its row id, or null when skipped. A reschedule
 * hits the ON CONFLICT branch and updates in place; a cancellation flips
 * status on the existing row (cancelled payloads are skeletal — no title or
 * times — so they must not blank out the stored copy).
 */
async function upsertEvent(
  ownerEmail: string,
  ev: any
): Promise<string | null> {
  if (!ev?.id) return null;

  if (ev.status === "cancelled") {
    await withRetry(
      () => sql`
        update calendar_events
        set status = 'cancelled', updated_at = now(), sync_token_owner = ${ownerEmail}
        where provider_event_key = ${String(ev.id)}
      `
    );
    return null; // never existed here → nothing to keep; existed → row kept
  }

  const starts = eventTime(ev.start);
  if (!starts) return null; // undated stubs carry no meeting signal
  const attendees = attendeesOf(ev);
  const rows = await withRetry(
    () => sql<{ id: string }[]>`
      insert into calendar_events
        (provider_event_key, series_key, owner_email, title, starts_at, ends_at,
         attendees, status, conference_url, sync_token_owner)
      values
        (${String(ev.id)}, ${ev.recurringEventId ? String(ev.recurringEventId) : null},
         ${ownerEmail}, ${String(ev.summary ?? "").slice(0, 300)},
         ${starts}, ${eventTime(ev.end)}, ${sql.json(attendees as never)},
         ${String(ev.status ?? "confirmed")}, ${conferenceUrl(ev)}, ${ownerEmail})
      on conflict (provider_event_key) do update set
        series_key = excluded.series_key,
        title = excluded.title,
        starts_at = excluded.starts_at,
        ends_at = excluded.ends_at,
        attendees = excluded.attendees,
        status = excluded.status,
        conference_url = excluded.conference_url,
        sync_token_owner = excluded.sync_token_owner,
        updated_at = now()
      where calendar_events.title is distinct from excluded.title
         or calendar_events.starts_at is distinct from excluded.starts_at
         or calendar_events.ends_at is distinct from excluded.ends_at
         or calendar_events.attendees is distinct from excluded.attendees
         or calendar_events.status is distinct from excluded.status
         or calendar_events.conference_url is distinct from excluded.conference_url
         or calendar_events.series_key is distinct from excluded.series_key
      returning id
    `
  );
  return rows[0]?.id ?? null;
}

/* ── Deal matching ─────────────────────────────────────────────────────────── */

/**
 * The open pipeline plus founder emails, from two sources: the canonical
 * founder links (network_people carries email/alt_emails now) and EXTERNAL
 * senders of the deal's inbound mail. Internal addresses are excluded from
 * the evidence pool entirely — a partner forwarding a pitch must never
 * become "founder evidence" that glues the partner's every meeting to that
 * deal (the failure mode: a weekly with another firm matched to a deal
 * "by attendee alex@example.com").
 */
async function loadMatchableDeals(): Promise<CalendarMatchDeal[]> {
  // The ONE evidence service (identityEvidence.ts) — this matcher must never
  // grow a private pool copy again. DealEvidencePool is a superset of
  // CalendarMatchDeal; the extra fields are simply unused here.
  return loadDealEvidencePools();
}

/** Match freshly-synced external meetings; returns how many got a deal. */
async function matchEvents(
  eventIds: string[],
  deals: CalendarMatchDeal[]
): Promise<number> {
  if (eventIds.length === 0 || deals.length === 0) return 0;
  const rows = await withRetry(
    () => sql<
      { id: string; title: string | null; attendees: CalendarAttendee[] }[]
    >`
      select id, title, attendees from calendar_events
      where id = any (${sql.array(eventIds)}::uuid[])
        and matched_deal_gid is null
        and status <> 'cancelled'
    `
  );
  let matched = 0;
  for (const row of rows) {
    const attendees = Array.isArray(row.attendees) ? row.attendees : [];
    if (!isExternalMeeting(attendees, INTERNAL_DOMAINS)) continue;
    const match = matchEvidence({ title: row.title, attendees }, deals);
    if (!match || match.confidence < 0.75) continue;
    await withRetry(
      () => sql`
        update calendar_events
        set matched_deal_gid = ${match.dealGid},
            match_confidence = ${match.confidence},
            match_evidence = ${sql.json(match.evidence as never)},
            updated_at = now()
        where id = ${row.id}
      `
    );
    matched++;
  }
  return matched;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/* ── Sync driver ───────────────────────────────────────────────────────────── */

export interface CalendarSyncCounts {
  events: number;
  matched: number;
  errors: number;
}

/** One member's calendar. Never throws — failures land in `errors`. */
export async function syncCalendarForMember(
  email: string
): Promise<CalendarSyncCounts> {
  const counts: CalendarSyncCounts = { events: 0, matched: 0, errors: 0 };
  const t0 = Date.now();
  const owner = email.toLowerCase();
  try {
    await ensureCalendarSchema();
    const conn = await getGoogleConnection(owner);
    if (!conn) return counts; // not connected — silent skip
    const token = await calendarAccessTokenFor(conn);

    const stateRows = await withRetry(
      () => sql<
        {
          sync_token: string | null;
          last_full_sync_at: Date | null;
          full_sync_page_token: string | null;
        }[]
      >`
        select sync_token, last_full_sync_at, full_sync_page_token
          from calendar_sync_state where owner_email = ${owner}
      `
    );
    // Re-baseline every quarter. Incremental sync is cheap but only sees what
    // Google reports; a meeting edited outside that stream, or missed during
    // an outage, would stay wrong indefinitely. Dropping the token forces a
    // full re-read of the whole window. A never-stamped last-full must NOT
    // discard a working token — that re-upserted the window every cron tick.
    const lastFull = stateRows[0]?.last_full_sync_at ?? null;
    const dueForFull = calendarNeedsFullResync(
      lastFull,
      Date.now(),
      FULL_RESYNC_EVERY_DAYS
    );
    const storedToken = dueForFull ? null : stateRows[0]?.sync_token ?? null;
    let windowed = storedToken == null;
    const resumePage = windowed
      ? stateRows[0]?.full_sync_page_token ?? null
      : null;
    if (dueForFull && !resumePage) {
      logEvent("info", "calendar", "quarterly re-baseline", { owner });
    }

    let listed: Awaited<ReturnType<typeof listEvents>>;
    try {
      listed = await listEvents(token, storedToken, resumePage);
    } catch (err) {
      if (!(err instanceof SyncTokenGoneError)) throw err;
      // Google expired the token: wipe it and re-baseline the window.
      await withRetry(
        () => sql`
          update calendar_sync_state
          set sync_token = null, full_sync_page_token = null, updated_at = now()
          where owner_email = ${owner}
        `
      );
      windowed = true;
      listed = await listEvents(token, null, null);
    }

    const upsertedIds: string[] = [];
    for (const ev of listed.items) {
      try {
        const id = await upsertEvent(owner, ev);
        counts.events++;
        if (id) upsertedIds.push(id);
      } catch (err) {
        counts.errors++;
        logError("calendar", "event upsert failed", err, {
          owner,
          event: String(ev?.id ?? ""),
        });
      }
    }

    if (upsertedIds.length > 0) {
      try {
        const deals = await loadMatchableDeals();
        counts.matched = await matchEvents(upsertedIds, deals);
      } catch (err) {
        counts.errors++;
        logError("calendar", "deal matching failed", err, { owner });
      }
    }

    // Incomplete windowed baseline: keep the page cursor, retry next run.
    // Finished pull: store Google's syncToken and (if this was a baseline)
    // stamp last_full so we don't throw the token away next tick.
    if (counts.errors === 0 && listed.nextPageToken && windowed) {
      await withRetry(
        () => sql`
          insert into calendar_sync_state
            (owner_email, sync_token, full_sync_page_token, updated_at)
          values (${owner}, null, ${listed.nextPageToken}, now())
          on conflict (owner_email) do update
            set full_sync_page_token = excluded.full_sync_page_token,
                updated_at = now()
        `
      );
    } else if (listed.nextSyncToken && counts.errors === 0) {
      await withRetry(
        () => sql`
          insert into calendar_sync_state
            (owner_email, sync_token, updated_at, last_full_sync_at, full_sync_page_token)
          values (
            ${owner}, ${listed.nextSyncToken}, now(),
            now(), null
          )
          on conflict (owner_email) do update
            set sync_token = excluded.sync_token,
                updated_at = now(),
                full_sync_page_token = null,
                last_full_sync_at = case
                  when ${windowed} then now()
                  else coalesce(calendar_sync_state.last_full_sync_at, now())
                end
        `
      );
    }

    logEvent(
      "info",
      "calendar",
      "sync done",
      { owner, ...counts },
      Date.now() - t0
    );
  } catch (err) {
    counts.errors++;
    logError("calendar", "sync failed", err, { owner });
  }
  return counts;
}

/** Cron sweep over every legacy Google grant (they carry calendar.readonly). */
export async function syncAllCalendars(): Promise<CalendarSyncCounts> {
  const totals: CalendarSyncCounts = { events: 0, matched: 0, errors: 0 };
  let owners: { email: string }[] = [];
  try {
    await ensureCalendarSchema();
    owners = await withRetry(
      () => sql<{ email: string }[]>`
        select email from google_connections
        where scopes like '%calendar.readonly%'
        order by connected_at
      `
    );
  } catch (err) {
    logError("calendar", "listing connections failed", err);
    totals.errors++;
    return totals;
  }
  for (const o of owners) {
    const r = await syncCalendarForMember(o.email);
    totals.events += r.events;
    totals.matched += r.matched;
    totals.errors += r.errors;
  }
  return totals;
}
