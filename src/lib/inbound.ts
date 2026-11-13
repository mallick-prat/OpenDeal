import "server-only";
import { randomUUID, createHash } from "crypto";
import { sql } from "./db";
import { logError, logEvent } from "./log";
import { logActivity } from "./users";
import { normalizeLinkedInUrl, normalizeText } from "./networkRules";
import { upsertPersonFromFounder, type Founder } from "./people";
import {
  getInboundMailbox,
  inboundAccessToken,
  inboundAddress,
  listInboxMessageIds,
  getFullMessage,
  getAttachment,
  ensureProcessedLabel,
  labelMessage,
  listHistoryMessageIds,
  HistoryTooOldError,
  saveHistoryId,
  startGmailWatch,
  stopGmailWatch,
  saveWatchState,
  isInboundAddress,
} from "./inboundMailbox";
import { parseGmailMessage, findDeckLinks, type DeckLink, type AttachmentMeta } from "./emailParse";
import { extractPitch, type ParsedPitch, type DeckSource } from "./deckExtract";
import { captureDeck, isCapturable } from "./docsend";
import { ensureCandidateFor, refreshCandidateFromInbound } from "./candidates";
import { crm, isInternalEmail } from "@/config/crm.config";

/**
 * Shadow this email's review candidate (stable /inbox/<id> URL) and keep its
 * machine-owned fields in step. Never throws — candidate bookkeeping must not
 * break ingestion.
 */
async function syncCandidate(inboundEmailId: string): Promise<void> {
  try {
    await ensureCandidateFor(inboundEmailId);
    await refreshCandidateFromInbound(inboundEmailId);
  } catch (err) {
    logError("inbound", "candidate sync failed", err, { id: inboundEmailId });
  }
}

/**
 * ── Inbound deal ingestion orchestrator ──────────────────────────────────────
 * Poll the inbound mailbox → parse pitch emails + decks → private deal DRAFTS in a
 * review queue (inbound_emails). A member turns a draft into a real private
 * deal from /inbound; nothing is auto-created.
 */

const MAX_PER_RUN = 20;
// Emails below this confidence (or not a pitch) land as 'skipped', still
// visible in the queue so a human can override.
const PITCH_MIN_CONFIDENCE = 0.4;

let schemaReady = false;
export async function ensureInboundSchema(): Promise<void> {
  if (schemaReady) return;
  await sql`
    create table if not exists inbound_mailboxes (
      email text primary key,
      refresh_token text not null,
      scopes text not null default '',
      history_id text,
      last_polled_at timestamptz,
      connected_at timestamptz not null default now(),
      connected_by text,
      poll_stats jsonb not null default '{}'::jsonb
    )
  `;
  await sql`
    create table if not exists inbound_emails (
      id uuid primary key default gen_random_uuid(),
      gmail_message_id text unique not null,
      gmail_thread_id text,
      mailbox text not null,
      from_name text,
      from_email text,
      subject text,
      received_at timestamptz,
      snippet text,
      body_text text,
      deck_links jsonb not null default '[]'::jsonb,
      attachments jsonb not null default '[]'::jsonb,
      status text not null default 'pending',
      parsed jsonb,
      deck_note text,
      deal_gid text,
      error text,
      created_at timestamptz not null default now(),
      processed_at timestamptz
    )
  `;
  await sql`
    create index if not exists inbound_emails_status_idx
      on inbound_emails (status, received_at desc)
  `;
  // Three hot paths walk a message's thread siblings (candidate view,
  // summary counts, deck sweep) — without this each walk re-scans the table.
  await sql`
    create index if not exists inbound_emails_thread_idx
      on inbound_emails (gmail_thread_id) where gmail_thread_id is not null
  `;
  schemaReady = true;
}

export interface InboundRow {
  id: string;
  gmail_message_id: string;
  gmail_thread_id: string | null;
  from_name: string | null;
  from_email: string | null;
  subject: string | null;
  received_at: Date | null;
  snippet: string | null;
  body_text: string | null;
  deck_links: DeckLink[];
  attachments: AttachmentMeta[];
  status: string;
  parsed: ParsedPitch | null;
  deck_note: string | null;
  deal_gid: string | null;
  error: string | null;
  created_at: Date;
}

/* ── Ingest ────────────────────────────────────────────────────────────────── */

export interface IngestResult {
  connected: boolean;
  fetched: number;
  stored: number;
  parsed: number;
  skipped: number;
  errors: number;
}

/**
 * Store + parse a specific set of message ids (shared by the push path and the
 * manual/backfill poll). New ids only — already-ingested messages are skipped.
 */
