import "server-only";
import { logError } from "./log";
import { recordClaims } from "./claims";
import { findLinkedInProfile } from "./linkedinFinder";
import { upsertPersonFromFounder } from "./people";
import { normalizeLinkedInUrl } from "./networkRules";

/**
 * ── Candidate enrichment: external sources ONLY ────────────────────────────
 * The original email and its extraction are read-only source truth — enrich
 * never rewrites them. It spins up cheap web research (Perplexity sonar) and
 * LinkedIn hunters, and everything it learns lands as 'externally_verified'
 * claims beside the founder's own, never over them.
 */

export interface EnrichSummary {
  claims: number;
  foundersLinked: number;
  linkedinCandidates: number;
}

interface WebIntel {
  one_liner?: string | null;
  sector?: string | null;
  location?: string | null;
  total_raised?: string | null;
  notable_investors?: string[] | null;
  competitors?: string[] | null;
  founded_year?: number | null;
  key_facts?: string[] | null;
  founders?: { name?: string | null; role?: string | null; school?: string | null }[] | null;
  confidence?: number | null;
}

/** One cheap sonar call: what does the open web say about this company? */
async function researchCompany(
  company: string,
  website: string | null
): Promise<{ intel: WebIntel; citations: string[] } | null> {
  const key = process.env.PERPLEXITY_API_KEY;
  if (!key || !company.trim()) return null;
  try {
    const res = await fetch("https://api.perplexity.ai/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "sonar",
        temperature: 0.1,
        max_tokens: 700,
        messages: [
          {
            role: "system",
            content:
              "You are a startup research agent. Reply with STRICT JSON only, no prose: " +
              '{"one_liner":string|null,"sector":string|null,"location":string|null,' +
              '"total_raised":string|null,"notable_investors":string[]|null,' +
              '"competitors":string[]|null,"founded_year":number|null,' +
              '"key_facts":string[]|null,' +
              '"founders":[{"name":string,"role":string|null,"school":string|null}]|null,"confidence":number}. ' +
              "confidence is 0..1 for how sure you are this is the right company. " +
              "founders: ONLY people you are confident founded THIS exact company (full names); omit anyone uncertain. " +
              "Unknown fields are null. key_facts: at most 5 short verifiable facts.",
          },
          {
            role: "user",
            content: `Research the startup "${company}"${website ? ` (website: ${website})` : ""}. What do they do, where are they, what have they raised, who invested, who competes?`,
          },
        ],
      }),
      signal: AbortSignal.timeout(25_000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
      citations?: string[];
    };
    const raw = data.choices?.[0]?.message?.content ?? "";
    const jsonText = raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1);
    const intel = JSON.parse(jsonText) as WebIntel;
    return { intel, citations: data.citations ?? [] };
  } catch (err) {
    logError("enrich", "web research failed", err, { company });
    return null;
  }
}

/**
 * Targeted school lookup, grounded on the confirmed LinkedIn URL — accurate
 * enough to run at confirm time instead of waiting for background enrichment.
 */
export async function lookupFounderSchool(
  name: string,
  linkedinUrl: string,
  company: string
): Promise<{ school: string; confidence: number } | null> {
  const key = process.env.PERPLEXITY_API_KEY;
  if (!key) return null;
  try {
    const res = await fetch("https://api.perplexity.ai/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "sonar",
        temperature: 0,
        max_tokens: 120,
        messages: [
          {
            role: "system",
            content:
              'Reply with STRICT JSON only: {"school":string|null,"confidence":number}. ' +
              "school = the university this person attended (undergrad preferred), normalized to " +
              'the plain institution name ("Harvard", "MIT", "Stanford", "Berkeley", "Oxford"...). ' +
              "null if genuinely unknown. confidence 0..1 that this is the right person AND school.",
          },
          {
            role: "user",
            content: `Which university did ${name} attend? They are a founder at ${company}; their LinkedIn is ${linkedinUrl}.`,
          },
        ],
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const raw = data.choices?.[0]?.message?.content ?? "";
    const parsed = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1)) as {
      school?: string | null;
      confidence?: number;
    };
    const school = parsed.school?.trim();
    const confidence = Math.max(0, Math.min(1, Number(parsed.confidence ?? 0)));
    return school && confidence >= 0.5 ? { school, confidence } : null;
  } catch (err) {
    logError("enrich", "school lookup failed", err, { name });
    return null;
  }
}

/**
 * Deep founder resolution, escalating in strength: when the standard hunt
 * finds nothing, search again with the founder's email handle + full company
 * context on sonar; still nothing → sonar-pro. An email handle like
 * "kathryndray" is nearly unique — it finds people name searches miss.
 */
