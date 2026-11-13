import { sql } from "./db";
import { enrichEventById, companyNameFromDomain } from "./calendarEnrich";
import { ensureCandidateFor, reopenCandidate } from "./candidates";
import { etWeekdayDate } from "./etDates";
import type { ParsedPitch } from "./deckExtract";

/**
 * ── The calendar door into the inbox workflow ────────────────────────────────
 * A meeting with a company is a pitch that arrived by calendar instead of by
 * email. Triaging it must be the SAME flow as the inbox — the full review
 * session with extraction, email context, and calendar history — not a
 * parallel one-click path. So this module resolves a meeting company to a
 * deal_candidates row and lets /inbox/<id> do what it already does:
 *
 *   1. Already on the board (deal tie, or a boarded candidate) → the deal.
 *   2. An open pitch anywhere in the queue → that IS the session; reuse it.
 *      Resolved server-side at click time — the page's snapshot can be stale.
 *   3. A reviewed PITCH from these people → reopen it. The original email
 *      (deck, thread, extraction) is strictly better triage material than
 *      anything we could synthesize. Junk the classifier skipped (newsletters,
 *      cold sales) is never resurrected — minting fresh beats reopening noise.
 *   4. No email trail at all → mint a candidate from what the calendar knows,
 *      with any prior correspondence from the reference mailboxes digested
 *      into the body so the reviewer still sees the email side.
 *
 * Minted rows live in inbound_emails under mailbox 'calendar' — a value the
 * ingestion, heal, and reparse sweeps never touch (they are scoped to the
 * sourcing mailbox), so a synthetic row can never be re-parsed or resurrected.
 */

export type MeetingCandidate =
  | { ok: true; how: "open" | "reopened" | "minted"; id: string }
  | { ok: true; how: "deal"; dealGid: string }
  | { ok: false; error: string };

const OPEN_STATUSES = new Set([
  "detected",
  "parsing",
  "ready",
  "assigned",
  "snoozed",
]);

