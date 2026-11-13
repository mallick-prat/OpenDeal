import "server-only";
import { sql } from "./db";
import { logError, logEvent } from "./log";

/**
 * ── Google interaction index (Relationship Agent, Agent 5) ──────────────────
 * Incrementally syncs Calendar event metadata and Gmail message HEADERS into
 * `network_interactions`. Metadata only — never message bodies. Requires a
 * per-user Google connection made via /api/google/connect with scopes:
 *   https://www.googleapis.com/auth/calendar.readonly
 *   https://www.googleapis.com/auth/gmail.metadata
 *
 * Caps keep the first sync cheap: 500 calendar events (3 years back),
 * 300 recent gmail messages. Reruns upsert (unique source+external_id).
 */

const CAL_SCOPE = "https://www.googleapis.com/auth/calendar.readonly";
const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.metadata";
export const GOOGLE_SCOPES = `${CAL_SCOPE} ${GMAIL_SCOPE}`;

export interface GoogleConnection {
  email: string;
  refresh_token: string;
  scopes: string;
  connected_at: Date;
  last_synced_at: Date | null;
  sync_stats: Record<string, unknown>;
}

export async function getGoogleConnection(
  email: string
): Promise<GoogleConnection | null> {
  const rows = await sql<GoogleConnection[]>`
    select * from google_connections where email = ${email.toLowerCase()}
  `;
  return rows[0] ?? null;
}

export async function saveGoogleConnection(
  email: string,
  refreshToken: string,
  scopes: string
): Promise<void> {
  await sql`
    insert into google_connections (email, refresh_token, scopes)
    values (${email.toLowerCase()}, ${refreshToken}, ${scopes})
    on conflict (email) do update
      set refresh_token = excluded.refresh_token,
          scopes = excluded.scopes,
          connected_at = now()
  `;
}

export async function accessTokenFor(conn: GoogleConnection): Promise<string> {
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
    throw new Error(`Google token refresh ${res.status}: ${(await res.text()).slice(0, 150)}`);
  const data = (await res.json()) as { access_token?: string };
  if (!data.access_token) throw new Error("No access token returned.");
  return data.access_token;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
async function gapi(token: string, url: string): Promise<any> {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`Google API ${res.status} for ${url.split("?")[0]}`);
  return res.json();
}

async function syncCalendar(token: string): Promise<number> {
  const timeMin = new Date(Date.now() - 3 * 365 * 86400_000).toISOString();
  let pageToken = "";
  let stored = 0;
  for (let page = 0; page < 2; page++) {
    const data = await gapi(
      token,
      `https://www.googleapis.com/calendar/v3/calendars/primary/events?maxResults=250&singleEvents=true&orderBy=startTime&timeMin=${encodeURIComponent(timeMin)}${pageToken ? `&pageToken=${pageToken}` : ""}`
    );
    for (const ev of data.items ?? []) {
      const start = ev.start?.dateTime ?? (ev.start?.date ? `${ev.start.date}T12:00:00Z` : null);
      if (!ev.id || !start) continue;
      const participants = [
        ...(ev.organizer ? [{ name: ev.organizer.displayName ?? "", email: ev.organizer.email ?? "" }] : []),
        ...((ev.attendees ?? []).map((a: any) => ({
          name: a.displayName ?? "",
          email: a.email ?? "",
          status: a.responseStatus ?? "",
        }))),
      ].slice(0, 40);
      await sql`
        insert into network_interactions (source, external_id, occurred_at, participants, title, snippet, metadata)
        values ('calendar', ${ev.id}, ${start}, ${sql.json(participants)},
                ${String(ev.summary ?? "").slice(0, 200)},
                ${String(ev.location ?? "").slice(0, 200)},
                ${sql.json({ end: ev.end?.dateTime ?? null })})
        on conflict (source, external_id) do nothing
      `;
      stored++;
    }
    pageToken = data.nextPageToken ?? "";
    if (!pageToken) break;
  }
  return stored;
}

function header(msg: any, name: string): string {
  const h = (msg.payload?.headers ?? []).find(
    (x: any) => x?.name?.toLowerCase() === name.toLowerCase()
  );
  return String(h?.value ?? "");
}

/** "Ada Lovelace <ada@x.com>, bob@y.com" → [{name, email}] */
export function parseAddressList(raw: string): { name: string; email: string }[] {
  return raw
    .split(",")
    .map((part) => {
      const m = part.match(/^\s*(?:"?([^"<]*)"?\s*)?<([^>]+)>\s*$/);
      if (m) return { name: (m[1] ?? "").trim(), email: m[2].trim().toLowerCase() };
      const bare = part.trim();
      return bare.includes("@") ? { name: "", email: bare.toLowerCase() } : null;
    })
    .filter((x): x is { name: string; email: string } => !!x)
    .slice(0, 20);
}

async function syncGmail(token: string): Promise<number> {
  let stored = 0;
  const list = await gapi(
    token,
    "https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=300"
  );
  for (const stub of (list.messages ?? []).slice(0, 300)) {
    // Skip already-indexed messages before spending a metadata call.
    const seen = await sql<{ id: string }[]>`
      select id from network_interactions
      where source = 'gmail' and external_id = ${stub.id}
    `;
    if (seen.length > 0) continue;
    const msg = await gapi(
      token,
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${stub.id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Cc&metadataHeaders=Subject&metadataHeaders=Date`
    );
    const date = Number(msg.internalDate);
    if (!date) continue;
    const participants = [
      ...parseAddressList(header(msg, "From")),
      ...parseAddressList(header(msg, "To")),
      ...parseAddressList(header(msg, "Cc")),
    ].slice(0, 30);
    await sql`
      insert into network_interactions (source, external_id, occurred_at, participants, title, snippet, metadata)
      values ('gmail', ${msg.id}, ${new Date(date).toISOString()},
              ${sql.json(participants)},
              ${header(msg, "Subject").slice(0, 200)},
              ${String(msg.snippet ?? "").slice(0, 200)},
              ${sql.json({ thread: msg.threadId ?? null })})
      on conflict (source, external_id) do nothing
    `;
    stored++;
  }
  return stored;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** Sync one member's Google account into the interaction index. */
export async function syncGoogle(
  email: string
): Promise<{ calendar: number; gmail: number }> {
  const t0 = Date.now();
  const conn = await getGoogleConnection(email);
  if (!conn) throw new Error("Google isn't connected for this account.");
  const token = await accessTokenFor(conn);
  let calendar = 0;
  let gmail = 0;
  try {
    calendar = await syncCalendar(token);
  } catch (err) {
    logError("google", "calendar sync failed", err, { email });
  }
  try {
    gmail = await syncGmail(token);
  } catch (err) {
    logError("google", "gmail sync failed", err, { email });
  }
  await sql`
    update google_connections
    set last_synced_at = now(),
        sync_stats = ${sql.json({ calendar, gmail, last_ms: Date.now() - t0 })}
    where email = ${email.toLowerCase()}
  `;
  logEvent("info", "google", "interaction sync done", { email, calendar, gmail }, Date.now() - t0);
  return { calendar, gmail };
}

export async function interactionCounts(): Promise<{ calendar: number; gmail: number }> {
  const rows = await sql<{ source: string; n: number }[]>`
    select source, count(*)::int as n from network_interactions group by source
  `;
  return {
    calendar: rows.find((r) => r.source === "calendar")?.n ?? 0,
    gmail: rows.find((r) => r.source === "gmail")?.n ?? 0,
  };
}
