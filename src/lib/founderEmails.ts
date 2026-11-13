import "server-only";
import { sql } from "./db";
import { withRetry } from "./retry";
import {
  classifyDomain,
  domainOf,
  canExpandToDomain,
  localPartMatchesName,
  type DomainKind,
} from "./emailDomains";

/**
 * ── A founder's addresses ────────────────────────────────────────────────────
 * Founders routinely have more than one: a school address they signed up with
 * and a company one they moved to, or a personal Gmail alongside either. A
 * meeting invite might use one and a thread the other, so holding only a single
 * address quietly loses half the history.
 *
 * The second address rarely needs typing — it's usually already sitting in a
 * calendar invite next to the first, under the same display name. So the app
 * proposes and the human confirms, rather than asking anyone to transcribe.
 *
 * Suggestions are evidence, never inference: an address is only proposed when
 * it shares a display name with one we already trust. Display names do collide,
 * which is exactly why nothing is stored until it's confirmed.
 */

export interface AddressView {
  email: string;
  kind: DomainKind;
  /** Primary is the one shown on the row and used for mailto. */
  primary: boolean;
}

export interface SuggestionView {
  email: string;
  kind: DomainKind;
  /** Where we saw it, so the choice is auditable rather than magic. */
  seenAs: string;
}

export interface FounderEmailView {
  personId: string;
  name: string;
  addresses: AddressView[];
  suggestions: SuggestionView[];
}

/** Everything we know, and everything we could propose, for one deal. */
export async function founderEmailState(
  gid: string
): Promise<FounderEmailView[]> {
  const people = await withRetry(
    () => sql<{ id: string; name: string; email: string | null; alt_emails: string[] }[]>`
      select p.id, p.name, p.email, p.alt_emails
        from deal_founders f join network_people p on p.id = f.person_id
       where f.deal_gid = ${gid}
       order by p.name
    `
  );
  if (people.length === 0) return [];

  const dismissedRows = await withRetry(
    () => sql<{ person_id: string; email: string }[]>`
      select d.person_id, lower(d.email) email
        from founder_email_dismissed d
        join deal_founders f on f.person_id = d.person_id
       where f.deal_gid = ${gid}
    `
  ).catch(() => [] as { person_id: string; email: string }[]);
  const dismissed = new Set(dismissedRows.map((d) => `${d.person_id}|${d.email}`));

  const known = new Set<string>();
  for (const p of people) {
    if (p.email) known.add(p.email.toLowerCase());
    for (const a of p.alt_emails ?? []) known.add(a.toLowerCase());
  }

  // Calendar attendees are the richest source: an invite names the person and
  // carries the address, so the same human under two addresses is visible.
  const seen = await withRetry(
    () => sql<{ person_id: string; email: string; seen_as: string }[]>`
      with mine as (
        select p.id person_id, lower(p.email) e
          from deal_founders f join network_people p on p.id = f.person_id
         where f.deal_gid = ${gid} and p.email is not null
        union
        select p.id, lower(a)
          from deal_founders f join network_people p on p.id = f.person_id,
               lateral unnest(p.alt_emails) a
         where f.deal_gid = ${gid}
      ),
      att as (
        select lower(a->>'email') em, lower(nullif(trim(a->>'name'), '')) nm
          from calendar_events e,
               lateral jsonb_array_elements(coalesce(e.attendees, '[]'::jsonb)) a
         where nullif(trim(a->>'name'), '') is not null
      ),
      -- The display names our known addresses appear under.
      names as (select distinct att.nm, mine.person_id from att join mine on att.em = mine.e)
      select distinct names.person_id, att.em as email, names.nm as seen_as
        from names join att on att.nm = names.nm
       where att.em not in (select e from mine)
         and not exists (
           select 1 from founder_email_dismissed d
            where d.person_id = names.person_id and lower(d.email) = att.em
         )
    `
  ).catch(() => [] as { person_id: string; email: string; seen_as: string }[]);

  // Second strategy, and the one that actually fires: only ~6% of calendar
  // attendees carry a display name, so the name bridge above finds almost
  // nothing. But once any founder is known at a company domain, that domain
  // belongs to this deal — and other addresses on it usually say whose in the
  // local part. That's how ian@pemberly.co reaches Ian Lee when the invite
  // recorded no name at all.
  const companyDomains = Array.from(
    new Set(
      [...known]
        .filter(canExpandToDomain)
        .map(domainOf)
        .filter(Boolean)
    )
  );
  const sameDomain =
    companyDomains.length === 0
      ? []
      : await withRetry(
          () => sql<{ email: string }[]>`
            select distinct lower(a->>'email') as email
              from calendar_events e,
                   lateral jsonb_array_elements(coalesce(e.attendees, '[]'::jsonb)) a
             where split_part(lower(a->>'email'), '@', 2) = any(${companyDomains})
          `
        ).catch(() => [] as { email: string }[]);

  return people.map((p) => {
    const alts = (p.alt_emails ?? []).map((a) => a.toLowerCase());
    const addresses: AddressView[] = [
      ...(p.email ? [{ email: p.email, kind: classifyDomain(p.email), primary: true }] : []),
      ...alts.map((a) => ({ email: a, kind: classifyDomain(a), primary: false })),
    ];
    return {
      personId: p.id,
      name: p.name,
      addresses,
      suggestions: [
        ...seen
          .filter((s) => s.person_id === p.id && !known.has(s.email))
          .map((s) => ({
            email: s.email,
            kind: classifyDomain(s.email),
            seenAs: `named "${s.seen_as}" on an invite`,
          })),
        ...sameDomain
          .map((r) => r.email)
          .filter(
            (em) =>
              !known.has(em) &&
              !dismissed.has(`${p.id}|${em}`) &&
              localPartMatchesName(em, p.name)
          )
          .map((em) => ({
            email: em,
            kind: classifyDomain(em),
            seenAs: `on the company domain, matching ${p.name}`,
          })),
      ]
        // The same address can arrive from both strategies.
        .filter((s, i, all) => all.findIndex((o) => o.email === s.email) === i)
        .slice(0, 4),
    };
  });
}

