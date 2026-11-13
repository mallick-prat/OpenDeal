import "server-only";
import { sql } from "./db";
import { withRetry } from "./retry";
import { logEvent, logError } from "./log";
import { recordFieldSource } from "./provenance";
import { domainOf, canExpandToDomain, localPartMatchesName } from "./emailDomains";
import { isInternalEmail } from "@/config/crm.config";

/**
 * ── The convergence layer ────────────────────────────────────────────────────
 * A deal can start from an email, a meeting, or a keyboard — but the moment it
 * exists, it should know everything EVERY channel knows: the pitch thread, the
 * dinner three weeks ago, the call on Tuesday's calendar, the founders' real
 * addresses. Before this module, each intake door built only its own slice:
 * email-born deals didn't claim their meetings, meeting-born deals left the
 * matching pitch sitting in the inbox as a second queue item.
 *
 * One seed shape covers every origin — the founders' addresses and corporate
 * domains, however they were learned. `previewDealContext` reads what the
 * other channels hold (for triage screens, BEFORE creating anything);
 * `stampDealContext` writes the links once the deal exists. Both are
 * deterministic joins on email evidence; both are idempotent.
 */

export interface ContextSeed {
  /** Founder / company addresses, any origin. Internal addresses are fine —
   *  they're ignored. */
  emails: string[];
  /** Corporate domains beyond those derivable from the emails (e.g. the
   *  pitch's website, a meeting's attendee cluster). */
  domains?: string[];
}

interface NormalizedSeed {
  emails: string[];
  domains: string[];
}

function normalizeSeed(seed: ContextSeed): NormalizedSeed {
  const emails = Array.from(
    new Set(
      (seed.emails ?? [])
        .map((e) => String(e ?? "").trim().toLowerCase())
        .filter((e) => e.includes("@") && !isInternalEmail(e))
    )
  );
  const domains = Array.from(
    new Set(
      [
        ...(seed.domains ?? []).map((d) =>
          String(d ?? "").trim().toLowerCase().replace(/^www\./, "")
        ),
        // Only corporate domains generalize; a gmail founder identifies
        // themselves, never a company.
        ...emails.map(domainOf).filter((d) => canExpandToDomain(`x@${d}`)),
      ].filter(Boolean)
    )
  );
  return { emails, domains };
}

export interface ContextPreview {
  priorMeetings: number;
  lastMetAt: string | null;
  upcoming: { id: string; title: string; startsAt: string }[];
  /** An open inbox item about the same company — triage should link, not fork. */
  openCandidate: { id: string; subject: string } | null;
}

const EMPTY_PREVIEW: ContextPreview = {
  priorMeetings: 0,
  lastMetAt: null,
  upcoming: [],
  openCandidate: null,
};

/**
 * What the OTHER channels already know about this company — shown at triage
 * time so the reviewer decides with the whole picture: "you've met them
 * twice, you're seeing them Tuesday, and their pitch is in the inbox."
 */
