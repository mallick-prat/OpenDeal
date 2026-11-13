import "server-only";
import { sql } from "./db";
import { withRetry } from "./retry";
import { ensureInboundSchema } from "./inbound";
import { inboundAddress, isInboundAddress } from "./inboundMailbox";
import { ensureCompaniesSchema } from "./companies";
import {
  OPEN_STATUSES,
  entitySignature,
  sameEntity,
  type CandidateStatus,
} from "./candidatesPure";

/**
 * ── Deal candidates: review state over ingested mail ────────────────────────
 * The stable, addressable unit of triage (/inbox/<id>). Ingestion keeps
 * writing inbound_emails exactly as before; ensureCandidateFor() shadows
 * each ingested pitch with a candidate row carrying the triage state.
 */

export interface CandidateRow {
  id: string;
  source_email_id: string | null;
  source_thread_id: string | null;
  status: CandidateStatus;
  assigned_to: string | null;
  snoozed_until: string | Date | null;
  proposed_company_id: string | null;
  proposed_deal_gid: string | null;
  promoted_deal_gid: string | null;
  classification: string | null;
  classifier_reason: string | null;
  confidence: number | null;
  visibility: string;
  received_at: string | Date | null;
  reviewed_at: string | Date | null;
  reviewed_by: string | null;
  created_at: string | Date;
}

/** Candidate joined with its source email for display. */
export interface CandidateView extends CandidateRow {
  from_name: string | null;
  from_email: string | null;
  subject: string | null;
  snippet: string | null;
  body_text: string | null;
  mailbox: string | null;
  gmail_thread_id: string | null;
  deck_links: { url: string; kind: string }[];
  attachments: { filename: string; mimeType: string; size: number }[];
  parsed: Record<string, unknown> | null;
  deck_note: string | null;
  inbound_status: string | null;
  deal_gid: string | null;
}

let schemaReady = false;
export async function ensureCandidatesSchema(): Promise<void> {
  if (schemaReady) return;
  await ensureInboundSchema();
  await ensureCompaniesSchema();
  await sql`
    create table if not exists deal_candidates (
      id                  uuid primary key default gen_random_uuid(),
      source_email_id     uuid unique references inbound_emails(id),
      source_thread_id    uuid,
      status              text not null default 'ready',
      assigned_to         text,
      snoozed_until       timestamptz,
      proposed_company_id uuid references deal_companies(id),
      proposed_deal_gid   text,
      promoted_deal_gid   text,
      classification      text,
      classifier_reason   text,
      confidence          numeric,
      visibility          text not null default 'team',
      received_at         timestamptz,
      reviewed_at         timestamptz,
      reviewed_by         text,
      created_at          timestamptz not null default now()
    )`;
  await sql`
    create index if not exists deal_candidates_status_idx
      on deal_candidates (status, received_at desc)`;
  await sql`
    create index if not exists deal_candidates_assigned_idx
      on deal_candidates (assigned_to) where assigned_to is not null`;
  schemaReady = true;
}

/**
 * Shadow an ingested email with its candidate row (idempotent on
 * source_email_id). Called from ingestion after parse and from the
 * backfill; safe to call any number of times.
 */
