import "server-only";
import { createHash } from "node:crypto";
import { sql } from "./db";
import { withRetry } from "./retry";
import { logError } from "./log";

/**
 * ── First-class documents (PRD §9.8) ───────────────────────────────────────
 * Attachment and captured-deck bytes stop being transient: stored once in a
 * private Supabase Storage bucket keyed by sha-256 (dedupe by construction),
 * with a metadata row per source reference. Failures never block intake.
 */

const BUCKET = "opendeal-docs";
const MAX_BYTES = 25 * 1024 * 1024;

function storageEnv(): { url: string; key: string } | null {
  const url = process.env.SUPABASE_URL?.trim();
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ||
    process.env.SUPABASE_SECRET_KEY?.trim();
  return url && key ? { url, key } : null;
}

export function documentsConfigured(): boolean {
  return storageEnv() !== null;
}

export interface DocumentRow {
  id: string;
  source_email_id: string | null;
  deal_gid: string | null;
  source_type: string;
  original_url: string | null;
  storage_key: string;
  filename: string;
  mime: string;
  bytes: number;
  checksum: string;
  status: string;
  retrieved_at: string | null;
}

let ensured = false;
export async function ensureDocumentsSchema(): Promise<void> {
  if (ensured) return;
  await sql`
    create table if not exists documents (
      id              uuid primary key default gen_random_uuid(),
      source_email_id uuid,
      deal_gid        text,
      source_type     text not null default 'attachment',
      original_url    text,
      storage_key     text not null,
      filename        text not null,
      mime            text not null,
      bytes           bigint not null,
      checksum        text not null,
      status          text not null default 'ready',
      retrieved_at    timestamptz not null default now(),
      unique (checksum, source_email_id, source_type)
    )
  `;
  await sql`
    create index if not exists documents_email_idx on documents (source_email_id)
  `;
  await sql`
    create index if not exists documents_deal_idx on documents (deal_gid)
  `;
  ensured = true;
}

/** Upload once per checksum; replays and multi-source references are free. */
async function putObject(
  key: string,
  bytes: Buffer,
  mime: string
): Promise<boolean> {
  const env = storageEnv();
  if (!env) return false;
  const res = await fetch(`${env.url}/storage/v1/object/${BUCKET}/${key}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.key}`,
      apikey: env.key,
      "Content-Type": mime,
      "x-upsert": "true",
    },
    body: new Uint8Array(bytes),
    signal: AbortSignal.timeout(30_000),
  });
  return res.ok;
}

/** Pull one stored document's bytes back out of the bucket. */
export async function downloadDocument(
  storageKey: string
): Promise<Buffer | null> {
  const env = storageEnv();
  if (!env) return null;
  try {
    const res = await fetch(
      `${env.url}/storage/v1/object/${BUCKET}/${storageKey}`,
      {
        headers: { Authorization: `Bearer ${env.key}`, apikey: env.key },
        signal: AbortSignal.timeout(20_000),
      }
    );
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch (err) {
    logError("documents", "download failed", err, { storageKey });
    return null;
  }
}

/** Short-lived signed URL for viewing a stored document. */
export async function signedDocumentUrl(
  storageKey: string,
  expiresIn = 600
): Promise<string | null> {
  const env = storageEnv();
  if (!env) return null;
  try {
    const res = await fetch(
      `${env.url}/storage/v1/object/sign/${BUCKET}/${storageKey}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.key}`,
          apikey: env.key,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ expiresIn }),
        signal: AbortSignal.timeout(15_000),
      }
    );
    if (!res.ok) return null;
    const data = (await res.json()) as { signedURL?: string };
    return data.signedURL ? `${env.url}/storage/v1${data.signedURL}` : null;
  } catch {
    return null;
  }
}

/**
 * Persist one document's bytes + metadata. Idempotent on
 * (checksum, source_email_id, source_type).
 */
