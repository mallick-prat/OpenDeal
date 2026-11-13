import "server-only";
import { sql } from "./db";
import { withRetry } from "./retry";
import { logError, logEvent } from "./log";
import { encryptToken, decryptToken } from "./tokenCrypt";
import { shouldExcludeMessage } from "./mailFilters";
import { parseFrom, parseGmailMessage } from "./emailParse";
import { parseAddressList } from "./googleSync";
import { HistoryTooOldError } from "./inboundMailbox";

/**
 * ── Personal-inbox Gmail sync (PR-05) ────────────────────────────────────────
 * Per-member gmail.readonly connections feed a shared thread/message store so
 * pitches sent to a partner's own address can enter the intelligence layer.
 * Deliberately separate from BOTH the shared deals@ pipeline (inbound*.ts —
 * untouched) and the metadata-only Network sync (googleSync.ts).
 *
 * Privacy posture: refresh tokens are AES-GCM-encrypted at rest (tokenCrypt),
 * rows default to visibility 'restricted', and deterministic pre-filters
 * (mailFilters) keep newsletters/receipts/calendar noise out entirely — their
 * bodies are never even fetched (format=metadata first, format=full only for
 * messages that pass).
 */

// readonly feeds the sync; send lets pass notes go out AS the member.
// Existing readonly-only connections keep syncing; sending as yourself
// needs a one-time reconnect that grants the second scope.
export const MAIL_SCOPE =
  "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send";

/* ── Schema ────────────────────────────────────────────────────────────────── */

let schemaReady = false;
/** Mirrors sql/013_mail.sql; kept in-sync by review. */
export async function ensureMailSchema(): Promise<void> {
  if (schemaReady) return;
  await sql`
    create table if not exists mailbox_connections (
      id                 uuid primary key default gen_random_uuid(),
      kind               text not null default 'personal',
      address            text not null,
      user_email         text not null,
      refresh_token_enc  text not null,
      scopes             text not null default '',
      sync_cursor        text,
      status             text not null default 'ok',
      error              text,
      last_synced_at     timestamptz,
      connected_at       timestamptz not null default now(),
      unique (address, user_email)
    )
  `;
  await sql`
    create table if not exists email_threads (
      id                  uuid primary key default gen_random_uuid(),
      provider_thread_key text not null unique,
      subject_norm        text,
      first_message_at    timestamptz,
      last_message_at     timestamptz,
      participants        jsonb not null default '[]',
      classification      text,
      company_id          uuid,
      deal_gid            text,
      visibility          text not null default 'restricted'
    )
  `;
  await sql`
    create table if not exists email_messages (
      id                   uuid primary key default gen_random_uuid(),
      thread_id            uuid not null references email_threads(id) on delete cascade,
      provider_message_key text not null unique,
      connection_ids       uuid[] not null default '{}',
      direction            text not null default 'inbound',
      from_addr            jsonb,
      to_addrs             jsonb not null default '[]',
      cc_addrs             jsonb not null default '[]',
      sent_at              timestamptz,
      snippet              text,
      body_text            text,
      headers              jsonb not null default '{}',
      visibility           text not null default 'restricted'
    )
  `;
  await sql`
    create index if not exists email_messages_thread_sent_idx
      on email_messages (thread_id, sent_at)
  `;
  await sql`
    create index if not exists email_threads_last_message_idx
      on email_threads (last_message_at desc)
  `;
  await sql`
    create index if not exists mailbox_connections_user_idx
      on mailbox_connections (user_email)
  `;
  schemaReady = true;
}

/* ── Connection CRUD ───────────────────────────────────────────────────────── */

export interface MailConnection {
  id: string;
  kind: string;
  address: string;
  user_email: string;
  refresh_token_enc: string;
  scopes: string;
  sync_cursor: string | null;
  status: string;
  error: string | null;
  last_synced_at: Date | null;
  connected_at: Date;
}

