import "server-only";
import { sql } from "./db";
import { withRetry } from "./retry";
import { logError } from "./log";
import { INTERNAL_DOMAINS } from "./companiesPure";
import { findCompany } from "./companies";
import { findLikelyDuplicates, type DuplicateHit } from "./people";
import {
  UNTRUSTED_NOTICE,
  callClaude,
  fenceUntrusted,
  modelJson,
} from "./llm";
import {
  companyNameFromDomain,
  REVIEW_EXTRACT_VERSION,
  domainOf,
  isGenericDomain,
  seedPeople,
  validateExtraction,
  type NoteExtraction,
  type XPerson,
} from "./meetingReviewPure";

/**
 * ── Granola review workspace: extract → match → enrich ─────────────────────
 * One bounded model call per note, cached forever in meeting_notes.extracted
 * (re-opening a note is free). Matching is plain SQL against the CRM that
 * already exists. Enrichment is the same Sixtyfour plumbing the rest of the
 * product uses, run only when a human presses Enrich, cached in
 * meeting_notes.enrich. Nothing here writes to a deal or person — commit
 * lives with the other mutations in actions.ts.
 */

const INTERNAL_RE = new RegExp(
  `@(${[...INTERNAL_DOMAINS].map((d) => d.replace(/\./g, "\\.")).join("|")})$`,
  "i"
);

interface NoteRow {
  id: string;
  title: string | null;
  starts_at: Date | null;
  participants: { name?: string | null; email?: string | null }[];
  summary_md: string | null;
  notes_md: string | null;
  note_url: string | null;
  matched_deal_gid: string | null;
  match_state: string;
  extracted: (NoteExtraction & { at?: string }) | null;
  enrich: NoteEnrichment | null;
}

export interface NoteEnrichment {
  company?: EnrichSlot;
  people?: Record<string, EnrichSlot>;
}
export interface EnrichSlot {
  status: "done" | "error";
  at: string;
  fields?: Record<string, string | null>;
  note?: string;
}

async function loadNote(noteId: string): Promise<NoteRow | null> {
  const rows = await withRetry(
    () => sql<NoteRow[]>`
      select id, title, starts_at, participants, summary_md, notes_md, note_url,
             matched_deal_gid, match_state, extracted, enrich
        from meeting_notes where id = ${noteId}`
  );
  return rows[0] ?? null;
}

/* ── Extraction ──────────────────────────────────────────────────────────── */

function seedsFor(note: NoteRow): XPerson[] {
  return seedPeople(
    (note.participants ?? []).map((p) => ({
      name: p.name ?? null,
      email: p.email ?? null,
    })),
    INTERNAL_RE
  );
}

/**
 * Structured facts for the note — cached per extractor version. The model
 * sees the attendee list as trusted context and the note fenced as untrusted
 * text; everything it claims is re-verified against the note verbatim in
 * validateExtraction before anything survives.
 *
 * llm:false is the free path (page open): the cached extraction when one
 * exists, otherwise calendar seeds only — no model call, nothing persisted.
 * The model runs solely on the Enrich click.
 */
