"use client";

import { STAGES, STAGE_BY_KEY, schoolColor } from "@/lib/stages";
import type { StageKey } from "@/lib/types";

/** Thin stacked distribution strip used inside school cards. */
export function StageStrip({
  byStage,
  height = 6,
}: {
  byStage: Record<StageKey, number>;
  height?: number;
}) {
  const total = STAGES.reduce((n, s) => n + byStage[s.key], 0);
  if (total === 0) return null;
  return (
    <div
      className="flex w-full overflow-hidden"
      style={{ height, borderRadius: 0 }}
    >
      {STAGES.filter((s) => byStage[s.key] > 0).map((s) => (
        <div
          key={s.key}
          title={`${s.label}: ${byStage[s.key]}`}
          style={{
            width: `${(byStage[s.key] / total) * 100}%`,
            background: s.color,
          }}
        />
      ))}
    </div>
  );
}

export function StagePill({
  stage,
  short = false,
}: {
  stage: StageKey;
  /** Compact label ("Elevate") for tight columns. */
  short?: boolean;
}) {
  const meta = STAGE_BY_KEY[stage];
  return (
    <span
      className="inline-flex items-center gap-1.5 whitespace-nowrap border border-line bg-bg px-2 py-1 text-[12px] font-medium text-body"
      style={{ borderRadius: 0 }}
      title={short ? meta.label : undefined}
    >
      <span
        className="inline-block h-2 w-2"
        style={{ background: meta.color, borderRadius: 0 }}
      />
      {short ? meta.short : meta.label}
    </span>
  );
}

/** Green "Offered" badge — an attribute you mark on a deal, not a stage. */
export function OfferedBadge({ size = "md" }: { size?: "sm" | "md" }) {
  return (
    <span
      className={`inline-flex items-center whitespace-nowrap border font-semibold ${
        size === "sm" ? "px-1.5 py-0.5 text-[10px]" : "px-2 py-0.5 text-[11px]"
      }`}
      style={{ color: "#198038", borderColor: "#198038", background: "#f0f9f3" }}
    >
      Offered
    </span>
  );
}

/** School chip in the school's brand color. */
export function SchoolChip({
  name,
  size = "md",
}: {
  name: string;
  size?: "sm" | "md";
}) {
  const color = schoolColor(name);
  return (
    <span
      className={`whitespace-nowrap border font-medium text-white ${
        size === "sm" ? "px-1.5 py-0.5 text-[11px]" : "px-2 py-0.5 text-[12px]"
      }`}
      style={{ background: color, borderColor: color }}
    >
      {name}
    </span>
  );
}