async function deepFindFounder(
  name: string,
  company: string,
  email: string | null,
  location: string | null,
  website: string | null
): Promise<{ linkedinUrl: string | null; school: string | null; confidence: number } | null> {
  const key = process.env.PERPLEXITY_API_KEY;
  if (!key) return null;
  const handle = email?.split("@")[0] ?? null;
  const ask = [
    `Find the LinkedIn profile URL and university of ${name}, founder at ${company}`,
    website ? `(company site: ${website})` : null,
    location ? `based near ${location}` : null,
    email ? `Their email handle is "${handle}" (${email}) — search that handle too.` : null,
  ]
    .filter(Boolean)
    .join(" ");
  for (const model of ["sonar", "sonar-pro"]) {
    try {
      const res = await fetch("https://api.perplexity.ai/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          temperature: 0,
          max_tokens: 160,
          messages: [
            {
              role: "system",
              content:
                'STRICT JSON only: {"linkedin_url":string|null,"school":string|null,"confidence":number}. ' +
                "linkedin_url must be a real linkedin.com/in/... profile of THIS person or null. " +
                'school = their university, plain name ("Tulane", "Harvard") or null. ' +
                "confidence 0..1 that both belong to the right person. Never guess URLs.",
            },
            { role: "user", content: ask },
          ],
        }),
        signal: AbortSignal.timeout(18_000),
      });
      if (!res.ok) continue;
      const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
      const raw = data.choices?.[0]?.message?.content ?? "";
      const parsed = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1)) as {
        linkedin_url?: string | null;
        school?: string | null;
        confidence?: number;
      };
      const conf = Math.max(0, Math.min(1, Number(parsed.confidence ?? 0)));
      const url = parsed.linkedin_url?.trim() || null;
      const school = parsed.school?.trim() || null;
      const validUrl = url && /^https?:\/\/([a-z]+\.)?linkedin\.com\/in\//i.test(url) ? url : null;
      if ((validUrl || school) && conf >= 0.55) {
        return { linkedinUrl: validUrl, school, confidence: conf };
      }
    } catch (err) {
      logError("enrich", `deep find failed (${model})`, err, { name });
    }
  }
  return null;
}

export async function enrichCandidateExternal(opts: {
  candidateId: string;
  company: string;
  website: string | null;
  founders: { fullName?: string; email?: string | null; linkedinUrl?: string; title?: string; school?: string | null }[];
  location?: string | null;
  userEmail: string;
}): Promise<EnrichSummary> {
  let claims = 0;
  let foundersLinked = 0;
  let linkedinCandidates = 0;

  // The whole run must land WELL inside the route's 60s ceiling: web research
  // and founder work fly concurrently, hunts share one short deadline, and
  // whatever missed the window is simply skipped — partial results beat 504s.
  const [web, founderOutcomes] = await Promise.all([
    researchCompany(opts.company, opts.website),
    runFounderWork({ ...opts, website: opts.website }),
  ]);
  foundersLinked = founderOutcomes.foundersLinked;
  linkedinCandidates = founderOutcomes.linkedinCandidates;
  claims += founderOutcomes.claims;
  if (web) {
    const conf = Math.min(0.75, Math.max(0.3, Number(web.intel.confidence ?? 0.5)));
    const span = web.citations.slice(0, 5).join("\n") || null;
    const rows: { field: string; value: unknown }[] = [];
    if (web.intel.one_liner) rows.push({ field: "oneLiner", value: web.intel.one_liner });
    if (web.intel.sector) rows.push({ field: "sector", value: web.intel.sector });
    if (web.intel.location) rows.push({ field: "location", value: web.intel.location });
    const factLines = [
      web.intel.total_raised ? `Raised to date: ${web.intel.total_raised}` : null,
      web.intel.notable_investors?.length
        ? `Investors: ${web.intel.notable_investors.slice(0, 6).join(", ")}`
        : null,
      web.intel.competitors?.length
        ? `Competitors: ${web.intel.competitors.slice(0, 6).join(", ")}`
        : null,
      web.intel.founded_year ? `Founded: ${web.intel.founded_year}` : null,
      ...(web.intel.key_facts ?? []).slice(0, 5),
    ].filter(Boolean) as string[];
    if (factLines.length > 0) rows.push({ field: "webIntel", value: factLines });
    if (rows.length > 0) {
      await recordClaims(
        "candidate",
        opts.candidateId,
        rows.map((r) => ({
          field: r.field,
          value: r.value,
          sourceType: "externally_verified" as const,
          sourceRef: "web:perplexity-sonar",
          sourceSpan: span,
          confidence: conf,
        }))
      );
      claims += rows.length;
    }
  }

  // 3 · Founder DISCOVERY: names the web knows that the pitch didn't give.
  // Each new founder becomes a claim, then rides the same hunt → confirm
  // sequence as everyone else.
  const knownNames = new Set(
    opts.founders.map((f) => (f.fullName ?? "").trim().toLowerCase()).filter(Boolean)
  );
  const discovered = (web?.intel.founders ?? [])
    .map((f) => ({
      name: (f.name ?? "").trim(),
      role: f.role?.trim() || "Founder",
      school: f.school?.trim() || null,
    }))
    .filter((f) => f.name.length > 3 && !knownNames.has(f.name.toLowerCase()))
    .slice(0, 3);
  if (discovered.length > 0) {
    await recordClaims(
      "candidate",
      opts.candidateId,
      discovered.flatMap((f) => [
        {
          field: `founderDiscovered:${f.name}`,
          value: f.role,
          sourceType: "externally_verified" as const,
          sourceRef: "web:perplexity-sonar",
          sourceSpan: null,
          confidence: 0.6,
        },
        ...(f.school
          ? [{
              field: `founderSchool:${f.name}`,
              value: f.school,
              sourceType: "externally_verified" as const,
              sourceRef: "web:perplexity-sonar",
              sourceSpan: null,
              confidence: 0.55,
            }]
          : []),
      ])
    ).catch(() => {});
    claims += discovered.length;
    const huntDeadline = Date.now() + 12_000;
    const huntResults = await Promise.all(
      discovered.map((f) =>
        huntFounder(opts.candidateId, opts.company, f.name, huntDeadline, f.school ?? "", {
          location: opts.location ?? null,
          website: opts.website,
        })
      )
    );
    for (const h of huntResults) {
      claims += h.claims;
      linkedinCandidates += h.linkedinCandidates;
    }
  }

  return { claims, foundersLinked, linkedinCandidates };
}

