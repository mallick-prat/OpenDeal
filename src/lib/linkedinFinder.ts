import "server-only";
import { createHash } from "crypto";
import { sql } from "./db";
import { logError } from "./log";
import {
  normalizeLinkedInUrl,
  scoreLinkedInCandidates,
  type FoundProfile,
} from "./networkRules";

/**
 * ── LinkedIn finder ─────────────────────────────────────────────────────────
 * Given a person's name + school (+ optional company, degree, grad year), find
 * their LinkedIn profile URL. Three independent passes, merged by agreement:
 *
 *   0. Google Programmable Search  "name + school + linkedin"
 *      (needs GOOGLE_SEARCH_KEY + GOOGLE_SEARCH_CX; skipped if unset)
 *   1. Perplexity web search, LinkedIn-only, by school
 *   2. Perplexity web search, open web, by company
 *      (passes 1-2 need PERPLEXITY_API_KEY; skipped if unset)
 *
 * With NO keys configured this returns [] and the app simply doesn't suggest
 * LinkedIn URLs. Everything else still works. Results are cached in the
 * api_cache table (30 days for hits, 1 day for "found nothing").
 */



/* ── Provider cache ──────────────────────────────────────────────────────────
 * Every expensive external call (Crustdata, Perplexity, Claude) is answered
 * from Postgres when the exact same request was made in the last 30 days, so
 * reruns and bulk enrichment never pay twice for the same lookup.
 */
const CACHE_TTL_MS = 30 * 24 * 3600_000;

/** How long a "no LinkedIn found" answer suppresses another hunt. */
const EMPTY_FINDER_TTL_MS = 24 * 3600_000;


function cacheKey(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}


async function cacheGetEntry<T>(
  provider: string,
  key: string
): Promise<{ payload: T; ageMs: number } | null> {
  try {
    const rows = await sql<{ payload: T; created_at: Date }[]>`
      select payload, created_at from api_cache
      where provider = ${provider} and cache_key = ${key}
    `;
    const hit = rows[0];
    if (!hit) return null;
    const ageMs = Date.now() - hit.created_at.getTime();
    return ageMs > CACHE_TTL_MS ? null : { payload: hit.payload, ageMs };
  } catch {
    return null; // cache is best-effort, never a failure source
  }
}


async function cacheGet<T>(provider: string, key: string): Promise<T | null> {
  return (await cacheGetEntry<T>(provider, key))?.payload ?? null;
}


async function cacheSet(
  provider: string,
  key: string,
  payload: unknown
): Promise<void> {
  try {
    await sql`
      insert into api_cache (provider, cache_key, payload)
      values (${provider}, ${key}, ${sql.json(payload as never)})
      on conflict (provider, cache_key) do update
        set payload = excluded.payload, created_at = now()
    `;
  } catch {
    // best-effort
  }
}


/* ── Agent 2: LinkedIn finder — always the FIRST search step ─────────────────
 * Name + school → web search (Perplexity, ~half a cent per query) with a
 * site-restricted query, reporting only URLs actually seen in results plus
 * the evidence for each. Identity is then judged DETERMINISTICALLY on our
 * side (school/company/year in the evidence, name in the slug). Not
 * confident + company known → one more query from the company angle; the
 * two angles agreeing on a URL is the strongest signal. High confidence →
 * adopted and enrichment proceeds with name + school + LinkedIn; genuinely
 * ambiguous → the review queue.
 */

// Type alias, not interface — sql.json needs the implicit index signature.
export type LinkedInCandidate = {
  url: string;
  confidence: number;
};


type FinderPerson = {
  name: string;
  school: string;
  grad_year: number | null;
  current_organization: string | null;
  /** Optional — present for network people, absent for hunted founders. */
  degree?: string | null;
};