async function ingestMessageIds(
  token: string,
  ids: string[],
  source: string
): Promise<Omit<IngestResult, "connected">> {
  const t0 = Date.now();
  const known = new Set(
    ids.length === 0
      ? []
      : (
          await sql<{ gmail_message_id: string }[]>`
            select gmail_message_id from inbound_emails
            where gmail_message_id = any(${ids})
          `
        ).map((r) => r.gmail_message_id)
  );
  const fresh = ids.filter((id) => !known.has(id)).slice(0, MAX_PER_RUN);

  let labelId = "";
  if (fresh.length > 0) {
    try {
      labelId = await ensureProcessedLabel(token);
    } catch (err) {
      logError("inbound", "could not ensure ingest label", err);
    }
  }

  const newRowIds: string[] = [];
  for (const id of fresh) {
    try {
      const msg = await getFullMessage(token, id);
      const p = parseGmailMessage(msg);
      const receivedAt = Number(msg.internalDate)
        ? new Date(Number(msg.internalDate)).toISOString()
        : null;
      const rows = await sql<{ id: string }[]>`
        insert into inbound_emails
          (gmail_message_id, gmail_thread_id, mailbox, from_name, from_email,
           subject, received_at, snippet, body_text, deck_links, attachments)
        values
          (${id}, ${msg.threadId ?? null}, ${inboundAddress()}, ${p.from.name || null},
           ${p.from.email || null}, ${p.subject || null}, ${receivedAt},
           ${(msg.snippet ?? "").slice(0, 300)}, ${p.bodyText},
           ${sql.json(p.deckLinks as never)}, ${sql.json(p.attachments as never)})
        on conflict (gmail_message_id) do nothing
        returning id
      `;
      if (rows[0]) newRowIds.push(rows[0].id);
      if (labelId) await labelMessage(token, id, labelId).catch(() => {});
    } catch (err) {
      logError("inbound", "message ingest failed", err, { id });
    }
  }

  // The pitch is VISIBLE the moment it's stored: create the candidate row
  // (status 'parsing') before extraction runs, not after. Extraction takes
  // 10-25s with a deck, and gating visibility on it meant a forwarded deal
  // sat invisible exactly when the sender was watching for it. The queue
  // already renders the parsing state; persistExtraction upgrades it.
  for (const rowId of newRowIds) {
    await syncCandidate(rowId);
  }

  // Extraction runs after, a few at once — pitches often arrive together
  // (one forward fanning out into several messages), and each parse is
  // dominated by an LLM call measured in tens of seconds, not local work.
  let parsed = 0;
  let skipped = 0;
  let errors = 0;
  const PARSE_CONCURRENCY = 3;
  for (let i = 0; i < newRowIds.length; i += PARSE_CONCURRENCY) {
    const batch = newRowIds.slice(i, i + PARSE_CONCURRENCY);
    const outcomes = await Promise.allSettled(
      batch.map((rowId) => processInboundEmail(rowId, token))
    );
    outcomes.forEach((o, j) => {
      if (o.status === "rejected") {
        errors++;
        logError("inbound", "processing failed", o.reason, { rowId: batch[j] });
      } else if (o.value === "parsed") parsed++;
      else if (o.value === "skipped") skipped++;
      else errors++;
    });
  }

  const stats = { source, fetched: fresh.length, stored: newRowIds.length, parsed, skipped, errors, last_ms: Date.now() - t0 };
  if (fresh.length > 0 || errors > 0) {
    await sql`
      update inbound_mailboxes set last_polled_at = now(), poll_stats = poll_stats || ${sql.json(stats as never)}
      where email = ${inboundAddress()}
    `.catch(() => {});
    logEvent("info", "inbound", "ingest done", stats, Date.now() - t0);
  } else {
    await sql`
      update inbound_mailboxes set last_polled_at = now()
      where email = ${inboundAddress()}
    `.catch(() => {});
  }
  return { fetched: fresh.length, stored: newRowIds.length, parsed, skipped, errors };
}

/** Full backfill / manual poll — scans recent INBOX (the daily reconcile). */
export async function ingestInbound(): Promise<IngestResult> {
  await ensureInboundSchema();
  const conn = await getInboundMailbox();
  if (!conn) return { connected: false, fetched: 0, stored: 0, parsed: 0, skipped: 0, errors: 0 };
  const token = await inboundAccessToken(conn);
  const ids = await listInboxMessageIds(token, 60);
  const r = await ingestMessageIds(token, ids, "poll");
  return { connected: true, ...r };
}

/**
 * Push path: ingest exactly what changed since the stored history watermark.
 * This is the instant route — a new pitch is stored, parsed, and queued within
 * seconds of arrival. Falls back to a full backfill if the watermark expired.
 */
export async function ingestSince(): Promise<IngestResult> {
  await ensureInboundSchema();
  const conn = await getInboundMailbox();
  if (!conn) return { connected: false, fetched: 0, stored: 0, parsed: 0, skipped: 0, errors: 0 };
  const token = await inboundAccessToken(conn);
  if (!conn.history_id) {
    // No watermark yet — establish one via a backfill.
    return ingestInbound();
  }
  try {
    const { ids, latestHistoryId } = await listHistoryMessageIds(token, conn.history_id);
    const r = await ingestMessageIds(token, ids, "push");
    await saveHistoryId(latestHistoryId);
    return { connected: true, ...r };
  } catch (err) {
    if (err instanceof HistoryTooOldError) {
      logEvent("warn", "inbound", "history watermark expired — backfilling", {});
      return ingestInbound();
    }
    throw err;
  }
}

/* ── Real-time watch lifecycle ─────────────────────────────────────────────── */

