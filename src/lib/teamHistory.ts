import "server-only";
import { sql } from "./db";
import { withRetry } from "./retry";
import { ensureCompaniesSchema } from "./companies";
import { INTERNAL_DOMAINS, isInternalEmail, normalizeCompanyDomain, normalizeCompanyName } from "./companiesPure";
import {
  EVIDENCE_STRENGTH,
  dealsByFounderEmails,
  dealsByFounderNames,
  dealsByNameBase,
  reasonText,
} from "./identityEvidence";

/**
 * ── Team history: "has the team seen this before?" ─────────────────────────────
 * Computed the moment a candidate renders, before any action (PRD §9.5).
 * Evidence, strongest first: company domain → company name → sender email →
 * founder names. Every claim links back to the thing it came from.
 */

export interface PriorDeal {
  gid: string;
  name: string;
  stage: string;
  owner: string;
  created_on: string | null;
  decision: string | null;
  decision_rationale: string | null;
  decision_at: string | null;
  /** Plain-language evidence: why this deal matched the candidate. */
  why?: string | null;
}

export interface PriorEmail {
  id: string;
  subject: string | null;
  from_email: string | null;
  received_at: string | null;
  status: string;
}

export interface TeamHistory {
  /** Company-level match with all its deals across cycles. */
  company: { id: string; name: string; domain: string | null } | null;
  deals: PriorDeal[];
  /** Earlier inbound emails from the same sender or domain. */
  priorEmails: PriorEmail[];
  /** Calendar/mail metadata touches involving these people (restricted: existence only). */
  interactions: { source: string; title: string | null; occurred_at: string | null }[];
  /** People already in the network by name. */
  knownPeople: { id: string; name: string; school: string | null; current_title: string | null }[];
}

const EMPTY: TeamHistory = {
  company: null,
  deals: [],
  priorEmails: [],
  interactions: [],
  knownPeople: [],
};

