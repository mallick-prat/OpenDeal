import "server-only";
import { corporateDomainOf } from "./meetingNotesPure";
import { sql } from "./db";
import { withRetry } from "./retry";
import { companyFromDealName } from "./founders";
import { normalizeEvidenceEmail } from "./identityEvidencePure";

export {
  EVIDENCE_REASONS,
  EVIDENCE_STRENGTH,
  nameBaseOf,
  normalizeEvidenceEmail,
  reasonText,
  type EvidenceReason,
} from "./identityEvidencePure";
import { INTERNAL_DOMAIN_SET } from "@/config/crm.config";

/**
 * ── The one founder-identity service ────────────────────────────────────────
 * Every matcher used to assemble its own "who belongs to this deal" pool —
 * meetingNotes, calendarSync, teamHistory, and dealEmails each carried a
 * near-identical copy. That duplication is why one bug poisoned all of them
 * at once, twice: the alt_emails text[]-vs-jsonb mistake silently emptied
 * founder-email evidence everywhere, and internal team senders became
 * "founder evidence" that gummed a partner's every meeting to one deal.
 *
 * This module is now the single place that decides:
 *   · which addresses count as founder identity (external only, canonical
 *     network_people.email plus alt_emails, plus external inbound senders)
 *   · how a deal name maps to its company base (name_base, mirrored by a
 *     generated column in Postgres so lookups are indexed, not scanned)
 *   · the reason codes matchers attach to their matches
 *
 * Matchers consume it; none of them re-derive identity on their own.
 */

/* ── Schema ──────────────────────────────────────────────────────────────── */

let nameBaseReady: Promise<void> | null = null;
/**
 * deals.name_base generated column + index. Catalog-check first: an
 * `alter table … if not exists` no-op still takes an ACCESS EXCLUSIVE lock
 * on deals — the hottest table — per cold lambda, which is the exact lock-
 * convoy class that took the dashboard down via perf_events. The checks
 * below read catalogs only; DDL runs solely on genuine absence.
 */
export function ensureNameBase(): Promise<void> {
  nameBaseReady ??= (async () => {
    const col = await sql<{ ok: boolean }[]>`
      select exists (
        select 1 from information_schema.columns
         where table_schema = 'public' and table_name = 'deals' and column_name = 'name_base'
      ) as ok`;
    if (!col[0]?.ok) {
      await sql`
        alter table deals add column if not exists name_base text
          generated always as (
            regexp_replace(lower(regexp_replace(name, '^.*//', '')), '[^a-z0-9]', '', 'g')
          ) stored`.catch(() => {});
    }
    const idx = await sql<{ ok: boolean }[]>`
      select to_regclass('public.deals_name_base_idx') is not null as ok`;
    if (!idx[0]?.ok) {
      await sql`create index if not exists deals_name_base_idx on deals (name_base)`.catch(
        () => {}
      );
    }
  })().catch((err) => {
    nameBaseReady = null;
    throw err;
  });
  return nameBaseReady;
}

/* ── The pool ────────────────────────────────────────────────────────────── */

export interface DealEvidencePool {
  gid: string;
  name: string;
  /** Company row's canonical name, else the deal name's company side. */
  companyName: string;
  /** External founder addresses: canonical + alts + inbound senders. */
  founderEmails: string[];
  founderNames: string[];
  /** Corporate domains: the company's own plus founders' work domains. */
  domains: string[];
  /** False for passed/to-pass deals (included only when asked). */
  active: boolean;
}

/**
 * Deals with whatever founder identity we can assemble. Open pipeline by
 * default; includeClosed adds passed/to-pass rows flagged active:false —
 * a meeting note about a passed deal is still that deal's context, but
 * weak evidence should never SUGGEST toward a dead deal. Each source is
 * fetched defensively — a missing side table (fresh DB) degrades that
 * signal to empty rather than failing the caller's sync.
 */