/** Arm (or renew) the Gmail push watch. No-op if Pub/Sub isn't configured. */
export async function startWatch(): Promise<{ armed: boolean; expiration?: string }> {
  if (!process.env.GMAIL_PUBSUB_TOPIC) return { armed: false };
  const conn = await getInboundMailbox();
  if (!conn) return { armed: false };
  const token = await inboundAccessToken(conn);
  const { historyId, expiration } = await startGmailWatch(token);
  await saveWatchState(historyId, expiration);
  logEvent("info", "inbound", "gmail watch armed", { expiration });
  return { armed: true, expiration };
}

export async function stopWatch(): Promise<void> {
  if (!process.env.GMAIL_PUBSUB_TOPIC) return;
  const conn = await getInboundMailbox();
  if (!conn) return;
  const token = await inboundAccessToken(conn).catch(() => null);
  if (token) await stopGmailWatch(token).catch(() => {});
}

/**
 * Daily safety net: renew the watch (Gmail expires it after ~7 days) and
 * backfill any messages a push might have missed. No-op if the mailbox isn't
 * connected. Renewing must come AFTER the backfill so the fresh watermark
 * doesn't skip messages we haven't ingested yet.
 */
export async function renewInboundWatch(): Promise<{
  connected: boolean;
  backfill?: IngestResult;
  armed?: boolean;
}> {
  await ensureInboundSchema();
  const conn = await getInboundMailbox();
  if (!conn) return { connected: false };
  const backfill = await ingestInbound();
  const watch = await startWatch().catch((err) => {
    logError("inbound", "watch renew failed", err);
    return { armed: false };
  });
  return { connected: true, backfill, armed: watch.armed };
}

/* ── Per-email processing ──────────────────────────────────────────────────── */

async function loadRow(id: string): Promise<InboundRow | null> {
  const rows = await sql<InboundRow[]>`select * from inbound_emails where id = ${id}`;
  return rows[0] ?? null;
}

/** DocSend/other deck links → converted deck PDFs (shared by both paths). */
async function captureDeckLinks(
  links: DeckLink[]
): Promise<{ pdfs: { filename: string; bytes: Buffer }[]; notes: string[] }> {
  const pdfs: { filename: string; bytes: Buffer }[] = [];
  const notes: string[] = [];
  for (const link of links) {
    if (!isCapturable(link.kind)) {
      notes.push(`${link.kind} deck link — open manually: ${link.url}`);
      continue;
    }
    // Already converted once? Pull the stored PDF instead of paying again.
    try {
      const { sql } = await import("./db");
      const { signedDocumentUrl } = await import("./documents");
      const prior = await sql<{ storage_key: string }[]>`
        select storage_key from documents
         where original_url = ${link.url} and source_type = 'docsend' limit 1`;
      if (prior[0]) {
        const url = await signedDocumentUrl(prior[0].storage_key);
        if (url) {
          const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
          if (res.ok) {
            pdfs.push({ filename: "docsend-deck.pdf", bytes: Buffer.from(await res.arrayBuffer()) });
            notes.push("Deck already converted — reused the stored PDF.");
            continue;
          }
        }
      }
    } catch {
      // fall through to a fresh conversion
    }
    const cap = await captureDeck(link.url);
    notes.push(cap.note);
    if (cap.status === "ok" && cap.pdf) pdfs.push({ filename: "docsend-deck.pdf", bytes: cap.pdf });
  }
  return { pdfs, notes };
}

/**
 * Ledger the extraction's facts as provenance claims on the candidate that
 * shadows this email (PR-06). Runs AFTER syncCandidate so the candidate row
 * exists. Never throws — the claims ledger must not break ingestion.
 */
async function recordPitchClaims(
  inboundEmailId: string,
  pitch: ParsedPitch,
  deckParsed: boolean
): Promise<void> {
  try {
    const rows = await sql<{ id: string }[]>`
      select id from deal_candidates where source_email_id = ${inboundEmailId}`;
    const candidateId = rows[0]?.id;
    if (!candidateId) return;
    const facts: [string, string | null][] = [
      ["companyName", pitch.companyName],
      ["oneLiner", pitch.oneLiner],
      ["round", pitch.round],
      ["raiseAmount", pitch.raiseAmount],
      ["valuation", pitch.valuation],
      ["traction", pitch.traction],
      ["sector", pitch.sector],
      ["website", pitch.website],
      ["location", pitch.location],
    ];
    const sourceType = deckParsed ? ("deck_extracted" as const) : ("email_extracted" as const);
    const claims = facts
      .filter((f): f is [string, string] => f[1] !== null && f[1] !== "")
      .map(([field, value]) => ({
        field,
        value,
        sourceType,
        sourceRef: inboundEmailId,
        confidence: pitch.confidence,
      }));
    if (claims.length === 0) return;
    const { recordClaims } = await import("./claims");
    await recordClaims("candidate", candidateId, claims);
  } catch (err) {
    logError("inbound", "claim record failed", err, { id: inboundEmailId });
  }
}

