"use client";

import { crm } from "@/config/crm.config";
import { useMemo } from "react";
import { ArrowRight, Close } from "@carbon/icons-react";
import type { Deal } from "@/lib/types";
import {
  byQuarter,
  countByStage,
  formatDate,
  isActive,
} from "@/lib/aggregate";
import { StageFunnelChart, MiniTrend } from "./analytics";
import { StagePill } from "./charts";

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="border-l-2 border-red-200 pl-3">
      <div className="text-[24px] font-light leading-none text-ink">
        {value}
      </div>
      <div className="mt-1 text-[12px] text-sub">{label}</div>
    </div>
  );
}

export function SchoolDetail({
  school,
  deals,
  onClose,
  onViewDeals,
}: {
  school: string;
  deals: Deal[]; // already filtered to this school
  onClose: () => void;
  onViewDeals: () => void;
}) {
  const stageCounts = useMemo(() => countByStage(deals), [deals]);
  const quarters = useMemo(() => byQuarter(deals), [deals]);

  const stats = useMemo(() => {
    const live = deals.filter((d) => isActive(d.stage)).length;
    const inDiligence = stageCounts["diligence"];
    const decided = stageCounts["passed"] + stageCounts["to-pass"];
    const owners = new Map<string, number>();
    for (const d of deals)
      owners.set(d.owner, (owners.get(d.owner) ?? 0) + 1);
    const topOwners = [...owners.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4);
    const recent = [...deals]
      .sort((a, b) => b.created.localeCompare(a.created))
      .slice(0, 5);
    return {
      total: deals.length,
      live,
      inDiligence,
      diligenceRate:
        deals.length > 0 ? ((inDiligence / deals.length) * 100).toFixed(1) : "0",
      passRate:
        deals.length > 0 ? Math.round((decided / deals.length) * 100) : 0,
      topOwners,
      recent,
    };
  }, [deals, stageCounts]);

  return (
    <div className="card mt-3 border-l-4 !border-l-primary p-6">
      <div className="mb-5 flex items-start justify-between gap-4">
        <div>
          <p className="eyebrow">{crm.tags.singular} detail</p>
          <h3 className="mt-1 text-[28px] font-light text-ink">{school}</h3>
        </div>
        <button
          className="text-sub hover:text-ink"
          onClick={onClose}
          aria-label="Close school detail"
        >
          <Close size={22} />
        </button>
      </div>

      <div className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-5">
        <Stat label="Total deals" value={stats.total.toLocaleString()} />
        <Stat label="Live now" value={stats.live.toLocaleString()} />
        <Stat label="Diligence" value={stats.inDiligence.toLocaleString()} />
        <Stat label="Diligence rate" value={`${stats.diligenceRate}%`} />
        <Stat label="Passed" value={`${stats.passRate}%`} />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <div>
          <h4 className="mb-2 text-[14px] font-semibold text-ink">
            Stage funnel
          </h4>
          <StageFunnelChart byStage={stageCounts} />
        </div>
        <div className="flex flex-col gap-6">
          <div>
            <h4 className="mb-2 text-[14px] font-semibold text-ink">
              Deals added over time
            </h4>
            <MiniTrend quarters={quarters} />
          </div>
          <div>
            <h4 className="mb-2 text-[14px] font-semibold text-ink">
              Deal owners
            </h4>
            <div className="flex flex-wrap gap-2">
              {stats.topOwners.map(([owner, n]) => (
                <span
                  key={owner}
                  className="border border-line bg-bg-soft px-3 py-1.5 text-[13px] text-body"
                  style={{ borderRadius: 0 }}
                >
                  {owner} <span className="font-semibold text-primary">{n}</span>
                </span>
              ))}
            </div>
          </div>
          <div>
            <h4 className="mb-2 text-[14px] font-semibold text-ink">
              Most recent deals
            </h4>
            <div className="flex flex-col">
              {stats.recent.map((d) => (
                <a
                  key={d.gid}
                  href={d.url}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center justify-between gap-3 border-b border-line py-2 last:border-0 hover:text-primary"
                >
                  <span className="truncate text-[13px] font-medium text-ink">
                    {d.name}
                  </span>
                  <span className="flex shrink-0 items-center gap-3">
                    <StagePill stage={d.stage} />
                    <span className="text-[12px] text-faint">
                      {formatDate(d.created)}
                    </span>
                  </span>
                </a>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="mt-6 flex justify-end border-t border-line pt-4">
        <button className="btn-primary flex items-center gap-2" onClick={onViewDeals}>
          See all {stats.total.toLocaleString()} {school} deals
          <ArrowRight size={16} />
        </button>
      </div>
    </div>
  );
}

// Re-export so callers can filter without importing aggregate helpers directly.