/**
 * Attach an address. The company one leads — it's what you'd actually send to,
 * and the only kind that expands to find colleagues — so a corporate address
 * takes over as primary and demotes whatever was there.
 */
export async function addFounderEmail(
  personId: string,
  email: string
): Promise<void> {
  const addr = email.trim().toLowerCase();
  const rows = await sql<{ email: string | null }[]>`
    select email from network_people where id = ${personId}
  `;
  const current = rows[0]?.email?.toLowerCase() ?? null;
  const promote = !current || (classifyDomain(addr) === "corporate" && classifyDomain(current) !== "corporate");

  if (promote) {
    await sql`
      update network_people
         set email = ${addr},
             email_confirmed = true,
             alt_emails = (
               select coalesce(array_agg(distinct e), '{}')
                 from unnest(array_remove(array_append(alt_emails, ${current}), ${addr})) e
                where e is not null
             ),
             updated_at = now()
       where id = ${personId}
    `;
  } else {
    await sql`
      update network_people
         set alt_emails = (
               select coalesce(array_agg(distinct e), '{}')
                 from unnest(array_append(alt_emails, ${addr})) e
                where e is not null and e <> ${current}
             ),
             updated_at = now()
       where id = ${personId}
    `;
  }
  // Adding settles the question; drop any standing suggestion for it.
  await sql`
    delete from founder_email_dismissed
     where person_id = ${personId} and lower(email) = ${addr}
  `.catch(() => {});
}

/** Promote an address already on the record to primary. */
export async function setPrimaryFounderEmail(
  personId: string,
  email: string
): Promise<void> {
  const addr = email.trim().toLowerCase();
  await sql`
    update network_people
       set email = ${addr},
           email_confirmed = true,
           alt_emails = (
             select coalesce(array_agg(distinct e), '{}')
               from unnest(array_remove(array_append(alt_emails, email), ${addr})) e
              where e is not null
           ),
           updated_at = now()
     where id = ${personId}
  `;
}

/** Remember a rejection so the same guess never comes back. */
export async function dismissFounderEmail(
  personId: string,
  email: string,
  by: string
): Promise<void> {
  await sql`
    insert into founder_email_dismissed (person_id, email, dismissed_by)
    values (${personId}, ${email.trim().toLowerCase()}, ${by})
    on conflict (person_id, email) do nothing
  `;
}

/** Detach an address entirely (primary or alternate). */
export async function removeFounderEmail(
  personId: string,
  email: string
): Promise<void> {
  const addr = email.trim().toLowerCase();
  await sql`
    update network_people
       set email = case when lower(email) = ${addr} then null else email end,
           alt_emails = array_remove(alt_emails, ${addr}),
           updated_at = now()
     where id = ${personId}
  `;
}