/** Run Claude over the assembled deck + email text, then persist the parse. */
async function persistExtraction(
  id: string,
  row: Pick<InboundRow, "subject" | "from_name" | "from_email" | "body_text">,
  deck: DeckSource,
  priorNotes: string[]
): Promise<"parsed" | "skipped" | "error"> {
  const emailText = [
    row.subject ? `Subject: ${row.subject}` : "",
    row.from_email ? `From: ${row.from_name ?? ""} <${row.from_email}>` : "",
    "",
    row.body_text ?? "",
  ].join("\n");

  const { pitch, deckNotes: extractNotes } = await extractPitch(emailText, deck);
  const allNotes = [...priorNotes, ...extractNotes].filter(Boolean).join(" · ").slice(0, 1000) || null;
  const status =
    pitch.isPitch && pitch.confidence >= PITCH_MIN_CONFIDENCE ? "parsed" : "skipped";
  await sql`
    update inbound_emails
    set parsed = ${sql.json(pitch as never)}, deck_note = ${allNotes},
        status = ${status}, processed_at = now(), error = null
    where id = ${id}
  `;
  await syncCandidate(id);
  if (status === "parsed") await recordPitchClaims(id, pitch, deck.pdfs.length > 0);
  else {
    const { proposeDealForUpdate } = await import("./candidates");
    await proposeDealForUpdate(id, row.subject);
  }
  return status;
}

/** Gmail path: fetch attachment bytes by id, convert decks, run Claude. */
export async function processInboundEmail(
  id: string,
  token?: string
): Promise<"parsed" | "skipped" | "error"> {
  const row = await loadRow(id);
  if (!row) return "error";

  // Our own outbound copies must never burn an extraction or mint a
  // candidate: mail FROM deals@ itself, and CC-to-deals@ copies of notes a
  // member just sent from their own mailbox (matched by sender + subject
  // against the outbound record written at send time).
  const fromLower = (row.from_email ?? "").trim().toLowerCase();
  if (isInboundAddress(fromLower)) {
    await sql`
      update inbound_emails set status = 'skipped', processed_at = now() where id = ${id}
    `.catch(() => {});
    return "skipped";
  }
  if (isInternalEmail(fromLower)) {
    const own = await sql<{ n: number }[]>`
      select count(*)::int as n from email_messages m
       where m.direction = 'outbound'
         and lower(m.from_addr->>'email') = ${fromLower}
         and lower(coalesce(m.headers->>'Subject', '')) = ${(row.subject ?? "").trim().toLowerCase()}
         and m.sent_at > now() - interval '3 days'
    `.catch(() => [{ n: 0 }]);
    if ((own[0]?.n ?? 0) > 0) {
      // Once a candidate was minted from this email, the guard must stand
      // down: a reparse refreshes an accepted pitch, it doesn't re-decide.
      const minted = await sql<{ id: string }[]>`
        select id from deal_candidates where source_email_id = ${id} limit 1
      `.catch(() => [] as { id: string }[]);
      if (!minted[0]) {
        await sql`
          update inbound_emails set status = 'skipped', processed_at = now() where id = ${id}
        `.catch(() => {});
        return "skipped";
      }
    }
  }

  const deck: DeckSource = { pdfs: [] };
  // Files fetched beyond the extraction corpus: archived, never parsed —
  // extraction stays capped at 3 PDFs, but the deal keeps everything.
  const storeOnly: { filename: string; bytes: Buffer }[] = [];

  // 1. PDF/PPTX attachments → bytes for Claude (fetched from Gmail by id).
  if (row.attachments.length > 0) {
    const t = token ?? (await mailboxToken());
    if (t) {
      for (const att of row.attachments.slice(0, 6)) {
        try {
          const bytes = await getAttachment(t, row.gmail_message_id, att.attachmentId);
          if (deck.pdfs.length < 3) deck.pdfs.push({ filename: att.filename, bytes });
          else storeOnly.push({ filename: att.filename, bytes });
        } catch (err) {
          logError("inbound", "attachment fetch failed", err, { id, file: att.filename });
        }
      }
    }
  }

  // 1b. The pitch is a THREAD: siblings' attachments (a forwarded deck)
  //     join the corpus, fetched with their own message ids.
  if (row.gmail_thread_id && deck.pdfs.length < 3) {
    try {
      const siblings = await sql<
        { gmail_message_id: string; attachments: { filename: string; attachmentId: string }[] | null }[]
      >`
        select gmail_message_id, attachments from inbound_emails
         where gmail_thread_id = ${row.gmail_thread_id} and id <> ${id}
           and jsonb_array_length(coalesce(attachments, '[]'::jsonb)) > 0
         order by received_at desc limit 3`;
      const t2 = token ?? (await mailboxToken());
      if (t2) {
        for (const sib of siblings) {
          for (const att of (sib.attachments ?? []).slice(0, 2)) {
            if (deck.pdfs.length >= 3) break;
            if (deck.pdfs.some((p) => p.filename === att.filename)) continue;
            try {
              const bytes = await getAttachment(t2, sib.gmail_message_id, att.attachmentId);
              deck.pdfs.push({ filename: att.filename, bytes });
            } catch (err) {
              logError("inbound", "thread attachment fetch failed", err, { id, file: att.filename });
            }
          }
        }
      }
    } catch {
      // thread widening is additive — the own-email parse still stands
    }
  }

  // 1c. Members push pitches in by hitting Reply — and Gmail replies drop
  //     the original attachments, leaving the intake copy alone in its own
  //     one-message thread with nothing to sweep. The original lives in the
  //     member's own mailbox: search it there by subject and recover the
  //     documents. A pitch a member forwarded must never lose its deck.
  if (deck.pdfs.length === 0 && isInternalEmail(fromLower)) {
    try {
      const recovered = await recoverMemberThreadPdfs(fromLower, row.subject ?? "");
      if (recovered.length > 0) {
        deck.pdfs.push(...recovered);
        logEvent("info", "inbound", "deck recovered from member mailbox", {
          id,
          member: fromLower,
          files: recovered.map((r) => r.filename).join(", ").slice(0, 200),
        });
      }
    } catch (err) {
      logError("inbound", "member mailbox recovery failed", err, { id });
    }
  }

  // 1d. CC'd intake from OUTSIDE: a founder adds the sourcing address
  //     mid-thread, and the deck rode an earlier message this mailbox never
  //     received (Gmail threads are per-mailbox, so 1b finds no siblings).
  //     The thread lives complete in the CC'd member's own mailbox — read the
  //     To/Cc lines, find a member with a connected mailbox, recover there.
  //     Subject search first; the sender's address is the fallback when the
  //     thread was renamed along the way.
  if (deck.pdfs.length === 0 && !isInternalEmail(fromLower)) {
    try {
      const t3 = token ?? (await mailboxToken());
      const members = t3 ? await memberRecipientsOf(t3, row.gmail_message_id) : [];
      for (const member of members.slice(0, 2)) {
        const recovered = await recoverMemberThreadPdfs(member, row.subject ?? "", fromLower);
        if (recovered.length > 0) {
          deck.pdfs.push(...recovered);
          logEvent("info", "inbound", "deck recovered via cc'd member mailbox", {
            id,
            member,
            files: recovered.map((r) => r.filename).join(", ").slice(0, 200),
          });
          break;
        }
      }
    } catch (err) {
      logError("inbound", "cc recovery failed", err, { id });
    }
  }

  // 2. DocSend links → converted PDFs (stored conversions reused).
  const captured = await captureDeckLinks(row.deck_links);
  deck.pdfs.push(...captured.pdfs);

  // Persist whatever bytes we hold — the deck stops being transient.
  {
    const { saveDocument } = await import("./documents");
    const mimeOf = (fn: string) =>
      /\.pptx?$/i.test(fn)
        ? "application/vnd.openxmlformats-officedocument.presentationml.presentation"
        : /\.key$/i.test(fn)
          ? "application/vnd.apple.keynote"
          : "application/pdf";
    for (const p of [...deck.pdfs, ...storeOnly]) {
      await saveDocument({
        bytes: p.bytes, filename: p.filename, mime: mimeOf(p.filename),
        sourceEmailId: id,
        sourceType: captured.pdfs.includes(p) ? "docsend" : "attachment",
      });
    }
  }

  return persistExtraction(id, row, deck, captured.notes);
}