export async function teamHistoryFor(input: {
  companyName?: string | null;
  website?: string | null;
  senderEmail?: string | null;
  founderNames?: string[];
  /** Founder emails from the extraction — the real people behind a forward. */
  founderEmails?: string[];
  /** Exclude the candidate's own source email from "prior" evidence. */
  excludeEmailId?: string | null;
}): Promise<TeamHistory> {
  try {
    await ensureCompaniesSchema();
    const senderRaw = input.senderEmail?.trim().toLowerCase() || null;
    // A forward: the "sender" is one of us. Fall back to the founders the
    // extraction named — they are who the history question is about.
    const senderIsInternal = isInternalEmail(senderRaw);
    const sender = senderIsInternal ? null : senderRaw;
    const founderEmails = (input.founderEmails ?? [])
      .map((e) => e.trim().toLowerCase())
      .filter((e) => e.includes("@") && !isInternalEmail(e))
      .slice(0, 4);
    const people = [...new Set([...(sender ? [sender] : []), ...founderEmails])];
    const senderDomain = normalizeCompanyDomain(sender ?? undefined);
    const domain =
      normalizeCompanyDomain(input.website ?? undefined) ??
      normalizeCompanyDomain(founderEmails[0] ?? undefined) ??
      (senderDomain && !INTERNAL_DOMAINS.has(senderDomain) ? senderDomain : null);
    const nameNorm = normalizeCompanyName(input.companyName ?? "");
    const founderNames = (input.founderNames ?? [])
      .map((n) => n.trim())
      .filter((n) => n.length > 3);

    // 1 · Company: domain first, then exact normalized name.
    const companyRows = await withRetry(
      () => sql<{ id: string; canonical_name: string; normalized_domain: string | null }[]>`
        select id, canonical_name, normalized_domain from deal_companies
        where (${domain}::text is not null and normalized_domain = ${domain})
           or (${nameNorm} <> '' and name_normalized = ${nameNorm})
        order by (normalized_domain = ${domain}) desc nulls last
        limit 1`
    );
    const company = companyRows[0] ?? null;

    // 2 · Deals, triangulated — evidence strongest first, deduped by gid:
    //    founder links (these exact people) > the company row > the deal
    //    name's base matching the company/domain > a thread that already
    //    carries a deal. Deals born outside the inbox (calendar door, manual)
    //    have no company_id, so the name/founder paths are what find them.
    const candidates = new Map<string, { strength: number; why: string }>();
    const consider = (gid: string, strength: number, why: string) => {
      const cur = candidates.get(gid);
      if (!cur || strength > cur.strength) candidates.set(gid, { strength, why });
    };

    // Founder links, both directions, through the ONE identity service —
    // strength and wording come from its reason ladder.
    const linked = await dealsByFounderEmails(people);
    for (const r of linked) {
      consider(r.gid, EVIDENCE_STRENGTH.founder_email, reasonText("founder_email", r.personName));
    }

    // Founder NAME links — weaker than an email hit, stronger than a bare
    // name-base match, and only for full multi-word names.
    const byName = await dealsByFounderNames(founderNames);
    for (const r of byName) {
      consider(r.gid, EVIDENCE_STRENGTH.founder_name, reasonText("founder_name", r.personName));
    }

    if (company) {
      const underCompany = await withRetry(
        () => sql<{ gid: string }[]>`
          select gid from deals where company_id = ${company.id}
          order by created_on desc nulls last limit 6`
      ).catch(() => [] as { gid: string }[]);
      for (const r of underCompany) {
        consider(r.gid, EVIDENCE_STRENGTH.company_row, reasonText("company_row", company.canonical_name));
      }
    }

    // Name-base match via the indexed generated column — replaces the old
    // "select every deal name and scan it in JS per candidate open" path.
    const base = (x: string) => x.toLowerCase().replace(/[^a-z0-9]/g, "");
    const nameBase = base(input.companyName ?? "");
    const domBase = domain ? base(domain.split(".")[0]) : "";
    const baseHits = await dealsByNameBase([nameBase, domBase]);
    for (const d of baseHits) {
      if (nameBase.length >= 4 && d.nameBase === nameBase) {
        consider(
          d.gid,
          EVIDENCE_STRENGTH.name_base_company,
          reasonText("name_base_company", input.companyName ?? nameBase)
        );
      } else if (domBase.length >= 4 && d.nameBase === domBase) {
        consider(
          d.gid,
          EVIDENCE_STRENGTH.name_base_domain,
          reasonText("name_base_domain", domain ?? domBase)
        );
      }
    }

    if (people.length > 0 || domain) {
      const threaded = await withRetry(
        () => sql<{ deal_gid: string }[]>`
          select distinct deal_gid from inbound_emails
           where deal_gid is not null
             and (
               (${people.length > 0} and lower(from_email) = any(${people}))
               or (${domain}::text is not null and lower(from_email) like ${"%@" + (domain ?? "")})
             )
           limit 4`
      ).catch(() => [] as { deal_gid: string }[]);
      for (const r of threaded) {
        consider(r.deal_gid, EVIDENCE_STRENGTH.thread, reasonText("thread", ""));
      }
    }

    const ranked = [...candidates.entries()]
      .sort((a, b) => b[1].strength - a[1].strength)
      .slice(0, 5);
    const deals: PriorDeal[] =
      ranked.length > 0
        ? await withRetry(
            () => sql<PriorDeal[]>`
              select d.gid, d.name, d.stage,
                     coalesce(
                       nullif((select string_agg(split_part(u.name, ' ', 1), ', ')
                          from deal_owners o join app_users u on u.email = o.email
                         where o.deal_gid = d.gid), ''),
                       nullif(d.owner, 'Unassigned'),
                       ''
                     ) as owner,
                     d.created_on::text as created_on,
                     dd.decision, dd.rationale as decision_rationale,
                     dd.created_at::text as decision_at
              from deals d
              left join lateral (
                select decision, rationale, created_at from deal_decisions
                where deal_gid = d.gid order by created_at desc limit 1
              ) dd on true
              where d.gid = any(${ranked.map(([gid]) => gid)})`
          ).then((rows) => {
            const order = new Map(ranked.map(([gid], i) => [gid, i]));
            const why = new Map(ranked.map(([gid, v]) => [gid, v.why]));
            return rows
              .map((r) => ({ ...r, why: why.get(r.gid) ?? null }))
              .sort((a, b) => (order.get(a.gid) ?? 9) - (order.get(b.gid) ?? 9));
          })
        : [];

    // 3 · Prior inbound emails from the founders (or external sender) or domain.
    const priorEmails =
      people.length > 0 || domain
        ? await withRetry(
            () => sql<PriorEmail[]>`
              select id, subject, from_email, received_at::text as received_at, status
              from inbound_emails
              where (${input.excludeEmailId ?? null}::uuid is null or id <> ${input.excludeEmailId ?? null})
                and (
                  (${people.length > 0} and lower(from_email) = any(${people}))
                  or (${domain}::text is not null and lower(from_email) like ${"%@" + (domain ?? "")})
                )
              order by received_at desc nulls last
              limit 5`
          )
        : [];

    // 4 · Metadata interactions (calendar/mail sync) touching those people.
    const interactions =
      people.length > 0
        ? await withRetry(
            () => sql<{ source: string; title: string | null; occurred_at: string | null }[]>`
              select source, title, occurred_at::text as occurred_at
              from network_interactions
              where ${people
                .map((p) => sql`participants::text ilike ${"%" + p + "%"}`)
                .reduce((a, b) => sql`${a} or ${b}`)}
              order by occurred_at desc nulls last
              limit 5`
          ).catch(() => [])
        : [];

    // 5 · Founders already known to the network (by name).
    const knownPeople =
      founderNames.length > 0
        ? await withRetry(
            () => sql<{ id: string; name: string; school: string | null; current_title: string | null }[]>`
              select id, name, school, current_title from network_people
              where lower(name) = any(${founderNames.map((n) => n.toLowerCase())})
              limit 6`
          ).catch(() => [])
        : [];

    return { company: company ? { id: company.id, name: company.canonical_name, domain: company.normalized_domain } : null, deals, priorEmails, interactions, knownPeople };
  } catch {
    // History must never block triage — an empty panel beats a dead page.
    return EMPTY;
  }
}