export async function mintCandidateFromMeeting(
  eventId: string,
  domain: string,
  actor: string
): Promise<MeetingCandidate> {
  const dom = domain.trim().toLowerCase();
  const ev = await enrichEventById(eventId);
  if (!ev) return { ok: false, error: "That meeting no longer exists." };
  const company = ev.companies.find((c) => c.domain === dom);
  if (!company) {
    return { ok: false, error: "Nobody from that company is on the invite." };
  }
  if (company.dealGid) {
    return { ok: true, how: "deal", dealGid: company.dealGid };
  }

  const emails = company.attendees.map((a) => a.email.toLowerCase());

  // Every candidate that is plausibly ABOUT this company, newest first.
  // Four kinds of evidence, judged per row below: the sender is one of the
  // people on this invite; the parsed founders are at this domain; the parsed
  // website is this domain; or the sender's domain matches AND the mail was a
  // pitch (a referral FROM this domain is about someone else's company).
  const rows = await sql<
    {
      id: string;
      status: string;
      promoted_deal_gid: string | null;
      classification: string;
      is_pitch: boolean;
      from_person: boolean;
      founder_match: boolean;
      website_match: boolean;
      from_domain: boolean;
    }[]
  >`
    select c.id,
           c.status,
           c.promoted_deal_gid,
           coalesce(c.classification, '') as classification,
           coalesce(e.parsed->>'isPitch', '') = 'true' as is_pitch,
           lower(coalesce(e.from_email, '')) = any(${emails}) as from_person,
           exists (
             select 1
               from jsonb_array_elements(coalesce(e.parsed->'founders', '[]'::jsonb)) f
              where lower(coalesce(f->>'email', '')) = any(${emails})
                 or split_part(lower(coalesce(f->>'email', '')), '@', 2) = ${dom}
           ) as founder_match,
           split_part(
             regexp_replace(lower(coalesce(e.parsed->>'website', '')), '^https?://(www\\.)?', ''),
             '/', 1
           ) = ${dom} as website_match,
           split_part(lower(coalesce(e.from_email, '')), '@', 2) = ${dom} as from_domain
      from deal_candidates c
      join inbound_emails e on e.id = c.source_email_id
     where lower(coalesce(e.from_email, '')) = any(${emails})
        or split_part(lower(coalesce(e.from_email, '')), '@', 2) = ${dom}
        or split_part(
             regexp_replace(lower(coalesce(e.parsed->>'website', '')), '^https?://(www\\.)?', ''),
             '/', 1
           ) = ${dom}
        or exists (
             select 1
               from jsonb_array_elements(coalesce(e.parsed->'founders', '[]'::jsonb)) f
              where lower(coalesce(f->>'email', '')) = any(${emails})
                 or split_part(lower(coalesce(f->>'email', '')), '@', 2) = ${dom}
           )
     order by e.received_at desc nulls last
     limit 12
  `;

  const pitchLike = (r: (typeof rows)[number]) =>
    r.classification === "pitch" || r.is_pitch;
  const aboutCompany = rows.filter(
    (r) =>
      r.from_person ||
      r.founder_match ||
      r.website_match ||
      (r.from_domain && pitchLike(r))
  );

  const open = aboutCompany.find((r) => OPEN_STATUSES.has(r.status));
  if (open) return { ok: true, how: "open", id: open.id };

  const boarded = aboutCompany.find(
    (r) =>
      (r.status === "approved" || r.status === "attached") &&
      r.promoted_deal_gid
  );
  if (boarded?.promoted_deal_gid) {
    return { ok: true, how: "deal", dealGid: boarded.promoted_deal_gid };
  }

  // Reopen only real pitches — newest PITCH, not newest mail, so a marketing
  // blast from June never outranks the actual deck from March.
  const reviewed = aboutCompany.find(
    (r) => (r.status === "passed" || r.status === "ignored") && pitchLike(r)
  );
  if (reviewed) {
    await reopenCandidate(reviewed.id, actor);
    return { ok: true, how: "reopened", id: reviewed.id };
  }

  // Nothing in the queue, past or present — mint. Pull whatever the reference
  // mailboxes have seen from these people into the body, so the session still
  // opens with the email side of the story.
  const trail = await sql<
    { n: number; last: Date | null; lines: string[] | null }[]
  >`
    with hits as (
      select m.sent_at, m.snippet
        from email_messages m
       where lower(m.from_addr->>'email') = any(${emails})
          or split_part(lower(m.from_addr->>'email'), '@', 2) = ${dom}
          or exists (
            select 1 from jsonb_array_elements(coalesce(m.to_addrs, '[]'::jsonb)) t
             where lower(t->>'email') = any(${emails})
                or split_part(lower(t->>'email'), '@', 2) = ${dom}
          )
    )
    select count(*)::int as n,
           max(sent_at) as last,
           (select array_agg(line) from (
              select to_char(sent_at, 'YYYY-MM-DD') || '  ' ||
                     left(regexp_replace(coalesce(snippet, ''), '\\s+', ' ', 'g'), 110) as line
                from hits
               where snippet is not null
               order by sent_at desc nulls last
               limit 3
           ) recent(line)) as lines
      from hits
  `.catch(() => [] as { n: number; last: Date | null; lines: string[] | null }[]);
  const mailCount = trail[0]?.n ?? 0;
  const mailLast = trail[0]?.last
    ? new Date(trail[0].last).toISOString().slice(0, 10)
    : null;

  const named = company.attendees.filter((a) => a.name);
  const whenLine = ev.startsAt
    ? etWeekdayDate(ev.startsAt)
    : "unscheduled";

  const parsed: ParsedPitch = {
    isPitch: true,
    confidence: 0.75,
    classification: "pitch",
    classifierReason: `Minted from the calendar by ${actor}: "${ev.title}".`,
    companyName: companyNameFromDomain(dom),
    oneLiner: null,
    founders: named.map((a) => ({
      fullName: a.name as string,
      email: a.email,
      linkedinUrl: null,
      title: null,
      school: null,
    })),
    round: null,
    raiseAmount: null,
    valuation: null,
    traction: null,
    sector: null,
    website: dom,
    location: null,
    summary: `${ev.upcoming ? "Meeting scheduled" : "Met"}: "${ev.title}" (${whenLine}).`,
  };

  const body = [
    "This pitch arrived as a calendar meeting. Everything below is digested from the invite and prior email with these founders.",
    "",
    `Meeting: ${ev.title}`,
    `When: ${whenLine}${ev.upcoming ? " (upcoming)" : ""}`,
    `Company domain: ${dom}`,
    "On the invite:",
    ...company.attendees.map((a) => `• ${a.name ?? "(name unknown)"} — ${a.email}`),
    "",
    mailCount > 0
      ? `Prior email across the connected mailboxes: ${mailCount} message${mailCount === 1 ? "" : "s"}, last ${mailLast}.`
      : "No prior email found from these people across the connected mailboxes.",
    ...(trail[0]?.lines ?? []).map((l) => `• ${l}`),
  ].join("\n");

  const inserted = await sql<{ id: string }[]>`
    insert into inbound_emails (
      gmail_message_id, mailbox, from_name, from_email, subject,
      received_at, snippet, body_text, status, parsed, processed_at
    ) values (
      ${`calendar:${eventId}:${dom}`},
      'calendar',
      ${named[0]?.name ?? null},
      ${company.attendees[0]?.email ?? null},
      ${`Meeting: ${ev.title}`},
      ${new Date()},
      ${parsed.summary},
      ${body},
      'parsed',
      ${sql.json(parsed as never)},
      now()
    )
    on conflict (gmail_message_id) do update set subject = excluded.subject
    returning id
  `;
  const emailRowId = inserted[0]?.id;
  if (!emailRowId) return { ok: false, error: "Couldn't mint the triage item." };

  const candidateId = await ensureCandidateFor(emailRowId);
  if (!candidateId) {
    // The identity pass recognized an already-boarded startup and filed the
    // email onto its deal instead of minting — triage lands on the deal.
    const filed = await sql<{ deal_gid: string | null }[]>`
      select deal_gid from inbound_emails where id = ${emailRowId}`;
    if (filed[0]?.deal_gid) {
      return { ok: true, how: "deal", dealGid: filed[0].deal_gid };
    }
    return { ok: false, error: "Couldn't mint the triage item." };
  }
  return { ok: true, how: "minted", id: candidateId };
}