export async function ensureCandidateFor(inboundEmailId: string): Promise<string | null> {
  await ensureCandidatesSchema();

  // ── Identity pass ──────────────────────────────────────────────────────
  // Before any insert: does the inbox already track this STARTUP? The same
  // entity arrives as re-sends, a co-founder's copy, or a renamed company
  // ("Nova AI" → "Nova (AirNova)"). An OPEN peer absorbs this send (one
  // row per entity, bumped fresh); a BOARDED peer files the email straight
  // onto its deal so the deal's history auto-updates without a new inbox
  // row. Passed/ignored peers don't suppress — a new cycle gets fresh eyes.
  try {
    const srcRows = await withRetry(
      () => sql<
        {
          from_email: string | null;
          company: string | null;
          founders: { fullName?: string | null; email?: string | null }[];
        }[]
      >`
        select from_email, parsed->>'companyName' as company,
               coalesce(parsed->'founders', '[]'::jsonb) as founders
          from inbound_emails where id = ${inboundEmailId}`
    );
    const src = srcRows[0];
    // Self-sent mail (the pass note's CC back to the shared inbox) is never triage.
    if (src && isInboundAddress(src.from_email)) {
      return null;
    }
    if (src) {
      const mine = entitySignature({
        fromEmail: src.from_email,
        companyName: src.company,
        founders: Array.isArray(src.founders) ? src.founders : [],
      });
      const hasSignal =
        mine.senderEmail !== null ||
        mine.founderEmails.length > 0 ||
        mine.nameTokens.length >= 2;
      if (hasSignal) {
        const peers = await withRetry(
          () => sql<
            {
              id: string;
              status: string;
              promoted_deal_gid: string | null;
              from_email: string | null;
              company: string | null;
              founders: { fullName?: string | null; email?: string | null }[];
            }[]
          >`
            select c.id, c.status, c.promoted_deal_gid,
                   e.from_email, e.parsed->>'companyName' as company,
                   coalesce(e.parsed->'founders', '[]'::jsonb) as founders
              from deal_candidates c
              join inbound_emails e on e.id = c.source_email_id
             where e.id <> ${inboundEmailId}
               and e.received_at > now() - interval '90 days'
             order by c.received_at desc
             limit 300`
        ).catch(() => []);
        const matches = peers.filter((p) =>
          sameEntity(
            mine,
            entitySignature({
              fromEmail: p.from_email,
              companyName: p.company,
              founders: Array.isArray(p.founders) ? p.founders : [],
            })
          )
        );
        const open = matches.find((p) =>
          (OPEN_STATUSES as string[]).includes(p.status)
        );
        if (open) {
          await withRetry(
            () => sql`
              update deal_candidates c
                 set received_at = greatest(c.received_at, e.received_at)
                from inbound_emails e
               where c.id = ${open.id} and e.id = ${inboundEmailId}`
          ).catch(() => {});
          return open.id;
        }
        const boarded = matches.find(
          (p) =>
            (p.status === "approved" || p.status === "attached") &&
            p.promoted_deal_gid
        );
        if (boarded?.promoted_deal_gid) {
          const gid = boarded.promoted_deal_gid;
          await withRetry(
            () => sql`
              update inbound_emails
                 set deal_gid = ${gid}, status = 'created', processed_at = now()
               where id = ${inboundEmailId} and deal_gid is null`
          ).catch(() => {});
          // New founder mail is deal activity — Live deals should notice.
          await withRetry(
            () => sql`update deals set modified_on = current_date where gid = ${gid}`
          ).catch(() => {});
          return null;
        }
      }
    }
  } catch {
    // Identity pass is best-effort — the insert below still has the
    // same-thread guard, and a duplicate beats a lost pitch.
  }

  const rows = await withRetry(
    () => sql<{ id: string }[]>`
      insert into deal_candidates (
        source_email_id, status, classification, classifier_reason, confidence,
        received_at, reviewed_at, reviewed_by
      )
      select
        e.id,
        case e.status
          when 'pending' then 'parsing'
          when 'parsed'  then 'ready'
          when 'created' then 'approved'
          when 'skipped' then 'ignored'
          when 'error'   then 'parse_failed'
          else 'ready'
        end,
        coalesce(
          e.parsed->>'classification',
          case
            when (e.parsed->>'isPitch')::boolean is true then 'pitch'
            when e.parsed is not null then 'uncertain'
          end
        ),
        e.parsed->>'classifierReason',
        nullif(e.parsed->>'confidence', '')::numeric,
        e.received_at,
        case when e.status in ('created','skipped') then e.processed_at end,
        null
      from inbound_emails e
      where e.id = ${inboundEmailId}
        -- Mail the firm sent itself (pass notes CC the shared inbox) is never a pitch.
        and lower(coalesce(e.from_email, '')) <> ${inboundAddress().toLowerCase() || "(no inbound mailbox)"}
        -- ONE candidate per Gmail thread. A follow-up or a second forward of
        -- the same conversation must not mint a twin row in the inbox; it
        -- bumps the thread's existing candidate below instead.
        and not exists (
          select 1
            from inbound_emails e2
            join deal_candidates c2 on c2.source_email_id = e2.id
           where e.gmail_thread_id is not null
             and e2.gmail_thread_id = e.gmail_thread_id
             and e2.id <> e.id
        )
      on conflict (source_email_id) do nothing
      returning id`
  );
  if (rows[0]) return rows[0].id;
  const existing = await withRetry(
    () => sql<{ id: string }[]>`
      select id from deal_candidates where source_email_id = ${inboundEmailId}`
  );
  if (existing[0]) return existing[0].id;
  // Thread-consolidated: surface the conversation's OPEN candidate as fresh
  // mail (handled threads stay handled — replies there attach, not reopen).
  const anchor = await withRetry(
    () => sql<{ id: string }[]>`
      update deal_candidates c
         set received_at = greatest(c.received_at, e_new.received_at)
        from inbound_emails e_new, inbound_emails e_anchor
       where e_new.id = ${inboundEmailId}
         and e_new.gmail_thread_id is not null
         and c.source_email_id = e_anchor.id
         and e_anchor.gmail_thread_id = e_new.gmail_thread_id
         and c.status in ('detected','parsing','ready','assigned','snoozed')
       returning c.id`
  ).catch(() => [] as { id: string }[]);
  return anchor[0]?.id ?? null;
}

