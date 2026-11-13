import "server-only";
import { sql } from "./db";
import { withRetry } from "./retry";
import { ensureMeetingNotesSchema } from "./meetingNotes";
import { linkFounder } from "./calendarEnrich";
import { logEvent, logError } from "./log";
import { recordFieldSource } from "./provenance";
import {
  UNTRUSTED_NOTICE,
  callClaude,
  clampEmail,
  clampStr,
  fenceUntrusted,
  modelJson,
  rejectAndLog,
} from "./llm";
import { etLongMonthDay } from "./etDates";

/** Stamped on proposals (G-02) — bump when the extraction rules change. */
const NOTE_EXTRACTOR_VERSION = "note-v2";

/**
 * ── Granola → deal updates: extract, review, apply, undo ────────────────────
 * The note tells us what was discussed; the deal record should quietly absorb
 * the parts that matter (financing, round, founders, a summary) — but only
 * after a human looks at a before/after diff. Nothing here writes to a deal
 * without an explicit Apply, and every Apply keeps a snapshot so Undo is one
 * click. States on meeting_notes.review_state:
 *
 *   none      — no updates proposed (nothing found, or not matched yet)
 *   ready     — proposed_updates waiting for review ("Granola found 4 updates")
 *   applied   — a human applied some or all (undo_snapshot holds pre-values)
 *   dismissed — a human said no thanks
 */

export interface ProposedUpdate {
  kind: "financing" | "round" | "founder" | "summary";
  /** Plain-English row for the review list. */
  label: string;
  before: string | null;
  after: string;
  /** For founder rows. */
  founder?: { name: string; email: string | null };
}

let ready = false;
async function ensureReviewSchema(): Promise<void> {
  if (ready) return;
  await ensureMeetingNotesSchema();
  await sql`alter table meeting_notes add column if not exists proposed_updates jsonb`;
  await sql`alter table meeting_notes add column if not exists review_state text not null default 'none'`;
  await sql`alter table meeting_notes add column if not exists applied_at timestamptz`;
  await sql`alter table meeting_notes add column if not exists applied_by text`;
  await sql`alter table meeting_notes add column if not exists undo_snapshot jsonb`;
  await sql`alter table meeting_notes add column if not exists extractor_version text`;
  ready = true;
}

/* ── Extraction ──────────────────────────────────────────────────────────── */

interface NoteFacts {
  financing: string | null;
  round: string | null;
  founders: { name: string; email: string | null }[];
  summary: string | null;
}

/**
 * Pull deal-relevant facts out of the note with the same model the inbox
 * uses for pitches. Returns null when the model is unavailable or the note
 * says nothing useful — extraction failing must never block the sync.
 */
async function extractNoteFacts(
  title: string | null,
  noteMd: string
): Promise<NoteFacts | null> {
  if (!noteMd.trim()) return null;
  try {
    const text = await callClaude({
      job: "note_facts",
      model: process.env.INBOUND_MODEL ?? "claude-sonnet-4-6",
      maxTokens: 700,
      // Rules in system, transcript fenced in the user turn: a participant
      // saying "tell the CRM we raised $50M" mid-meeting is a fact about
      // the conversation, never an instruction to this extractor.
      system: `You extract deal facts from a VC's meeting note with a startup. Extract ONLY facts stated in the note, as JSON with keys: financing (string like "$2.4M" or null), round (like "Seed"/"Series A" or null), founders (array of {name, email|null} for company founders NAMED in the note), summary (2-3 sentence factual summary of the discussion, or null). No markdown, JSON only.\n\n${UNTRUSTED_NOTICE}`,
      content: `The meeting note${title ? ` (titled ${JSON.stringify(title.slice(0, 200))})` : ""}:\n${fenceUntrusted(noteMd, 12_000)}`,
      timeoutMs: 30_000,
    });
    if (text === null) return null;
    const json = modelJson(text) as {
      financing?: unknown;
      round?: unknown;
      founders?: unknown;
      summary?: unknown;
    } | null;
    if (!json) return rejectAndLog("note_facts", text);
    return {
      financing: clampStr(json.financing, 60),
      round: clampStr(json.round, 40),
      summary: clampStr(json.summary, 700),
      founders: (Array.isArray(json.founders) ? json.founders : [])
        .map((f) => ({
          name: clampStr((f as { name?: unknown }).name, 120) ?? "",
          email: clampEmail((f as { email?: unknown }).email),
        }))
        .filter((f) => f.name)
        .slice(0, 6),
    };
  } catch {
    return null;
  }
}