/** Hunt one founder's LinkedIn and surface candidates as a claim. */
async function huntFounder(
  candidateId: string,
  company: string,
  name: string,
  deadline: number,
  school = "",
  extra?: { email?: string | null; location?: string | null; website?: string | null }
): Promise<{ claims: number; linkedinCandidates: number }> {
  try {
    // School is the sharpest disambiguator the finder has — same-name people
    // rarely share both a company AND a campus.
    const found = await findLinkedInProfile(
      { name, school, grad_year: null, current_organization: company },
      deadline
    );
    let best = found.filter((c) => c.confidence >= 0.5).slice(0, 2);
    let written = 0;
    if (best.length === 0) {
      // Escalate: email-handle-armed deep search, sonar then sonar-pro.
      const deep = await deepFindFounder(name, company, extra?.email ?? null, extra?.location ?? null, extra?.website ?? null);
      if (deep?.linkedinUrl) {
        best = [{ url: deep.linkedinUrl, confidence: deep.confidence }];
      }
      if (deep?.school) {
        await recordClaims("candidate", candidateId, [
          {
            field: `founderSchool:${name}`,
            value: deep.school,
            sourceType: "externally_verified",
            sourceSpan: null,
            sourceRef: "web:deep-find",
            confidence: deep.confidence,
          },
        ]);
        written++;
      }
    }
    if (best.length === 0) return { claims: written, linkedinCandidates: 0 };
    await recordClaims("candidate", candidateId, [
      {
        field: `founderLinkedin:${name}`,
        value: best.map((b) => `${b.url} (${Math.round(b.confidence * 100)}%)`),
        sourceType: "externally_verified",
        sourceSpan: null,
        sourceRef: "web:linkedin-hunt",
        confidence: best[0].confidence,
      },
    ]);
    return { claims: written + 1, linkedinCandidates: best.length };
  } catch (err) {
    logError("enrich", "linkedin hunt failed", err, { name });
    return { claims: 0, linkedinCandidates: 0 };
  }
}

/**
 * Founder work, all in parallel under one shared ~18s deadline: known
 * LinkedIn → network enrichment; missing → hunt, surfaced as claims.
 */
async function runFounderWork(opts: {
  candidateId: string;
  company: string;
  founders: { fullName?: string; email?: string | null; linkedinUrl?: string; title?: string; school?: string | null }[];
  location?: string | null;
  website?: string | null;
  userEmail: string;
}): Promise<EnrichSummary> {
  const deadline = Date.now() + 18_000;
  const outcomes = await Promise.all(
    opts.founders.slice(0, 3).map(async (f): Promise<EnrichSummary> => {
      const none = { claims: 0, foundersLinked: 0, linkedinCandidates: 0 };
      const name = f.fullName?.trim();
      if (!name) return none;
      if (f.linkedinUrl && normalizeLinkedInUrl(f.linkedinUrl)) {
        try {
          await upsertPersonFromFounder(
            {
              linkedinUrl: f.linkedinUrl,
              fullName: name,
              headline: f.title ?? undefined,
              experience: [],
              education: [],
            },
            null,
            opts.userEmail
          );
          return { ...none, foundersLinked: 1 };
        } catch {
          return none; // One founder failing must not sink the run.
        }
      }
      const h = await huntFounder(
        opts.candidateId,
        opts.company,
        name,
        deadline,
        (f as { school?: string | null }).school ?? "",
        { email: f.email ?? null, location: opts.location ?? null, website: opts.website ?? null }
      );
      return { ...none, claims: h.claims, linkedinCandidates: h.linkedinCandidates };
    })
  );
  return outcomes.reduce(
    (a, b) => ({
      claims: a.claims + b.claims,
      foundersLinked: a.foundersLinked + b.foundersLinked,
      linkedinCandidates: a.linkedinCandidates + b.linkedinCandidates,
    }),
    { claims: 0, foundersLinked: 0, linkedinCandidates: 0 }
  );
}