/** Keep a candidate's machine-owned fields in step after (re)parsing. */
export async function refreshCandidateFromInbound(inboundEmailId: string): Promise<void> {
  await ensureCandidatesSchema();
  await withRetry(
    () => sql`
      update deal_candidates c
      set
        status = case
          -- Human triage states are never clobbered by a reparse.
          when c.status in ('assigned','snoozed','approved','attached','passed','ignored')
            then c.status
          when e.status = 'pending' then 'parsing'
          when e.status = 'parsed'  then 'ready'
          when e.status = 'created' then 'approved'
          -- Not a pitch, but about a deal we hold: stays on the desk as a
          -- one-click "file to that deal", never silently dropped.
          when e.status = 'skipped' and c.proposed_deal_gid is not null then 'ready'
          when e.status = 'skipped' then 'ignored'
          when e.status = 'error'   then 'parse_failed'
          else c.status
        end,
        classification = coalesce(
          e.parsed->>'classification',
          case when (e.parsed->>'isPitch')::boolean is true then 'pitch'
               when e.parsed is not null then 'uncertain' end,
          c.classification
        ),
        classifier_reason = coalesce(e.parsed->>'classifierReason', c.classifier_reason),
        confidence = coalesce(nullif(e.parsed->>'confidence','')::numeric, c.confidence),
        promoted_deal_gid = coalesce(e.deal_gid, c.promoted_deal_gid)
      from inbound_emails e
      where e.id = ${inboundEmailId} and c.source_email_id = e.id`
  );
}

/**
 * Recover inbound mail that was stored but never made it into the queue.
 *
 * Scoped to the sourcing mailbox on purpose. The inbox exists to triage deals
 * into the CRM — only mail sent to the shared address is a deal. A member's
 * personal mailbox is reference material for "have we met this person
 * before", never a source of things to triage, and rows left in
 * inbound_emails from an earlier INBOUND_MAILBOX setting are not work.
 * Without this filter the heal would drag all of that back into Open.
 */
