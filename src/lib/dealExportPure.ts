/**
 * ── Due-diligence export, pure half ─────────────────────────────────────────
 * Composers for the zip a deal exports to: every artifact on the deal
 * (record, meetings, emails, documents, team notes) as clean markdown
 * plus a machine-readable manifest, structured so an AI model can ingest the
 * bundle and run diligence without ever seeing our database. No IO here —
 * the server half (dealExport.ts) fetches rows and bytes, this file turns
 * them into files.
 */
import { crm } from "@/config/crm.config";


export interface XPerson {
  name: string;
  email: string;
}

export interface XDeal {
  gid: string;
  name: string;
  company: string;
  founderLine: string;
  stage: string | null;
  round: string | null;
  financing: string | null;
  schools: string[];
  owner: string | null;
  source: string | null;
  metAtEvent: string | null;
  createdOn: string | null; // ISO
  notes: string;
}

export interface XFounder {
  name: string;
  role: string | null;
  school: string | null;
  degree: string | null;
  gradYear: number | null;
  title: string | null;
  organization: string | null;
  linkedin: string | null;
  emails: string[];
  context: string | null;
}

export interface XReferral {
  name: string | null;
  email: string;
  hop: number;
}

export interface XMeeting {
  title: string;
  startsAt: string | null; // ISO
  participants: XPerson[];
  summaryMd: string;
  notesMd: string;
  noteUrl: string | null;
  provider: string;
}

export interface XPitchEmail {
  from: XPerson;
  subject: string;
  receivedAt: string | null;
  bodyText: string;
}

export interface XMessage {
  direction: string;
  from: XPerson;
  to: XPerson[];
  cc: XPerson[];
  sentAt: string | null;
  bodyText: string;
}

export interface XThread {
  subject: string;
  firstAt: string | null;
  lastAt: string | null;
  messages: XMessage[];
}

export interface XComment {
  author: string;
  at: string | null;
  body: string;
  depth: number;
}

export interface XDecision {
  decision: string;
  rationale: string;
  actor: string;
  at: string | null;
}

export interface XDocMeta {
  path: string;
  filename: string;
  mime: string;
  bytes: number;
  source: string; // 'stored'
  date: string | null;
}

export interface XCounts {
  meetings: number;
  pitchEmails: number;
  emailThreads: number;
  documents: number;
  comments: number;
  decisions: number;
}

/* ── Formatting ──────────────────────────────────────────────────────────── */

