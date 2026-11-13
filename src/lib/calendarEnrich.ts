import "server-only";
import { sql } from "./db";
import { withRetry } from "./retry";
import { logEvent, logError } from "./log";
import { domainOf, canExpandToDomain, localPartMatchesName } from "./emailDomains";
import {
  attendeeIdentity,
  clusterByCompany,
  looksLikeInvestorDomain,
  type AttendeeIdentity,
} from "./attendeeIdentity";
import { companyFromDealName, founderNamesFromDealName } from "./founders";
import { INTERNAL_DOMAIN_SET, isInternalEmail } from "@/config/crm.config";

/**
 * ── Reverse enrichment: from an invite back to the CRM ───────────────────────
 * Forward matching (deal → founder email → find meetings) only works once a
 * deal exists. But sourcing often runs the other way: the dinner happens
 * first. This module starts from the calendar event and works backwards —
 * who are these attendees, which company is that, which deal does it belong
 * to — using nothing but deterministic string evidence, so every link it
 * writes can be explained in one sentence.
 *
 * Three ways a corporate domain ties to a deal, strongest first:
 *   1. A founder on that deal already has an address at the domain.
 *   2. A referral on that deal came from the domain.
 *   3. The domain's base matches the company in the deal's title
 *      ("Lark AI" ↔ larkai.com, "Pemberly" ↔ pemberly.co).
 *
 * What it writes is deliberately tiered by confidence:
 *   - meeting → deal links (matched_deal_gid) when exactly one company ties;
 *   - person records ONLY when an attendee's address matches a founder name
 *     already printed in the deal title (the 16-tested strict matcher);
 *   - last-interaction timestamps for people we already know.
 * Everything else stays a suggestion on the /meetings page, for a human.
 */

export interface CompanyOnMeeting {
  domain: string;
  attendees: AttendeeIdentity[];
  /** Funds and firms — shown for context, never offered as a deal. */
  investor: boolean;
  /** The deal this domain ties to, when one does. */
  dealGid: string | null;
  dealName: string | null;
  /** Which evidence tied it (founder-email | referral | title-match). */
  via: string | null;
  /** An open inbox item about this company (filled on the triage surface):
   *  creating from the meeting will absorb it — one company, one queue slot. */
  candidateId?: string | null;
  candidateSubject?: string | null;
}

export interface MeetingEnrichment {
  externals: AttendeeIdentity[];
  companies: CompanyOnMeeting[];
}

interface DealTie {
  gid: string;
  name: string;
  via: string;
}

/** Stage keys that mean "still alive" — preferred when a domain ties twice. */
const ACTIVE_STAGES = new Set([
  "to-meet",
  "first-meeting",
  "cultivate",
  "elevate",
  "diligence",
  "offered",
]);

function domainBase(domain: string): string {
  return domain.split(".")[0].replace(/[^a-z0-9]/g, "");
}