export async function previewDealContext(seed: ContextSeed): Promise<ContextPreview> {
  const { emails, domains } = normalizeSeed(seed);
  if (emails.length === 0 && domains.length === 0) return EMPTY_PREVIEW;

  const [meetings, candidate] = await Promise.all([
    withRetry(
      () => sql<{ id: string; title: string | null; starts_at: Date }[]>`
        select e.id, e.title, e.starts_at
          from calendar_events e
         where e.status is distinct from 'cancelled'
           and e.starts_at is not null
           and exists (
             select 1 from jsonb_array_elements(coalesce(e.attendees, '[]'::jsonb)) a
              where lower(a->>'email') = any(${emails})
                 or split_part(lower(a->>'email'), '@', 2) = any(${domains})
           )
         order by e.starts_at
      `
    ).catch(() => [] as { id: string; title: string | null; starts_at: Date }[]),
    withRetry(
      () => sql<{ id: string; subject: string | null }[]>`
        select c.id, e.subject
          from deal_candidates c
          join inbound_emails e on e.id = c.source_email_id
         where c.status in ('detected', 'parsing', 'ready', 'assigned')
           and (
             exists (
               select 1 from jsonb_array_elements(coalesce(e.parsed->'founders', '[]'::jsonb)) f
                where lower(f->>'email') = any(${emails})
                   or split_part(lower(f->>'email'), '@', 2) = any(${domains})
             )
             or split_part(lower(coalesce(e.from_email, '')), '@', 2) = any(${domains})
           )
         order by c.received_at desc nulls last
         limit 1
      `
    ).catch(() => [] as { id: string; subject: string | null }[]),
  ]);

  const now = Date.now();
  const past = meetings.filter((m) => m.starts_at.getTime() <= now);
  const future = meetings.filter((m) => m.starts_at.getTime() > now);
  return {
    priorMeetings: past.length,
    lastMetAt: past.length > 0 ? past[past.length - 1].starts_at.toISOString() : null,
    upcoming: future.slice(0, 3).map((m) => ({
      id: m.id,
      title: m.title ?? "Untitled",
      startsAt: m.starts_at.toISOString(),
    })),
    openCandidate: candidate[0]
      ? { id: candidate[0].id, subject: candidate[0].subject ?? "(no subject)" }
      : null,
  };
}

export interface StampResult {
  meetingsStamped: number;
  candidatesAttached: number;
  founderEmailsFilled: number;
}

/**
 * The deal exists — claim its context everywhere, whatever door it came
 * through. Idempotent: stamps only unmatched meetings, attaches only open
 * candidates, fills only missing addresses. Never throws; a deal creation
 * must not fail because its context couldn't be fully claimed.
 */
export async function stampDealContext(
  gid: string,
  seed: ContextSeed,
  by: string
): Promise<StampResult> {
  const { emails, domains } = normalizeSeed(seed);
  const result: StampResult = {
    meetingsStamped: 0,
    candidatesAttached: 0,
    founderEmailsFilled: 0,
  };
  if (emails.length === 0 && domains.length === 0) return result;

  // 1. Every meeting with these people — past AND future — belongs to this
  //    deal. Unmatched events only; a human or stronger evidence keeps wins.
  try {
    const stamped = await sql<{ id: string }[]>`
      update calendar_events e
         set matched_deal_gid = ${gid},
             match_confidence = 0.8,
             match_evidence = ${sql.json({ via: "deal-context", by } as never)}
       where e.matched_deal_gid is null
         and exists (
           select 1 from jsonb_array_elements(coalesce(e.attendees, '[]'::jsonb)) a
            where lower(a->>'email') = any(${emails})
               or split_part(lower(a->>'email'), '@', 2) = any(${domains})
         )
       returning id
    `;
    result.meetingsStamped = stamped.length;
  } catch (err) {
    logError("pipeline", "context stamp: meetings failed", err, { gid });
  }

  // 2. An open inbox item about the same company is THIS deal's pitch — link
  //    it so the queue never asks anyone to triage the same company twice.
  try {
    const attached = await sql<{ id: string }[]>`
      update deal_candidates c
         set status = 'attached', promoted_deal_gid = ${gid},
             reviewed_at = now(), reviewed_by = ${by}
        from inbound_emails e
       where e.id = c.source_email_id
         and c.status in ('detected', 'parsing', 'ready', 'assigned')
         and (
           exists (
             select 1 from jsonb_array_elements(coalesce(e.parsed->'founders', '[]'::jsonb)) f
              where lower(f->>'email') = any(${emails})
                 or split_part(lower(f->>'email'), '@', 2) = any(${domains})
           )
           or split_part(lower(coalesce(e.from_email, '')), '@', 2) = any(${domains})
         )
       returning c.id
    `;
    result.candidatesAttached = attached.length;
  } catch (err) {
    logError("pipeline", "context stamp: candidates failed", err, { gid });
  }

  // 3. Founders on this deal who are missing an address, when the seed holds
  //    one whose local part matches their name. Guarded by the unique index —
  //    an address that belongs to someone else stays put.
  try {
    const founders = await sql<{ id: string; name: string; email: string | null }[]>`
      select p.id, p.name, p.email
        from deal_founders f join network_people p on p.id = f.person_id
       where f.deal_gid = ${gid}
    `;
    for (const p of founders) {
      if (p.email) continue;
      const match = emails.find((e) => localPartMatchesName(e, p.name));
      if (!match) continue;
      const updated = await sql<{ id: string }[]>`
        update network_people set email = ${match}, updated_at = now()
         where id = ${p.id}
           and email is null
           and not exists (select 1 from network_people where lower(email) = ${match})
         returning id
      `.catch(() => [] as { id: string }[]);
      result.founderEmailsFilled += updated.length;
    }
  } catch (err) {
    logError("pipeline", "context stamp: founder emails failed", err, { gid });
  }

  logEvent("info", "pipeline", "deal context stamped", {
    gid,
    ...result,
    emails: emails.length,
    domains: domains.length,
  });
  return result;
}