export async function backfillCandidatesBatch(batchSize = 200): Promise<{
  processed: number;
  remaining: number;
}> {
  await ensureCandidatesSchema();
  const { inboundAddress } = await import("./inboundMailbox");
  const mailbox = inboundAddress();
  // Only mail that still needs a queue row. Created/reply/skipped mail, mail
  // already attached to a deal, and self-sends used to match this join forever
  // — ensureCandidateFor correctly returns null for them, so the next cron
  // picked the same ids again and scanned 90 days of peers each time.
  const healWhere = sql`
    c.id is null
    and lower(e.mailbox) = ${mailbox}
    and e.deal_gid is null
    and e.status in ('pending', 'parsed', 'error')
    and lower(coalesce(e.from_email, '')) <> ${mailbox}
    and e.received_at > now() - interval '14 days'
  `;
  const rows = await withRetry(
    () => sql<{ id: string }[]>`
      select e.id from inbound_emails e
      left join deal_candidates c on c.source_email_id = e.id
      where ${healWhere}
      order by e.received_at desc nulls last
      limit ${batchSize}`
  );
  for (const r of rows) await ensureCandidateFor(r.id);
  if (rows.length < batchSize) return { processed: rows.length, remaining: 0 };
  const remaining = await withRetry(
    () => sql<{ n: number }[]>`
      select count(*)::int as n from inbound_emails e
      left join deal_candidates c on c.source_email_id = e.id
      where ${healWhere}`
  );
  return { processed: rows.length, remaining: remaining[0]?.n ?? 0 };
}

/** Wake snoozes whose time has come — cheap, run before every list read. */
let lastWake = 0;
async function wakeLapsedSnoozes(): Promise<void> {
  // An UPDATE on every list read is pure tax — once a minute is plenty.
  if (Date.now() - lastWake < 60_000) return;
  lastWake = Date.now();
  await withRetry(
    () => sql`
      update deal_candidates
      set status = 'ready', snoozed_until = null
      where status = 'snoozed' and snoozed_until <= now()`
  );
}

const VIEW_SELECT = sql`
  select
    c.*,
    e.from_name, e.from_email, e.subject, e.snippet, e.body_text, e.mailbox,
    e.parsed, e.deck_note, e.gmail_thread_id,
    e.status as inbound_status, e.deal_gid,
    -- A pitch is a THREAD: the deck often rides a sibling email (a forward,
    -- a follow-up), so attachments and deck links aggregate across it.
    coalesce(ta.thread_attachments, case when jsonb_typeof(e.attachments) = 'array' then e.attachments else '[]'::jsonb end) as attachments,
    coalesce(td.thread_deck_links, case when jsonb_typeof(e.deck_links) = 'array' then e.deck_links else '[]'::jsonb end) as deck_links
  from deal_candidates c
  left join inbound_emails e on e.id = c.source_email_id
  left join lateral (
    select jsonb_agg(a.elem) as thread_attachments
      from inbound_emails te,
           jsonb_array_elements(case when jsonb_typeof(te.attachments) = 'array' then te.attachments else '[]'::jsonb end) a(elem)
     where e.gmail_thread_id is not null and te.gmail_thread_id = e.gmail_thread_id
  ) ta on true
  left join lateral (
    select jsonb_agg(distinct d.elem) as thread_deck_links
      from inbound_emails te,
           jsonb_array_elements(case when jsonb_typeof(te.deck_links) = 'array' then te.deck_links else '[]'::jsonb end) d(elem)
     where e.gmail_thread_id is not null and te.gmail_thread_id = e.gmail_thread_id
  ) td on true
`;

/**
 * Visibility rule (privacy before features): 'team' candidates are for
 * everyone; 'restricted'/'private' ones — personal-inbox pitches — render
 * only for the member whose mailbox sourced them, until they share by
 * boarding or attaching.
 */
const VISIBLE_TO = (viewerEmail: string) => sql`
  (c.visibility = 'team' or lower(coalesce(e.mailbox, '')) = ${viewerEmail.toLowerCase()})
`;

export async function listCandidates(
  viewerEmail: string,
  limit = 200
): Promise<CandidateView[]> {
  await ensureCandidatesSchema();
  await wakeLapsedSnoozes();
  return withRetry(
    () => sql<CandidateView[]>`
      ${VIEW_SELECT}
      where ${VISIBLE_TO(viewerEmail)}
      order by c.received_at desc nulls last
      limit ${limit}`
  );
}