export async function extractForNote(
  noteId: string,
  opts: { force?: boolean; llm?: boolean } = {}
): Promise<(NoteExtraction & { llmRan?: boolean }) | null> {
  const note = await loadNote(noteId);
  if (!note) return null;
  if (!opts.force && note.extracted?.version === REVIEW_EXTRACT_VERSION) {
    return { ...note.extracted, llmRan: true };
  }

  const seeds = seedsFor(note);
  const source = [note.summary_md, note.notes_md].filter(Boolean).join("\n\n");
  let extraction: NoteExtraction = {
    version: REVIEW_EXTRACT_VERSION,
    company: null,
    financing: null,
    people: seeds,
  };
  if (opts.llm === false) {
    return { ...extraction, llmRan: false };
  }

  if (source.trim()) {
    try {
      const attendeeLine = seeds
        .map((s) => `${s.name}${s.email ? ` <${s.email}>` : ""}`)
        .join("; ");
      const text = await callClaude({
        job: "note_review",
        model: process.env.INBOUND_MODEL ?? "claude-sonnet-4-6",
        maxTokens: 1000,
        system: `You extract structured facts from a VC's meeting note. Return JSON only:
{"company": {"name", "domain", "description", "location", "evidence"} | null,
 "financing": {"amount", "security", "round", "valuation", "status": "current"|"planned"|"historical"|"discussed", "targetClose", "investors": [], "evidence"} | null,
 "people": [{"name", "email", "title", "company", "school", "gradYear", "city", "linkedin", "role": "founder"|"advisor"|"investor"|"customer"|"team"|"unknown", "evidence"}]}
Rules:
- null for anything the note does not state. Never guess or invent.
- school/gradYear/city/linkedin only when the note itself states them ("CS + Econ at Harvard" → school "Harvard").
- "evidence" is a VERBATIM quote from the note supporting the fact (required for company, financing, and any person not in the attendee list).
- Keep amounts exactly as written — "$3M–$5M" stays "$3M–$5M".
- Grants, government awards, contracts, and revenue are NOT financing. A NIST/NSF/SBIR award is never the round size.
- status: "planned" for a raise being organized, "current" for one open now, "historical" for past rounds, "discussed" when merely mentioned.
- people: only humans in this meeting or explicitly named in the note. Max 8.
No markdown. JSON only.

${UNTRUSTED_NOTICE}`,
        content: `Attendees (from the calendar): ${attendeeLine || "unknown"}\nMeeting title: ${JSON.stringify(
          (note.title ?? "").slice(0, 200)
        )}\n\nThe note:\n${fenceUntrusted(source, 14_000)}`,
        timeoutMs: 30_000,
      });
      const json = text === null ? null : modelJson(text);
      extraction = validateExtraction(json, source, seeds);
      // Visibility when validation rejects what the model claimed.
      const raw = (json ?? {}) as { company?: unknown; financing?: unknown };
      if ((raw.company && !extraction.company) || (raw.financing && !extraction.financing)) {
        const { logEvent } = await import("./log");
        logEvent("info", "granola", "review facts dropped by validation", {
          note: noteId,
          company: !!raw.company && !extraction.company,
          financing: !!raw.financing && !extraction.financing,
        });
      }
    } catch (err) {
      logError("granola", "note review extraction failed", err, { note: noteId });
      // Seeds alone still make a usable review screen.
    }
  }

  await withRetry(
    () => sql`
      update meeting_notes
         set extracted = ${sql.json({ ...extraction, at: new Date().toISOString() } as never)}
       where id = ${noteId}`
  ).catch(() => undefined);

  // Field-level provenance for what the model claimed (best effort).
  void recordClaims(noteId, extraction);
  return extraction;
}

async function recordClaims(noteId: string, x: NoteExtraction): Promise<void> {
  try {
    const rows: { field: string; value: unknown; span: string | null }[] = [];
    if (x.company) rows.push({ field: "company", value: x.company, span: x.company.evidence });
    if (x.financing) rows.push({ field: "financing", value: x.financing, span: x.financing.evidence });
    for (const p of x.people) {
      if (!p.fromCalendar) rows.push({ field: "person", value: p, span: p.evidence });
    }
    for (const r of rows.slice(0, 12)) {
      await sql`
        insert into extracted_claims (subject_type, subject_id, field, value, source_type, source_ref, source_span, confidence)
        select 'meeting_note', ${noteId}, ${r.field}, ${sql.json(r.value as never)}, 'granola', ${noteId}, ${r.span}, null
        where not exists (
          select 1 from extracted_claims
           where subject_type = 'meeting_note' and subject_id = ${noteId}
             and field = ${r.field} and source_span is not distinct from ${r.span})`;
    }
  } catch {
    // Claims are an audit trail, never a blocker.
  }
}

/* ── Matching ────────────────────────────────────────────────────────────── */

export interface CompanyMatchView {
  state: "existing" | "new" | "none";
  companyId: string | null;
  companyName: string | null;
  evidence: string | null;
  deals: { gid: string; name: string; stage: string; round: string | null; owner: string | null }[];
}
export interface PersonMatchView {
  key: string;
  state: "existing" | "possible" | "new" | "insufficient";
  personId: string | null;
  label: string | null;
  candidates: { id: string; name: string; school: string | null; reason: string }[];
}
export interface NoteMatches {
  company: CompanyMatchView;
  people: PersonMatchView[];
}