export interface AbsorbResult {
  filledFinancing: boolean;
  filledRound: boolean;
  pitchAppended: boolean;
  threadsNoted: number;
}

/**
 * Pull the email channel's CONTENT into the deal, not just a link. Stamping
 * attaches the queue item; this copies what the pitch actually said —
 * raise, round, the one-liner — into the deal's own fields when they're
 * empty, so a meeting-born deal reads like an inbox-born one.
 *
 * Any candidate qualifies, including skipped or ignored: a verdict of "not
 * actionable then" doesn't invalidate the extraction. Empty fields only —
 * a human's entry always outranks a machine's copy.
 */
export async function absorbPitchContent(
  gid: string,
  seed: ContextSeed,
  by: string
): Promise<AbsorbResult> {
  const { emails, domains } = normalizeSeed(seed);
  const result: AbsorbResult = {
    filledFinancing: false,
    filledRound: false,
    pitchAppended: false,
    threadsNoted: 0,
  };
  if (emails.length === 0 && domains.length === 0) return result;

  try {
    const candidates = await sql<{
      id: string;
      status: string;
      raise: string | null;
      round: string | null;
      one_liner: string | null;
      summary: string | null;
    }[]>`
      select c.id, c.status,
             e.parsed->>'raiseAmount' as raise,
             e.parsed->>'round' as round,
             e.parsed->>'oneLiner' as one_liner,
             e.parsed->>'summary' as summary
        from deal_candidates c
        join inbound_emails e on e.id = c.source_email_id
       where e.parsed is not null
         and (c.promoted_deal_gid is null or c.promoted_deal_gid = ${gid})
         and (
           exists (
             select 1 from jsonb_array_elements(coalesce(e.parsed->'founders', '[]'::jsonb)) f
              where lower(f->>'email') = any(${emails})
                 or split_part(lower(f->>'email'), '@', 2) = any(${domains})
           )
           or split_part(lower(coalesce(e.from_email, '')), '@', 2) = any(${domains})
         )
       order by c.received_at desc nulls last
       limit 5
    `;
    // Min-max across the pitches: newest wins per FIELD, not per row — an
    // older email's raise survives a newer one that only shared a deck.
    const first = <T,>(xs: (T | null | undefined)[]): T | null =>
      xs.find((x): x is T => x !== null && x !== undefined && x !== ("" as unknown as T)) ?? null;
    const pitch = candidates[0]
      ? {
          raise: first(candidates.map((c) => c.raise)),
          round: first(candidates.map((c) => c.round)),
          one_liner: first(candidates.map((c) => c.one_liner)),
          summary: first(candidates.map((c) => c.summary)),
        }
      : null;
    if (pitch) {
      const filled = await sql<{ financing_amount: string | null; round: string | null }[]>`
        update deals
           set financing_amount = coalesce(nullif(financing_amount, ''), ${pitch.raise}),
               round = coalesce(nullif(round, ''), ${pitch.round}),
               modified_on = ${new Date().toISOString().slice(0, 10)}
         where gid = ${gid}
         returning financing_amount, round
      `;
      result.filledFinancing = !!pitch.raise && filled[0]?.financing_amount === pitch.raise;
      result.filledRound = !!pitch.round && filled[0]?.round === pitch.round;
      // A-01: values absorbed from pitch emails say so on the card.
      if (result.filledFinancing) {
        recordFieldSource(gid, "financing", pitch.raise, "email", candidates[0]?.id ?? null, by);
      }
      if (result.filledRound) {
        recordFieldSource(gid, "round", pitch.round, "email", candidates[0]?.id ?? null, by);
      }

      const line = (pitch.one_liner ?? pitch.summary ?? "").trim();
      if (line) {
        const appended = await sql<{ gid: string }[]>`
          update deals set notes = notes || ${"\n\nFrom the pitch: " + line}
           where gid = ${gid} and position(${line} in coalesce(notes, '')) = 0
           returning gid
        `;
        result.pitchAppended = appended.length > 0;
        if (result.pitchAppended) {
          recordFieldSource(gid, "notes", null, "email", candidates[0]?.id ?? null, by);
        }
      }
      // Link the sources (attach only those still open; reviewed ones keep
      // their verdict but gain the pointer).
      await sql`
        update deal_candidates
           set promoted_deal_gid = ${gid},
               status = case when status in ('detected','parsing','ready','assigned')
                             then 'attached' else status end,
               reviewed_at = coalesce(reviewed_at, now()),
               reviewed_by = coalesce(reviewed_by, ${by})
         where id = any(${candidates.map((c) => c.id)})
      `.catch(() => {});
    }

    // Prior correspondence, one quiet line — the History panel holds the
    // detail; the notes just say it exists.
    const threads = await sql<{ n: number; last: Date | null }[]>`
      select count(*)::int as n, max(sent_at) as last
        from email_messages m
       where lower(m.from_addr->>'email') = any(${emails})
          or split_part(lower(m.from_addr->>'email'), '@', 2) = any(${domains})
          or exists (select 1 from jsonb_array_elements(coalesce(m.to_addrs, '[]'::jsonb)) t
                      where lower(t->>'email') = any(${emails})
                         or split_part(lower(t->>'email'), '@', 2) = any(${domains}))
    `;
    const n = threads[0]?.n ?? 0;
    if (n > 0) {
      const last = threads[0]?.last
        ? new Date(threads[0].last).toISOString().slice(0, 10)
        : "unknown";
      await sql`
        update deals set notes = notes || ${"\nPrior email: " + n + " message" + (n === 1 ? "" : "s") + ", last " + last}
         where gid = ${gid} and position('Prior email:' in coalesce(notes, '')) = 0
      `.catch(() => {});
      result.threadsNoted = n;
    }
  } catch (err) {
    logError("pipeline", "pitch absorb failed", err, { gid });
  }
  return result;
}

