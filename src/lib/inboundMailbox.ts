import "server-only";
import { sql } from "./db";
import { crm } from "@/config/crm.config";

/**
 * ── Inbound sourcing mailbox (e.g. deals@yourfund.com) ───────────────────────
 * A single shared mailbox, OAuth'd once with Gmail readonly + modify so the
 * ingestion cron can read message BODIES and ATTACHMENTS (the per-member
 * Network connection is metadata-only and lives in google_connections; this is
 * deliberately separate so the shared inbox never rides the Network sync).
 *
 * modify is used only to stamp a "processed" label on messages we've ingested,
 * so a human filter can see the ingest trail and we double-guard re-processing.
 */

const READONLY = "https://www.googleapis.com/auth/gmail.readonly";
const MODIFY = "https://www.googleapis.com/auth/gmail.modify";
export const INBOUND_SCOPES = `${READONLY} ${MODIFY}`;
/** Gmail label stamped on messages we have ingested. */
export const PROCESSED_LABEL = "CRM/Ingested";

/**
 * The mailbox address to poll (NEXT_PUBLIC_INBOUND_MAILBOX, or the older
 * INBOUND_MAILBOX). May be "" when none is configured: callers treat that as
 * "the inbound inbox is switched off", never as an address to poll.
 */
export function inboundAddress(): string {
  return crm.inbound.address;
}

/** Is an inbound mailbox configured at all? */
export function inboundConfigured(): boolean {
  return crm.inbound.address !== "";
}

/**
 * Is this address the inbound mailbox itself? Always false when none is
 * configured: a bare `a === inboundAddress()` would otherwise match every
 * empty/missing sender against the empty string.
 */
export function isInboundAddress(email: string | null | undefined): boolean {
  const a = crm.inbound.address;
  return a !== "" && (email ?? "").trim().toLowerCase() === a;
}

export interface InboundMailbox {
  email: string;
  refresh_token: string;
  scopes: string;
  history_id: string | null;
  last_polled_at: Date | null;
  connected_at: Date;
  connected_by: string | null;
  poll_stats: Record<string, unknown>;
}

export async function getInboundMailbox(): Promise<InboundMailbox | null> {
  try {
    const rows = await sql<InboundMailbox[]>`
      select * from inbound_mailboxes where email = ${inboundAddress()}
    `;
    return rows[0] ?? null;
  } catch {
    // Table not created yet (no cron/connect has run) — treat as unconnected.
    return null;
  }
}

export async function saveInboundMailbox(
  email: string,
  refreshToken: string,
  scopes: string,
  connectedBy: string
): Promise<void> {
  await sql`
    insert into inbound_mailboxes (email, refresh_token, scopes, connected_by)
    values (${email.toLowerCase()}, ${refreshToken}, ${scopes}, ${connectedBy})
    on conflict (email) do update
      set refresh_token = excluded.refresh_token,
          scopes = excluded.scopes,
          connected_by = excluded.connected_by,
          connected_at = now()
  `;
}

export async function deleteInboundMailbox(): Promise<void> {
  await sql`delete from inbound_mailboxes where email = ${inboundAddress()}`;
}

export async function recordPoll(
  historyId: string | null,
  stats: Record<string, unknown>
): Promise<void> {
  await sql`
    update inbound_mailboxes
    set last_polled_at = now(),
        history_id = coalesce(${historyId}, history_id),
        poll_stats = ${sql.json(stats as never)}
    where email = ${inboundAddress()}
  `;
}

/** Exchange the stored refresh token for a short-lived access token. */
export async function inboundAccessToken(conn: InboundMailbox): Promise<string> {
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
      `Gmail token refresh ${res.status}: ${(await res.text()).slice(0, 150)}`
    );
  const data = (await res.json()) as { access_token?: string };
  if (!data.access_token) throw new Error("No access token returned.");
  return data.access_token;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
async function gmail(token: string, path: string): Promise<any> {
  const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(25_000),
  });
  if (!res.ok)
    throw new Error(`Gmail API ${res.status} for ${path.split("?")[0]}`);
  return res.json();
}

async function gmailPost(token: string, path: string, body: unknown): Promise<any> {
  const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok)
    throw new Error(`Gmail API ${res.status} for ${path.split("?")[0]}`);
  return res.json();
}

export interface GmailMessage {
  id: string;
  threadId: string;
  internalDate: string;
  snippet: string;
  payload: any;
}

/** Recent INBOX message ids, newest first, primary category only. */
export async function listInboxMessageIds(
  token: string,
  max: number
): Promise<string[]> {
  const q = encodeURIComponent("in:inbox newer_than:14d -category:promotions -category:social");
  const data = await gmail(
    token,
    `/messages?maxResults=${max}&labelIds=INBOX&q=${q}`
  );
  return (data.messages ?? []).map((m: any) => m.id as string);
}

