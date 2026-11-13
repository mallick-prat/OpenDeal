import "server-only";
import { sql } from "./db";
import { timed } from "./perf";
import { STAGES } from "./stages";
import { crm } from "@/config/crm.config";

/** Calendar days are bucketed in the org timezone (crm.config). */
const TZ = crm.org.timezone;
import type { StageKey } from "./types";
import {
  AGE_BUCKETS,
  ageBucketOf,
  fillSeries,
  stageGroupOf,
  type Bucket,
  type ResolvedPeriod,
  type SeriesPoint,
  type StageGroupKey,
} from "./analyticsPure";

/**
 * ── Analytics aggregation ───────────────────────────────────────────────────
 * Every number on /analytics is computed here, database-side, from fields the
 * app already maintains. Definitions (one place, used everywhere):
 *
 *   New deals     deals with created_on inside the period (creation date)
 *   Meeting       a confirmed calendar event matched to a deal — the same
 *                 concept DealMeetings shows; no separate analytics definition
 *   Active        the stages stages.ts marks active (to-meet … offered)
 *   Age           days since created_on; active deals only
 *   Untouched     modified_on older than N days (last-modified date)
 *
 * Deliberately absent, because the data can't support them honestly:
 * stage-transition history (only logged since 2026-07-09), conversion rates,
 * decision-time medians, sourcing attribution, sectors.
 */

export const ACTIVE_STAGE_KEYS = STAGES.filter((s) => s.active).map((s) => s.key);
const EARLY: StageKey[] = ["to-meet", "first-meeting"];

export interface AnalyticsFilters {
  period: ResolvedPeriod;
  stage?: StageKey;
  owner?: string;
  school?: string;
}

export interface UniversityRow {
  school: string;
  byGroup: Record<StageGroupKey, number>;
  active: number;
  total: number;
  signal: number; // diligence + offered — the depth sort key
}

export interface TeamRow {
  owner: string;
  active: number;
  diligence: number;
  offered: number;
  meetings: number;
  total: number;
}

export interface AttentionItem {
  key: string;
  count: number;
  title: string;
  rule: string;
}

export interface AnalyticsPayload {
  generatedAt: string;
  kpis: {
    newDeals: number;
    newDealsPrev: number | null;
    meetings: number;
    meetingsPrev: number | null;
    active: number;
    diligence: number;
    offered: number;
  };
  distribution: { stage: StageKey; count: number }[];
  ageBuckets: { key: string; label: string; count: number }[];
  medianAgeDays: number | null;
  oldestAgeDays: number | null;
  flow: {
    deals: SeriesPoint[];
    dealsPrev: SeriesPoint[] | null;
    meetings: SeriesPoint[];
    meetingsPrev: SeriesPoint[] | null;
  };
  university: UniversityRow[];
  team: TeamRow[];
  attention: AttentionItem[];
  completeness: {
    activeTotal: number;
    activeWithSchool: number;
    activeWithOwner: number;
    allTotal: number;
    allWithSchool: number;
    allWithOwner: number;
    withSource: number;
  };
  options: { owners: string[]; schools: string[] };
}

/* Dimension fragments — built fresh per use so they always come from the
   CURRENT pool (db.ts swaps pools to self-heal; a fragment made on the old
   instance must not leak into a query on the new one). */
const unowned = () => sql`(d.owner is null or d.owner = '' or d.owner = 'Unassigned')`;
function ownerCond(owner?: string) {
  if (!owner) return sql``;
  if (owner === "Unassigned") return sql`and ${unowned()}`;
  return sql`and d.owner = ${owner}`;
}
function schoolCond(school?: string) {
  return school ? sql`and ${school} = any(d.schools)` : sql``;
}
function stageCond(stage?: StageKey) {
  return stage ? sql`and d.stage = ${stage}` : sql``;
}
function createdBetween(start: string | null, end: string) {
  return start
    ? sql`and d.created_on >= ${start} and d.created_on <= ${end}`
    : sql`and d.created_on <= ${end}`;
}

type CountRow = { n: number };

async function countDeals(f: AnalyticsFilters, start: string | null, end: string): Promise<number> {
  const r = await sql<CountRow[]>`
    select count(*)::int n from deals d
     where 1=1 ${createdBetween(start, end)}
       ${stageCond(f.stage)} ${ownerCond(f.owner)} ${schoolCond(f.school)}`;
  return r[0]?.n ?? 0;
}