/* ── The full merge ─────────────────────────────────────────────────────── */

export interface MergeResult {
  stamped: StampResult | null;
  absorbed: AbsorbResult | null;
  emailsFiled: number;
  decksCarried: number;
  notesConfirmed: number;
}

/**
 * Everything the firm knows about this company converges on the deal — the
 * min-max merge behind "Merge into this deal" and boarding:
 *
 *   · meetings past and future claim the deal (stampDealContext)
 *   · the best value per field across every matching pitch fills what's
 *     empty; human-entered values are never overwritten (absorbPitchContent)
 *   · every inbound email from these people files under the deal
 *   · deck links the deal's notes don't have yet are carried over
 *   · Granola notes whose attendees are these people confirm onto the deal
 *     and queue their update proposals for review
 *
 * Idempotent and never-throws: each sweep is independent, so one failing
 * leaves the rest standing.
 */
export async function mergeDealContext(
  gid: string,
  seed: ContextSeed,
  by: string
): Promise<MergeResult> {
  const result: MergeResult = {
    stamped: null,
    absorbed: null,
    emailsFiled: 0,
    decksCarried: 0,
    notesConfirmed: 0,
  };
  const { emails, domains } = normalizeSeed(seed);
  if (emails.length === 0 && domains.length === 0) return result;

  // Dig the founders' full mail history first — the scheduled sync only
  // skims a 30-day window, and the sweeps below count what's in the store.
  // A merge's dig also stamps the deal-open cooldown (claimDeepSearch), so
  // opening the card right after boarding costs zero extra provider calls.
  try {
    const { claimDeepSearch, deepSearchMail } = await import("./mailSync");
    await claimDeepSearch(gid).catch(() => true);
    await deepSearchMail(emails, { domain: domains[0] ?? null, maxPerConnection: 60 });
  } catch {
    // metadata dig is best-effort
  }

  result.stamped = await stampDealContext(gid, seed, by).catch(() => null);
  result.absorbed = await absorbPitchContent(gid, seed, by).catch(() => null);

  // Every email from these people or this domain files under the deal.
  try {
    const filed = await sql`
      update inbound_emails e
         set deal_gid = ${gid}
       where e.deal_gid is null
         and (
           lower(coalesce(e.from_email, '')) = any(${emails})
           or split_part(lower(coalesce(e.from_email, '')), '@', 2) = any(${domains})
           or exists (
             select 1 from jsonb_array_elements(coalesce(e.parsed->'founders', '[]'::jsonb)) f
              where lower(coalesce(f->>'email', '')) = any(${emails})
                 or split_part(lower(coalesce(f->>'email', '')), '@', 2) = any(${domains})
           )
         )
    `;
    result.emailsFiled = filed.count;
  } catch {
    // filing is additive
  }

  // Deck links the deal doesn't already carry, from any matching email.
  try {
    const rows = await sql<{ deck_links: { url?: string; kind?: string }[] | null }[]>`
      select e.deck_links
        from inbound_emails e
       where e.deal_gid = ${gid}
         and jsonb_array_length(coalesce(e.deck_links, '[]'::jsonb)) > 0
       order by e.received_at desc nulls last
       limit 6
    `;
    const deal = await sql<{ notes: string | null }[]>`
      select notes from deals where gid = ${gid}`;
    const notes = deal[0]?.notes ?? "";
    const fresh: string[] = [];
    for (const r of rows) {
      for (const l of r.deck_links ?? []) {
        if (l?.url && !notes.includes(l.url) && !fresh.some((f) => f.includes(l.url!))) {
          fresh.push(`• ${l.kind ? `(${l.kind}) ` : ""}${l.url}`);
        }
        if (fresh.length >= 4) break;
      }
      if (fresh.length >= 4) break;
    }
    if (fresh.length > 0) {
      await sql`
        update deals set notes = notes || ${"\n\nDecks:\n" + fresh.join("\n")}
         where gid = ${gid}
      `;
      result.decksCarried = fresh.length;
    }
  } catch {
    // decks are a bonus
  }

  // Granola notes with these people in the room confirm onto the deal (only
  // unmatched ones, or ones already suggested HERE — never steal a note
  // suggested to a different deal), then queue their proposals.
  try {
    const confirmed = await sql<{ id: string }[]>`
      update meeting_notes n
         set matched_deal_gid = ${gid},
             match_state = 'confirmed',
             match_confidence = 0.95,
             match_evidence = ${sql.json({ kind: "attendee_email", value: emails[0] ?? domains[0] } as never)}
       where (
               n.match_state = 'unmatched'
               or (n.match_state = 'suggested' and n.matched_deal_gid = ${gid})
             )
         and exists (
           select 1 from jsonb_array_elements(coalesce(n.participants, '[]'::jsonb)) pp
            where lower(coalesce(pp->>'email', '')) = any(${emails})
         )
       returning id
    `;
    result.notesConfirmed = confirmed.length;
    if (confirmed.length > 0) {
      const { proposeNoteUpdates } = await import("./meetingNoteUpdates");
      for (const n of confirmed.slice(0, 2)) {
        await proposeNoteUpdates(n.id).catch(() => 0);
      }
    }
  } catch {
    // note confirmation is additive
  }

  return result;
}