export async function getFullMessage(
  token: string,
  id: string
): Promise<GmailMessage> {
  return gmail(token, `/messages/${id}?format=full`);
}

/** Message ids for an arbitrary Gmail search, newest first. */
export async function searchMessageIds(
  token: string,
  query: string,
  max: number
): Promise<string[]> {
  const data = await gmail(
    token,
    `/messages?maxResults=${max}&q=${encodeURIComponent(query)}`
  );
  return (data.messages ?? []).map((m: any) => m.id as string);
}

/** Base64url-encoded attachment bytes. */
export async function getAttachment(
  token: string,
  messageId: string,
  attachmentId: string
): Promise<Buffer> {
  const data = await gmail(
    token,
    `/messages/${messageId}/attachments/${attachmentId}`
  );
  const b64 = String(data.data ?? "").replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(b64, "base64");
}

/** Get-or-create the ingest label, returning its id. */
export async function ensureProcessedLabel(token: string): Promise<string> {
  const list = await gmail(token, "/labels");
  const existing = (list.labels ?? []).find(
    (l: any) => l.name === PROCESSED_LABEL
  );
  if (existing) return existing.id as string;
  const created = await gmailPost(token, "/labels", {
    name: PROCESSED_LABEL,
    labelListVisibility: "labelShow",
    messageListVisibility: "show",
  });
  return created.id as string;
}

export async function labelMessage(
  token: string,
  messageId: string,
  labelId: string
): Promise<void> {
  await gmailPost(token, `/messages/${messageId}/modify`, {
    addLabelIds: [labelId],
  });
}

/* ── Real-time watch (Gmail push over Pub/Sub) ─────────────────────────────── */

export interface WatchResult {
  historyId: string;
  expiration: string; // epoch ms as string
}

/** Register the mailbox for push notifications to GMAIL_PUBSUB_TOPIC. */
export async function startGmailWatch(token: string): Promise<WatchResult> {
  const topic = process.env.GMAIL_PUBSUB_TOPIC;
  if (!topic) throw new Error("GMAIL_PUBSUB_TOPIC not set");
  const data = await gmailPost(token, "/watch", {
    topicName: topic,
    labelIds: ["INBOX"],
    labelFilterBehavior: "include",
  });
  return { historyId: String(data.historyId ?? ""), expiration: String(data.expiration ?? "") };
}

export async function stopGmailWatch(token: string): Promise<void> {
  await gmailPost(token, "/stop", {});
}

export async function saveWatchState(historyId: string, expiration: string): Promise<void> {
  await sql`
    update inbound_mailboxes
    set history_id = ${historyId || null},
        poll_stats = poll_stats || ${sql.json({ watch_expiration: expiration } as never)}
    where email = ${inboundAddress()}
  `;
}

export async function saveHistoryId(historyId: string): Promise<void> {
  if (!historyId) return;
  await sql`
    update inbound_mailboxes set history_id = ${historyId} where email = ${inboundAddress()}
  `;
}

export class HistoryTooOldError extends Error {}

/**
 * Message ids added to INBOX since `startHistoryId`. Throws HistoryTooOldError
 * if Gmail has expired that watermark (caller should do a full backfill).
 */
export async function listHistoryMessageIds(
  token: string,
  startHistoryId: string
): Promise<{ ids: string[]; latestHistoryId: string }> {
  const ids = new Set<string>();
  let pageToken = "";
  let latest = startHistoryId;
  for (let page = 0; page < 10; page++) {
    const qs = new URLSearchParams({
      startHistoryId,
      historyTypes: "messageAdded",
      labelId: "INBOX",
      maxResults: "200",
    });
    if (pageToken) qs.set("pageToken", pageToken);
    const res = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/history?${qs.toString()}`,
      { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(25_000) }
    );
    if (res.status === 404) throw new HistoryTooOldError("history watermark expired");
    if (!res.ok) throw new Error(`Gmail history ${res.status}`);
    const data = await res.json();
    if (data.historyId) latest = String(data.historyId);
    for (const h of data.history ?? []) {
      for (const m of h.messagesAdded ?? []) {
        const msg = m.message;
        if (msg?.id && (msg.labelIds ?? []).includes("INBOX")) ids.add(msg.id);
      }
    }
    pageToken = data.nextPageToken ?? "";
    if (!pageToken) break;
  }
  return { ids: [...ids], latestHistoryId: latest };
}
/* eslint-enable @typescript-eslint/no-explicit-any */