export async function matchForNote(noteId: string, x: NoteExtraction): Promise<NoteMatches> {
  const note = await loadNote(noteId);
  const domains = [
    ...new Set(
      [
        x.company?.domain ?? null,
        ...x.people.map((p) => domainOf(p.email)),
      ].filter((d): d is string => !!d && !isGenericDomain(d) && !INTERNAL_RE.test(`@${d}`))
    ),
  ];

  const company: CompanyMatchView = {
    state: "none",
    companyId: null,
    companyName: x.company?.name ?? null,
    evidence: null,
    deals: [],
  };
  const lookupName = x.company?.name ?? (domains[0] ? domains[0].split(".")[0] : null);
  // No company in the note? The attendee's work domain still names it —
  // the card proposes "New deal: Gentle" instead of an empty Create.
  if (!company.companyName && domains[0]) {
    company.companyName = companyNameFromDomain(domains[0]);
  }
  if (lookupName) {
    company.state = "new";
    const hit = await findCompany(lookupName, domains[0] ?? null).catch(() => null);
    if (hit && (hit.autoLink || hit.evidence === "domain")) {
      company.state = "existing";
      company.companyId = hit.company.id;
      company.companyName = hit.company.canonical_name;
      company.evidence = hit.evidence;
    }
    // Deals that could already be this company's record.
    // Whole-word match: "gentle" must not surface "Aigentless".
    const namePat = `\\m${lookupName.slice(0, 60).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\M`;
    const deals = await withRetry(
      () => sql<{ gid: string; name: string; stage: string; round: string | null; owner: string | null }[]>`
        select d.gid, d.name, d.stage, d.round, d.owner
          from deals d
         where (${company.companyId}::uuid is not null and d.company_id = ${company.companyId})
            or d.name ~* ${namePat}
         order by d.modified_on desc nulls last
         limit 5`
    ).catch(() => []);
    company.deals = deals;
    if (note?.matched_deal_gid && !deals.some((d) => d.gid === note.matched_deal_gid)) {
      const cur = await sql<{ gid: string; name: string; stage: string; round: string | null; owner: string | null }[]>`
        select gid, name, stage, round, owner from deals where gid = ${note.matched_deal_gid}`.catch(() => []);
      if (cur[0]) company.deals = [cur[0], ...deals].slice(0, 5);
    }
  }

  const people: PersonMatchView[] = [];
  for (const p of x.people) {
    const view: PersonMatchView = {
      key: p.key,
      state: "new",
      personId: null,
      label: null,
      candidates: [],
    };
    if (p.email) {
      const hit = await withRetry(
        () => sql<{ id: string; name: string; line: string | null }[]>`
          select np.id, np.name,
                 nullif(concat_ws(' · ', nullif(np.current_title, ''), nullif(np.current_organization, ''), nullif(np.school, '')), '') as line
            from network_people np
           where lower(np.email) = ${p.email}
              or ${p.email} = any(coalesce(np.alt_emails, '{}'))
           limit 1`
      ).catch(() => []);
      if (hit[0]) {
        view.state = "existing";
        view.personId = hit[0].id;
        view.label = hit[0].line;
        people.push(view);
        continue;
      }
    }
    const dupes: DuplicateHit[] = await findLikelyDuplicates({
      name: p.name,
      email: p.email ?? "",
      linkedinUrl: "",
      school: "",
    }).catch(() => []);
    if (dupes.length > 0) {
      view.state = "possible";
      view.candidates = dupes.slice(0, 3).map((d) => ({
        id: d.id,
        name: d.name,
        school: d.school ?? null,
        reason: d.reason,
      }));
    } else if (!p.email && !p.name.includes(" ")) {
      view.state = "insufficient";
    }
    people.push(view);
  }

  return { company, people };
}

/* ── Enrichment (explicit button, cached, fill-empty-only downstream) ────── */

/**
 * Cheap first: one Perplexity sonar lookup answers most surface facts
 * (LinkedIn, school, city, website) in seconds for fractions of a cent.
 * Sixtyfour — slow and credit-priced — runs only when the web pass finds
 * nothing usable.
 */