export async function loadDealEvidencePools(
  opts: { includeClosed?: boolean } = {}
): Promise<DealEvidencePool[]> {
  const includeClosed = opts.includeClosed === true;
  type Row = { gid: string; name: string; company_name: string | null; company_domain: string | null; stage: string };
  let rows: Row[];
  try {
    rows = await withRetry(
      () => sql<Row[]>`
        select d.gid, d.name, c.canonical_name as company_name,
               c.normalized_domain as company_domain, d.stage
        from deals d
        left join deal_companies c on c.id = d.company_id
        where ${includeClosed} or d.stage not in ('passed', 'to-pass')
      `
    );
  } catch {
    // deal_companies may not exist yet — fall back to bare deals.
    rows = await withRetry(
      () => sql<Row[]>`
        select gid, name, null as company_name, null as company_domain, stage
        from deals where ${includeClosed} or stage not in ('passed', 'to-pass')
      `
    ).catch(() => []);
  }

  const emailsByGid = new Map<string, string[]>();
  const addEmail = (gid: string, email: string | null | undefined) => {
    const e = normalizeEvidenceEmail(email);
    if (!e) return;
    const cur = emailsByGid.get(gid);
    if (cur) {
      if (!cur.includes(e)) cur.push(e);
    } else {
      emailsByGid.set(gid, [e]);
    }
  };
  try {
    const emailRows = await withRetry(
      () => sql<{ deal_gid: string; emails: string[] }[]>`
        select deal_gid, array_agg(distinct lower(from_email)) as emails
        from inbound_emails
        where deal_gid is not null and from_email is not null
        group by deal_gid
      `
    );
    for (const r of emailRows) for (const e of r.emails ?? []) addEmail(r.deal_gid, e);
  } catch {
    // inbound_emails absent — founder links remain the only email evidence.
  }
  try {
    const founderRows = await withRetry(
      () => sql<{ deal_gid: string; email: string | null; alt_emails: string[] | null }[]>`
        select f.deal_gid, p.email,
               p.alt_emails as alt_emails
        from deal_founders f join network_people p on p.id = f.person_id
        where p.email is not null or p.alt_emails is not null
      `
    );
    for (const r of founderRows) {
      addEmail(r.deal_gid, r.email);
      for (const e of r.alt_emails ?? []) addEmail(r.deal_gid, e);
    }
  } catch {
    // founder links absent — inbound senders remain the only email evidence.
  }

  const namesByGid = new Map<string, string[]>();
  try {
    const nameRows = await withRetry(
      () => sql<{ deal_gid: string; names: string[] }[]>`
        select f.deal_gid, array_agg(p.name) as names
        from deal_founders f join network_people p on p.id = f.person_id
        where lower(split_part(coalesce(p.email, ''), '@', 2)) <> all(${sql.array([...INTERNAL_DOMAIN_SET])})
        group by f.deal_gid
      `
    );
    for (const r of nameRows) namesByGid.set(r.deal_gid, r.names ?? []);
  } catch {
    // deal_founders / network_people absent — name context unavailable.
  }

  return rows.map((r) => {
    const founderEmails = emailsByGid.get(r.gid) ?? [];
    // The company's own domain plus every founder's work domain — a
    // colleague joining the call from @company.com is still the company.
    const domains = new Set<string>();
    const own = corporateDomainOf(`x@${r.company_domain ?? ""}`);
    if (own) domains.add(own);
    for (const e of founderEmails) {
      const d = corporateDomainOf(e);
      if (d) domains.add(d);
    }
    return {
      gid: r.gid,
      name: r.name,
      // No company row (modal-boarded deals never get one)? The deal NAME
      // carries the company after the // — "Eli Brandt // Honest Pebble"
      // still title-matches "Acme / YourFund".
      companyName: r.company_name ?? companyFromDealName(r.name),
      founderEmails,
      founderNames: namesByGid.get(r.gid) ?? [],
      domains: [...domains],
      active: r.stage !== "passed" && r.stage !== "to-pass",
    };
  });
}

/* ── Single-deal and reverse lookups ─────────────────────────────────────── */

/**
 * One deal's founder addresses (canonical + alts, external only) — the deal
 * card's email history and the Gmail deep-search key off these.
 */
export async function founderEmailsForDeal(gid: string): Promise<string[]> {
  const rows = await withRetry(
    () => sql<{ email: string | null; alt_emails: string[] | null }[]>`
      select p.email, p.alt_emails as alt_emails
        from deal_founders df join network_people p on p.id = df.person_id
       where df.deal_gid = ${gid}`
  ).catch(() => [] as { email: string | null; alt_emails: string[] | null }[]);
  const out = new Set<string>();
  for (const r of rows) {
    for (const raw of [r.email, ...(r.alt_emails ?? [])]) {
      const e = normalizeEvidenceEmail(raw);
      if (e) out.add(e);
    }
  }
  return [...out];
}

/**
 * Deals these people are founders on (email equality across canonical and
 * alt addresses). Internal addresses are stripped here too — callers can
 * pass raw lists without re-implementing the guard.
 */
export async function dealsByFounderEmails(
  emails: string[],
  limit = 6
): Promise<{ gid: string; personName: string }[]> {
  const people = [...new Set(emails.map(normalizeEvidenceEmail).filter((e): e is string => !!e))];
  if (people.length === 0) return [];
  const rows = await withRetry(
    () => sql<{ gid: string; pname: string }[]>`
      select distinct d.gid, p.name as pname
        from deals d
        join deal_founders df on df.deal_gid = d.gid
        join network_people p on p.id = df.person_id
       where lower(coalesce(p.email, '')) = any(${people})
          or exists (
            select 1 from unnest(coalesce(p.alt_emails, '{}')) ae
             where lower(ae) = any(${people})
          )
       limit ${limit}`
  ).catch(() => [] as { gid: string; pname: string }[]);
  return rows.map((r) => ({ gid: r.gid, personName: r.pname }));
}

/** Deals whose founders carry one of these full names (exact, lowered). */
export async function dealsByFounderNames(
  fullNames: string[],
  limit = 6
): Promise<{ gid: string; personName: string }[]> {
  const names = fullNames.map((n) => n.trim().toLowerCase()).filter((n) => n.includes(" "));
  if (names.length === 0) return [];
  const rows = await withRetry(
    () => sql<{ gid: string; pname: string }[]>`
      select distinct d.gid, p.name as pname
        from deals d
        join deal_founders df on df.deal_gid = d.gid
        join network_people p on p.id = df.person_id
       where lower(p.name) = any(${names})
       limit ${limit}`
  ).catch(() => [] as { gid: string; pname: string }[]);
  return rows.map((r) => ({ gid: r.gid, personName: r.pname }));
}

/**
 * Deals whose name_base equals one of the given bases — the indexed
 * replacement for "ship every deal name to JS and scan". Bases shorter than
 * 4 characters are ignored (too collision-prone to be evidence).
 */
export async function dealsByNameBase(
  bases: string[],
  limit = 8
): Promise<{ gid: string; nameBase: string }[]> {
  const wanted = [...new Set(bases.filter((b) => b.length >= 4))];
  if (wanted.length === 0) return [];
  await ensureNameBase().catch(() => {});
  const rows = await withRetry(
    () => sql<{ gid: string; name_base: string }[]>`
      select gid, name_base from deals
       where name_base = any(${wanted})
       limit ${limit}`
  ).catch(() => [] as { gid: string; name_base: string }[]);
  return rows.map((r) => ({ gid: r.gid, nameBase: r.name_base }));
}
