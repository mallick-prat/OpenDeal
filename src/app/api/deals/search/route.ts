import { NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { currentAppUser } from "@/lib/users";
import { logError } from "@/lib/log";
import { UNTRUSTED_NOTICE, callClaude, clampStr, fenceUntrusted, modelJson } from "@/lib/llm";
import { record } from "@/lib/perf";

export const maxDuration = 30;

/**
 * Deep deal search: stemmed full-text over deal name + body (notes carry the
 * pitch, founders, summaries, merged history), ranked, with a highlighted
 * snippet per hit. (deals.search_tsv is maintained by a trigger; see
 * sql/schema.sql.) A quick Claude pass expands the query with adjacent terms
 * — "warehouse robots" also searches robotics, automation, fulfillment — so
 * meaning finds deals that exact words would miss. The expansion is shown to
 * the user, cached per query, and skipped silently when the model is slow.
 */

// Per-lambda memo for query expansions. Bounded: past ~300 distinct
// queries the oldest entries fall out (Maps iterate in insertion order).
const expansionCache = new Map<string, string[]>();
const expansionInFlight = new Map<string, Promise<string[]>>();
const EXPANSION_CACHE_MAX = 300;

async function expandQuery(q: string): Promise<string[]> {
  const key = q.toLowerCase();
  const hit = expansionCache.get(key);
  if (hit) return hit;
  const pending = expansionInFlight.get(key);
  if (pending) return pending;
  const promise = (async () => {
    try {
      const text = await callClaude({
        job: "expand_query",
        model: "claude-haiku-4-5-20251001",
        maxTokens: 120,
        system: `A venture investor is searching their deal pipeline. Reply with ONLY a JSON array of up to 5 short alternate search terms (synonyms, adjacent technologies, category names) that pitches matching this intent might use instead. No explanations.\n\n${UNTRUSTED_NOTICE}`,
        content: `The search query:\n${fenceUntrusted(q, 200)}`,
        timeoutMs: 4_000,
      });
      if (text === null) return [];
      const arr = modelJson(text, "array");
      const terms = (Array.isArray(arr) ? arr : [])
        .map((t) => clampStr(t, 40))
        .filter((t): t is string => !!t && t.length > 1 && t.length < 40)
        .slice(0, 5);
      if (expansionCache.size >= EXPANSION_CACHE_MAX) {
        const oldest = expansionCache.keys().next().value;
        if (oldest !== undefined) expansionCache.delete(oldest);
      }
      expansionCache.set(key, terms);
      return terms;
    } catch {
      return [];
    } finally {
      expansionInFlight.delete(key);
    }
  })();
  expansionInFlight.set(key, promise);
  return promise;
}

export async function GET(req: Request) {
  const member = await currentAppUser();
  if (!member) return NextResponse.json({ ok: false }, { status: 401 });
  const params = new URL(req.url).searchParams;
  const q = (params.get("q") ?? "").trim().slice(0, 120);
  const phase = params.get("phase") === "expanded" ? "expanded" : "initial";
  if (q.length < 3) return NextResponse.json({ ok: true, results: [], expanded: [] });

  const t0 = performance.now();
  try {
    // The first response searches the literal query immediately. Expansion
    // is requested separately by the client, so it never gates these hits.
    // A warm per-lambda cache makes later follow-ups cheap.
    const cachedExpansion = expansionCache.get(q.toLowerCase());
    const expanded =
      phase === "expanded" ? await expandQuery(q) : (cachedExpansion ?? []);
    const full = [q, ...expanded].map((t) => t.replace(/["()]/g, " ")).join(" OR ");

    const [likeRows, ftsRows] = await Promise.all([
      // A literal name hit always surfaces — a deal created seconds ago has
      // no ranking history, but typing its name must find it first.
      sql<{ gid: string; name: string; stage: string; snippet: string | null }[]>`
        select gid, name, stage,
               left(regexp_replace(coalesce(notes, ''), '\\s+', ' ', 'g'), 140) as snippet
          from deals
         where name ilike ${"%" + q + "%"}
         order by case when name ilike ${q + "%"} then 0 else 1 end,
                  modified_on desc nulls last
         limit 6
      `.catch(() => []),
      sql<
        { gid: string; name: string; stage: string; snippet: string | null }[]
      >`
        select gid, name, stage,
               ts_headline(
                 'english', coalesce(notes, ''),
                 websearch_to_tsquery('english', ${full}),
                 'MaxFragments=1, MaxWords=18, MinWords=6, StartSel=[[, StopSel=]]'
               ) as snippet
          from deals
         where search_tsv @@ websearch_to_tsquery('english', ${full})
         order by ts_rank(search_tsv, websearch_to_tsquery('english', ${full})) desc
         limit 12
      `,
    ]);

    // Rank fusion: a literal name hit outranks a full-text hit.
    const fused = new Map<
      string,
      { gid: string; name: string; stage: string; snippet: string | null; score: number; via: string }
    >();
    ftsRows.forEach((r, i) => {
      fused.set(r.gid, { ...r, score: 1 / (i + 1), via: "text" });
    });
    likeRows.forEach((r, i) => {
      const cur = fused.get(r.gid);
      if (cur) {
        cur.score += 10 / (i + 1);
        cur.via = "name";
      } else {
        fused.set(r.gid, { ...r, score: 10 / (i + 1), via: "name" });
      }
    });
    const results = [...fused.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, 12)
      .map(({ gid, name, stage, snippet, via }) => ({ gid, name, stage, snippet, via }));

    const ms = performance.now() - t0;
    record("api.search", ms, {
      hits: results.length,
      expanded: expanded.length,
      phase,
    });
    const res = NextResponse.json({
      ok: true,
      results,
      expanded,
      semantic: false,
      phase,
      expansionPending: phase === "initial" && cachedExpansion === undefined,
    });
    res.headers.set("Server-Timing", `app;dur=${Math.round(ms)}`);
    return res;
  } catch (err) {
    logError("pipeline", "deep deal search failed", err, { q });
    return NextResponse.json({ ok: false }, { status: 500 });
  }
}