async function mailboxToken(): Promise<string | null> {
  const conn = await getInboundMailbox();
  if (!conn) return null;
  return inboundAccessToken(conn).catch(() => null);
}

/** Every PDF/deck part in a Gmail payload tree — forwards nest, so recurse. */
function pdfPartsOf(
  payload: { filename?: string; body?: { attachmentId?: string }; parts?: unknown[] } | null | undefined,
  out: { filename: string; attachmentId: string }[] = []
): { filename: string; attachmentId: string }[] {
  if (!payload) return out;
  const fn = payload.filename ?? "";
  if (payload.body?.attachmentId && /\.(pdf|pptx?)$/i.test(fn)) {
    out.push({ filename: fn, attachmentId: payload.body.attachmentId });
  }
  for (const part of payload.parts ?? []) {
    pdfPartsOf(part as never, out);
  }
  return out;
}

/**
 * Search a member's own connected mailbox for the original of a
 * replied/forwarded pitch (Re:/Fwd: stripped) and pull its deck files.
 * Read-only, capped, deduped by filename; any failure returns [] and the
 * normal parse stands.
 */
async function recoverMemberThreadPdfs(
  memberEmail: string,
  subject: string,
  senderEmail?: string
): Promise<{ filename: string; bytes: Buffer }[]> {
  const base = subject
    .replace(/^\s*((re|fwd?|fw)\s*:\s*)+/i, "")
    .replace(/"/g, "")
    .trim()
    .slice(0, 120);
  if (base.length < 3 && !senderEmail) return [];
  const conns = await sql<{ id: string; refresh_token_enc: string }[]>`
    select id, refresh_token_enc from mailbox_connections
     where lower(address) = ${memberEmail} and status = 'ok'
     limit 1`.catch(() => []);
  if (!conns[0]) return [];
  const { gmailAccessTokenFor } = await import("./mailSync");
  const token = await gmailAccessTokenFor(conns[0] as never);
  if (!token) return [];

  const { searchMessageIds, getFullMessage } = await import("./inboundMailbox");
  let ids =
    base.length >= 3
      ? await searchMessageIds(token, `subject:"${base}" has:attachment newer_than:180d`, 4)
      : [];
  // Renamed thread (or no usable subject): the sender's address still finds
  // the deck they mailed this member directly.
  if (ids.length === 0 && senderEmail) {
    ids = await searchMessageIds(
      token,
      `from:${senderEmail} has:attachment newer_than:180d`,
      4
    );
  }
  const out: { filename: string; bytes: Buffer }[] = [];
  const seen = new Set<string>();
  for (const mid of ids) {
    if (out.length >= 3) break;
    try {
      const msg = await getFullMessage(token, mid);
      for (const att of pdfPartsOf(msg.payload)) {
        if (out.length >= 3) break;
        const key = att.filename.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        const bytes = await getAttachment(token, mid, att.attachmentId);
        if (bytes.length > 0) out.push({ filename: att.filename, bytes });
      }
    } catch (err) {
      logError("inbound", "member message fetch failed", err, { mid });
    }
  }
  return out;
}

/**
 * Team addresses on the To/Cc lines of an ingested message (the sourcing
 * address itself excluded) — the members whose own mailboxes hold the full
 * thread when the intake copy arrived mid-conversation via CC.
 */
async function memberRecipientsOf(
  token: string,
  gmailMessageId: string
): Promise<string[]> {
  const msg = await getFullMessage(token, gmailMessageId).catch(() => null);
  if (!msg) return [];
  const hdr = (name: string) =>
    String(
      ((msg.payload?.headers ?? []) as { name?: string; value?: string }[]).find(
        (h) => (h.name ?? "").toLowerCase() === name.toLowerCase()
      )?.value ?? ""
    );
  const domain = inboundAddress().split("@")[1];
  if (!domain) return [];
  const pattern = new RegExp(`[a-z0-9._%+-]+@${domain.replace(/\./g, "\\.")}`, "gi");
  const found = `${hdr("To")}, ${hdr("Cc")}`.match(pattern) ?? [];
  const self = inboundAddress();
  return [...new Set(found.map((e) => e.toLowerCase()))].filter((e) => e !== self);
}

/* ── Inbound-email webhook path ─────────────────────────────────────────── */

export interface WebhookEmailInput {
  messageId: string | null;
  /** Provider thread id. A second message on a known thread is a reply. */
  threadId?: string | null;
  from: { name: string; email: string };
  subject: string;
  bodyText: string;
  attachments: { filename: string; mimeType: string; bytes: Buffer }[];
  /** Source mailbox label; defaults to the shared sourcing address. */
  mailbox?: string;
  /** Candidate visibility — personal-inbox pitches stay 'restricted'. */
  candidateVisibility?: string;
}

export interface WebhookIngestResult {
  stored: boolean;
  duplicate: boolean;
  id: string | null;
  status: string;
}

function isPdfAttachment(a: { filename: string; mimeType: string }): boolean {
  return /pdf/i.test(a.mimeType) || /\.pdf$/i.test(a.filename);
}

/**
 * Ingest one email delivered by the inbound-parse webhook. Attachment bytes are
 * already inline, so PDF decks parse without any follow-up fetch. Deduped by
 * message id (or a content hash when the provider omits one), so at-least-once
 * webhook redelivery never creates a duplicate draft.
 */
export async function ingestWebhookEmail(
  input: WebhookEmailInput
): Promise<WebhookIngestResult> {
  await ensureInboundSchema();
  const messageId =
    input.messageId?.trim() ||
    `webhook-${createHash("sha256")
      .update(`${input.from.email}|${input.subject}|${input.bodyText}`)
      .digest("hex")
      .slice(0, 48)}`;

  const deckLinks = findDeckLinks(`${input.subject}\n${input.bodyText}`);
  const attachmentMeta: AttachmentMeta[] = input.attachments.map((a) => ({
    filename: a.filename,
    mimeType: a.mimeType,
    attachmentId: "",
    size: a.bytes.length,
  }));

  const rows = await sql<{ id: string }[]>`
    insert into inbound_emails
      (gmail_message_id, gmail_thread_id, mailbox, from_name, from_email,
       subject, received_at, snippet, body_text, deck_links, attachments)
    values
      (${messageId}, ${input.threadId ?? null}, ${input.mailbox ?? inboundAddress()}, ${input.from.name || null},
       ${input.from.email || null}, ${input.subject || null}, ${new Date().toISOString()},
       ${input.bodyText.slice(0, 300)}, ${input.bodyText},
       ${sql.json(deckLinks as never)}, ${sql.json(attachmentMeta as never)})
    on conflict (gmail_message_id) do nothing
    returning id
  `;
  if (!rows[0]) {
    const existing = await sql<{ id: string; status: string }[]>`
      select id, status from inbound_emails where gmail_message_id = ${messageId}
    `;
    return { stored: false, duplicate: true, id: existing[0]?.id ?? null, status: existing[0]?.status ?? "pending" };
  }
  const id = rows[0].id;

  // A reply on a thread we've already ingested ATTACHES to that thread — it
  // never mints a second draft to triage. Its documents still persist (a
  // revised deck matters), but extraction does not re-run, so no field a
  // human already edited gets overwritten.
  const prior = input.threadId
    ? await sql<{ deal_gid: string | null }[]>`
        select deal_gid from inbound_emails
        where gmail_thread_id = ${input.threadId} and id <> ${id}
        order by received_at asc nulls last
        limit 1
      `
    : [];
  const isReply = prior.length > 0;

  // Assemble the deck: inline PDF attachments + converted DocSend links.
  const deck: DeckSource = { pdfs: [] };
  const notes: string[] = [];
  for (const a of input.attachments.slice(0, 5)) {
    if (isPdfAttachment(a)) deck.pdfs.push({ filename: a.filename, bytes: a.bytes });
    else notes.push(`Attachment ${a.filename} isn't a PDF — open manually.`);
  }
  const captured = await captureDeckLinks(deckLinks);
  deck.pdfs.push(...captured.pdfs);
  notes.push(...captured.notes);

  // First-class documents: every attachment persists once (sha-256 dedupe).
  {
    const { saveDocument } = await import("./documents");
    for (const a of input.attachments) {
      await saveDocument({
        bytes: a.bytes, filename: a.filename, mime: a.mimeType,
        sourceEmailId: id, sourceType: "attachment",
      });
    }
    for (const p of captured.pdfs) {
      await saveDocument({
        bytes: p.bytes, filename: p.filename, mime: "application/pdf",
        sourceEmailId: id, sourceType: "docsend",
      });
    }
  }

  if (isReply) {
    await sql`
      update inbound_emails
      set status = 'reply', deal_gid = ${prior[0].deal_gid}, processed_at = now()
      where id = ${id}
    `;
    logEvent("info", "inbound", "thread reply attached", {
      id,
      threadId: input.threadId ?? "",
      from: input.from.email,
      documents: input.attachments.length,
    });
    return { stored: true, duplicate: false, id, status: "reply" };
  }

  const status = await persistExtraction(
    id,
    { subject: input.subject, from_name: input.from.name, from_email: input.from.email, body_text: input.bodyText },
    deck,
    notes
  );
  // Personal-inbox candidates stay restricted until their owner shares them.
  if (input.candidateVisibility) {
    await sql`
      update deal_candidates set visibility = ${input.candidateVisibility}
      where source_email_id = ${id}
    `.catch(() => {});
  }
  logEvent("info", "inbound", "webhook email ingested", { id, from: input.from.email, status });
  return { stored: true, duplicate: false, id, status };
}

/* ── Queue reads + actions ─────────────────────────────────────────────────── */

export async function listInbound(limit = 100): Promise<InboundRow[]> {
  await ensureInboundSchema();
  return sql<InboundRow[]>`
    select * from inbound_emails
    order by received_at desc nulls last, created_at desc
    limit ${limit}
  `;
}

export async function inboundCounts(): Promise<Record<string, number>> {
  await ensureInboundSchema();
  const rows = await sql<{ status: string; n: number }[]>`
    select status, count(*)::int as n from inbound_emails group by status
  `;
  return Object.fromEntries(rows.map((r) => [r.status, r.n]));
}

export async function skipInbound(id: string): Promise<void> {
  await sql`
    update inbound_emails set status = 'skipped', processed_at = now() where id = ${id}
  `;
  await syncCandidate(id);
}

export async function reparseInbound(id: string): Promise<"parsed" | "skipped" | "error"> {
  return processInboundEmail(id);
}

/**
 * Turn a parsed draft into a PRIVATE deal owned by the acting member. Founders
 * with a resolvable LinkedIn URL become network_people + deal_founders; the
 * rest are captured in the notes. The deck stays in Gmail + as links until the
 * deal is elevated (attaching is team-only).
 */
/** Reviewer tweaks applied on top of the extraction when boarding a deal. */
export interface BoardOverrides {
  companyName?: string;
  stage?: string;
  financing?: string;
  round?: string;
  note?: string;
}

export async function createDealFromInbound(
  id: string,
  userEmail: string,
  userName: string,
  overrides: BoardOverrides = {}
): Promise<{ gid: string; name: string }> {
  const row = await loadRow(id);
  if (!row) throw new Error("That inbound email no longer exists.");
  if (row.deal_gid) {
    const existing = await sql<{ name: string }[]>`select name from deals where gid = ${row.deal_gid}`;
    if (existing[0]) return { gid: row.deal_gid, name: existing[0].name };
  }
  const pitch = row.parsed;
  if (!pitch) throw new Error("This email hasn't been parsed yet.");

  const company =
    normalizeText(overrides.companyName ?? "") ||
    normalizeText(pitch.companyName ?? "") ||
    normalizeText(row.subject ?? "") ||
    "Untitled";
  const founderNames = pitch.founders.map((f) => normalizeText(f.fullName)).filter(Boolean);
  // Fall back to the sender as the founder when the deck named no one.
  if (founderNames.length === 0 && row.from_name) founderNames.push(normalizeText(row.from_name));
  const name = founderNames.length
    ? `${founderNames.join(", ")} // ${company}`
    : company;

  const notesLines = [
    overrides.note?.trim() || null,
    pitch.oneLiner,
    pitch.summary,
    [
      pitch.round ? `Round: ${pitch.round}` : null,
      pitch.raiseAmount ? `Raise: ${pitch.raiseAmount}` : null,
      pitch.valuation ? `Valuation: ${pitch.valuation}` : null,
    ].filter(Boolean).join(" · ") || null,
    pitch.traction ? `Traction: ${pitch.traction}` : null,
    pitch.sector ? `Sector: ${pitch.sector}` : null,
    pitch.website ? `Website: ${pitch.website}` : null,
    row.deck_links.length ? `Decks:\n${row.deck_links.map((d) => `• (${d.kind}) ${d.url}`).join("\n")}` : null,
    row.attachments.length ? `Attachments: ${row.attachments.map((a) => a.filename).join(", ")}` : null,
    `Founders:\n${pitch.founders
      .map((f) => `• ${f.fullName}${f.title ? ` — ${f.title}` : ""}${f.linkedinUrl ? ` — ${f.linkedinUrl}` : f.email ? ` — ${f.email}` : ""}`)
      .join("\n") || `• ${row.from_name || row.from_email || "Unknown sender"}`}`,
    `Ingested from ${inboundAddress()} — "${row.subject ?? ""}" (${row.from_email ?? "unknown"})`,
  ].filter(Boolean);
  const notes = notesLines.join("\n\n").slice(0, 8000);

  // Only the app's known rounds go in the column (a CHECK/enum may guard it);
  // the raw round text is still preserved in the notes above.
  const ROUND_VALUES = crm.rounds;
  const roundInput = overrides.round ?? pitch.round;
  const roundColumn =
    roundInput && ROUND_VALUES.some((r) => r.toLowerCase() === roundInput.toLowerCase())
      ? ROUND_VALUES.find((r) => r.toLowerCase() === roundInput.toLowerCase())!
      : null;

  // Reviewer-picked stage, validated against the board's real columns.
  const STAGE_KEYS = ["to-meet", "first-meeting", "cultivate", "elevate", "to-pass", "passed", "diligence", "offered"];
  const stage =
    overrides.stage && STAGE_KEYS.includes(overrides.stage) ? overrides.stage : "to-meet";
  const financing = overrides.financing?.trim() || pitch.raiseAmount || null;

  const gid = `local-${randomUUID()}`;
  const today = new Date().toISOString().slice(0, 10);
  await sql`
    insert into deals (gid, name, notes, stage, section_gid, schools, owner,
      created_on, modified_on, completed, subtasks, followers, url,
      met_at_event, created_by, visibility, source, financing_amount, round)
    values (${gid}, ${name}, ${notes}, ${stage}, ${null}, ${[]},
      ${userName || "Unassigned"}, ${today}, ${today}, false, 0, 0, ${""},
      false, ${userEmail}, 'team', 'inbound_email',
      ${financing}, ${roundColumn})
  `;

  // Link the durable company entity (domain evidence from the sender/site).
  try {
    const { resolveCompany, linkDealToCompany } = await import("./companies");
    const { company: companyRow } = await resolveCompany(company, {
      domain: pitch.website ?? row.from_email,
      description: pitch.oneLiner ?? null,
      createdFrom: "candidate",
    });
    await linkDealToCompany(gid, companyRow.id);
  } catch (err) {
    logError("inbound", "company link failed", err, { id, company });
  }
  await sql`
    insert into deal_owners (deal_gid, email) values (${gid}, ${userEmail})
    on conflict do nothing
  `;

  // Materialize every founder the pitch names. LinkedIn-bearing ones go
  // through the profile upsert; the rest used to be DROPPED entirely — and
  // with them their extracted emails, which are the join key for meetings
  // and mail history. Now a name + address is enough for a person record.
  for (const f of pitch.founders) {
    try {
      if (f.linkedinUrl && normalizeLinkedInUrl(f.linkedinUrl)) {
        const founder: Founder = {
          linkedinUrl: f.linkedinUrl,
          fullName: f.fullName,
          headline: f.title ?? undefined,
          experience: [],
          education: [],
        };
        const person = await upsertPersonFromFounder(founder, null, userEmail);
        await sql`
          insert into deal_founders (deal_gid, person_id, founder_role, created_by)
          values (${gid}, ${person.id}, 'Founder', ${userEmail})
          on conflict (deal_gid, person_id) do nothing
        `;
        if (f.email) {
          // Attach the pitch's address unless it's taken (unique per person).
          await sql`
            update network_people set email = ${f.email.toLowerCase()}, updated_at = now()
             where id = ${person.id} and email is null
               and not exists (select 1 from network_people where lower(email) = ${f.email.toLowerCase()})
          `.catch(() => {});
        }
      } else if (f.fullName && f.email) {
        const { linkFounder } = await import("./calendarEnrich");
        await linkFounder(gid, f.fullName, f.email);
      }
    } catch (err) {
      logError("inbound", "founder link failed", err, { id, founder: f.fullName });
    }
  }

  // Claim the rest of this company's context: meetings already on the
  // calendar (past and future) and any sibling queue items.
  try {
    const { stampDealContext } = await import("./dealContext");
    await stampDealContext(
      gid,
      {
        emails: pitch.founders.map((f) => f.email ?? "").filter(Boolean),
        domains: pitch.website ? [pitch.website.replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0]] : [],
      },
      userEmail
    );
  } catch (err) {
    logError("inbound", "context stamp failed", err, { gid });
  }

  await sql`
    update inbound_emails set status = 'created', deal_gid = ${gid}, processed_at = now()
    where id = ${id}
  `;
  await syncCandidate(id);
  void logActivity(userEmail, "inbound_created_deal", gid, { name, from: row.from_email });
  logEvent("info", "inbound", "draft promoted to deal", { gid, by: userEmail });
  return { gid, name };
}
