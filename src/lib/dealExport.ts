import { appUrl } from "@/config/crm.config";
import "server-only";
import { strToU8, zipSync, type Zippable } from "fflate";
import { sql } from "./db";
import { withRetry } from "./retry";
import { logError } from "./log";
import { splitDealName } from "./nameParts";
import { downloadDocument } from "./documents";
import {
  dealMarkdown,
  exportZipName,
  isoDayET,
  meetingMarkdown,
  manifestJson,
  orderComments,
  pad3,
  pitchEmailMarkdown,
  readmeMarkdown,
  safeFilename,
  slugify,
  teamNotesMarkdown,
  threadMarkdown,
  type ManifestFile,
  type XCounts,
  type XDeal,
  type XDocMeta,
  type XFounder,
  type XMeeting,
  type XPerson,
  type XPitchEmail,
  type XThread,
} from "./dealExportPure";

/**
 * ── Due-diligence export, server half ───────────────────────────────────────
 * Gathers everything the pipeline holds on one deal (record, founders,
 * meetings, emails, stored documents, team notes)
 * and hands back a ready-to-stream zip. Member-gated by the route; this file
 * assumes the caller already checked the session.
 */

const GID_RE = /^(\d{1,30}|local-[0-9a-f-]{36})$/;
const MAX_DOC_BYTES = 40 * 1024 * 1024; // per file; anything bigger is noted, not fetched

type Addr = { name?: string | null; email?: string | null } | null;

const asPerson = (a: Addr): XPerson => ({
  name: (a?.name ?? "").trim(),
  email: (a?.email ?? "").trim().toLowerCase(),
});

const asPeople = (list: unknown): XPerson[] =>
  Array.isArray(list) ? list.map((a) => asPerson(a as Addr)).filter((p) => p.name || p.email) : [];

const iso = (d: Date | string | null): string | null =>
  d ? new Date(d).toISOString() : null;

export interface DealExportBundle {
  zipName: string;
  company: string;
  /** path -> file body; text stays string until zipping. */
  entries: Map<string, string | Uint8Array>;
}

