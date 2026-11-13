import "server-only";
import { sql } from "./db";
import { withRetry } from "./retry";
import { matchTargets } from "./emailDomains";

/**
 * ── Shots on goal ────────────────────────────────────────────────────────────
 * Everything we've actually exchanged with a deal's founders, keyed on the one
 * identifier that spans every source: their email address.
 *
 * Email is the spine here. A founder's address joins the deal to synced mail
 * (personal + deals mailboxes) and to calendar invites, which is what turns
 * "we've been talking to them" into "last contact was 12 days ago, 4 threads,
 * 2 meetings". Before network_people.email existed, none of this could be
 * asked — the only address on a deal was whoever forwarded the pitch.
 *
 * Referrers are deliberately NOT counted. Sean introducing us to Lydia is not
 * a touchpoint with Lydia.
 */

export interface InteractionMessage {
  id: string;
  direction: string;
  sentAt: string | null;
  snippet: string;
  fromName: string;
  fromEmail: string;
}

export interface InteractionMeeting {
  id: string;
  title: string;
  startsAt: string | null;
  endsAt: string | null;
  conferenceUrl: string | null;
  status: string | null;
  attendeeCount: number;
  /** Display names (or addresses) of who was there — the context "4 attendees" hides. */
  attendees: string[];
}

export interface DealInteractions {
  /** The founder addresses this history was assembled from. */
  matchedOn: string[];
  /** Company domains we also counted (corporate only — never gmail/.edu). */
  matchedDomains: string[];
  /** Addresses a human has vouched for, a subset of matchedOn. */
  confirmed: string[];
  /** Touchpoints with the company that were NOT with a known founder. */
  companyCount: number;
  lastContactAt: string | null;
  emailCount: number;
  meetingCount: number;
  messages: InteractionMessage[];
  meetings: InteractionMeeting[];
}

const EMPTY: DealInteractions = {
  matchedOn: [],
  matchedDomains: [],
  confirmed: [],
  companyCount: 0,
  lastContactAt: null,
  emailCount: 0,
  meetingCount: 0,
  messages: [],
  meetings: [],
};

/** Every address we know for this deal's founders — primary plus alternates. */
async function founderEmails(
  gid: string
): Promise<{ email: string; confirmed: boolean }[]> {
  const rows = await sql<{ email: string; confirmed: boolean }[]>`
    select lower(p.email) as email, p.email_confirmed as confirmed
      from deal_founders f join network_people p on p.id = f.person_id
     where f.deal_gid = ${gid} and p.email is not null
    union
    select lower(a) as email, false as confirmed
      from deal_founders f
      join network_people p on p.id = f.person_id,
           lateral unnest(p.alt_emails) a
     where f.deal_gid = ${gid}
  `;
  return rows.filter((r) => r.email);
}

export async function dealInteractions(gid: string): Promise<DealInteractions> {
  const rows = await withRetry(() => founderEmails(gid)).catch(
    () => [] as { email: string; confirmed: boolean }[]
  );
  // Exact addresses always; company domains only when they're corporate.
  const { addresses, domains } = matchTargets(rows.map((r) => r.email));
  const confirmed = rows.filter((r) => r.confirmed).map((r) => r.email);

  const [messages, meetings, companyRows] = await Promise.all([
    addresses.length === 0
      ? Promise.resolve([] as InteractionMessage[])
      : withRetry(
          () => sql<InteractionMessage[]>`
            select m.id,
                   m.direction,
                   m.sent_at   as "sentAt",
                   coalesce(m.snippet, '')            as snippet,
                   coalesce(m.from_addr->>'name', '') as "fromName",
                   coalesce(m.from_addr->>'email','') as "fromEmail"
              from email_messages m
             where lower(m.from_addr->>'email') = any(${addresses})
                or exists (select 1 from jsonb_array_elements(coalesce(m.to_addrs, '[]'::jsonb)) t
                            where lower(t->>'email') = any(${addresses}))
                or exists (select 1 from jsonb_array_elements(coalesce(m.cc_addrs, '[]'::jsonb)) t
                            where lower(t->>'email') = any(${addresses}))
             order by m.sent_at desc nulls last
             limit 50
          `
        ).catch(() => [] as InteractionMessage[]),

    withRetry(
      () => sql<InteractionMeeting[]>`
        select e.id,
               coalesce(e.title, 'Untitled') as title,
               e.starts_at        as "startsAt",
               e.ends_at          as "endsAt",
               e.conference_url   as "conferenceUrl",
               e.status,
               jsonb_array_length(coalesce(e.attendees, '[]'::jsonb)) as "attendeeCount",
               -- Prefer the display name; fall back to the address so an
               -- unnamed invitee still says who it was.
               coalesce((
                 select array_agg(coalesce(nullif(trim(a->>'name'), ''), a->>'email')
                                  order by a->>'email')
                   from jsonb_array_elements(coalesce(e.attendees, '[]'::jsonb)) a
               ), '{}') as attendees
          from calendar_events e
         where e.matched_deal_gid = ${gid}
            or (${addresses.length > 0} and exists (
                  select 1 from jsonb_array_elements(coalesce(e.attendees, '[]'::jsonb)) a
                   where lower(a->>'email') = any(${addresses})))
         order by e.starts_at desc nulls last
         limit 50
      `
    ).catch(() => [] as InteractionMeeting[]),

    // Everyone else at the company — co-founders and staff on a corporate
    // domain. Counted separately so it never inflates "shots on goal with
    // this founder". Never runs for gmail/.edu: domains is empty there.
    domains.length === 0
      ? Promise.resolve([] as { n: string }[])
      : withRetry(
          () => sql<{ n: string }[]>`
            select count(*)::text as n
              from email_messages m
             where (split_part(lower(m.from_addr->>'email'), '@', 2) = any(${domains})
                or exists (select 1 from jsonb_array_elements(coalesce(m.to_addrs, '[]'::jsonb)) t
                            where split_part(lower(t->>'email'), '@', 2) = any(${domains})))
               and lower(m.from_addr->>'email') <> all(${addresses})
          `
        ).catch(() => [] as { n: string }[]),
  ]);

  const base = {
    matchedOn: addresses,
    matchedDomains: domains,
    confirmed,
    companyCount: Number(companyRows[0]?.n ?? 0),
  };

  if (messages.length === 0 && meetings.length === 0) {
    return { ...EMPTY, ...base };
  }

  const stamps = [
    ...messages.map((m) => m.sentAt),
    ...meetings.map((m) => m.startsAt),
  ]
    .filter((s): s is string => !!s)
    // A meeting on the calendar for next week isn't contact that has happened.
    .filter((s) => Date.parse(s) <= Date.now());

  return {
    ...base,
    lastContactAt:
      stamps.length > 0
        ? new Date(Math.max(...stamps.map((s) => Date.parse(s)))).toISOString()
        : null,
    emailCount: messages.length,
    meetingCount: meetings.length,
    messages,
    meetings,
  };
}