const ET_DATE = new Intl.DateTimeFormat("en-US", {
  timeZone: crm.org.timezone,
  year: "numeric",
  month: "short",
  day: "numeric",
});
const ET_DATETIME = new Intl.DateTimeFormat("en-US", {
  timeZone: crm.org.timezone,
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZoneName: "short",
});
const ET_ISO_DAY = new Intl.DateTimeFormat("en-CA", {
  timeZone: crm.org.timezone,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export function fmtET(iso: string | null | undefined, withTime = false): string {
  if (!iso) return "unknown date";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "unknown date";
  return (withTime ? ET_DATETIME : ET_DATE).format(d);
}

/** YYYY-MM-DD in ET, for filename prefixes; "undated" when missing. */
export function isoDayET(iso: string | null | undefined): string {
  if (!iso) return "undated";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "undated";
  return ET_ISO_DAY.format(d);
}

export function slugify(s: string, max = 48): string {
  const slug = s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/g, "");
  return slug || "untitled";
}

/** Zip-safe filename for a raw document: strips path tricks, clamps the base,
 *  keeps the extension. */
export function safeFilename(name: string, fallbackExt = "pdf"): string {
  const base = name.split(/[/\\]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  const ext = (dot > 0 ? base.slice(dot + 1) : fallbackExt)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 8) || fallbackExt;
  const stem = slugify(dot > 0 ? base.slice(0, dot) : base, 80);
  return `${stem}.${ext}`;
}

export const pad3 = (n: number): string => String(n).padStart(3, "0");

const person = (p: XPerson): string =>
  p.name && p.email ? `${p.name} <${p.email}>` : p.name || p.email || "unknown";

const people = (list: XPerson[]): string =>
  list.length ? list.map(person).join(", ") : "none recorded";

/* ── File composers ──────────────────────────────────────────────────────── */

export function dealMarkdown(
  d: XDeal,
  founders: XFounder[],
  referrals: XReferral[],
  generatedAt: string,
  recordBase = ""
): string {
  const lines: string[] = [];
  lines.push(`# ${d.company}`);
  lines.push("");
  lines.push(`${crm.org.name} deal record. Exported ${fmtET(generatedAt, true)}. Confidential.`);
  lines.push("");
  lines.push("## Snapshot");
  lines.push("");
  const snap: [string, string | null][] = [
    ["Company", d.company],
    ["Founders", founders.length ? founders.map((f) => f.name).join(", ") : d.founderLine || null],
    ["Round", d.round],
    ["Raising", d.financing],
    ["Schools", d.schools.length ? d.schools.join(", ") : null],
    ["Board stage", d.stage],
    ["Owner", d.owner],
    ["Source", d.source],
    ["Met at", d.metAtEvent],
    ["First seen", d.createdOn ? fmtET(d.createdOn) : null],
    ["Record", recordBase ? `${recordBase}/deals/${d.gid}` : null],
  ];
  for (const [k, v] of snap) if (v) lines.push(`- ${k}: ${v}`);
  if (founders.length) {
    lines.push("");
    lines.push("## Founders");
    for (const f of founders) {
      lines.push("");
      lines.push(`### ${f.name}${f.role ? ` (${f.role})` : ""}`);
      const edu = [f.school, f.degree, f.gradYear ? `Class of ${f.gradYear}` : null]
        .filter(Boolean)
        .join(", ");
      if (edu) lines.push(`- Education: ${edu}`);
      const job = [f.title, f.organization].filter(Boolean).join(", ");
      if (job) lines.push(`- Role: ${job}`);
      if (f.linkedin) lines.push(`- LinkedIn: ${f.linkedin}`);
      if (f.emails.length) lines.push(`- Email: ${f.emails.join(", ")}`);
      if (f.context) lines.push(`- Context: ${f.context}`);
    }
  }
  if (referrals.length) {
    lines.push("");
    lines.push("## Referred by");
    lines.push("");
    for (const r of referrals)
      lines.push(`- ${r.name ? `${r.name} <${r.email}>` : r.email}${r.hop > 1 ? ` (hop ${r.hop})` : ""}`);
  }
  const notes = d.notes.trim();
  if (notes) {
    lines.push("");
    lines.push("## Deal notes");
    lines.push("");
    lines.push(notes);
  }
  lines.push("");
  return lines.join("\n");
}

export function meetingMarkdown(m: XMeeting): string {
  const lines: string[] = [];
  lines.push(`# Meeting: ${m.title || "Untitled meeting"}`);
  lines.push("");
  lines.push(`- When: ${fmtET(m.startsAt, true)}`);
  lines.push(`- Participants: ${people(m.participants)}`);
  lines.push(`- Source: ${m.provider}${m.noteUrl ? ` (${m.noteUrl})` : ""}`);
  const summary = m.summaryMd.trim();
  const notes = m.notesMd.trim();
  if (summary) {
    lines.push("");
    lines.push("## Summary");
    lines.push("");
    lines.push(summary);
  }
  if (notes && notes !== summary) {
    lines.push("");
    lines.push("## Full notes");
    lines.push("");
    lines.push(notes);
  }
  if (!summary && !notes) {
    lines.push("");
    lines.push("No notes captured for this meeting.");
  }
  lines.push("");
  return lines.join("\n");
}

export function pitchEmailMarkdown(p: XPitchEmail): string {
  const lines: string[] = [];
  lines.push(`# Inbound pitch: ${p.subject || "(no subject)"}`);
  lines.push("");
  lines.push(`- From: ${person(p.from)}`);
  lines.push(`- Received: ${fmtET(p.receivedAt, true)}`);
  lines.push("");
  lines.push(p.bodyText.trim() || "(no text body captured)");
  lines.push("");
  return lines.join("\n");
}

export function threadMarkdown(t: XThread): string {
  const lines: string[] = [];
  lines.push(`# Email thread: ${t.subject || "(no subject)"}`);
  lines.push("");
  lines.push(
    `${t.messages.length} message${t.messages.length === 1 ? "" : "s"}, ` +
      `${fmtET(t.firstAt)} to ${fmtET(t.lastAt)}.`
  );
  for (const m of t.messages) {
    lines.push("");
    lines.push("---");
    lines.push("");
    lines.push(`From: ${person(m.from)}`);
    lines.push(`To: ${people(m.to)}`);
    if (m.cc.length) lines.push(`Cc: ${people(m.cc)}`);
    lines.push(`Date: ${fmtET(m.sentAt, true)}`);
    lines.push("");
    lines.push(m.bodyText.trim() || "(no text body captured)");
  }
  lines.push("");
  return lines.join("\n");
}

export function teamNotesMarkdown(decisions: XDecision[], comments: XComment[]): string {
  const lines: string[] = [];
  lines.push("# Team notes");
  lines.push("");
  lines.push(`Internal ${crm.org.name} discussion and verdicts on this deal. Chronological.`);
  if (decisions.length) {
    lines.push("");
    lines.push("## Decisions");
    for (const d of decisions) {
      lines.push("");
      lines.push(`### ${d.decision} by ${d.actor} on ${fmtET(d.at)}`);
      if (d.rationale.trim()) {
        lines.push("");
        lines.push(d.rationale.trim());
      }
    }
  }
  if (comments.length) {
    lines.push("");
    lines.push("## Comments");
    lines.push("");
    for (const c of comments) {
      const stamp = `${c.author} on ${fmtET(c.at, true)}:`;
      const body = c.body.trim().split("\n");
      if (c.depth > 0) {
        lines.push(`> ${stamp}`);
        for (const b of body) lines.push(`> ${b}`);
      } else {
        lines.push(stamp);
        lines.push(...body);
      }
      lines.push("");
    }
  }
  return lines.join("\n");
}

/** Comment rows (with parent ids) into a flat chronological list, replies
 *  directly under their root and marked with depth. */
export function orderComments(
  rows: { id: string; parentId: string | null; author: string; at: string | null; body: string }[]
): XComment[] {
  const roots = rows.filter((r) => !r.parentId || !rows.some((x) => x.id === r.parentId));
  const byTime = (a: { at: string | null }, b: { at: string | null }) =>
    (a.at ?? "").localeCompare(b.at ?? "");
  roots.sort(byTime);
  const out: XComment[] = [];
  for (const root of roots) {
    out.push({ author: root.author, at: root.at, body: root.body, depth: 0 });
    const replies = rows.filter((r) => r.parentId === root.id).sort(byTime);
    for (const r of replies) out.push({ author: r.author, at: r.at, body: r.body, depth: 1 });
  }
  return out;
}

export function readmeMarkdown(
  company: string,
  counts: XCounts,
  generatedAt: string,
  warnings: string[]
): string {
  const lines: string[] = [];
  lines.push(`# ${company}: due-diligence bundle`);
  lines.push("");
  lines.push(
    `Exported from the ${crm.org.name} pipeline on ${fmtET(generatedAt, true)}. ` +
      "Confidential. Everything the team has on this deal, structured for an AI model " +
      "(or a human) to run due diligence."
  );
  lines.push("");
  lines.push("## Contents");
  lines.push("");
  lines.push("- `manifest.json`: machine-readable index of every file in this bundle");
  lines.push("- `deal.md`: the deal record, founders, referral chain, and full deal notes");
  if (counts.meetings) lines.push(`- \`meetings/\`: ${counts.meetings} meeting note${counts.meetings === 1 ? "" : "s"}, chronological`);
  if (counts.pitchEmails + counts.emailThreads) {
    const parts: string[] = [];
    if (counts.pitchEmails)
      parts.push(`${counts.pitchEmails} inbound pitch${counts.pitchEmails === 1 ? "" : "es"}`);
    if (counts.emailThreads)
      parts.push(`${counts.emailThreads} synced thread${counts.emailThreads === 1 ? "" : "s"}`);
    lines.push(`- \`emails/\`: ${parts.join(" and ")}`);
  }
  if (counts.documents) lines.push(`- \`documents/\`: ${counts.documents} raw file${counts.documents === 1 ? "" : "s"} (decks, PDFs, attachments)`);
  if (counts.decisions + counts.comments) lines.push("- `team-notes.md`: internal decisions and comment thread");
  lines.push("");
  lines.push("## Reading order");
  lines.push("");
  lines.push(
    "Start with `deal.md`, then `documents/` for the pitch materials, then `meetings/` " +
      "and `emails/` for what the founders said over time. `team-notes.md` holds the " +
      "team's own view; weigh it separately from the founders' claims."
  );
  if (warnings.length) {
    lines.push("");
    lines.push("## Gaps");
    lines.push("");
    for (const w of warnings) lines.push(`- ${w}`);
  }
  lines.push("");
  return lines.join("\n");
}

export interface ManifestFile {
  path: string;
  type: string;
  title: string;
  date: string | null;
}

export function manifestJson(opts: {
  deal: XDeal;
  founders: XFounder[];
  files: ManifestFile[];
  counts: XCounts;
  generatedAt: string;
  warnings: string[];
  /** Public base URL of this app, to link back to the record. */
  recordBase?: string;
}): string {
  return JSON.stringify(
    {
      kind: "opendeal-diligence-bundle",
      version: 1,
      generatedAt: opts.generatedAt,
      deal: {
        gid: opts.deal.gid,
        company: opts.deal.company,
        founders: opts.founders.map((f) => ({
          name: f.name,
          role: f.role,
          school: f.school,
          gradYear: f.gradYear,
          linkedin: f.linkedin,
        })),
        round: opts.deal.round,
        raising: opts.deal.financing,
        schools: opts.deal.schools,
        boardStage: opts.deal.stage,
        owner: opts.deal.owner,
        firstSeen: opts.deal.createdOn,
        record: opts.recordBase ? `${opts.recordBase}/deals/${opts.deal.gid}` : null,
      },
      counts: opts.counts,
      files: opts.files,
      warnings: opts.warnings,
    },
    null,
    2
  );
}

export function exportZipName(company: string, generatedAt: string): string {
  return `dd-${slugify(company, 40)}-${isoDayET(generatedAt)}.zip`;
}