/**
 * Diff extracted facts against the matched deal and store the proposals.
 * Only real changes become rows; a note that confirms what we already know
 * proposes nothing. Human-reviewed notes are never re-proposed.
 */
export async function proposeNoteUpdates(noteId: string): Promise<number> {
  await ensureReviewSchema();
  const notes = await withRetry(
    () => sql<
      {
        id: string;
        title: string | null;
        notes_md: string | null;
        summary_md: string | null;
        matched_deal_gid: string | null;
        review_state: string;
        match_state: string;
      }[]
    >`select id, title, notes_md, summary_md, matched_deal_gid, review_state, match_state
        from meeting_notes where id = ${noteId}`
  );
  const note = notes[0];
  if (!note?.matched_deal_gid) return 0;
  // A merely-suggested match still lives in Unmatched — no proposals until a
  // human attaches it (or the matcher was certain enough to confirm).
  if (note.match_state !== "confirmed" && note.match_state !== "attached") return 0;
  if (note.review_state === "applied" || note.review_state === "dismissed") return 0;

  const deals = await withRetry(
    () => sql<
      { gid: string; name: string; financing: string | null; round: string | null; notes: string | null }[]
    >`select gid, name, financing_amount as financing, round, notes
        from deals where gid = ${note.matched_deal_gid}`
  );
  const deal = deals[0];
  if (!deal) return 0;

  const facts = await extractNoteFacts(
    note.title,
    [note.summary_md, note.notes_md].filter(Boolean).join("\n\n")
  );
  if (!facts) return 0;

  const existingFounders = await withRetry(
    () => sql<{ name: string }[]>`
      select p.name as name
        from deal_founders df join network_people p on p.id = df.person_id
       where df.deal_gid = ${deal.gid}`
  ).catch(() => [] as { name: string }[]);
  const known = new Set(existingFounders.map((f) => f.name.toLowerCase()));

  const updates: ProposedUpdate[] = [];
  if (facts.financing && facts.financing !== deal.financing) {
    updates.push({
      kind: "financing",
      label: deal.financing
        ? `Financing changed from ${deal.financing} to ${facts.financing}`
        : `Financing set to ${facts.financing}`,
      before: deal.financing,
      after: facts.financing,
    });
  }
  if (facts.round && facts.round !== deal.round) {
    updates.push({
      kind: "round",
      label: deal.round
        ? `Round changed from ${deal.round} to ${facts.round}`
        : `Round set to ${facts.round}`,
      before: deal.round,
      after: facts.round,
    });
  }
  for (const f of facts.founders) {
    if (!known.has(f.name.toLowerCase())) {
      updates.push({
        kind: "founder",
        label: `Added founder ${f.name}`,
        before: null,
        after: f.name + (f.email ? ` <${f.email}>` : ""),
        founder: f,
      });
    }
  }
  if (facts.summary && !(deal.notes ?? "").includes(facts.summary.slice(0, 60))) {
    updates.push({
      kind: "summary",
      label: "Meeting summary added to notes",
      before: null,
      after: facts.summary,
    });
  }

  await withRetry(
    () => sql`
      update meeting_notes
         set proposed_updates = ${sql.json(updates as never)},
             review_state = ${updates.length > 0 ? "ready" : "none"},
             extractor_version = ${NOTE_EXTRACTOR_VERSION}
       where id = ${noteId} and review_state in ('none', 'ready')`
  );
  return updates.length;
}