/** Years mentioned in evidence text: "2025", "class of '25". */
function yearsIn(text: string): number[] {
  const out = new Set<number>();
  for (const m of text.matchAll(/\b(19|20)\d{2}\b/g)) out.add(Number(m[0]));
  for (const m of text.matchAll(/'(\d{2})\b/g)) {
    const n = Number(m[1]);
    out.add(n <= 40 ? 2000 + n : 1900 + n);
  }
  return [...out];
}


/** A provider ran out of credits — abort, don't burn through the queue. */
export class ProviderQuotaError extends Error {
  code = "PROVIDER_QUOTA" as const;
}


function throwIfQuota(status: number, body: string, provider: string): void {
  if (
    status === 401 ||
    status === 402 ||
    status === 429 ||
    /insufficient_quota|exceeded your current quota/i.test(body)
  ) {
    throw new ProviderQuotaError(
      `${provider} is out of credits or rate-limited (${status}).`
    );
  }
}


/**
 * Pass 0, when configured: literally google it. Google Programmable Search
 * (env GOOGLE_SEARCH_KEY + GOOGLE_SEARCH_CX) with a site:linkedin.com/in
 * query — the exact "name + school + linkedin" search a human would run.
 */
async function googleFindLinkedIn(
  person: FinderPerson,
  deadline: number
): Promise<FoundProfile[]> {
  const key = process.env.GOOGLE_SEARCH_KEY;
  const cx = process.env.GOOGLE_SEARCH_CX;
  if (!key || !cx) return [];
  const schoolKnown =
    person.school && person.school.toLowerCase() !== "unknown";
  // "name + school + linkedin", plus the degree when we know it — the exact
  // query a human runs, and the one that resolves same-name classmates.
  const q = `site:linkedin.com/in "${person.name}" ${
    schoolKnown ? person.school : (person.current_organization ?? "")
  } ${person.degree ?? ""} linkedin`
    .replace(/\s+/g, " ")
    .trim();
  const ck = cacheKey(`gsearch|${q.toLowerCase()}`);
  const cached = await cacheGet<FoundProfile[]>("google", ck);
  if (cached) return cached;
  const res = await fetch(
    `https://www.googleapis.com/customsearch/v1?key=${key}&cx=${cx}&num=10&q=${encodeURIComponent(q)}`,
    { signal: AbortSignal.timeout(Math.min(15_000, deadline - Date.now())) }
  );
  if (!res.ok) {
    const body = (await res.text()).slice(0, 300);
    throwIfQuota(res.status, body, "Google Search");
    throw new Error(`Google Search ${res.status}: ${body}`);
  }
  const data = (await res.json()) as {
    items?: { link?: string; title?: string; snippet?: string }[];
  };
  const found: FoundProfile[] = (data.items ?? [])
    .map((it) => {
      const title = String(it.title ?? "");
      const snippet = String(it.snippet ?? "");
      return {
        url: normalizeLinkedInUrl(String(it.link ?? "")) ?? "",
        // Google titles look like "Name - Title - Company | LinkedIn".
        name: title.split(/[-–|]/)[0].trim().slice(0, 120),
        headline: `${title} ${snippet}`.slice(0, 400),
        eduYears: yearsIn(`${title} ${snippet}`),
      };
    })
    .filter((f) => f.url)
    .slice(0, 5);
  await cacheSet("google", ck, found);
  return found;
}


/** One Perplexity search pass; `angle` varies the query. */
async function webSearchLinkedIn(
  person: FinderPerson,
  angle: "school" | "company",
  deadline: number
): Promise<FoundProfile[]> {
  const key = process.env.PERPLEXITY_API_KEY;
  if (!key) return [];
  const schoolKnown =
    person.school && person.school.toLowerCase() !== "unknown";
  const company = person.current_organization?.trim();
  const context =
    angle === "school"
      ? [
          schoolKnown ? `who attended ${person.school}` : null,
          person.grad_year ? `class of ${person.grad_year}` : null,
          company ? `associated with ${company}` : null,
        ]
      : [company ? `who works at or founded ${company}` : null];
  const who = [person.name, ...context.filter(Boolean)].join(", ");
  const searchQuery =
    angle === "school"
      ? `${person.name} ${schoolKnown ? person.school : (company ?? "")} linkedin`
      : `${person.name} ${company ?? ""} linkedin`;

  const ck = cacheKey(`lisearch2|${angle}|${who.toLowerCase()}`);
  const cached = await cacheGet<FoundProfile[]>("perplexity", ck);
  if (cached) return cached;

  const t0 = performance.now();
  const res = await fetch("https://api.perplexity.ai/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "sonar",
      // The school pass reads ONLY linkedin.com — the same results a
      // "name + school + linkedin" web search surfaces. The company pass
      // stays open-web to catch bios and about pages that link the profile.
      ...(angle === "school" ? { search_domain_filter: ["linkedin.com"] } : {}),
      web_search_options: { search_context_size: "medium" },
      max_tokens: 350,
      messages: [
        {
          role: "user",
          content: `${searchQuery}

Find the LinkedIn profile of ${who}.
Report ONLY linkedin.com/in profile URLs that actually appear in the search results — never construct or guess a URL.
For each candidate give the name shown on the profile and one line of evidence (school, class year, employer, headline seen in the result).
Reply with ONLY JSON:
{"candidates":[{"url":"https://www.linkedin.com/in/...","name":"...","evidence":"..."}]}
Up to 3 candidates, best first. Empty list if nothing convincing.`,
        },
      ],
    }),
    signal: AbortSignal.timeout(Math.min(20_000, deadline - Date.now())),
  });
  if (!res.ok) {
    const body = (await res.text()).slice(0, 300);
    throwIfQuota(res.status, body, "Perplexity");
    throw new Error(`Perplexity finder ${res.status}`);
  }
  void import("./perf").then((p) => p.record("llm.perplexity_finder", performance.now() - t0, { angle })).catch(() => {});
  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const json = data.choices?.[0]?.message?.content?.match(/\{[\s\S]*\}/)?.[0];
  let found: FoundProfile[] = [];
  try {
    const out = json ? (JSON.parse(json) as { candidates?: unknown }) : {};
    found = (Array.isArray(out.candidates) ? out.candidates : [])
      .map((c: { url?: unknown; name?: unknown; evidence?: unknown }) => {
        const evidence = String(c.evidence ?? "").slice(0, 300);
        return {
          url: normalizeLinkedInUrl(String(c.url ?? "")) ?? "",
          name: String(c.name ?? "").slice(0, 120),
          headline: evidence,
          eduYears: yearsIn(evidence),
        };
      })
      .filter((f) => f.url)
      .slice(0, 3);
  } catch {
    found = [];
  }
  await cacheSet("perplexity", ck, found);
  return found;
}