export async function saveDocument(opts: {
  bytes: Buffer;
  filename: string;
  mime: string;
  sourceEmailId?: string | null;
  sourceType?: string;
  originalUrl?: string | null;
  /** A deal the file belongs to directly (manual uploads on a local deal). */
  dealGid?: string | null;
}): Promise<void> {
  try {
    if (!documentsConfigured()) return;
    if (opts.bytes.length === 0 || opts.bytes.length > MAX_BYTES) return;
    await ensureDocumentsSchema();
    const checksum = createHash("sha256").update(opts.bytes).digest("hex");
    const ext = (opts.filename.match(/\.[a-z0-9]{1,6}$/i)?.[0] ?? "").toLowerCase();
    const key = `docs/${checksum}${ext}`;
    const uploaded = await putObject(key, opts.bytes, opts.mime);
    if (!uploaded) return;
    await withRetry(
      () => sql`
        insert into documents
          (source_email_id, source_type, original_url, storage_key, filename, mime, bytes, checksum, deal_gid)
        values
          (${opts.sourceEmailId ?? null}, ${opts.sourceType ?? "attachment"},
           ${opts.originalUrl ?? null}, ${key}, ${opts.filename.slice(0, 300)},
           ${opts.mime.slice(0, 120)}, ${opts.bytes.length}, ${checksum}, ${opts.dealGid ?? null})
        on conflict (checksum, source_email_id, source_type) do nothing
      `
    );
  } catch (err) {
    logError("documents", "persist failed", err, { filename: opts.filename });
  }
}

/** Files attached straight to a deal (direct uploads). */
export async function listDocumentsForDeal(gid: string): Promise<DocumentRow[]> {
  await ensureDocumentsSchema();
  return withRetry(
    () => sql<DocumentRow[]>`
      select id, source_email_id, deal_gid, source_type, original_url,
             storage_key, filename, mime, bytes, checksum, status, retrieved_at
      from documents where deal_gid = ${gid} and status = 'ready'
      order by retrieved_at`
  );
}

export async function listDocumentsForEmail(
  sourceEmailId: string
): Promise<DocumentRow[]> {
  if (!documentsConfigured()) return [];
  await ensureDocumentsSchema();
  return withRetry(
    () => sql<DocumentRow[]>`
      select id, source_email_id, deal_gid, source_type, original_url,
             storage_key, filename, mime, bytes, checksum, status,
             retrieved_at::text as retrieved_at
      from documents where source_email_id = ${sourceEmailId}
      order by retrieved_at desc
      limit 12`
  ).catch(() => []);
}

/** Every stored document across a Gmail thread — the pitch's real corpus. */
export async function listDocumentsForThread(
  gmailThreadId: string
): Promise<DocumentRow[]> {
  if (!documentsConfigured()) return [];
  await ensureDocumentsSchema();
  return withRetry(
    () => sql<DocumentRow[]>`
      select d.id, d.source_email_id, d.deal_gid, d.source_type, d.original_url,
             d.storage_key, d.filename, d.mime, d.bytes, d.checksum, d.status,
             d.retrieved_at::text as retrieved_at
      from documents d
      join inbound_emails e on e.id = d.source_email_id
      where e.gmail_thread_id = ${gmailThreadId}
      order by d.retrieved_at desc
      limit 12`
  ).catch(() => []);
}

export async function getDocument(id: string): Promise<DocumentRow | null> {
  await ensureDocumentsSchema();
  const rows = await sql<DocumentRow[]>`
    select id, source_email_id, deal_gid, source_type, original_url,
           storage_key, filename, mime, bytes, checksum, status,
           retrieved_at::text as retrieved_at
    from documents where id = ${id}`;
  return rows[0] ?? null;
}

/**
 * Remove one document row. The stored object is keyed by content hash and may
 * be shared by other rows (the same file attached to two deals), so it is only
 * deleted from storage when this was the last reference to it.
 */
export async function deleteDocument(id: string): Promise<boolean> {
  await ensureDocumentsSchema();
  const rows = await sql<{ storage_key: string }[]>`
    delete from documents where id = ${id} returning storage_key`;
  const key = rows[0]?.storage_key;
  if (!key) return false;
  const still = await sql<{ n: number }[]>`
    select count(*)::int as n from documents where storage_key = ${key}`;
  const env = storageEnv();
  if (env && (still[0]?.n ?? 0) === 0) {
    await fetch(`${env.url}/storage/v1/object/${BUCKET}/${key}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${env.key}`, apikey: env.key },
      signal: AbortSignal.timeout(15_000),
    }).catch(() => {});
  }
  return true;
}