/** Run proposal for every freshly matched note that has none yet. */
export async function proposePendingUpdates(limit = 10): Promise<number> {
  await ensureReviewSchema();
  const rows = await withRetry(
    () => sql<{ id: string }[]>`
      select id from meeting_notes
       where matched_deal_gid is not null
         and match_state in ('confirmed', 'attached')
         and review_state = 'none'
         and proposed_updates is null
       order by coalesce(refreshed_at, imported_at) desc
       limit ${limit}`
  );
  let proposed = 0;
  for (const r of rows) {
    try {
      if ((await proposeNoteUpdates(r.id)) > 0) proposed++;
    } catch (err) {
      logError("granola", "propose failed", err, { note: r.id });
    }
  }
  return proposed;
}

/* ── Apply / dismiss / undo ──────────────────────────────────────────────── */

const stamp = () =>
  etLongMonthDay(new Date());

/**
 * Apply the selected proposal indexes to the matched deal. Snapshot the
 * fields we are about to change first, so undo can restore them exactly.
 */
export async function applyNoteUpdates(
  noteId: string,
  picks: number[] | "all",
  actor: string
): Promise<{ applied: number; dealGid: string } | { error: string }> {
  await ensureReviewSchema();

  // Atomic claim: only one caller ever flips ready → applied. Everything
  // after this runs as the sole owner; on failure we hand the claim back.
  const claimed = await withRetry(
    () => sql<
      {
        matched_deal_gid: string | null;
        proposed_updates: ProposedUpdate[] | null;
        provider: string;
        provider_note_key: string;
        title: string | null;
        note_url: string | null;
      }[]
    >`
      update meeting_notes
         set review_state = 'applied', applied_at = now(), applied_by = ${actor}
       where id = ${noteId} and review_state = 'ready'
       returning matched_deal_gid, proposed_updates, provider, provider_note_key, title, note_url`
  );
  const note = claimed[0];
  if (!note) return { error: "Already reviewed." };
  const release = () =>
    sql`
      update meeting_notes
         set review_state = 'ready', applied_at = null, applied_by = null
       where id = ${noteId} and review_state = 'applied'
    `.catch(() => {});

  try {
    if (!note.matched_deal_gid || !note.proposed_updates?.length) {
      await release();
      return { error: "Nothing to apply." };
    }
    const all = note.proposed_updates;
    const chosen = picks === "all" ? all : picks.map((i) => all[i]).filter(Boolean);
    if (chosen.length === 0) {
      await release();
      return { error: "Nothing selected." };
    }

    const deals = await withRetry(
      () => sql<
        {
          gid: string;
          financing: string | null;
          round: string | null;
          notes: string | null;
          name: string;
          section_gid: string | null;
          schools: string[] | null;
        }[]
      >`select gid, financing_amount as financing, round, notes,
               name, section_gid, schools
          from deals where gid = ${note.matched_deal_gid}`
    );
    const deal = deals[0];
    if (!deal) {
      await release();
      return { error: "The matched deal no longer exists." };
    }

    // Stale rows are skipped, never force-written: a proposal whose "before"
    // no longer matches the deal means a human edited it since the diff was
    // shown — their value wins.
    const fin = chosen.find((c) => c.kind === "financing");
    const round = chosen.find((c) => c.kind === "round");
    let summary = chosen.find((c) => c.kind === "summary");
    const founders = chosen.filter((c) => c.kind === "founder" && c.founder);
    const finFresh = fin && (fin.before ?? null) === (deal.financing ?? null);
    const roundFresh = round && (round.before ?? null) === (deal.round ?? null);
    if (summary && (deal.notes ?? "").includes(summary.after.slice(0, 60))) {
      summary = undefined; // already there — never append twice
    }

    let applied = 0;
    const snapshot: {
      financing?: string | null;
      round?: string | null;
      notes?: string | null;
    } = {};
    if (finFresh) {
      snapshot.financing = deal.financing;
      await withRetry(
        () => sql`update deals set financing_amount = ${fin!.after} where gid = ${deal.gid}`
      );
      recordFieldSource(deal.gid, "financing", fin!.after, "granola", noteId, actor);
      applied++;
    }
    if (roundFresh) {
      snapshot.round = deal.round;
      await withRetry(
        () => sql`update deals set round = ${round!.after} where gid = ${deal.gid}`
      );
      recordFieldSource(deal.gid, "round", round!.after, "granola", noteId, actor);
      applied++;
    }
    if (summary) {
      snapshot.notes = deal.notes;
      // The summary travels with its source: a link back to the Granola note.
      const noteLink = note.note_url
        ? `\nGranola note${note.title ? ` — "${note.title}"` : ""}: ${note.note_url}`
        : "";
      const notesVal =
        (deal.notes ? deal.notes.trimEnd() + "\n\n" : "") +
        `${summary.after}${noteLink}\nUpdated from Granola · ${stamp()}`;
      await withRetry(
        () => sql`update deals set notes = ${notesVal} where gid = ${deal.gid}`
      );
      recordFieldSource(deal.gid, "notes", null, "granola", noteId, actor);
      applied++;
    }
    for (const f of founders) {
      await linkFounder(deal.gid, f.founder!.name, f.founder!.email ?? "").catch(() => {});
      applied++;
    }

    if (applied === 0) {
      // Everything was stale — the deal moved on since the diff was shown.
      await release();
      return { error: "The deal has changed since these were proposed — take another look." };
    }

    await withRetry(
      () => sql`
        update meeting_notes
           set undo_snapshot = ${sql.json(snapshot as never)}
         where id = ${noteId}`
    );
    logEvent("info", "granola", "updates applied", {
      note: noteId,
      deal: deal.gid,
      applied,
      by: actor,
    });
    return { applied, dealGid: deal.gid };
  } catch (err) {
    await release();
    throw err;
  }
}