/** One list row, pre-digested in SQL — no bodies, no parsed blobs. */
export interface CandidateSummary {
  id: string;
  status: CandidateStatus;
  assigned_to: string | null;
  classification: string | null;
  confidence: number | string | null;
  received_at: Date | null;
  snoozed_until: Date | null;
  promoted_deal_gid: string | null;
  from_name: string | null;
  from_email: string | null;
  subject: string | null;
  company_name: string | null;
  one_liner: string | null;
  round: string | null;
  raise_amount: string | null;
  /** Founder full names, comma-joined in SQL. */
  founders: string | null;
  deck_count: number;
  attachment_count: number;
}

/**
 * The list surfaces (inbox rail, Home cockpit) render ~15 scalar fields per
 * row, but listCandidates hauls the full join — body_text up to 40KB, the
 * whole parsed blob, attachment manifests — for every one of its 200 rows.
 * This query extracts exactly the render fields in SQL, cutting the
 * database-to-server transfer by roughly two orders of magnitude.
 */
export async function listCandidateSummaries(
  viewerEmail: string,
  limit = 200
): Promise<CandidateSummary[]> {
  await ensureCandidatesSchema();
  await wakeLapsedSnoozes();
  return withRetry(
    () => sql<CandidateSummary[]>`
      select
        c.id, c.status, c.assigned_to, c.classification, c.confidence,
        c.received_at, c.snoozed_until, c.promoted_deal_gid,
        e.from_name, e.from_email, e.subject,
        e.parsed->>'companyName' as company_name,
        e.parsed->>'oneLiner' as one_liner,
        e.parsed->>'round' as round,
        e.parsed->>'raiseAmount' as raise_amount,
        (select string_agg(f->>'fullName', ', ')
           from jsonb_array_elements(
             case when jsonb_typeof(e.parsed->'founders') = 'array'
                  then e.parsed->'founders' else '[]'::jsonb end
           ) f
          where coalesce(f->>'fullName', '') <> '') as founders,
        coalesce(tc.deck_count, case when jsonb_typeof(e.deck_links) = 'array' then jsonb_array_length(e.deck_links) else 0 end) as deck_count,
        coalesce(tc.attachment_count, case when jsonb_typeof(e.attachments) = 'array' then jsonb_array_length(e.attachments) else 0 end) as attachment_count
      from deal_candidates c
      left join inbound_emails e on e.id = c.source_email_id
      left join lateral (
        select
          sum(case when jsonb_typeof(te.deck_links) = 'array' then jsonb_array_length(te.deck_links) else 0 end)::int as deck_count,
          sum(case when jsonb_typeof(te.attachments) = 'array' then jsonb_array_length(te.attachments) else 0 end)::int as attachment_count
          from inbound_emails te
         where e.gmail_thread_id is not null and te.gmail_thread_id = e.gmail_thread_id
      ) tc on true
      where ${VISIBLE_TO(viewerEmail)}
      order by c.received_at desc nulls last
      limit ${limit}`
  );
}

export async function getCandidate(
  id: string,
  viewerEmail: string
): Promise<CandidateView | null> {
  await ensureCandidatesSchema();
  const rows = await withRetry(
    () => sql<CandidateView[]>`
      ${VIEW_SELECT} where c.id = ${id} and ${VISIBLE_TO(viewerEmail)}`
  );
  return rows[0] ?? null;
}

/**
 * The triage session order: open candidates ranked exactly like the queue
 * (priority band, then newest). Powers "next up" auto-advance — the
 * call-list the investor is clearing.
 */