async function countMeetings(f: AnalyticsFilters, start: string | null, end: string): Promise<number> {
  const r = await sql<CountRow[]>`
    select count(*)::int n
      from calendar_events ce
      join deals d on d.gid = ce.matched_deal_gid
     where ce.status = 'confirmed'
       and (ce.starts_at at time zone ${TZ})::date <= ${end}
       ${start ? sql`and (ce.starts_at at time zone ${TZ})::date >= ${start}` : sql``}
       ${stageCond(f.stage)} ${ownerCond(f.owner)} ${schoolCond(f.school)}`;
  return r[0]?.n ?? 0;
}

async function dealSeries(
  f: AnalyticsFilters, start: string, end: string, bucket: Bucket
): Promise<SeriesPoint[]> {
  const rows = await sql<{ b: string; n: number }[]>`
    select to_char(date_trunc(${bucket}, d.created_on), 'YYYY-MM-DD') b, count(*)::int n
      from deals d
     where d.created_on >= ${start} and d.created_on <= ${end}
       ${stageCond(f.stage)} ${ownerCond(f.owner)} ${schoolCond(f.school)}
     group by 1`;
  return fillSeries(new Map(rows.map((r) => [r.b, r.n])), start, end, bucket);
}

async function meetingSeries(
  f: AnalyticsFilters, start: string, end: string, bucket: Bucket
): Promise<SeriesPoint[]> {
  const rows = await sql<{ b: string; n: number }[]>`
    select to_char(date_trunc(${bucket}, (ce.starts_at at time zone ${TZ})::date), 'YYYY-MM-DD') b,
           count(*)::int n
      from calendar_events ce
      join deals d on d.gid = ce.matched_deal_gid
     where ce.status = 'confirmed'
       and (ce.starts_at at time zone ${TZ})::date >= ${start}
       and (ce.starts_at at time zone ${TZ})::date <= ${end}
       ${stageCond(f.stage)} ${ownerCond(f.owner)} ${schoolCond(f.school)}
     group by 1`;
  return fillSeries(new Map(rows.map((r) => [r.b, r.n])), start, end, bucket);
}