export async function dismissNoteUpdates(noteId: string, actor: string): Promise<void> {
  await ensureReviewSchema();
  await withRetry(
    () => sql`
      update meeting_notes
         set review_state = 'dismissed', applied_by = ${actor}
       where id = ${noteId} and review_state = 'ready'`
  );
}

/**
 * Put back exactly — and only — the fields Apply changed. Founder links are
 * additive and stay (the card says so); the note then re-proposes from the
 * current deal so what it shows next is true again.
 */
export async function undoNoteApply(
  noteId: string
): Promise<{ ok: boolean; dealGid?: string }> {
  await ensureReviewSchema();
  const notes = await withRetry(
    () => sql<
      {
        matched_deal_gid: string | null;
        undo_snapshot: {
          financing?: string | null;
          round?: string | null;
          notes?: string | null;
        } | null;
        review_state: string;
      }[]
    >`select matched_deal_gid, undo_snapshot, review_state
        from meeting_notes where id = ${noteId}`
  );
  const note = notes[0];
  if (!note?.matched_deal_gid || !note.undo_snapshot || note.review_state !== "applied") {
    return { ok: false };
  }
  const snap = note.undo_snapshot;
  if ("financing" in snap) {
    await withRetry(
      () => sql`update deals set financing_amount = ${snap.financing ?? null}
                 where gid = ${note.matched_deal_gid}`
    );
    recordFieldSource(note.matched_deal_gid, "financing", snap.financing ?? null, "manual", noteId, null);
  }
  if ("round" in snap) {
    await withRetry(
      () => sql`update deals set round = ${snap.round ?? null}
                 where gid = ${note.matched_deal_gid}`
    );
    recordFieldSource(note.matched_deal_gid, "round", snap.round ?? null, "manual", noteId, null);
  }
  if ("notes" in snap) {
    await withRetry(
      () => sql`update deals set notes = ${snap.notes ?? null}
                 where gid = ${note.matched_deal_gid}`
    );
    recordFieldSource(note.matched_deal_gid, "notes", null, "manual", noteId, null);
  }
  // Clear the old proposals and diff again from the CURRENT deal — founder
  // rows already linked won't re-list, and values reflect what undo left.
  await withRetry(
    () => sql`
      update meeting_notes
         set review_state = 'none', applied_at = null,
             undo_snapshot = null, proposed_updates = null
       where id = ${noteId}`
  );
  await proposeNoteUpdates(noteId).catch(() => 0);
  return { ok: true, dealGid: note.matched_deal_gid };
}

