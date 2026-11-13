import "server-only";
import { sql } from "./db";
import { withRetry } from "./retry";
import { companyFromDealName } from "./founders";
import {
  autoLinkThreshold,
  nameSimilarity,
  normalizeCompanyDomain,
  normalizeCompanyName,
} from "./companiesPure";

/**
 * ── Companies: durable identity above deals ─────────────────────────────────
 * Match policy (mirrors the PRD's evidence ladder):
 *   1. normalized_domain — exact hit auto-links, always.
 *   2. name_normalized exact — auto-links.
 *   3. trigram similarity — auto-links only above autoLinkThreshold(name);
 *      anything fuzzier is a SUGGESTION for a human, never a silent merge.
 * Two existing companies are never auto-merged, full stop.
 */

export interface CompanyRow {
  id: string;
  canonical_name: string;
  name_normalized: string;
  aliases: string[];
  normalized_domain: string | null;
  description: string | null;
  created_from: string;
  created_at: string | Date;
  updated_at: string | Date;
}

let schemaReady = false;
export async function ensureCompaniesSchema(): Promise<void> {
  if (schemaReady) return;
  await sql`create extension if not exists pg_trgm`;
  await sql`
    create table if not exists deal_companies (
      id                uuid primary key default gen_random_uuid(),
      canonical_name    text not null,
      name_normalized   text not null,
      aliases           text[] not null default '{}',
      normalized_domain text,
      description       text,
      created_from      text not null default 'manual',
      created_at        timestamptz not null default now(),
      updated_at        timestamptz not null default now()
    )`;
  await sql`
    create unique index if not exists deal_companies_domain_uq
      on deal_companies (normalized_domain) where normalized_domain is not null`;
  await sql`
    create index if not exists deal_companies_name_trgm
      on deal_companies using gin (name_normalized gin_trgm_ops)`;
  await sql`
    create index if not exists deal_companies_name_norm_idx
      on deal_companies (name_normalized)`;
  await sql`alter table deals add column if not exists company_id uuid references deal_companies(id)`;
  await sql`
    create index if not exists deals_company_idx
      on deals (company_id) where company_id is not null`;
  schemaReady = true;
}

export interface CompanyMatch {
  company: CompanyRow;
  /** Why this matched — surfaces in duplicate UI and match_suggestions. */
  evidence: "domain" | "name_exact" | "name_similar";
  score: number;
}

/**
 * Find the existing company for (name, domain) per the evidence ladder.
 * Returns the match plus whether policy allows auto-linking it.
 */
export async function findCompany(
  name: string,
  domain?: string | null
): Promise<(CompanyMatch & { autoLink: boolean }) | null> {
  await ensureCompaniesSchema();
  const normDomain = normalizeCompanyDomain(domain ?? undefined);
  if (normDomain) {
    const byDomain = await withRetry(
      () => sql<CompanyRow[]>`
        select * from deal_companies where normalized_domain = ${normDomain} limit 1`
    );
    if (byDomain[0]) {
      return { company: byDomain[0], evidence: "domain", score: 1, autoLink: true };
    }
  }
  const norm = normalizeCompanyName(name);
  if (!norm) return null;
  const exact = await withRetry(
    () => sql<CompanyRow[]>`
      select * from deal_companies where name_normalized = ${norm} limit 1`
  );
  if (exact[0]) {
    return { company: exact[0], evidence: "name_exact", score: 1, autoLink: true };
  }
  // Trigram recall in SQL, precision re-rank in JS.
  const fuzzy = await withRetry(
    () => sql<CompanyRow[]>`
      select * from deal_companies
      where name_normalized % ${norm}
      order by similarity(name_normalized, ${norm}) desc
      limit 10`
  );
  let best: CompanyMatch | null = null;
  for (const c of fuzzy) {
    const score = nameSimilarity(name, c.canonical_name);
    if (!best || score > best.score) best = { company: c, evidence: "name_similar", score };
  }
  if (!best) return null;
  return { ...best, autoLink: best.score >= autoLinkThreshold(name) };
}

/**
 * Resolve-or-create for a company. Auto-links only on ladder policy;
 * otherwise creates a fresh row (fuzzy near-misses become suggestions
 * for the caller to surface, never silent merges).
 */
export async function resolveCompany(
  name: string,
  opts: { domain?: string | null; description?: string | null; createdFrom?: string } = {}
): Promise<{ company: CompanyRow; created: boolean; suggestion: CompanyMatch | null }> {
  await ensureCompaniesSchema();
  const trimmed = name.trim();
  const match = await findCompany(trimmed, opts.domain);
  if (match?.autoLink) {
    // Learn the domain when we arrive with one the row lacks.
    const normDomain = normalizeCompanyDomain(opts.domain ?? undefined);
    if (normDomain && !match.company.normalized_domain) {
      await withRetry(
        () => sql`
          update deal_companies set normalized_domain = ${normDomain}, updated_at = now()
          where id = ${match.company.id} and normalized_domain is null`
      );
      match.company.normalized_domain = normDomain;
    }
    // A new spelling of the name becomes an alias, once.
    if (
      trimmed &&
      trimmed !== match.company.canonical_name &&
      !match.company.aliases.includes(trimmed)
    ) {
      await withRetry(
        () => sql`
          update deal_companies
          set aliases = array_append(aliases, ${trimmed}), updated_at = now()
          where id = ${match.company.id} and not (${trimmed} = any(aliases))`
      );
    }
    return { company: match.company, created: false, suggestion: null };
  }
  const rows = await withRetry(
    () => sql<CompanyRow[]>`
      insert into deal_companies (canonical_name, name_normalized, normalized_domain, description, created_from)
      values (
        ${trimmed || "(unnamed)"},
        ${normalizeCompanyName(trimmed)},
        ${normalizeCompanyDomain(opts.domain ?? undefined)},
        ${opts.description ?? null},
        ${opts.createdFrom ?? "manual"}
      )
      on conflict (normalized_domain) where normalized_domain is not null
      do update set updated_at = now()
      returning *`
  );
  return { company: rows[0], created: true, suggestion: match };
}

/** Link a deal to a company (idempotent; never overwrites an existing link). */
export async function linkDealToCompany(gid: string, companyId: string): Promise<void> {
  await withRetry(
    () => sql`
      update deals set company_id = ${companyId}
      where gid = ${gid} and company_id is null`
  );
}

/**
 * Backfill: one batch of unlinked deals → companies parsed from deal names.
 * Returns progress so the runner can loop/pause. Batches keep each
 * invocation well under serverless limits.
 */
export async function backfillCompaniesBatch(batchSize = 100): Promise<{
  processed: number;
  linked: number;
  created: number;
  remaining: number;
}> {
  await ensureCompaniesSchema();
  const deals = await withRetry(
    () => sql<{ gid: string; name: string }[]>`
      select gid, name from deals
      where company_id is null and name is not null and name <> ''
      order by created_on desc nulls last
      limit ${batchSize}`
  );
  let linked = 0;
  let created = 0;
  for (const d of deals) {
    const companyName = companyFromDealName(d.name).trim();
    if (!companyName) continue;
    const { company, created: isNew } = await resolveCompany(companyName, {
      createdFrom: "backfill",
    });
    await linkDealToCompany(d.gid, company.id);
    linked++;
    if (isNew) created++;
  }
  const remainingRows = await withRetry(
    () => sql<{ n: number }[]>`
      select count(*)::int as n from deals
      where company_id is null and name is not null and name <> ''`
  );
  return {
    processed: deals.length,
    linked,
    created,
    remaining: remainingRows[0]?.n ?? 0,
  };
}