export async function openCandidateQueue(viewerEmail: string): Promise<string[]> {
  await ensureCandidatesSchema();
  await wakeLapsedSnoozes();
  const rows = await withRetry(
    () => sql<{
      id: string;
      status: CandidateStatus;
      assigned_to: string | null;
      classification: string | null;
      confidence: number | null;
      received_at: string | Date | null;
    }[]>`
      select c.id, c.status, c.assigned_to, c.classification, c.confidence, c.received_at
      from deal_candidates c
      left join inbound_emails e on e.id = c.source_email_id
      where c.status in ('detected','parsing','ready','assigned')
        and ${VISIBLE_TO(viewerEmail)}`
  );
  const { compareCandidates } = await import("./candidatesPure");
  return rows
    .map((r) => ({
      id: r.id,
      rank: {
        status: r.status,
        assignedTo: r.assigned_to,
        classification: r.classification,
        confidence: r.confidence === null ? null : Number(r.confidence),
        meetingScheduled: false,
        receivedAt: r.received_at ? new Date(r.received_at).toISOString() : null,
        snoozedUntil: null,
      },
    }))
    .sort((a, b) => compareCandidates(a.rank, b.rank, viewerEmail))
    .map((r) => r.id);
}

/** School names for the full boarding form's pickers. */
let schoolsMemo: { at: number; value: string[] } | null = null;
export async function listSchoolNames(): Promise<string[]> {
  if (schoolsMemo && Date.now() - schoolsMemo.at < 10 * 60 * 1000) return schoolsMemo.value;
  // EXACTLY the dashboard's ordering: schools ranked by deal volume, so the
  // boarding modal's top-10 checkboxes match New deal's checkbox-for-checkbox.
  const { isSchoolTag } = await import("./stages");
  const rows = await withRetry(
    () => sql<{ name: string }[]>`
      select s as name, count(*)::int as n
      from deals d, unnest(d.schools) as s
      group by s
      order by n desc, s
      limit 60`
  ).catch(() => [] as { name: string }[]);
  const value = rows.map((r) => r.name).filter((n) => n && isSchoolTag(n));
  if (value.length > 0) schoolsMemo = { at: Date.now(), value };
  return value;
}

/** Counts for the queue header and the sidebar badge. */
export async function candidateCounts(): Promise<Record<string, number>> {
  await ensureCandidatesSchema();
  const rows = await withRetry(
    () => sql<{ status: string; n: number }[]>`
      select status, count(*)::int as n from deal_candidates group by status`
  );
  const out: Record<string, number> = {};
  for (const r of rows) out[r.status] = r.n;
  return out;
}

/**
 * An email the classifier called "not a pitch" may still be ABOUT a deal we
 * hold: DD questions, a follow-up, a new deck on a thread. Ten such emails in
 * sixty days were auto-ignored. When the subject names a live deal (squashed
 * the same way deals.name_base is, common suffixes dropped), the candidate
 * stays reviewable with the deal proposed — one click files it. Passed deals
 * don't qualify; their follow-ups are noise. Best-effort, never throws.
 */