export async function loadAnalytics(f: AnalyticsFilters): Promise<AnalyticsPayload> {
  return timed("analytics.load", async () => {
    const { period } = f;
    const today = period.end;
    // "All time" series still need a concrete left edge for gap filling.
    const seriesStart = period.start ?? (await earliestDeal()) ?? today;

    // The fan-out runs in waves of ≤4: the dev pool holds 4 connections and
    // the pool-health detector treats a saturating burst as a poisoned pool
    // (in-flight queries die CONNECTION_DESTROYED when it swaps). Waves keep
    // every query inside capacity; total latency stays ~1s.
    const [newDeals, newDealsPrev, meetings, meetingsPrev] = await Promise.all([
      countDeals(f, period.start, period.end),
      period.prevStart ? countDeals(f, period.prevStart, period.prevEnd!) : Promise.resolve(null),
      countMeetings(f, period.start, period.end),
      period.prevStart ? countMeetings(f, period.prevStart, period.prevEnd!) : Promise.resolve(null),
    ]);
    const [snapshot, ages, deals, dealsPrev] = await Promise.all([

      // Current stage snapshot — the distribution chart and the point-in-time
      // KPIs. The stage filter is NOT applied here (the chart highlights the
      // selected stage instead); owner/school are.
      sql<{ stage: string; n: number }[]>`
        select d.stage, count(*)::int n from deals d
         where 1=1 ${ownerCond(f.owner)} ${schoolCond(f.school)}
         group by 1`,

      // Ages of the active pipeline, honoring every filter.
      sql<{ age: number }[]>`
        select (current_date - d.created_on)::int age from deals d
         where d.stage = any(${ACTIVE_STAGE_KEYS})
           ${stageCond(f.stage)} ${ownerCond(f.owner)} ${schoolCond(f.school)}`,

      dealSeries(f, seriesStart, period.end, period.bucket),
      period.prevStart
        ? dealSeries(f, period.prevStart, period.prevEnd!, period.bucket)
        : Promise.resolve(null),
    ]);
    const [meetingsSeries, meetingsSeriesPrev, uni, teamStages] = await Promise.all([
      meetingSeries(f, seriesStart, period.end, period.bucket),
      period.prevStart
        ? meetingSeries(f, period.prevStart, period.prevEnd!, period.bucket)
        : Promise.resolve(null),

      // University: school × stage counts; stage/owner filters apply, and a
      // school filter narrows to that school's row (still deterministic).
      sql<{ school: string; stage: string; n: number }[]>`
        select s school, d.stage, count(*)::int n
          from deals d cross join lateral unnest(d.schools) s
         where array_length(d.schools, 1) > 0
           ${stageCond(f.stage)} ${ownerCond(f.owner)} ${schoolCond(f.school)}
         group by 1, 2`,

      // Team: owner × stage (school/stage filters apply).
      sql<{ owner: string; stage: string; n: number }[]>`
        select coalesce(nullif(d.owner, ''), 'Unassigned') owner, d.stage, count(*)::int n
          from deals d
         where 1=1 ${stageCond(f.stage)} ${schoolCond(f.school)}
         group by 1, 2`,
    ]);
    const [teamMeetings, attention, completeness] = await Promise.all([
      sql<{ owner: string; n: number }[]>`
        select coalesce(nullif(d.owner, ''), 'Unassigned') owner, count(*)::int n
          from calendar_events ce
          join deals d on d.gid = ce.matched_deal_gid
         where ce.status = 'confirmed'
           and (ce.starts_at at time zone ${TZ})::date <= ${period.end}
           ${period.start ? sql`and (ce.starts_at at time zone ${TZ})::date >= ${period.start}` : sql``}
           ${stageCond(f.stage)} ${schoolCond(f.school)}
         group by 1`,

      // Needs attention — deterministic rules over real fields. Each rule
      // defines its own stage set, so the page-level stage filter is ignored
      // here on purpose; owner/school still narrow it.
      sql<{ unowned: number; stale_dil: number; aging_early: number; no_school: number; quiet_offers: number }[]>`
        select
          count(*) filter (where d.stage = any(${ACTIVE_STAGE_KEYS}) and ${unowned()})::int unowned,
          count(*) filter (where d.stage = 'diligence' and d.modified_on < current_date - 14)::int stale_dil,
          count(*) filter (where d.stage = any(${EARLY}) and d.created_on < current_date - 60)::int aging_early,
          count(*) filter (where d.stage = any(${ACTIVE_STAGE_KEYS})
                             and (d.schools is null or d.schools = '{}'))::int no_school,
          count(*) filter (where d.stage = 'offered' and d.modified_on < current_date - 30)::int quiet_offers
        from deals d
        where 1=1 ${ownerCond(f.owner)} ${schoolCond(f.school)}`,

      // Completeness is a diagnostic of the whole dataset — unfiltered.
      sql<{
        active_n: number; active_school: number; active_owner: number;
        all_n: number; all_school: number; all_owner: number; with_source: number;
      }[]>`
        select
          count(*) filter (where d.stage = any(${ACTIVE_STAGE_KEYS}))::int active_n,
          count(*) filter (where d.stage = any(${ACTIVE_STAGE_KEYS})
                             and d.schools is not null and d.schools <> '{}')::int active_school,
          count(*) filter (where d.stage = any(${ACTIVE_STAGE_KEYS}) and not ${unowned()})::int active_owner,
          count(*)::int all_n,
          count(*) filter (where d.schools is not null and d.schools <> '{}')::int all_school,
          count(*) filter (where not ${unowned()})::int all_owner,
          count(*) filter (where d.source is not null)::int with_source
        from deals d`,
    ]);
    const [ownerOpts, schoolOpts, meetingCoverage] = await Promise.all([
      sql<{ o: string }[]>`
        select coalesce(nullif(owner, ''), 'Unassigned') o
          from deals group by 1 order by count(*) desc limit 15`,
      sql<{ s: string }[]>`
        select s from deals cross join lateral unnest(schools) s
         group by 1 order by count(*) desc limit 40`,
      // Calendar sync has a start date; comparing meeting counts against a
      // window the sync never covered would report coverage, not activity.
      sql<{ d: string | null }[]>`
        select to_char(min((starts_at at time zone ${TZ})::date), 'YYYY-MM-DD') d
          from calendar_events where status = 'confirmed' and matched_deal_gid is not null`,
    ]);
    const meetingsSince = meetingCoverage[0]?.d ?? null;
    const prevCovered =
      period.prevStart !== null && meetingsSince !== null && period.prevStart >= meetingsSince;

    const byStage = new Map(snapshot.map((r) => [r.stage as StageKey, r.n]));
    const inStage = (k: StageKey) => byStage.get(k) ?? 0;
    const activeAll = ACTIVE_STAGE_KEYS.reduce((n, k) => n + inStage(k), 0);
    // KPIs respect a stage filter; the distribution chart shows all stages.
    const active = f.stage
      ? ACTIVE_STAGE_KEYS.includes(f.stage) ? inStage(f.stage) : 0
      : activeAll;

    const ageCounts = new Map(AGE_BUCKETS.map((b) => [b.key, 0]));
    const sortedAges = ages.map((a) => a.age).sort((a, b) => a - b);
    for (const a of sortedAges) ageCounts.set(ageBucketOf(a), (ageCounts.get(ageBucketOf(a)) ?? 0) + 1);
    const median = sortedAges.length
      ? sortedAges[Math.floor((sortedAges.length - 1) / 2)]
      : null;

    const uniMap = new Map<string, UniversityRow>();
    for (const r of uni) {
      let row = uniMap.get(r.school);
      if (!row) {
        row = {
          school: r.school,
          byGroup: { early: 0, cultivate: 0, elevate: 0, diligence: 0, offered: 0, passed: 0 },
          active: 0, total: 0, signal: 0,
        };
        uniMap.set(r.school, row);
      }
      const g = stageGroupOf(r.stage as StageKey);
      row.byGroup[g] += r.n;
      row.total += r.n;
      if (ACTIVE_STAGE_KEYS.includes(r.stage as StageKey)) row.active += r.n;
      if (r.stage === "diligence" || r.stage === "offered") row.signal += r.n;
    }
    // Depth first: schools with live signal outrank raw volume.
    const university = [...uniMap.values()].sort(
      (a, b) => b.signal - a.signal || b.active - a.active || b.total - a.total
        || a.school.localeCompare(b.school)
    );

    const teamMap = new Map<string, TeamRow>();
    for (const r of teamStages) {
      let row = teamMap.get(r.owner);
      if (!row) {
        row = { owner: r.owner, active: 0, diligence: 0, offered: 0, meetings: 0, total: 0 };
        teamMap.set(r.owner, row);
      }
      row.total += r.n;
      if (ACTIVE_STAGE_KEYS.includes(r.stage as StageKey)) row.active += r.n;
      if (r.stage === "diligence") row.diligence += r.n;
      if (r.stage === "offered") row.offered += r.n;
    }
    for (const r of teamMeetings) {
      const row = teamMap.get(r.owner);
      if (row) row.meetings = r.n;
      else teamMap.set(r.owner, { owner: r.owner, active: 0, diligence: 0, offered: 0, meetings: r.n, total: 0 });
    }
    const team = [...teamMap.values()].sort(
      (a, b) => b.active - a.active || b.meetings - a.meetings || a.owner.localeCompare(b.owner)
    );

    const att = attention[0];
    const attentionItems: AttentionItem[] = [
      { key: "unowned", count: att?.unowned ?? 0, title: "Active deals with no owner", rule: "Stage is active and owner is empty or Unassigned" },
      { key: "stale-diligence", count: att?.stale_dil ?? 0, title: "Diligence untouched 14+ days", rule: "Stage is Diligence and the deal hasn't been edited in 14 days" },
      { key: "quiet-offers", count: att?.quiet_offers ?? 0, title: "Offers with no movement in 30 days", rule: "Stage is Offered and the deal hasn't been edited in 30 days" },
      { key: "aging-early", count: att?.aging_early ?? 0, title: "Early-stage deals older than 60 days", rule: "Stage is To Meet or First Meeting and the deal was added over 60 days ago" },
      { key: "no-school", count: att?.no_school ?? 0, title: "Active deals missing a school", rule: "Stage is active and no school is tagged" },
    ].filter((a) => a.count > 0).slice(0, 5);

    const comp = completeness[0];
    return {
      generatedAt: new Date().toISOString(),
      kpis: {
        newDeals, newDealsPrev, meetings,
        meetingsPrev: prevCovered ? meetingsPrev : null,
        active,
        diligence: f.stage && f.stage !== "diligence" ? 0 : inStage("diligence"),
        offered: f.stage && f.stage !== "offered" ? 0 : inStage("offered"),
      },
      distribution: STAGES.map((s) => ({ stage: s.key, count: inStage(s.key) })),
      ageBuckets: AGE_BUCKETS.map((b) => ({ key: b.key, label: b.label, count: ageCounts.get(b.key) ?? 0 })),
      medianAgeDays: median,
      oldestAgeDays: sortedAges.length ? sortedAges[sortedAges.length - 1] : null,
      flow: {
        deals, dealsPrev,
        meetings: meetingsSeries,
        meetingsPrev: prevCovered ? meetingsSeriesPrev : null,
      },
      university,
      team,
      attention: attentionItems,
      completeness: {
        activeTotal: comp?.active_n ?? 0,
        activeWithSchool: comp?.active_school ?? 0,
        activeWithOwner: comp?.active_owner ?? 0,
        allTotal: comp?.all_n ?? 0,
        allWithSchool: comp?.all_school ?? 0,
        allWithOwner: comp?.all_owner ?? 0,
        withSource: comp?.with_source ?? 0,
      },
      options: { owners: ownerOpts.map((r) => r.o), schools: schoolOpts.map((r) => r.s) },
    };
  }, { period: f.period.key, stage: f.stage ?? null });
}