function companyBase(dealName: string): string {
  return companyFromDealName(dealName).toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Corporate domain → deal, from all three evidence sources. Built once per
 * sweep (three cheap queries), reused across every event in the batch.
 */
export async function dealDomainMap(): Promise<DealTieLookup> {
  const [deals, founderDomains, referralDomains] = await Promise.all([
    withRetry(
      () => sql<{ gid: string; name: string; stage: string; created_on: string }[]>`
        select gid, name, stage, created_on::text from deals
      `
    ),
    withRetry(
      () => sql<{ gid: string; name: string; stage: string; domain: string }[]>`
        select d.gid, d.name, d.stage, split_part(lower(p.email), '@', 2) as domain
          from deal_founders f
          join network_people p on p.id = f.person_id
          join deals d on d.gid = f.deal_gid
         where p.email is not null
      `
    ).catch(() => []),
    withRetry(
      () => sql<{ gid: string; name: string; stage: string; domain: string }[]>`
        select d.gid, d.name, d.stage, split_part(lower(r.email), '@', 2) as domain
          from deal_referrals r join deals d on d.gid = r.deal_gid
      `
    ).catch(() => []),
  ]);

  const map = new Map<string, DealTie & { active: boolean; created: string }>();
  const consider = (
    domain: string,
    tie: DealTie,
    active: boolean,
    created: string
  ) => {
    if (!domain || !canExpandToDomain(`x@${domain}`)) return;
    const cur = map.get(domain);
    // Active deals outrank passed ones; ties break to the newer deal.
    if (
      !cur ||
      (active && !cur.active) ||
      (active === cur.active && created > cur.created)
    ) {
      map.set(domain, { ...tie, active, created });
    }
  };

  for (const f of founderDomains) {
    consider(
      f.domain,
      { gid: f.gid, name: f.name, via: "founder-email" },
      ACTIVE_STAGES.has(f.stage),
      "9999" // direct evidence always wins over title heuristics
    );
  }
  for (const r of referralDomains) {
    consider(
      r.domain,
      { gid: r.gid, name: r.name, via: "referral" },
      ACTIVE_STAGES.has(r.stage),
      "9998"
    );
  }
  // Title heuristic: companyBase("Lark AI") = "larkai" = domainBase(larkai.com).
  // Held as a BASE index and consulted at lookup time, so infera.bio ties to
  // the deal "Infera" without anyone having to guess which TLD a startup
  // picked — the earlier hardcoded .com/.co/.io list missed .bio and let the
  // same company be created three times from one meeting.
  const byBase = new Map<string, { gid: string; name: string; stage: string; created_on: string }>();
  for (const d of deals) {
    const base = companyBase(d.name);
    if (base.length < 4) continue; // "ai", "labs" — too generic to trust
    const cur = byBase.get(base);
    if (
      !cur ||
      (ACTIVE_STAGES.has(d.stage) && !ACTIVE_STAGES.has(cur.stage)) ||
      (ACTIVE_STAGES.has(d.stage) === ACTIVE_STAGES.has(cur.stage) &&
        d.created_on > cur.created_on)
    ) {
      byBase.set(base, d);
    }
  }

  const byDomain = new Map(
    [...map].map(([k, v]) => [k, { gid: v.gid, name: v.name, via: v.via }])
  );
  return {
    get(domain: string): DealTie | null {
      const direct = byDomain.get(domain);
      if (direct) return direct;
      const d = byBase.get(domainBase(domain));
      return d ? { gid: d.gid, name: d.name, via: "title-match" } : null;
    },
  };
}

export interface DealTieLookup {
  get(domain: string): DealTie | null;
}

/** Team addresses never count as external — the meeting is ABOUT the others. */
async function internalAddresses(): Promise<Set<string>> {
  const rows = await withRetry(
    () => sql<{ email: string }[]>`select lower(email) as email from app_users`
  ).catch(() => [] as { email: string }[]);
  return new Set(rows.map((r) => r.email));
}

function isInternal(email: string, internal: Set<string>): boolean {
  return internal.has(email) || isInternalEmail(email);
}

/** The per-event read model — used by the sweep and the /meetings page. */
export function enrichMeeting(
  attendees: { email?: string | null; name?: string | null }[],
  internal: Set<string>,
  domains: DealTieLookup
): MeetingEnrichment {
  const externals = attendees
    .map(attendeeIdentity)
    .filter((a): a is AttendeeIdentity => a !== null && !isInternal(a.email, internal));

  const companies: CompanyOnMeeting[] = [...clusterByCompany(externals)].map(
    ([domain, people]) => {
      const tie = domains.get(domain) ?? null;
      return {
        domain,
        attendees: people,
        investor: looksLikeInvestorDomain(domain),
        dealGid: tie?.gid ?? null,
        dealName: tie?.name ?? null,
        via: tie?.via ?? null,
      };
    }
  );
  return { externals, companies };
}

export interface SweepStats {
  scanned: number;
  meetingsLinked: number;
  foundersLinked: number;
  interactionsStamped: number;
}

/**
 * Sweep recently-synced events and write back what the evidence supports.
 * Incremental via enriched_at; safe to re-run (every write is idempotent).
 */
export async function reverseEnrichSweep(
  limit = Number(process.env.CAL_ENRICH_BATCH ?? 200)
): Promise<SweepStats> {
  const stats: SweepStats = {
    scanned: 0,
    meetingsLinked: 0,
    foundersLinked: 0,
    interactionsStamped: 0,
  };

  const events = await withRetry(
    () => sql<{
      id: string;
      title: string | null;
      starts_at: Date | null;
      matched_deal_gid: string | null;
      attendees: { email?: string; name?: string }[];
    }[]>`
      select id, title, starts_at, matched_deal_gid,
             coalesce(attendees, '[]'::jsonb) as attendees
        from calendar_events
       where enriched_at is null or updated_at > enriched_at
       -- Nearest to NOW first. Descending-by-date starts the backfill in the
       -- 2040s (recurring-event placeholders) and takes hours of sweeps to
       -- reach the meetings that actually matter — this week's.
       order by abs(extract(epoch from (starts_at - now()))) asc nulls last
       limit ${limit}
    `
  );
  if (events.length === 0) return stats;

  const [internal, domains] = await Promise.all([
    internalAddresses(),
    dealDomainMap(),
  ]);

  for (const ev of events) {
    stats.scanned++;
    try {
      const enr = enrichMeeting(ev.attendees, internal, domains);
      const tied = enr.companies.filter((c) => c.dealGid);

      // 1. Meeting → deal, only when the evidence is unambiguous: exactly one
      //    tied company on the invite. Never overwrites an existing match.
      if (!ev.matched_deal_gid && tied.length === 1) {
        await sql`
          update calendar_events
             set matched_deal_gid = ${tied[0].dealGid},
                 match_confidence = 0.7,
                 match_evidence = ${sql.json({
                   via: `attendee-domain (${tied[0].via})`,
                   domain: tied[0].domain,
                 } as never)}
           where id = ${ev.id} and matched_deal_gid is null
        `;
        stats.meetingsLinked++;
      }

      // 2. Attendee → founder, only through the strict matcher: the address's
      //    local part must match a founder name already printed in the deal
      //    title. "brian@" never becomes Ian this way.
      for (const company of tied) {
        const founderNames = founderNamesFromDealName(company.dealName ?? "");
        for (const person of company.attendees) {
          const match = founderNames.find((n) =>
            localPartMatchesName(person.email, n)
          );
          if (!match) continue;
          const linked = await linkFounder(
            company.dealGid!,
            match,
            person.email
          );
          if (linked) stats.foundersLinked++;
        }
      }

      // 3. People we already know were in the room — stamp the interaction
      //    (past meetings only; a future invite isn't contact yet).
      if (ev.starts_at && ev.starts_at.getTime() <= Date.now()) {
        const emails = enr.externals.map((a) => a.email);
        if (emails.length > 0) {
          const stamped = await sql<{ id: string }[]>`
            update network_people p
               set last_interaction_at = greatest(
                     coalesce(p.last_interaction_at, 'epoch'::timestamptz),
                     ${ev.starts_at}
                   )
             where (lower(p.email) = any(${emails})
                    or exists (select 1 from unnest(p.alt_emails) a
                                where lower(a) = any(${emails})))
               and (p.last_interaction_at is null or p.last_interaction_at < ${ev.starts_at})
             returning id
          `;
          stats.interactionsStamped += stamped.length;
        }
      }

      await sql`update calendar_events set enriched_at = now() where id = ${ev.id}`;
    } catch (err) {
      logError("calendar", "reverse enrich failed for event", err, { id: ev.id });
    }
  }

  logEvent("info", "calendar", "reverse enrich sweep done", { ...stats });
  return stats;
}

/**
 * Attach a founder discovered on an invite. Reuses an existing person row by
 * name — creating a second "Remy Rosado" is exactly the duplicate bug this
 * codebase already paid for once — and never overwrites a stored email.
 */
export async function linkFounder(
  dealGid: string,
  founderName: string,
  email: string
): Promise<boolean> {
  const existing = await sql<{ id: string; email: string | null }[]>`
    select id, email from network_people
     where lower(name) = ${founderName.toLowerCase()}
     order by (email is not null) desc, created_at asc
     limit 1
  `;
  let personId = existing[0]?.id ?? null;

  if (personId) {
    if (!existing[0].email) {
      // The unique index means a taken address stays where it is.
      await sql`
        update network_people set email = ${email}, updated_at = now()
         where id = ${personId}
           and not exists (select 1 from network_people where lower(email) = ${email})
      `.catch(() => {});
    }
  } else {
    const rows = await sql<{ id: string }[]>`
      insert into network_people (name, school, added_by, email, profile_status)
      values (${founderName}, 'Unknown', 'calendar-enrich', ${email}, 'partial')
      on conflict do nothing
      returning id
    `.catch(() => [] as { id: string }[]);
    personId = rows[0]?.id ?? null;
  }
  if (!personId) return false;

  const link = await sql<{ deal_gid: string }[]>`
    insert into deal_founders (deal_gid, person_id, founder_role, created_by)
    values (${dealGid}, ${personId}, 'Founder', 'calendar-enrich')
    on conflict do nothing
    returning deal_gid
  `;
  return link.length > 0;
}


/* ── The personal triage surface ─────────────────────────────────────────── */

export interface TriageMeeting {
  id: string;
  title: string;
  startsAt: string | null;
  endsAt: string | null;
  conferenceUrl: string | null;
  upcoming: boolean;
  externals: AttendeeIdentity[];
  companies: CompanyOnMeeting[];
  matchedDealGid: string | null;
  matchedDealName: string | null;
  /** Google event key — joins meetings to their Granola note. */
  providerEventKey: string | null;
  /** Company domains the reviewer already said no to, hidden from actions. */
  dismissed: string[];
}

/**
 * One person's meetings, enriched, ready to triage: recent past (what did I
 * just take, is it on the board?) and near future (what am I walking into?).
 * Scoped to the signed-in member's own calendar — this page is personal by
 * construction; each member sees only meetings their connected account owns.
 */
export async function meetingsForTriage(
  ownerEmail: string,
  pastDays = 30,
  futureDays = 21
): Promise<TriageMeeting[]> {
  const events = await withRetry(
    () => sql<{
      id: string;
      title: string | null;
      starts_at: Date | null;
      ends_at: Date | null;
      conference_url: string | null;
      matched_deal_gid: string | null;
      matched_name: string | null;
      provider_event_key: string | null;
      triage_dismissed: string[] | null;
      attendees: { email?: string; name?: string }[];
    }[]>`
      select e.id, e.title, e.starts_at, e.ends_at, e.conference_url,
             e.matched_deal_gid, d.name as matched_name,
             e.provider_event_key,
             e.triage_dismissed,
             coalesce(e.attendees, '[]'::jsonb) as attendees
        from calendar_events e
        left join deals d on d.gid = e.matched_deal_gid
       where e.owner_email = ${ownerEmail.toLowerCase()}
         and e.status is distinct from 'cancelled'
         and e.starts_at between now() - make_interval(days => ${pastDays})
                             and now() + make_interval(days => ${futureDays})
       order by e.starts_at desc
       limit 200
    `
  );
  if (events.length === 0) return [];

  const [internal, domains, openByDomain] = await Promise.all([
    internalAddresses(),
    dealDomainMap(),
    openCandidateDomains(),
  ]);
  const now = Date.now();

  return events
    .map((ev) => {
      const enr = enrichMeeting(ev.attendees, internal, domains);
      for (const c of enr.companies) {
        const open = openByDomain.get(c.domain);
        if (open && !c.dealGid) {
          c.candidateId = open.id;
          c.candidateSubject = open.subject;
        }
      }
      return {
        id: ev.id,
        title: ev.title ?? "Untitled",
        startsAt: ev.starts_at ? ev.starts_at.toISOString() : null,
        endsAt: ev.ends_at ? ev.ends_at.toISOString() : null,
        conferenceUrl: ev.conference_url,
        upcoming: !!ev.starts_at && ev.starts_at.getTime() > now,
        externals: enr.externals,
        companies: enr.companies,
        matchedDealGid: ev.matched_deal_gid,
        matchedDealName: ev.matched_name,
        providerEventKey: ev.provider_event_key,
        dismissed: ev.triage_dismissed ?? [],
      };
    })
    // Internal-only meetings (standups, team lunches) carry nothing to triage.
    .filter((m) => m.externals.length > 0);
}


/** One event, enriched — the shape the triage actions verify against. */
export async function enrichEventById(eventId: string): Promise<
  | (MeetingEnrichment & {
      title: string;
      startsAt: Date | null;
      upcoming: boolean;
      matchedDealGid: string | null;
    })
  | null
> {
  const rows = await withRetry(
    () => sql<{
      id: string;
      title: string | null;
      starts_at: Date | null;
      matched_deal_gid: string | null;
      attendees: { email?: string; name?: string }[];
    }[]>`
      select id, title, starts_at, matched_deal_gid,
             coalesce(attendees, '[]'::jsonb) as attendees
        from calendar_events where id = ${eventId}
    `
  );
  const ev = rows[0];
  if (!ev) return null;
  const [internal, domains] = await Promise.all([
    internalAddresses(),
    dealDomainMap(),
  ]);
  const enr = enrichMeeting(ev.attendees, internal, domains);
  return {
    ...enr,
    title: ev.title ?? "Untitled",
    startsAt: ev.starts_at,
    upcoming: !!ev.starts_at && ev.starts_at.getTime() > Date.now(),
    matchedDealGid: ev.matched_deal_gid,
  };
}

/** "corvia.dev" → "Corvia" — a presentable company name from a domain. */
export function companyNameFromDomain(domain: string): string {
  const base = domainBase(domain);
  return base ? base[0].toUpperCase() + base.slice(1) : domain;
}


/** Open inbox items keyed by the corporate domains their pitch mentions. */
async function openCandidateDomains(): Promise<
  Map<string, { id: string; subject: string }>
> {
  const rows = await withRetry(
    () => sql<{ id: string; subject: string | null; domain: string }[]>`
      select c.id, e.subject, d.domain
        from deal_candidates c
        join inbound_emails e on e.id = c.source_email_id,
             lateral (
               select split_part(lower(f->>'email'), '@', 2) as domain
                 from jsonb_array_elements(coalesce(e.parsed->'founders', '[]'::jsonb)) f
                where f->>'email' is not null
               union
               select split_part(lower(coalesce(e.from_email, '')), '@', 2)
             ) d
       where c.status in ('detected', 'parsing', 'ready', 'assigned')
         and d.domain <> '' and d.domain <> all(${sql.array([...INTERNAL_DOMAIN_SET])})
    `
  ).catch(() => [] as { id: string; subject: string | null; domain: string }[]);
  const map = new Map<string, { id: string; subject: string }>();
  for (const r of rows) {
    if (!canExpandToDomain(`x@${r.domain}`)) continue;
    if (!map.has(r.domain)) {
      map.set(r.domain, { id: r.id, subject: r.subject ?? "(no subject)" });
    }
  }
  return map;
}