export async function collectDealExport(gid: string): Promise<DealExportBundle | null> {
  if (!GID_RE.test(gid)) return null;
  const dealRows = await withRetry(
    () => sql<
      {
        gid: string;
        name: string | null;
        notes: string | null;
        stage: string | null;
        schools: string[] | null;
        owner: string | null;
        source: string | null;
        met_at_event: string | null;
        financing_amount: string | null;
        round: string | null;
        created_on: Date | null;
      }[]
    >`
      select gid, name, notes, stage, schools, owner, source, met_at_event,
             financing_amount, round, created_on
      from deals where gid = ${gid}
    `
  );
  const row = dealRows[0];
  if (!row) return null;

  const generatedAt = new Date().toISOString();
  const { founder, company } = splitDealName(row.name ?? "");
  const deal: XDeal = {
    gid: row.gid,
    name: row.name ?? "",
    company,
    founderLine: founder,
    stage: row.stage,
    round: row.round,
    financing: row.financing_amount,
    schools: (row.schools ?? []).filter(Boolean),
    owner: row.owner,
    source: row.source,
    metAtEvent: row.met_at_event,
    createdOn: iso(row.created_on),
    notes: String(row.notes ?? ""),
  };

  // Two waves of reads, pool-friendly.
  const [founderRows, referralRows, meetingRows, threadRows] = await Promise.all([
    sql<
      {
        founder_role: string | null; name: string; school: string | null; degree: string | null;
        grad_year: number | null; current_title: string | null; current_organization: string | null;
        linkedin_url: string | null; email: string | null; personal_email: string | null;
        work_email: string | null; context_summary: string | null;
      }[]
    >`
      select df.founder_role, np.name, np.school, np.degree, np.grad_year,
             np.current_title, np.current_organization, np.linkedin_url,
             np.email, np.personal_email, np.work_email, np.context_summary
      from deal_founders df join network_people np on np.id = df.person_id
      where df.deal_gid = ${gid} order by df.created_at
    `,
    sql<{ name: string | null; email: string; hop: number }[]>`
      select name, email, hop from deal_referrals where deal_gid = ${gid} order by hop, created_at
    `,
    sql<
      {
        title: string | null; starts_at: Date | null; participants: unknown;
        summary_md: string | null; notes_md: string | null; note_url: string | null; provider: string | null;
      }[]
    >`
      select title, starts_at, participants, summary_md, notes_md, note_url, provider
      from meeting_notes
      where matched_deal_gid = ${gid}
        and (match_state is null or match_state <> 'dismissed')
      order by starts_at nulls last, imported_at
    `,
    sql<{ id: string; subject_norm: string | null; first_message_at: Date | null; last_message_at: Date | null }[]>`
      select id, subject_norm, first_message_at, last_message_at
      from email_threads where deal_gid = ${gid} order by first_message_at nulls last
    `,
  ]);
  const [pitchRows, commentRows, decisionRows] = await Promise.all([
    sql<
      { id: string; from_name: string | null; from_email: string | null; subject: string | null; received_at: Date | null; body_text: string | null }[]
    >`
      select distinct on (e.id)
             e.id, e.from_name, e.from_email, e.subject, e.received_at, e.body_text
      from inbound_emails e
      left join deal_candidates c on c.source_email_id = e.id
      where e.deal_gid = ${gid}
         or c.promoted_deal_gid = ${gid}
         or c.proposed_deal_gid = ${gid}
      order by e.id
    `,
    sql<
      { id: string; parent_id: string | null; author_name: string | null; author_email: string | null; body: string; created_at: Date | null }[]
    >`
      select id, parent_id, author_name, author_email, body, created_at
      from deal_comments where deal_gid = ${gid} order by created_at
    `,
    sql<{ decision: string; rationale: string | null; actor_name: string | null; actor_email: string | null; created_at: Date | null }[]>`
      select decision, rationale, actor_name, actor_email, created_at
      from deal_decisions where deal_gid = ${gid} order by created_at
    `,
  ]);

  const messageRows = threadRows.length
    ? await sql<
        {
          thread_id: string; direction: string | null; from_addr: unknown; to_addrs: unknown;
          cc_addrs: unknown; sent_at: Date | null; body_text: string | null; snippet: string | null;
        }[]
      >`
        select thread_id, direction, from_addr, to_addrs, cc_addrs, sent_at, body_text, snippet
        from email_messages
        where thread_id = any(${threadRows.map((t) => t.id)})
        order by sent_at nulls last
      `
    : [];

  const founders: XFounder[] = founderRows.map((f) => ({
    name: f.name,
    role: f.founder_role,
    school: f.school,
    degree: f.degree,
    gradYear: f.grad_year,
    title: f.current_title,
    organization: f.current_organization,
    linkedin: f.linkedin_url,
    emails: [...new Set([f.email, f.personal_email, f.work_email].filter((e): e is string => !!e))],
    context: f.context_summary,
  }));

  const meetings: XMeeting[] = meetingRows.map((m) => ({
    title: m.title ?? "",
    startsAt: iso(m.starts_at),
    participants: asPeople(m.participants),
    summaryMd: m.summary_md ?? "",
    notesMd: m.notes_md ?? "",
    noteUrl: m.note_url,
    provider: m.provider ?? "meeting notes",
  }));

  const pitches: XPitchEmail[] = pitchRows
    .map((p) => ({
      from: asPerson({ name: p.from_name, email: p.from_email }),
      subject: p.subject ?? "",
      receivedAt: iso(p.received_at),
      bodyText: p.body_text ?? "",
    }))
    .sort((a, b) => (a.receivedAt ?? "").localeCompare(b.receivedAt ?? ""));

  const threads: XThread[] = threadRows.map((t) => ({
    subject: t.subject_norm ?? "",
    firstAt: iso(t.first_message_at),
    lastAt: iso(t.last_message_at),
    messages: messageRows
      .filter((m) => m.thread_id === t.id)
      .map((m) => ({
        direction: m.direction ?? "unknown",
        from: asPerson(m.from_addr as Addr),
        to: asPeople(m.to_addrs),
        cc: asPeople(m.cc_addrs),
        sentAt: iso(m.sent_at),
        bodyText: m.body_text ?? m.snippet ?? "",
      })),
  }));

  const comments = orderComments(
    commentRows.map((c) => ({
      id: c.id,
      parentId: c.parent_id,
      author: c.author_name || c.author_email || "unknown",
      at: iso(c.created_at),
      body: c.body,
    }))
  );
  const decisions = decisionRows.map((d) => ({
    decision: d.decision,
    rationale: d.rationale ?? "",
    actor: d.actor_name || d.actor_email || "unknown",
    at: iso(d.created_at),
  }));
  /* ── Raw documents: stored bucket files ───────────────────────────────── */

  const warnings: string[] = [];
  const docRows = await sql<
    {
      filename: string; mime: string; bytes: number; checksum: string;
      storage_key: string; source_type: string; retrieved_at: Date | null;
    }[]
  >`
    select distinct on (d.checksum)
           d.filename, d.mime, d.bytes, d.checksum, d.storage_key, d.source_type, d.retrieved_at
    from documents d
    left join deal_candidates c on c.source_email_id = d.source_email_id
    left join inbound_emails e on e.id = d.source_email_id
    where d.status = 'ready'
      and (d.deal_gid = ${gid}
        or c.promoted_deal_gid = ${gid}
        or c.proposed_deal_gid = ${gid}
        or e.deal_gid = ${gid})
    order by d.checksum, d.retrieved_at
  `;

  type RawDoc = { filename: string; mime: string; date: string | null; source: string; bytes: Uint8Array };
  const rawDocs: RawDoc[] = [];

  // Stored documents, three at a time.
  for (let i = 0; i < docRows.length; i += 3) {
    const wave = docRows.slice(i, i + 3);
    const got = await Promise.all(
      wave.map(async (d) => {
        if (d.bytes > MAX_DOC_BYTES) return { d, buf: null as Buffer | null };
        const buf = await downloadDocument(d.storage_key);
        return { d, buf };
      })
    );
    for (const { d, buf } of got) {
      if (buf) {
        rawDocs.push({
          filename: d.filename,
          mime: d.mime,
          date: iso(d.retrieved_at),
          source: "stored",
          bytes: new Uint8Array(buf),
        });
      } else {
        warnings.push(`Could not include stored document "${d.filename}" (${d.source_type}).`);
      }
    }
  }

  /* ── Assemble the bundle ─────────────────────────────────────────────── */

  const entries = new Map<string, string | Uint8Array>();
  const files: ManifestFile[] = [];
  const put = (path: string, body: string | Uint8Array, type: string, title: string, date: string | null) => {
    entries.set(path, body);
    files.push({ path, type, title, date });
  };

  put("deal.md", dealMarkdown(deal, founders, referralRows, generatedAt, appUrl()), "deal_record", deal.company, deal.createdOn);

  meetings.forEach((m, i) => {
    const path = `meetings/${pad3(i + 1)}-${isoDayET(m.startsAt)}-${slugify(m.title || "meeting")}.md`;
    put(path, meetingMarkdown(m), "meeting_note", m.title || "Meeting", m.startsAt);
  });

  let mailIdx = 0;
  for (const p of pitches) {
    const path = `emails/${pad3(++mailIdx)}-${isoDayET(p.receivedAt)}-pitch-${slugify(p.subject || "inbound")}.md`;
    put(path, pitchEmailMarkdown(p), "inbound_pitch", p.subject || "Inbound pitch", p.receivedAt);
  }
  for (const t of threads) {
    const path = `emails/${pad3(++mailIdx)}-${isoDayET(t.firstAt)}-thread-${slugify(t.subject || "thread")}.md`;
    put(path, threadMarkdown(t), "email_thread", t.subject || "Email thread", t.firstAt);
  }

  const docMetas: XDocMeta[] = [];
  const seenPaths = new Set<string>();
  rawDocs.forEach((d, i) => {
    let path = `documents/${pad3(i + 1)}-${safeFilename(d.filename)}`;
    while (seenPaths.has(path)) path = path.replace(/(\.[a-z0-9]+)$/, `-x$1`);
    seenPaths.add(path);
    entries.set(path, d.bytes);
    files.push({ path, type: "document", title: d.filename, date: d.date });
    docMetas.push({ path, filename: d.filename, mime: d.mime, bytes: d.bytes.byteLength, source: d.source, date: d.date });
  });

  if (decisions.length || comments.length) {
    put("team-notes.md", teamNotesMarkdown(decisions, comments), "team_notes", "Team notes", null);
  }

  const counts: XCounts = {
    meetings: meetings.length,
    pitchEmails: pitches.length,
    emailThreads: threads.length,
    documents: docMetas.length,
    comments: comments.length,
    decisions: decisions.length,
  };
  entries.set("README.md", readmeMarkdown(deal.company, counts, generatedAt, warnings));
  entries.set(
    "manifest.json",
    manifestJson({ deal, founders, files, counts, generatedAt, warnings, recordBase: appUrl() })
  );

  return { zipName: exportZipName(deal.company, generatedAt), company: deal.company, entries };
}

/** Bundle -> zip bytes. Text deflates; documents are stored as-is (already
 *  compressed formats; recompressing buys nothing and costs CPU). */
export function zipDealExport(bundle: DealExportBundle): Uint8Array {
  const zippable: Zippable = {};
  for (const [path, body] of bundle.entries) {
    zippable[path] =
      typeof body === "string" ? [strToU8(body), { level: 6 }] : [body, { level: 0 }];
  }
  return zipSync(zippable);
}