async function webJson(prompt: string, job: string): Promise<Record<string, unknown> | null> {
  const key = process.env.PERPLEXITY_API_KEY;
  if (!key) return null;
  const t0 = performance.now();
  const res = await fetch("https://api.perplexity.ai/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: process.env.PERPLEXITY_MODEL ?? "sonar",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 350,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) return null;
  void import("./perf").then((p) => p.record(`llm.${job}`, performance.now() - t0)).catch(() => {});
  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const content = data.choices?.[0]?.message?.content ?? "";
  const { modelJson } = await import("./llm");
  return modelJson(content) as Record<string, unknown> | null;
}

const str2 = (v: unknown, max: number) =>
  typeof v === "string" && v.trim() && !/^null$/i.test(v.trim()) ? v.trim().slice(0, max) : null;

async function webPersonLookup(p: {
  name: string;
  title: string | null;
  company: string | null;
  email: string | null;
}): Promise<Record<string, string | null> | null> {
  const who = [p.name, p.title, p.company ? `at ${p.company}` : null, p.email ? `(email ${p.email})` : null]
    .filter(Boolean)
    .join(", ");
  const json = await webJson(
    `Find public professional facts about ${who}. Reply with ONLY JSON, no prose: {"linkedin": "full linkedin.com/in URL or null", "school": "university name or null", "grad_year": "4-digit year or null", "city": "city they are based in or null", "title": "current title or null", "company": "current company or null"}. Use null for anything you are not confident belongs to this exact person.`,
    "web_person"
  ).catch(() => null);
  if (!json) return null;
  const li = str2(json.linkedin, 300);
  const yr = str2(json.grad_year, 12);
  return {
    linkedin: li && /linkedin\.com\//i.test(li) ? li : null,
    school: str2(json.school, 120),
    grad_year: yr && /\b(19|20)\d{2}\b/.test(yr) ? (yr.match(/\b(19|20)\d{2}\b/) ?? [null])[0] : null,
    location: str2(json.city, 120),
    title: str2(json.title, 120),
    company: str2(json.company, 120),
  };
}

async function webCompanyLookup(name: string, domain: string | null): Promise<Record<string, string | null> | null> {
  const json = await webJson(
    `Find public facts about the startup "${name}"${domain ? ` (website domain ${domain})` : ""}. Reply with ONLY JSON, no prose: {"description": "one sentence on what they do or null", "website": "URL or null", "location": "HQ city or null", "linkedin": "linkedin.com/company URL or null", "last_round": "most recent financing round and amount or null"}. Use null for anything uncertain or belonging to a different company with the same name.`,
    "web_company"
  ).catch(() => null);
  if (!json) return null;
  const li = str2(json.linkedin, 200);
  return {
    description: str2(json.description, 300),
    website: str2(json.website, 200),
    location: str2(json.location, 120),
    linkedin: li && /linkedin\.com\//i.test(li) ? li : null,
    last_round: str2(json.last_round, 200),
    founders: null,
  };
}

const ENRICH_COOLDOWN_MS = 5 * 60 * 1000;

function slotFresh(slot: EnrichSlot | undefined): boolean {
  return !!slot && Date.now() - Date.parse(slot.at) < ENRICH_COOLDOWN_MS && slot.status === "done";
}

async function saveEnrich(noteId: string, patch: (cur: NoteEnrichment) => NoteEnrichment): Promise<void> {
  const rows = await sql<{ enrich: NoteEnrichment | null }[]>`
    select enrich from meeting_notes where id = ${noteId}`;
  const next = patch(rows[0]?.enrich ?? {});
  await sql`update meeting_notes set enrich = ${sql.json(next as never)} where id = ${noteId}`;
}

export async function enrichCompanyForNote(noteId: string): Promise<EnrichSlot> {
  const note = await loadNote(noteId);
  const x = note?.extracted;
  if (!note || !x?.company?.name) {
    return { status: "error", at: new Date().toISOString(), note: "No company to enrich." };
  }
  if (slotFresh(note.enrich?.company)) return note.enrich!.company!;

  // Surface pass: one cheap web lookup answers most of this.
  const web = await webCompanyLookup(x.company.name, x.company.domain);
  if (web && (web.description || web.website || web.location)) {
    const slot: EnrichSlot = { status: "done", at: new Date().toISOString(), fields: web };
    await saveEnrich(noteId, (cur) => ({ ...cur, company: slot })).catch(() => undefined);
    return slot;
  }

  // The web pass above is the whole enrichment; nothing deeper is configured.
  return { status: "error", at: new Date().toISOString(), note: "Nothing found on the web." };
}

export async function enrichPersonForNote(noteId: string, key: string): Promise<EnrichSlot> {
  const note = await loadNote(noteId);
  const person = note?.extracted?.people.find((p) => p.key === key);
  if (!note || !person) {
    return { status: "error", at: new Date().toISOString(), note: "No such person on this note." };
  }
  const existing = note.enrich?.people?.[key];
  if (slotFresh(existing)) return existing!;

  // Surface pass: LinkedIn, school, and city are usually one search away.
  const companyCtx = person.company ?? note.extracted?.company?.name ?? null;
  const web = await webPersonLookup({
    name: person.name,
    title: person.title,
    company: companyCtx,
    email: person.email,
  });
  if (web && (web.linkedin || web.school || web.location)) {
    const slot: EnrichSlot = { status: "done", at: new Date().toISOString(), fields: web };
    await saveEnrich(noteId, (cur) => ({
      ...cur,
      people: { ...(cur.people ?? {}), [key]: slot },
    })).catch(() => undefined);
    return slot;
  }

  return { status: "error", at: new Date().toISOString(), note: "Nothing found on the web." };
}
