"use client";

import { crm } from "@/config/crm.config";

import { useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronLeft, Close, Information, Renew } from "@carbon/icons-react";
import {
  Bar,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { STAGES } from "@/lib/stages";
import type { StageKey } from "@/lib/types";
import { formatDateTime } from "@/lib/aggregate";
import {
  AGE_BUCKETS,
  deltaLabel,
  fmtInt,
  pctOf,
  PERIODS,
  STAGE_GROUPS,
  type PeriodKey,
  type ResolvedPeriod,
} from "@/lib/analyticsPure";
import type {
  AnalyticsPayload,
  DrillDeal,
  TeamRow,
  UniversityRow,
} from "@/lib/analyticsData";
import { StagePill } from "@/components/charts";

/**
 * ── Analytics ───────────────────────────────────────────────────────────────
 * One page, five modules: the desk (KPIs), pipeline (distribution + age),
 * deal flow over time, university pipeline, team + needs-attention. Every
 * number opens the deals behind it. Filters live in the URL, so a filtered
 * view is shareable and the back button undoes a click.
 *
 * Deliberately absent (data can't support them honestly): conversion rates,
 * decision-time medians, sourcing/sector dimensions, scores of any kind.
 */

const ACTIVE_STAGES = STAGES.filter((s) => s.active);
const TERMINAL_STAGES = STAGES.filter((s) => !s.active);

interface Filters {
  period: ResolvedPeriod;
  stage: StageKey | null;
  owner: string | null;
  school: string | null;
}

type DrillRequest = { title: string; sub?: string; query: Record<string, string> };

export function AnalyticsApp({
  payload,
  period,
  stage,
  owner,
  school,
}: {
  payload: AnalyticsPayload;
  period: ResolvedPeriod;
  stage: StageKey | null;
  owner: string | null;
  school: string | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [drill, setDrill] = useState<DrillRequest | null>(null);
  const f: Filters = { period, stage, owner, school };

  /** Push a new filter combination into the URL (server re-aggregates). */
  const apply = (patch: Partial<{ period: string; from: string; to: string; stage: string | null; owner: string | null; school: string | null }>) => {
    const q = new URLSearchParams();
    const periodKey = patch.period ?? period.key;
    if (periodKey !== "12m") q.set("period", periodKey);
    if (periodKey === "custom") {
      q.set("from", patch.from ?? period.start ?? "");
      q.set("to", patch.to ?? period.end);
    }
    const st = patch.stage === undefined ? stage : patch.stage;
    const ow = patch.owner === undefined ? owner : patch.owner;
    const sc = patch.school === undefined ? school : patch.school;
    if (st) q.set("stage", st);
    if (ow) q.set("owner", ow);
    if (sc) q.set("school", sc);
    const qs = q.toString();
    startTransition(() => router.replace(`/analytics${qs ? `?${qs}` : ""}`, { scroll: false }));
  };
  const reset = () => startTransition(() => router.replace("/analytics", { scroll: false }));
  const filtered = stage !== null || owner !== null || school !== null || period.key !== "12m";

  /* Drill helpers: every one is a typed query the API turns into WHERE. */
  const dims = () => {
    const q: Record<string, string> = {};
    if (owner) q.owner = owner;
    if (school) q.school = school;
    return q;
  };
  const dimNote = [owner, school].filter(Boolean).join(" · ");

  return (
    <main className={`mx-auto w-full max-w-[1500px] px-4 pb-24 pt-8 transition-opacity sm:px-8 ${pending ? "opacity-60" : ""}`}>
      {/* ── Header ──────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <Link
            href="/"
            className="mb-1 inline-flex items-center gap-1 text-[13px] font-medium text-primary hover:text-primary-pressed lg:hidden"
          >
            <ChevronLeft size={14} aria-hidden /> Back
          </Link>
          <h1 className="text-[28px] font-light text-ink">Analytics</h1>
          <p className="mt-0.5 text-[12.5px] text-faint">
            Updated {formatDateTime(payload.generatedAt)}
          </p>
        </div>
        {filtered && (
          <button className="tag" onClick={reset}>
            <Renew size={13} className="mr-1 inline" aria-hidden />
            Reset filters
          </button>
        )}
      </div>

      <FilterBar f={f} payload={payload} apply={apply} />

      {/* ── 1 · The desk ────────────────────────────────────────────────── */}
      <section className="mt-5 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
        <Kpi
          n={payload.kpis.newDeals}
          label="New deals"
          delta={payload.kpis.newDealsPrev !== null ? deltaLabel(payload.kpis.newDeals, payload.kpis.newDealsPrev) : null}
          compare={period.compareLabel}
          onClick={() =>
            setDrill({
              title: `New deals · ${periodTitle(period)}`,
              query: {
                ...dims(),
                ...(period.start ? { createdFrom: period.start } : {}),
                createdTo: period.end,
                ...(stage ? { stages: stage } : {}),
              },
            })
          }
        />
        <Kpi
          n={payload.kpis.meetings}
          label="Meetings"
          delta={payload.kpis.meetingsPrev !== null ? deltaLabel(payload.kpis.meetings, payload.kpis.meetingsPrev) : null}
          compare={period.compareLabel}
          info="Confirmed calendar events matched to a deal."
          onClick={() =>
            setDrill({
              title: `Deals met · ${periodTitle(period)}`,
              sub: "Deals with a confirmed matched calendar event in the period",
              query: {
                ...dims(),
                ...(period.start ? { meetingFrom: period.start } : {}),
                meetingTo: period.end,
                ...(stage ? { stages: stage } : {}),
              },
            })
          }
        />
        <Kpi
          n={payload.kpis.active}
          label="Active pipeline"
          info="Deals currently in an active stage: To Meet through Offered."
          onClick={() =>
            setDrill({
              title: "Active pipeline",
              query: { ...dims(), active: "1", ...(stage ? { stages: stage } : {}) },
            })
          }
        />
        <Kpi
          n={payload.kpis.diligence}
          label="In diligence"
          onClick={() => setDrill({ title: "In diligence", query: { ...dims(), stages: "diligence" } })}
        />
        <Kpi
          n={payload.kpis.offered}
          label="Offered"
          onClick={() => setDrill({ title: "Offered", query: { ...dims(), stages: "offered" } })}
        />
      </section>

      {/* ── 2 · Pipeline ────────────────────────────────────────────────── */}
      <section className="mt-8 grid gap-3 lg:grid-cols-5">
        <div className="card p-5 lg:col-span-3">
          <SectionTitle
            title="Current pipeline distribution"
          />
          <Distribution
            distribution={payload.distribution}
            selected={stage}
            onStage={(s) => apply({ stage: stage === s ? null : s })}
          />
          <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-line pt-3">
            {TERMINAL_STAGES.map((s) => {
              const n = payload.distribution.find((d) => d.stage === s.key)?.count ?? 0;
              return (
                <button
                  key={s.key}
                  className="text-[12.5px] text-sub hover:text-primary"
                  onClick={() => setDrill({ title: s.label, sub: dimNote || undefined, query: { ...dims(), stages: s.key } })}
                >
                  {s.label} <span className="font-semibold tabular-nums text-body">{fmtInt(n)}</span>
                </button>
              );
            })}
          </div>
        </div>

        <div className="card p-5 lg:col-span-2">
          <SectionTitle
            title="Age of active pipeline"
            right={
              payload.medianAgeDays !== null ? (
                <span className="text-[12.5px] text-sub">
                  median <span className="font-semibold tabular-nums text-ink">{payload.medianAgeDays}d</span>
                  {payload.oldestAgeDays !== null && (
                    <span className="text-faint"> · oldest {fmtInt(payload.oldestAgeDays)}d</span>
                  )}
                </span>
              ) : undefined
            }
          />
          <AgeBars
            buckets={payload.ageBuckets}
            onPick={(key) => {
              const b = AGE_BUCKETS.find((x) => x.key === key);
              if (!b) return;
              setDrill({
                title: `Active pipeline · ${b.label}`,
                sub: "Age = days since the deal was added",
                query: {
                  ...dims(),
                  active: "1",
                  ...(stage ? { stages: stage } : {}),
                  ageMin: String(b.min),
                  ...(b.max !== null ? { ageMax: String(b.max) } : {}),
                },
              });
            }}
          />
        </div>
      </section>

      {/* ── 3 · Deal flow ───────────────────────────────────────────────── */}
      <section className="card mt-8 p-5">
        <FlowChart payload={payload} period={period} />
      </section>

      {/* ── 4 · Pipeline by tag ─────────────────────────────────────── */}
      <section className="card mt-8 p-5">
        <University
          rows={payload.university}
          school={school}
          onSchool={(s) => apply({ school: school === s ? null : s })}
          onSegment={(s, groupKey) => {
            const g = STAGE_GROUPS.find((x) => x.key === groupKey);
            if (!g) return;
            setDrill({
              title: `${s} · ${g.label}`,
              sub: g.detail,
              query: { school: s, stages: g.stages.join(","), ...(owner ? { owner } : {}) },
            });
          }}
        />
      </section>

      {/* ── 5 · Team + attention ────────────────────────────────────────── */}
      <section className="mt-8 grid gap-3 lg:grid-cols-2">
        <div className="card p-5">
          <SectionTitle
            title="Team activity"
          />
          <TeamTable
            rows={payload.team}
            selected={owner}
            onOwner={(o) => apply({ owner: owner === o ? null : o })}
          />
        </div>
        <div className="card p-5">
          <SectionTitle title="Needs attention" />
          {payload.attention.length === 0 ? (
            <p className="mt-4 text-[13.5px] text-sub">Nothing tripping a rule right now.</p>
          ) : (
            <ul className="mt-2 divide-y divide-line">
              {payload.attention.map((a) => (
                <li key={a.key}>
                  <button
                    className="group flex w-full items-baseline gap-3 py-2.5 text-left"
                    onClick={() =>
                      setDrill({ title: a.title, sub: a.rule, query: { ...dims(), ...attentionQuery(a.key) } })
                    }
                  >
                    <span className="w-12 shrink-0 text-right text-[22px] font-light tabular-nums text-ink">
                      {fmtInt(a.count)}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-[13.5px] font-medium text-ink">{a.title}</span>
                      <span className="block text-[12px] text-faint">{a.rule}</span>
                    </span>
                    <span className="shrink-0 text-[12.5px] font-medium text-primary opacity-0 transition-opacity group-hover:opacity-100">
                      View deals →
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      {/* ── Footer · data completeness ──────────────────────────────────── */}
      <section className="card-flat mt-8 border border-line p-5">
        <Completeness
          c={payload.completeness}
          onMissing={(kind) =>
            setDrill(
              kind === "school"
                ? { title: "Active deals missing a school", query: { active: "1", noSchool: "1" } }
                : { title: "Active deals with no owner", query: { active: "1", unowned: "1" } }
            )
          }
        />
      </section>

      {drill && <DrillDrawer req={drill} onClose={() => setDrill(null)} />}
    </main>
  );
}

function periodTitle(p: ResolvedPeriod): string {
  const label = PERIODS.find((x) => x.key === p.key)?.label ?? p.key;
  return p.key === "all" ? "All time" : p.key === "custom" ? `${p.start} → ${p.end}` : `Last ${label.toLowerCase()}`;
}

function attentionQuery(key: string): Record<string, string> {
  const today = new Date();
  const iso = (daysAgo: number) => {
    const d = new Date(today);
    d.setDate(d.getDate() - daysAgo);
    return d.toISOString().slice(0, 10);
  };
  switch (key) {
    case "unowned": return { active: "1", unowned: "1" };
    case "stale-diligence": return { stages: "diligence", modifiedBefore: iso(14) };
    case "quiet-offers": return { stages: "offered", modifiedBefore: iso(30) };
    case "aging-early": return { stages: "to-meet,first-meeting", ageMin: "61" };
    case "no-school": return { active: "1", noSchool: "1" };
    default: return {};
  }
}

/* ── Filter bar ──────────────────────────────────────────────────────────── */

function FilterBar({
  f, payload, apply,
}: {
  f: Filters;
  payload: AnalyticsPayload;
  apply: (p: Partial<{ period: string; from: string; to: string; stage: string | null; owner: string | null; school: string | null }>) => void;
}) {
  const [customOpen, setCustomOpen] = useState(false);
  const [from, setFrom] = useState(f.period.start ?? "");
  const [to, setTo] = useState(f.period.end);
  const sel =
    "h-8 max-w-[160px] border border-line bg-bg px-2 text-[12.5px] text-ink focus:border-primary/50 focus:outline-none";
  return (
    <div className="mt-4 flex flex-wrap items-center gap-2 border-y border-line py-2.5">
      <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Period">
        {PERIODS.map((p) => {
          const active = f.period.key === p.key;
          return (
            <button
              key={p.key}
              className={`px-2.5 py-1.5 text-[12.5px] font-medium transition-colors ${
                active ? "bg-red-50 text-primary-pressed" : "text-sub hover:text-ink"
              }`}
              aria-pressed={active}
              onClick={() => {
                if (p.key === "custom") setCustomOpen((v) => !v);
                else {
                  setCustomOpen(false);
                  apply({ period: p.key as PeriodKey });
                }
              }}
            >
              {p.label}
            </button>
          );
        })}
      </div>
      {customOpen && (
        <span className="flex items-center gap-1.5">
          <input type="date" aria-label="From" className={sel} value={from} onChange={(e) => setFrom(e.target.value)} />
          <span className="text-[12px] text-faint">to</span>
          <input type="date" aria-label="To" className={sel} value={to} onChange={(e) => setTo(e.target.value)} />
          <button
            className="tag"
            onClick={() => {
              if (from && to && from <= to) {
                setCustomOpen(false);
                apply({ period: "custom", from, to });
              }
            }}
          >
            Apply
          </button>
        </span>
      )}
      <span className="mx-1 hidden h-5 w-px bg-line sm:block" />
      <select
        className={sel}
        aria-label="Stage"
        value={f.stage ?? ""}
        onChange={(e) => apply({ stage: e.target.value || null })}
      >
        <option value="">All stages</option>
        {STAGES.map((s) => (
          <option key={s.key} value={s.key}>{s.label}</option>
        ))}
      </select>
      <select
        className={sel}
        aria-label="Owner"
        value={f.owner ?? ""}
        onChange={(e) => apply({ owner: e.target.value || null })}
      >
        <option value="">All owners</option>
        {payload.options.owners.map((o) => (
          <option key={o} value={o}>{o}</option>
        ))}
      </select>
      <select
        className={sel}
        aria-label={crm.tags.singular}
        value={f.school ?? ""}
        onChange={(e) => apply({ school: e.target.value || null })}
      >
        <option value="">All {crm.tags.plural.toLowerCase()}</option>
        {payload.options.schools.map((s) => (
          <option key={s} value={s}>{s}</option>
        ))}
      </select>
    </div>
  );
}

/* ── KPI card ────────────────────────────────────────────────────────────── */

function Kpi({
  n, label, delta, compare, info, onClick,
}: {
  n: number;
  label: string;
  delta?: string | null;
  compare?: string | null;
  info?: string;
  onClick: () => void;
}) {
  return (
    <button className="card group p-4 text-left transition-colors hover:border-primary/40" onClick={onClick}>
      <div className="text-[30px] font-light leading-none tabular-nums text-ink">{fmtInt(n)}</div>
      <div className="mt-1.5 flex items-center gap-1 text-[11.5px] font-semibold uppercase tracking-wide text-sub">
        {label}
        {info && (
          <span title={info} className="text-faint">
            <Information size={13} aria-label={info} />
          </span>
        )}
      </div>
      {delta && compare ? (
        <div className="mt-0.5 text-[12px] tabular-nums text-faint">
          {delta} {compare}
        </div>
      ) : (
        <div className="mt-0.5 text-[12px] text-transparent" aria-hidden>·</div>
      )}
    </button>
  );
}

/* ── Pipeline distribution ───────────────────────────────────────────────── */

function Distribution({
  distribution, selected, onStage,
}: {
  distribution: { stage: StageKey; count: number }[];
  selected: StageKey | null;
  onStage: (s: StageKey) => void;
}) {
  const active = ACTIVE_STAGES.map((s) => ({
    meta: s,
    count: distribution.find((d) => d.stage === s.key)?.count ?? 0,
  }));
  const max = Math.max(1, ...active.map((a) => a.count));
  return (
    <div className="mt-3 flex flex-col gap-1">
      {active.map(({ meta, count }) => {
        const dim = selected !== null && selected !== meta.key;
        return (
          <button
            key={meta.key}
            className={`group flex items-center gap-3 py-0.5 text-left transition-opacity ${dim ? "opacity-35" : ""}`}
            aria-pressed={selected === meta.key}
            title={`${meta.label}: ${fmtInt(count)} deal${count === 1 ? "" : "s"} — click to filter`}
            onClick={() => onStage(meta.key)}
          >
            <span className="w-24 shrink-0 truncate text-[12.5px] text-body sm:w-28">{meta.short}</span>
            <span className="relative h-[18px] min-w-0 flex-1">
              <span
                className="absolute inset-y-0 left-0 group-hover:opacity-80"
                style={{ width: `${Math.max(count > 0 ? 1.2 : 0, (count / max) * 100)}%`, background: meta.color }}
              />
            </span>
            <span className="w-10 shrink-0 text-right text-[13px] font-semibold tabular-nums text-ink">
              {fmtInt(count)}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/* ── Age bars ────────────────────────────────────────────────────────────── */

function AgeBars({
  buckets, onPick,
}: {
  buckets: { key: string; label: string; count: number }[];
  onPick: (key: string) => void;
}) {
  const max = Math.max(1, ...buckets.map((b) => b.count));
  const shade = ["#e7e4df", "#c8c2bb", "#8a837c", "var(--brand-red-500)"]; // 60+ gets the accent
  return (
    <div className="mt-3 flex flex-col gap-1">
      {buckets.map((b, i) => (
        <button
          key={b.key}
          className="group flex items-center gap-3 py-0.5 text-left"
          title={`${b.label}: ${fmtInt(b.count)} active deal${b.count === 1 ? "" : "s"} — click to view`}
          onClick={() => onPick(b.key)}
        >
          <span className="w-20 shrink-0 text-[12.5px] text-body">{b.label}</span>
          <span className="relative h-[18px] min-w-0 flex-1">
            <span
              className="absolute inset-y-0 left-0 group-hover:opacity-80"
              style={{ width: `${Math.max(b.count > 0 ? 1.2 : 0, (b.count / max) * 100)}%`, background: shade[i] ?? "#c8c2bb" }}
            />
          </span>
          <span className="w-10 shrink-0 text-right text-[13px] font-semibold tabular-nums text-ink">
            {fmtInt(b.count)}
          </span>
        </button>
      ))}
    </div>
  );
}

/* ── Deal flow ───────────────────────────────────────────────────────────── */

const FLOW_TOOLTIP: React.CSSProperties = {
  background: "#ffffff",
  border: "1px solid #e7e4df",
  borderRadius: 0,
  fontSize: 13,
  boxShadow: "0 8px 24px rgba(16,24,40,0.10)",
};

function FlowChart({ payload, period }: { payload: AnalyticsPayload; period: ResolvedPeriod }) {
  const [metric, setMetric] = useState<"deals" | "meetings">("deals");
  const cur = metric === "deals" ? payload.flow.deals : payload.flow.meetings;
  const prev = metric === "deals" ? payload.flow.dealsPrev : payload.flow.meetingsPrev;
  const rows = cur.map((p, i) => ({
    label: p.label,
    count: p.count,
    prev: prev?.[i]?.count ?? null,
    prevLabel: prev?.[i]?.label ?? null,
  }));
  const total = cur.reduce((n, p) => n + p.count, 0);
  const prevTotal = prev ? prev.reduce((n, p) => n + p.count, 0) : null;
  const delta = prevTotal !== null ? deltaLabel(total, prevTotal) : null;
  const unit = metric === "deals" ? "new deals" : "meetings";
  const granularity =
    period.bucket === "day" ? "daily" : period.bucket === "week" ? "weekly"
    : period.bucket === "month" ? "monthly" : "quarterly";
  const empty = total === 0 && (prevTotal ?? 0) === 0;

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <SectionTitle
          title="Deal flow"
        />
        <div className="flex items-center gap-4">
          <span className="text-[12.5px] tabular-nums text-sub">
            This period <span className="font-semibold text-ink">{fmtInt(total)}</span>
            {prevTotal !== null && (
              <>
                {" · "}prior <span className="font-semibold text-ink">{fmtInt(prevTotal)}</span>
                {delta && <span className="text-faint"> ({delta})</span>}
              </>
            )}
          </span>
          <div className="flex" role="group" aria-label="Metric">
            {(["deals", "meetings"] as const).map((m) => (
              <button
                key={m}
                className={`border border-line px-2.5 py-1 text-[12.5px] font-medium first:border-r-0 ${
                  metric === m ? "bg-red-50 text-primary-pressed" : "text-sub hover:text-ink"
                }`}
                aria-pressed={metric === m}
                onClick={() => setMetric(m)}
              >
                {m === "deals" ? "New deals" : "Meetings"}
              </button>
            ))}
          </div>
        </div>
      </div>
      {empty ? (
        <p className="mt-6 pb-4 text-[13.5px] text-sub">
          No {unit} recorded in this period{metric === "meetings" ? " — meetings count once a calendar event is matched to a deal" : ""}.
        </p>
      ) : (
        <div className="mt-4 h-[280px]">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={rows} margin={{ left: 0, right: 8, top: 8, bottom: 0 }}>
              <XAxis
                dataKey="label"
                tick={{ fontSize: 11, fill: "#8a837c" }}
                axisLine={{ stroke: "#e7e4df" }}
                tickLine={false}
                interval="preserveStartEnd"
                minTickGap={28}
              />
              <YAxis
                tick={{ fontSize: 11, fill: "#8a837c" }}
                axisLine={false}
                tickLine={false}
                width={34}
                allowDecimals={false}
              />
              <Tooltip
                cursor={{ fill: "#fafafa" }}
                content={({ active, payload: tp, label }) => {
                  if (!active || !tp || tp.length === 0) return null;
                  const row = tp[0]?.payload as (typeof rows)[number] | undefined;
                  if (!row) return null;
                  return (
                    <div style={{ ...FLOW_TOOLTIP, padding: "8px 12px" }}>
                      <div style={{ fontWeight: 600, color: "#171717" }}>{label}</div>
                      <div style={{ color: "#55514d", marginTop: 2 }}>
                        {fmtInt(row.count)} {unit}
                      </div>
                      {row.prev !== null && row.prevLabel && (
                        <div style={{ color: "#8a837c", fontSize: 12, marginTop: 2 }}>
                          {row.prevLabel} (prior period): {fmtInt(row.prev)}
                        </div>
                      )}
                    </div>
                  );
                }}
              />
              <Bar dataKey="count" name="This period" fill="var(--brand-red-500)" maxBarSize={18} />
              {prev && (
                <Line
                  dataKey="prev"
                  name="Prior period"
                  stroke="#c8c2bb"
                  strokeWidth={1.5}
                  dot={false}
                  type="linear"
                />
              )}
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      )}
    </>
  );
}

/* ── Pipeline by tag ─────────────────────────────────────────────────── */

function University({
  rows, school, onSchool, onSegment,
}: {
  rows: UniversityRow[];
  school: string | null;
  onSchool: (s: string) => void;
  onSegment: (school: string, group: string) => void;
}) {
  const [topN, setTopN] = useState<10 | 25>(10);
  const [includePassed, setIncludePassed] = useState(false);
  const groups = STAGE_GROUPS.filter((g) => includePassed || g.key !== "passed");
  const shown = rows.slice(0, topN);
  const max = Math.max(
    1,
    ...shown.map((r) => groups.reduce((n, g) => n + r.byGroup[g.key], 0))
  );
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <SectionTitle
          title={`Pipeline by ${crm.tags.singular.toLowerCase()}`}
        />
        <div className="flex items-center gap-2">
          <div className="flex" role="group" aria-label="Rows">
            {([10, 25] as const).map((n) => (
              <button
                key={n}
                className={`border border-line px-2.5 py-1 text-[12.5px] font-medium first:border-r-0 ${
                  topN === n ? "bg-red-50 text-primary-pressed" : "text-sub hover:text-ink"
                }`}
                aria-pressed={topN === n}
                onClick={() => setTopN(n)}
              >
                Top {n}
              </button>
            ))}
          </div>
          <button
            className={`border border-line px-2.5 py-1 text-[12.5px] font-medium ${
              includePassed ? "bg-red-50 text-primary-pressed" : "text-sub hover:text-ink"
            }`}
            aria-pressed={includePassed}
            onClick={() => setIncludePassed((v) => !v)}
          >
            Include passed
          </button>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1">
        {groups.map((g) => (
          <span key={g.key} className="flex items-center gap-1.5 text-[12px] text-sub" title={g.detail}>
            <span className="inline-block h-2.5 w-2.5" style={{ background: g.color }} />
            {g.label}
          </span>
        ))}
      </div>

      {shown.length === 0 ? (
        <p className="mt-5 text-[13.5px] text-sub">No school-tagged deals match these filters.</p>
      ) : (
        <div className="mt-4 flex flex-col gap-[7px]">
          {shown.map((r) => {
            const rowTotal = groups.reduce((n, g) => n + r.byGroup[g.key], 0);
            const dim = school !== null && school !== r.school;
            return (
              <div key={r.school} className={`flex items-center gap-3 transition-opacity ${dim ? "opacity-35" : ""}`}>
                <button
                  className={`w-24 shrink-0 truncate text-left text-[12.5px] hover:text-primary sm:w-28 ${
                    school === r.school ? "font-semibold text-primary-pressed" : "text-body"
                  }`}
                  title={`${r.school} — click to filter`}
                  onClick={() => onSchool(r.school)}
                >
                  {r.school}
                </button>
                <div className="flex h-[16px] min-w-0 flex-1 items-stretch">
                  {groups.map((g) => {
                    const n = r.byGroup[g.key];
                    if (n === 0) return null;
                    return (
                      <button
                        key={g.key}
                        className="mr-[2px] transition-opacity hover:opacity-75"
                        style={{ width: `${Math.max(0.8, (n / max) * 100)}%`, background: g.color }}
                        title={`${r.school} · ${g.label} (${g.detail}): ${fmtInt(n)} — click to view`}
                        aria-label={`${r.school} ${g.label}: ${n} deals`}
                        onClick={() => onSegment(r.school, g.key)}
                      />
                    );
                  })}
                </div>
                <span className="w-12 shrink-0 text-right text-[13px] font-semibold tabular-nums text-ink">
                  {fmtInt(rowTotal)}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

/* ── Team table ──────────────────────────────────────────────────────────── */

function TeamTable({
  rows, selected, onOwner,
}: {
  rows: TeamRow[];
  selected: string | null;
  onOwner: (o: string) => void;
}) {
  const maxActive = Math.max(1, ...rows.map((r) => r.active));
  return (
    <div className="mt-2 overflow-x-auto">
      <table className="table w-full">
        <thead>
          <tr>
            <th>Member</th>
            <th className="w-[38%]">Active</th>
            <th className="w-16 text-right">Dilig.</th>
            <th className="w-16 text-right">Offered</th>
            <th className="w-20 text-right">Meetings</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const dim = selected !== null && selected !== r.owner;
            const muted = r.owner === "Unassigned";
            return (
              <tr
                key={r.owner}
                className={`cursor-pointer transition-colors hover:bg-bg-soft ${dim ? "opacity-35" : ""} ${
                  selected === r.owner ? "bg-red-50/50" : ""
                }`}
                onClick={() => onOwner(r.owner)}
                title={`${r.owner} — click to filter`}
              >
                <td className={`whitespace-nowrap text-[13px] ${muted ? "italic text-faint" : "text-ink"}`}>
                  {r.owner}
                </td>
                <td>
                  <span className="flex items-center gap-2">
                    <span className="relative h-[12px] w-full max-w-[140px]">
                      <span
                        className="absolute inset-y-0 left-0"
                        style={{
                          width: `${Math.max(r.active > 0 ? 2 : 0, (r.active / maxActive) * 100)}%`,
                          background: muted ? "#c8c2bb" : "var(--brand-red-500)",
                        }}
                      />
                    </span>
                    <span className="text-[12.5px] font-semibold tabular-nums text-ink">{fmtInt(r.active)}</span>
                  </span>
                </td>
                <td className="text-right text-[12.5px] tabular-nums text-body">{r.diligence || ""}</td>
                <td className="text-right text-[12.5px] tabular-nums text-body">{r.offered || ""}</td>
                <td className="text-right text-[12.5px] tabular-nums text-body">{r.meetings || ""}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/* ── Completeness footer ─────────────────────────────────────────────────── */

function Completeness({
  c, onMissing,
}: {
  c: AnalyticsPayload["completeness"];
  onMissing: (kind: "school" | "owner") => void;
}) {
  const row = (
    label: string,
    have: number,
    total: number,
    kind: "school" | "owner"
  ) => {
    const missing = total - have;
    return (
      <div className="flex items-center gap-3">
        <span className="w-14 shrink-0 text-[12.5px] text-body">{label}</span>
        <span className="relative h-[8px] w-full max-w-[220px] bg-bg-soft">
          <span
            className="absolute inset-y-0 left-0 bg-[#8a837c]"
            style={{ width: total > 0 ? `${(have / total) * 100}%` : 0 }}
          />
        </span>
        <span className="text-[12.5px] font-semibold tabular-nums text-ink">{pctOf(have, total)}</span>
        {missing > 0 ? (
          <button className="text-[12px] text-sub underline-offset-2 hover:text-primary hover:underline" onClick={() => onMissing(kind)}>
            {fmtInt(missing)} missing
          </button>
        ) : (
          <span className="text-[12px] text-faint">complete</span>
        )}
      </div>
    );
  };
  return (
    <div>
      <h2 className="text-[12px] font-semibold uppercase tracking-wide text-sub">
        Data completeness · active pipeline ({fmtInt(c.activeTotal)} deals)
      </h2>
      <div className="mt-3 flex flex-col gap-2">
        {row(crm.tags.singular, c.activeWithSchool, c.activeTotal, "school")}
        {row("Owner", c.activeWithOwner, c.activeTotal, "owner")}
      </div>
      <p className="mt-3 text-[12px] text-faint">
        All-time: {crm.tags.singular.toLowerCase()} on {pctOf(c.allWithSchool, c.allTotal)}, owner on{" "}
        {pctOf(c.allWithOwner, c.allTotal)} of {fmtInt(c.allTotal)} deals.
      </p>
    </div>
  );
}

/* ── Shared bits ─────────────────────────────────────────────────────────── */

function SectionTitle({ title, note, right }: { title: string; note?: string; right?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5">
      <div>
        <h2 className="text-[15px] font-semibold text-ink">{title}</h2>
        {note && <p className="mt-0.5 max-w-xl text-[12px] leading-snug text-faint">{note}</p>}
      </div>
      {right}
    </div>
  );
}

/* ── Drill drawer ────────────────────────────────────────────────────────── */

function DrillDrawer({ req, onClose }: { req: DrillRequest; onClose: () => void }) {
  const [deals, setDeals] = useState<DrillDeal[] | null>(null);
  const [failed, setFailed] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    setDeals(null);
    setFailed(false);
    const qs = new URLSearchParams(req.query).toString();
    fetch(`/api/analytics/drill?${qs}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((j: { ok: boolean; deals?: DrillDeal[] }) => {
        if (alive) setDeals(j.deals ?? []);
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
    };
  }, [req]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-navy/40"
      onMouseDown={(e) => {
        if (panelRef.current && !panelRef.current.contains(e.target as Node)) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-label={req.title}
        className="flex h-full w-full max-w-xl flex-col border-l border-line bg-bg shadow-xl"
      >
        <div className="flex items-start justify-between gap-3 border-b border-line px-5 py-4">
          <div className="min-w-0">
            <h2 className="truncate text-[16px] font-semibold text-ink">{req.title}</h2>
            <p className="mt-0.5 text-[12px] text-faint">
              {req.sub ? `${req.sub} · ` : ""}
              {deals === null ? "Loading…" : `${fmtInt(deals.length)}${deals.length === 300 ? "+" : ""} deal${deals.length === 1 ? "" : "s"}`}
            </p>
          </div>
          <button className="tap p-1.5 text-sub hover:text-ink" aria-label="Close" onClick={onClose}>
            <Close size={22} />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {failed ? (
            <p className="p-5 text-[13.5px] text-sub">Couldn&rsquo;t load these deals. Close and try again.</p>
          ) : deals === null ? (
            <div className="flex flex-col gap-2 p-5">
              {[0, 1, 2, 3, 4].map((i) => (
                <div key={i} className="h-12 animate-pulse bg-bg-soft" />
              ))}
            </div>
          ) : deals.length === 0 ? (
            <p className="p-5 text-[13.5px] text-sub">No deals match.</p>
          ) : (
            <ul className="divide-y divide-line">
              {deals.map((d) => (
                <li key={d.gid}>
                  <Link
                    href={`/deals/${d.gid}`}
                    className="flex items-center gap-3 px-5 py-2.5 transition-colors hover:bg-bg-soft"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13.5px] font-medium text-ink">{d.name || "(unnamed)"}</span>
                      <span className="block truncate text-[12px] text-faint">
                        {d.owner}
                        {d.schools.length > 0 && ` · ${d.schools.join(", ")}`}
                        {` · added ${d.created} (${fmtInt(d.ageDays)}d ago)`}
                      </span>
                    </span>
                    <span className="shrink-0">
                      <StagePill stage={d.stage} short />
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
        {deals !== null && deals.length === 300 && (
          <p className="border-t border-line px-5 py-2 text-[12px] text-faint">
            Showing the 300 most recent — narrow the filters for the rest.
          </p>
        )}
      </div>
    </div>
  );
}