export async function findLinkedInProfile(
  person: FinderPerson,
  deadline: number
): Promise<LinkedInCandidate[]> {
  // Grad year and degree steer both the query and the scoring, so two people
  // who differ only there must not share a cache entry.
  const ck = cacheKey(
    `lifind5|${person.name}|${person.school}|${person.degree ?? ""}|${person.grad_year ?? ""}|${person.current_organization ?? ""}`.toLowerCase()
  );
  const cached = await cacheGetEntry<LinkedInCandidate[]>("finder", ck);
  // A hit is worth keeping for the full month. "Found nothing" is a weaker
  // fact — the profile may simply not have been indexed yet — so it only
  // suppresses re-searching for a day, then we look again.
  if (cached && cached.payload.length > 0) return cached.payload;
  if (cached && cached.ageMs < EMPTY_FINDER_TTL_MS) return [];

  const identity = {
    name: person.name,
    school: person.school,
    degree: person.degree ?? null,
    gradYear: person.grad_year,
    company: person.current_organization,
  };

  const merge = (
    into: LinkedInCandidate[],
    add: LinkedInCandidate[],
    agreementBoost: number
  ): LinkedInCandidate[] => {
    for (const w of add) {
      const hit = into.find((c) => c.url === w.url);
      if (hit)
        hit.confidence = Math.min(
          0.95,
          Math.max(hit.confidence, w.confidence) + agreementBoost
        );
      else into.push(w);
    }
    return into.sort((a, b) => b.confidence - a.confidence).slice(0, 3);
  };

  let candidates: LinkedInCandidate[] = [];
  // Pass 0: real Google, when configured — "name + school + linkedin".
  try {
    const found = await googleFindLinkedIn(person, deadline);
    candidates = scoreLinkedInCandidates(identity, found);
  } catch (err) {
    if (err instanceof ProviderQuotaError) throw err;
    logError("network", "google linkedin search failed", err, {
      name: person.name,
    });
  }

  // Pass 1: LinkedIn-only web search by name + school.
  if ((candidates[0]?.confidence ?? 0) < 0.8 && Date.now() < deadline) {
    try {
      const found = await webSearchLinkedIn(person, "school", deadline);
      candidates = merge(candidates, scoreLinkedInCandidates(identity, found), 0.15);
    } catch (err) {
      if (err instanceof ProviderQuotaError) throw err;
      logError("network", "linkedin search (school) failed", err, {
        name: person.name,
      });
    }
  }

  // Pass 2: the company angle, open web. Independent searches agreeing on
  // one URL is the strongest signal.
  if (
    (candidates[0]?.confidence ?? 0) < 0.8 &&
    person.current_organization &&
    Date.now() < deadline
  ) {
    try {
      const found = await webSearchLinkedIn(person, "company", deadline);
      candidates = merge(candidates, scoreLinkedInCandidates(identity, found), 0.2);
    } catch (err) {
      if (err instanceof ProviderQuotaError) throw err;
      logError("network", "linkedin search (company) failed", err, {
        name: person.name,
      });
    }
  }

  await cacheSet("finder", ck, candidates);
  return candidates;
}
