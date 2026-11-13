import "server-only";
import { sql } from "./db";

/**
 * ── API keys & spend ─────────────────────────────────────────────────────────
 * Key presence comes straight from the environment (never the values — only
 * a 4-character tail for identification). Spend is estimated from api_cache:
 * every row there is one PAID provider call (cache hits reuse rows and cost
 * nothing), so counts by created_at are the app's real outbound usage.
 */

export interface KeyStatus {
  name: string;
  env: string;
  configured: boolean;
  /** Last 4 characters, for telling keys apart. Null for pure secrets. */
  tail: string | null;
  manageUrl: string | null;
  usedFor: string;
}

const tail = (v: string | undefined): string | null =>
  v && v.length >= 8 ? v.slice(-4) : null;

export function keyStatuses(): KeyStatus[] {
  const env = process.env;
  const key = (
    name: string,
    envVar: string,
    usedFor: string,
    manageUrl: string | null,
    showTail = true
  ): KeyStatus => ({
    name,
    env: envVar,
    configured: !!env[envVar],
    tail: showTail ? tail(env[envVar]) : null,
    manageUrl,
    usedFor,
  });
  return [
    key("Anthropic", "ANTHROPIC_API_KEY", "Pitch extraction, meeting-note review, pass-note drafting", "https://console.anthropic.com/settings/keys"),
    key("Perplexity", "PERPLEXITY_API_KEY", "LinkedIn finder and web research (optional)", "https://www.perplexity.ai/settings/api"),
    key("Google Search", "GOOGLE_SEARCH_KEY", "Optional finder pass 0 — real Google results", "https://console.cloud.google.com/apis/credentials"),
    key("Google Search engine", "GOOGLE_SEARCH_CX", "The Programmable Search engine id that pairs with the key", "https://programmablesearchengine.google.com"),
    key("Resend", "RESEND_API_KEY", "Sign-in code emails and inbound email", "https://resend.com/api-keys"),
    key("Google OAuth", "AUTH_GOOGLE_ID", "Sign in with Google + calendar and Gmail connections", "https://console.cloud.google.com/apis/credentials"),
    key("Auth secret", "AUTH_SECRET", "Session and magic-link signing", null, false),
    key("Cron secret", "CRON_SECRET", "Protects the cron and ops routes", null, false),
    {
      // DATABASE_URL, or the legacy SUPABASE_DB_URL; never show any of it.
      name: "Database",
      env: env.DATABASE_URL ? "DATABASE_URL" : env.SUPABASE_DB_URL ? "SUPABASE_DB_URL" : "DATABASE_URL",
      configured: !!(env.DATABASE_URL || env.SUPABASE_DB_URL),
      tail: null,
      manageUrl: null,
      usedFor: "Postgres connection",
    },
  ];
}

/**
 * Per-call cost ESTIMATES in dollars — deliberately rough, adjust here as
 * plans change. Perplexity sonar ≈ request fee + tokens; Claude ≈ Haiku-sized classification.
 */
export const COST_ESTIMATES: Record<string, number> = {
  perplexity: 0.008,
  claude: 0.002,
  google: 0.005,
};

export interface ProviderUsage {
  provider: string;
  day: number;
  week: number;
  month: number;
  total: number;
  estMonthCost: number;
  quotaErrors7d: number;
}

export async function providerUsage(): Promise<ProviderUsage[]> {
  // 'finder' rows are memos of already-counted searches, not paid calls.
  const rows = await sql<
    { provider: string; day: number; week: number; month: number; total: number }[]
  >`
    select provider,
      count(*) filter (where created_at > now() - interval '1 day')::int as day,
      count(*) filter (where created_at > now() - interval '7 days')::int as week,
      count(*) filter (where created_at > now() - interval '30 days')::int as month,
      count(*)::int as total
    from api_cache
    where provider <> 'finder'
    group by provider
    order by month desc
  `;
  const errs = await sql<{ provider: string; n: number }[]>`
    select
      case
        when blob ilike '%anthropic%' or blob ilike '%claude%' then 'claude'
        when blob ilike '%perplexity%' then 'perplexity'
        when blob ilike '%google%' then 'google'
        else 'other'
      end as provider,
      count(*)::int as n
    from (
      select message as blob
      from app_events
      where level = 'error'
        and created_at > now() - interval '7 days'
        and (message ilike '%quota%'
          or message ilike '%credits%'
          or message ilike '%rate-limited%'
          or message ilike '%restricted%')
    ) q
    group by 1
  `;
  const quotaCount = (provider: string): number =>
    errs
      .filter((e) => e.provider === provider)
      .reduce((n, e) => n + e.n, 0);
  return rows.map((r) => ({
    ...r,
    estMonthCost: r.month * (COST_ESTIMATES[r.provider] ?? 0),
    quotaErrors7d: quotaCount(r.provider),
  }));
}