async function earliestDeal(): Promise<string | null> {
  const r = await sql<{ d: string | null }[]>`
    select to_char(min(created_on), 'YYYY-MM-DD') d from deals`;
  return r[0]?.d ?? null;
}

/* ── Drill-down: the deals behind any number on the page ─────────────────── */

export interface DrillParams {
  stages?: StageKey[];
  owner?: string;
  school?: string;
  noSchool?: boolean;
  unowned?: boolean;
  ageMin?: number; // days, active deals
  ageMax?: number;
  createdFrom?: string;
  createdTo?: string;
  meetingFrom?: string; // deals with a confirmed matched meeting in a window
  meetingTo?: string;
  modifiedBefore?: string;
  activeOnly?: boolean;
}

export interface DrillDeal {
  gid: string;
  name: string;
  stage: StageKey;
  owner: string;
  schools: string[];
  created: string;
  modified: string;
  ageDays: number;
}

export async function drillDeals(p: DrillParams): Promise<DrillDeal[]> {
  const rows = await sql<{
    gid: string; name: string; stage: string; owner: string | null;
    schools: string[] | null; created: string; modified: string; age: number;
  }[]>`
    select d.gid, d.name, d.stage, d.owner, d.schools,
           to_char(d.created_on, 'YYYY-MM-DD') created,
           to_char(d.modified_on, 'YYYY-MM-DD') modified,
           (current_date - d.created_on)::int age
      from deals d
     where 1=1
       ${p.stages && p.stages.length > 0 ? sql`and d.stage = any(${p.stages})` : sql``}
       ${p.activeOnly ? sql`and d.stage = any(${ACTIVE_STAGE_KEYS})` : sql``}
       ${ownerCond(p.owner)}
       ${schoolCond(p.school)}
       ${p.noSchool ? sql`and (d.schools is null or d.schools = '{}')` : sql``}
       ${p.unowned ? sql`and ${unowned()}` : sql``}
       ${p.ageMin !== undefined ? sql`and (current_date - d.created_on) >= ${p.ageMin}` : sql``}
       ${p.ageMax !== undefined ? sql`and (current_date - d.created_on) <= ${p.ageMax}` : sql``}
       ${p.createdFrom ? sql`and d.created_on >= ${p.createdFrom}` : sql``}
       ${p.createdTo ? sql`and d.created_on <= ${p.createdTo}` : sql``}
       ${p.modifiedBefore ? sql`and d.modified_on < ${p.modifiedBefore}` : sql``}
       ${p.meetingFrom || p.meetingTo ? sql`
         and exists (
           select 1 from calendar_events ce
            where ce.matched_deal_gid = d.gid and ce.status = 'confirmed'
              ${p.meetingFrom ? sql`and (ce.starts_at at time zone ${TZ})::date >= ${p.meetingFrom}` : sql``}
              ${p.meetingTo ? sql`and (ce.starts_at at time zone ${TZ})::date <= ${p.meetingTo}` : sql``}
         )` : sql``}
     order by d.created_on desc, d.name
     limit 300`;
  return rows.map((r) => ({
    gid: r.gid,
    name: r.name,
    stage: r.stage as StageKey,
    owner: r.owner?.trim() || "Unassigned",
    schools: r.schools ?? [],
    created: r.created,
    modified: r.modified,
    ageDays: r.age,
  }));
}