export async function proposeDealForUpdate(
  inboundEmailId: string,
  subject: string | null
): Promise<string | null> {
  const squashed = (subject ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (squashed.length < 5) return null;
  try {
    const rows = await sql<{ gid: string }[]>`
      select d.gid
      from deals d
      where d.stage not in ('passed', 'to-pass')
        and length(regexp_replace(d.name_base, '(inc|llc|corp|ltd|co|labs)$', '')) >= 5
        and position(regexp_replace(d.name_base, '(inc|llc|corp|ltd|co|labs)$', '') in ${squashed}) > 0
      order by length(d.name_base) desc
      limit 1`;
    const gid = rows[0]?.gid ?? null;
    if (!gid) return null;
    await sql`
      update deal_candidates
      set proposed_deal_gid = ${gid},
          status = case when status = 'ignored' and reviewed_by is null then 'ready' else status end
      where source_email_id = ${inboundEmailId}
        and promoted_deal_gid is null`;
    return gid;
  } catch {
    return null;
  }
}

/** Name and stage for a proposed deal, for the card's "already on the board" line. */
export async function dealStub(gid: string): Promise<{ gid: string; name: string; stage: string } | null> {
  const rows = await sql<{ gid: string; name: string; stage: string }[]>`
    select gid, name, stage from deals where gid = ${gid}`.catch(() => []);
  return rows[0] ?? null;
}

/* ── Triage mutations — each records the actor and stamps review time ────── */

export async function assignCandidate(
  id: string,
  assignee: string | null,
  actor: string
): Promise<void> {
  await ensureCandidatesSchema();
  await withRetry(
    () => sql`
      update deal_candidates
      set assigned_to = ${assignee},
          status = case
            when ${assignee}::text is not null and status in ('ready','detected') then 'assigned'
            when ${assignee}::text is null and status = 'assigned' then 'ready'
            else status
          end,
          reviewed_by = ${actor}
      where id = ${id}`
  );
}

export async function snoozeCandidate(
  id: string,
  until: Date,
  actor: string
): Promise<void> {
  await ensureCandidatesSchema();
  await withRetry(
    () => sql`
      update deal_candidates
      set status = 'snoozed', snoozed_until = ${until}, reviewed_by = ${actor}
      where id = ${id} and status not in ('approved','attached')`
  );
}

/** Ignore = "not deal mail" — classifier feedback, distinct from pass. */
export async function ignoreCandidate(id: string, actor: string): Promise<void> {
  await ensureCandidatesSchema();
  await withRetry(
    () => sql`
      update deal_candidates
      set status = 'ignored', reviewed_at = now(), reviewed_by = ${actor}
      where id = ${id} and status not in ('approved','attached')`
  );
}

/** Pass = a real look, declined — records intent on the candidate. */
/** Ignore = gone: the candidate row is deleted outright (the raw email row
 * stays for dedupe so the same message never re-mints). Promoted candidates
 * are never deleted this way. */
export async function deleteCandidate(id: string): Promise<boolean> {
  const rows = await withRetry(
    () => sql<{ id: string }[]>`
      delete from deal_candidates
      where id = ${id} and promoted_deal_gid is null
      returning id`
  );
  return rows.length > 0;
}

export async function passCandidate(id: string, actor: string): Promise<void> {
  await ensureCandidatesSchema();
  await withRetry(
    () => sql`
      update deal_candidates
      set status = 'passed', reviewed_at = now(), reviewed_by = ${actor}
      where id = ${id} and status not in ('approved','attached')`
  );
}

/** Reopen a passed/ignored candidate for another look. */
export async function reopenCandidate(id: string, actor: string): Promise<void> {
  await ensureCandidatesSchema();
  await withRetry(
    () => sql`
      update deal_candidates
      set status = 'ready', reviewed_at = null, reviewed_by = ${actor}
      where id = ${id} and status in ('passed','ignored')`
  );
}

/**
 * Attach the candidate to an EXISTING deal — the reopen-not-duplicate path.
 * The source email is stamped onto that deal; no new record is created.
 */
export async function attachCandidateToDeal(
  id: string,
  dealGid: string,
  actor: string
): Promise<void> {
  await ensureCandidatesSchema();
  await withRetry(
    () => sql`
      update deal_candidates
      set status = 'attached', promoted_deal_gid = ${dealGid},
          reviewed_at = now(), reviewed_by = ${actor}
      where id = ${id} and status not in ('approved','attached')`
  );
  await withRetry(
    () => sql`
      update inbound_emails e
      set deal_gid = ${dealGid}
      from deal_candidates c
      where c.id = ${id} and c.source_email_id = e.id and e.deal_gid is null`
  );
}

/** Mark promotion after createDealFromInbound succeeds. */
export async function markCandidatePromoted(
  id: string,
  dealGid: string,
  actor: string
): Promise<void> {
  await ensureCandidatesSchema();
  await withRetry(
    () => sql`
      update deal_candidates
      set status = 'approved', promoted_deal_gid = ${dealGid},
          reviewed_at = now(), reviewed_by = ${actor}
      where id = ${id}`
  );
}