/** Upsert a personal connection; the raw token is encrypted before storage. */
export async function saveMailConnection(
  address: string,
  userEmail: string,
  refreshToken: string,
  scopes: string
): Promise<void> {
  await ensureMailSchema();
  const enc = encryptToken(refreshToken);
  await withRetry(
    () => sql`
      insert into mailbox_connections (kind, address, user_email, refresh_token_enc, scopes)
      values ('personal', ${address.toLowerCase()}, ${userEmail.toLowerCase()}, ${enc}, ${scopes})
      on conflict (address, user_email) do update
        set refresh_token_enc = excluded.refresh_token_enc,
            scopes = excluded.scopes,
            status = 'ok',
            error = null,
            connected_at = now()
    `
  );
}

/** The member's personal connection id (tokens never leave this module). */
export async function personalConnectionIdFor(
  userEmail: string
): Promise<string | null> {
  try {
    const rows = await withRetry(
      () => sql<{ id: string }[]>`
        select id from mailbox_connections
        where user_email = ${userEmail.toLowerCase()} and kind = 'personal'
        order by connected_at desc
        limit 1
      `
    );
    return rows[0]?.id ?? null;
  } catch {
    return null; // table not created yet — treat as unconnected
  }
}

/** Token-free view for the settings card. */
export interface MailConnectionOverview {
  address: string;
  status: string;
  error: string | null;
  last_synced_at: Date | null;
  connected_at: Date;
  /** Granted OAuth scopes — sending pass notes needs gmail.send. */
  scopes: string;
}

/** Can this connection send mail as its owner? */
export function scopesAllowSend(scopes: string): boolean {
  return /gmail\.(send|modify)|mail\.google\.com/.test(scopes);
}

export async function mailConnectionOverview(
  userEmail: string
): Promise<MailConnectionOverview | null> {
  try {
    const rows = await withRetry(
      () => sql<MailConnectionOverview[]>`
        select address, status, error, last_synced_at, connected_at, scopes
        from mailbox_connections
        where user_email = ${userEmail.toLowerCase()} and kind = 'personal'
        order by connected_at desc
        limit 1
      `
    );
    return rows[0] ?? null;
  } catch {
    return null; // table not created yet — treat as unconnected
  }
}

export async function mailCounts(
  userEmail: string
): Promise<{ messages: number; threads: number }> {
  try {
    const rows = await withRetry(
      () => sql<{ messages: number; threads: number }[]>`
        select count(*)::int as messages,
               count(distinct m.thread_id)::int as threads
        from email_messages m
        join mailbox_connections c on c.id = any (m.connection_ids)
        where c.user_email = ${userEmail.toLowerCase()}
      `
    );
    return rows[0] ?? { messages: 0, threads: 0 };
  } catch {
    return { messages: 0, threads: 0 };
  }
}

async function markReauthNeeded(id: string, why: string): Promise<void> {
  try {
    await withRetry(
      () => sql`
        update mailbox_connections
        set status = 'reauth_needed', error = ${why.slice(0, 300)}
        where id = ${id}
      `
    );
  } catch (err) {
    logError("mail", "marking connection reauth_needed failed", err, { id });
  }
}

/* ── Gmail REST ────────────────────────────────────────────────────────────── */

/**
 * Short-lived access token for a connection, or null when the grant is gone
 * (revoked/expired refresh token, unreadable ciphertext). The null path marks
 * the connection reauth_needed and NEVER throws — sync just skips it.
 */
export async function gmailAccessTokenFor(
  conn: MailConnection
): Promise<string | null> {
  const refreshToken = decryptToken(conn.refresh_token_enc);
  if (!refreshToken) {
    await markReauthNeeded(conn.id, "stored token unreadable — reconnect");
    return null;
  }
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.AUTH_GOOGLE_ID!,
      client_secret: process.env.AUTH_GOOGLE_SECRET!,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const data = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    error?: string;
  };
  if (!res.ok) {
    if (data.error === "invalid_grant") {
      await markReauthNeeded(conn.id, "Google revoked the grant — reconnect");
      return null;
    }
    throw new Error(`Gmail token refresh ${res.status}: ${data.error ?? ""}`);
  }
  if (!data.access_token) throw new Error("No access token returned.");
  return data.access_token;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
async function gmail(token: string, path: string): Promise<any> {
  const res = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me${path}`,
    {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(20_000),
    }
  );
  if (res.status === 404 && path.startsWith("/history"))
    throw new HistoryTooOldError("history watermark expired");
  if (!res.ok)
    throw new Error(`Gmail API ${res.status} for ${path.split("?")[0]}`);
  return res.json();
}

/**
 * Message ids added since the cursor. No labelId filter on purpose: unlike
 * the deals@ ingest (INBOX-only), the personal sync wants SENT mail too so
 * outbound replies land in the thread. Spam/trash/drafts are skipped.
 */
async function listHistoryIds(
  token: string,
  startHistoryId: string,
  max: number
): Promise<{ ids: string[]; latestHistoryId: string }> {
  const ids = new Set<string>();
  let pageToken = "";
  let latest = startHistoryId;
  for (let page = 0; page < 10; page++) {
    const qs = new URLSearchParams({
      startHistoryId,
      historyTypes: "messageAdded",
      maxResults: "100",
    });
    if (pageToken) qs.set("pageToken", pageToken);
    const data = await gmail(token, `/history?${qs.toString()}`);
    if (data.historyId) latest = String(data.historyId);
    for (const h of data.history ?? []) {
      for (const m of h.messagesAdded ?? []) {
        const message = m.message;
        if (!message?.id) continue;
        const labels: string[] = message.labelIds ?? [];
        if (
          labels.includes("SPAM") ||
          labels.includes("TRASH") ||
          labels.includes("DRAFT")
        )
          continue;
        ids.add(message.id);
      }
    }
    pageToken = data.nextPageToken ?? "";
    if (!pageToken || ids.size >= max) break;
  }
  return { ids: [...ids].slice(0, max), latestHistoryId: latest };
}

/** Windowed re-baseline when there's no cursor or Gmail expired it. */
async function baselineIds(token: string, max: number): Promise<string[]> {
  const q = encodeURIComponent("newer_than:30d -in:chats");
  const data = await gmail(
    token,
    `/messages?maxResults=${Math.min(max, 100)}&q=${q}`
  );
  return (data.messages ?? []).map((m: any) => m.id as string).slice(0, max);
}

async function profileHistoryId(token: string): Promise<string | null> {
  const data = await gmail(token, "/profile");
  return data.historyId ? String(data.historyId) : null;
}

/* ── Message persistence ───────────────────────────────────────────────────── */

const META_HEADERS = [
  "From",
  "To",
  "Cc",
  "Subject",
  "Date",
  "List-Id",
  "List-Unsubscribe",
  "Precedence",
  "Message-Id",
  "Content-Type",
];

function headerRecord(payload: any): Record<string, string> {
  const rec: Record<string, string> = {};
  for (const h of payload?.headers ?? []) {
    if (h?.name) rec[String(h.name)] = String(h.value ?? "");
  }
  return rec;
}

function headerOf(rec: Record<string, string>, name: string): string {
  const want = name.toLowerCase();
  for (const [k, v] of Object.entries(rec)) {
    if (k.toLowerCase() === want) return v;
  }
  return "";
}

function normalizeSubject(subject: string): string | null {
  const norm = subject
    .replace(/^\s*(?:(?:re|fwd?|fw)\s*:\s*)+/i, "")
    .trim()
    .toLowerCase()
    .slice(0, 300);
  return norm || null;
}

/**
 * Fetch headers, filter, then (only if kept) fetch the full body and upsert
 * thread + message. Returns 'synced' | 'excluded'.
 */
async function ingestMessage(
  conn: MailConnection,
  token: string,
  messageId: string
): Promise<"synced" | "excluded"> {
  const metaQs = META_HEADERS.map((h) => `metadataHeaders=${h}`).join("&");
  const meta = await gmail(
    token,
    `/messages/${messageId}?format=metadata&${metaQs}`
  );
  const headers = headerRecord(meta.payload);
  const fromRaw = headerOf(headers, "From");
  const subject = headerOf(headers, "Subject");

  const verdict = shouldExcludeMessage({ headers, from: fromRaw, subject });
  if (verdict.exclude) return "excluded";

  // Body only for messages that passed the pre-filters.
  const full = await gmail(token, `/messages/${messageId}?format=full`);
  const parsed = parseGmailMessage(full);

  const fromAddr = parseFrom(fromRaw);
  const toAddrs = parseAddressList(headerOf(headers, "To"));
  const ccAddrs = parseAddressList(headerOf(headers, "Cc"));
  const direction =
    fromAddr.email === conn.address.toLowerCase() ? "outbound" : "inbound";
  const participants = [
    ...(fromAddr.email ? [fromAddr] : []),
    ...toAddrs,
    ...ccAddrs,
  ].slice(0, 30);

  const internal = Number(full.internalDate ?? meta.internalDate);
  const headerDate = Date.parse(headerOf(headers, "Date"));
  const sentAt = internal
    ? new Date(internal).toISOString()
    : Number.isFinite(headerDate)
      ? new Date(headerDate).toISOString()
      : null;

  const threadKey = String(full.threadId ?? meta.threadId ?? messageId);

  const threadRows = await withRetry(
    () => sql<{ id: string }[]>`
      insert into email_threads
        (provider_thread_key, subject_norm, first_message_at, last_message_at, participants)
      values
        (${threadKey}, ${normalizeSubject(subject)}, ${sentAt}, ${sentAt},
         ${sql.json(participants as never)})
      on conflict (provider_thread_key) do update set
        subject_norm = coalesce(email_threads.subject_norm, excluded.subject_norm),
        first_message_at = least(email_threads.first_message_at, excluded.first_message_at),
        last_message_at = greatest(email_threads.last_message_at, excluded.last_message_at),
        participants = (
          select coalesce(jsonb_agg(distinct p), '[]'::jsonb)
          from jsonb_array_elements(email_threads.participants || excluded.participants) as p
        )
      returning id
    `
  );
  const threadId = threadRows[0].id;

  await withRetry(
    () => sql`
      insert into email_messages
        (thread_id, provider_message_key, connection_ids, direction,
         from_addr, to_addrs, cc_addrs, sent_at, snippet, body_text, headers)
      values
        (${threadId}, ${messageId}, ${sql.array([conn.id])}::uuid[], ${direction},
         ${sql.json(fromAddr as never)}, ${sql.json(toAddrs as never)},
         ${sql.json(ccAddrs as never)}, ${sentAt},
         ${String(full.snippet ?? "").slice(0, 400)},
         ${parsed.bodyText.slice(0, 40_000)}, ${sql.json(headers as never)})
      on conflict (provider_message_key) do update set
        connection_ids = array(
          select distinct unnest(email_messages.connection_ids || excluded.connection_ids)
        )
    `
  );

  // Deal-looking inbound mail mints a RESTRICTED candidate through the same
  // pipeline as the shared mailbox (idempotent on the Gmail message id, so a
  // pitch CC'd to deals@ never doubles up). Deterministic gate before any AI.
  if (direction === "inbound") {
    const { looksDealRelated } = await import("./mailFilters");
    const { findDeckLinks } = await import("./emailParse");
    const hasDeckLink = findDeckLinks(`${subject}\n${parsed.bodyText}`).length > 0;
    if (
      looksDealRelated(subject, parsed.bodyText, {
        hasAttachment: parsed.attachments.length > 0,
        hasDeckLink,
      })
    ) {
      try {
        const { ingestWebhookEmail } = await import("./inbound");
        await ingestWebhookEmail({
          messageId,
          // The thread id must ride along or the reply-attach rule is blind
          // on this path — six copies of one pitch proved it the hard way.
          threadId: (full as { threadId?: string | null }).threadId ?? null,
          from: { name: fromAddr.name ?? "", email: fromAddr.email ?? "" },
          subject,
          bodyText: parsed.bodyText,
          attachments: [],
          mailbox: conn.address,
          candidateVisibility: "restricted",
        });
      } catch {
        // Candidate minting must never fail the sync itself.
      }
    }
  }
  return "synced";
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/* ── Sync driver ───────────────────────────────────────────────────────────── */

export interface MailSyncCounts {
  synced: number;
  excluded: number;
  errors: number;
}

/**
 * Targeted backfill for one company's people: pull every message exchanged
 * with the given addresses (and their corporate domain) into the metadata
 * store, across every healthy connection. The scheduled sync only skims a
 * 30-day window — this digs the full history on demand, which is what
 * "shots on goal" counts. Returns how many messages were ingested.
 */
let cooldownReady = false;

/**
 * Claim the right to deep-search a deal's mail — at most once per 6 hours
 * per deal, enforced atomically so two simultaneous deal-opens can't both
 * fire Gmail searches. Deal-open used to trigger a provider sweep on EVERY
 * view; the stamp makes "provider calls per deal-open ≤ 1 per 6h" checkable
 * straight off deals.deep_searched_at.
 */
export async function claimDeepSearch(gid: string): Promise<boolean> {
  if (!cooldownReady) {
    // Catalog-check first: even a no-op ALTER takes an ACCESS EXCLUSIVE lock
    // on deals per cold lambda (the perf_events convoy class).
    const col = await sql<{ ok: boolean }[]>`
      select exists (
        select 1 from information_schema.columns
         where table_schema = 'public' and table_name = 'deals' and column_name = 'deep_searched_at'
      ) as ok`.catch(() => [{ ok: true }]);
    if (!col[0]?.ok) {
      await sql`alter table deals add column if not exists deep_searched_at timestamptz`.catch(
        () => {}
      );
    }
    cooldownReady = true;
  }
  const rows = await withRetry(
    () => sql<{ gid: string }[]>`
      update deals set deep_searched_at = now()
      where gid = ${gid}
        and (deep_searched_at is null or deep_searched_at < now() - interval '6 hours')
      returning gid`
  ).catch(() => [] as { gid: string }[]);
  return rows.length > 0;
}

export async function deepSearchMail(
  addresses: string[],
  opts: { domain?: string | null; maxPerConnection?: number } = {}
): Promise<number> {
  await ensureMailSchema();
  const t0 = performance.now();
  const clean = [
    ...new Set(
      addresses
        .map((a) => a.trim().toLowerCase())
        .filter((a) => a.includes("@"))
    ),
  ].slice(0, 6);
  const dom = opts.domain?.trim().toLowerCase() || null;
  if (clean.length === 0 && !dom) return 0;

  // Gmail OR-group: {from:a to:a …}. A bare term after from:/to: substring-
  // matches the address, so from:terranova.inc catches every mailbox there.
  const terms = [
    ...clean.flatMap((a) => [`from:${a}`, `to:${a}`, `cc:${a}`]),
    ...(dom ? [`from:${dom}`, `to:${dom}`] : []),
  ];
  const q = encodeURIComponent(`{${terms.join(" ")}} -in:chats`);

  const conns = await withRetry(
    () => sql<MailConnection[]>`
      select * from mailbox_connections where status <> 'reauth_needed'
    `
  ).catch(() => [] as MailConnection[]);

  let ingested = 0;
  for (const conn of conns) {
    const token = await gmailAccessTokenFor(conn);
    if (!token) continue;
    try {
      const data = await gmail(
        token,
        `/messages?maxResults=${Math.min(opts.maxPerConnection ?? 60, 100)}&q=${q}`
      );
      const ids: string[] = (data.messages ?? []).map((m: { id: string }) => m.id);
      for (const id of ids) {
        try {
          if ((await ingestMessage(conn, token, id)) === "synced") ingested++;
        } catch {
          // one bad message never stops the dig
        }
      }
    } catch (err) {
      logError("mail", "deep search failed", err, { address: conn.address });
    }
  }
  void import("./perf")
    .then((p) =>
      p.record("job.deep_search", performance.now() - t0, {
        addrs: clean.length,
        connections: conns.length,
        ingested,
      })
    )
    .catch(() => {});
  return ingested;
}

export async function syncConnection(
  connectionId: string,
  { maxMessages = 60 }: { maxMessages?: number } = {}
): Promise<MailSyncCounts> {
  const counts: MailSyncCounts = { synced: 0, excluded: 0, errors: 0 };
  const t0 = Date.now();
  await ensureMailSchema();
  const rows = await withRetry(
    () => sql<MailConnection[]>`
      select * from mailbox_connections where id = ${connectionId}
    `
  );
  const conn = rows[0];
  if (!conn) return counts;

  const token = await gmailAccessTokenFor(conn);
  if (!token) return counts; // reauth_needed already recorded — silent skip

  let ids: string[] = [];
  let nextCursor: string | null = null;
  try {
    if (conn.sync_cursor) {
      try {
        const r = await listHistoryIds(token, conn.sync_cursor, maxMessages);
        ids = r.ids;
        nextCursor = r.latestHistoryId;
      } catch (err) {
        if (!(err instanceof HistoryTooOldError)) throw err;
        // Gmail expired the watermark: re-baseline the last 30 days and take
        // a fresh cursor from the profile.
        ids = await baselineIds(token, maxMessages);
        nextCursor = await profileHistoryId(token);
      }
    } else {
      ids = await baselineIds(token, maxMessages);
      nextCursor = await profileHistoryId(token);
    }
  } catch (err) {
    logError("mail", "listing messages failed", err, { address: conn.address });
    counts.errors++;
    await withRetry(
      () => sql`
        update mailbox_connections
        set status = 'error',
            error = ${err instanceof Error ? err.message.slice(0, 300) : "listing failed"}
        where id = ${conn.id}
      `
    ).catch(() => {});
    return counts;
  }

  for (const id of ids) {
    try {
      const outcome = await ingestMessage(conn, token, id);
      counts[outcome]++;
    } catch (err) {
      counts.errors++;
      logError("mail", "message ingest failed", err, {
        address: conn.address,
        message: id,
      });
    }
  }

  // The cursor only advances once the page fully persisted — any failed
  // message keeps the old watermark so the next run retries it (message
  // upserts are idempotent, so re-processing the rest is harmless).
  const advance = counts.errors === 0 && !!nextCursor;
  await withRetry(
    () => sql`
      update mailbox_connections
      set last_synced_at = now(),
          status = 'ok',
          error = ${counts.errors > 0 ? `${counts.errors} message(s) failed — will retry` : null},
          sync_cursor = ${advance ? nextCursor : conn.sync_cursor}
      where id = ${conn.id}
    `
  ).catch((err) => logError("mail", "recording sync result failed", err, { id: conn.id }));

  logEvent(
    "info",
    "mail",
    "personal sync done",
    { address: conn.address, ...counts },
    Date.now() - t0
  );
  return counts;
}

/** Cron sweep: every active personal connection, isolated per-connection. */
export async function syncAllPersonalMail(): Promise<
  Record<string, MailSyncCounts>
> {
  await ensureMailSchema();
  const conns = await withRetry(
    () => sql<{ id: string; address: string }[]>`
      select id, address from mailbox_connections
      where kind = 'personal' and status <> 'reauth_needed'
      order by connected_at
    `
  );
  const results: Record<string, MailSyncCounts> = {};
  for (const c of conns) {
    try {
      results[c.address] = await syncConnection(c.id);
    } catch (err) {
      logError("mail", "personal sync failed", err, { address: c.address });
      results[c.address] = { synced: 0, excluded: 0, errors: 1 };
    }
  }
  return results;
}
