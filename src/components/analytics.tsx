"use client";

import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { StageKey } from "@/lib/types";
import { STAGES } from "@/lib/stages";
import type { QuarterCount } from "@/lib/aggregate";

const AXIS = { fontSize: 12, fill: "#8a837c" };
const TOOLTIP_STYLE: React.CSSProperties = {
  background: "#ffffff",
  border: "1px solid #e7e4df",
  borderRadius: 0,
  fontSize: 13,
  boxShadow: "0 8px 24px rgba(16,24,40,0.12)",
};

/** Pipeline funnel as horizontal bars, one per stage. */
export function StageFunnelChart({
  byStage,
}: {
  byStage: Record<StageKey, number>;
}) {
  const rows = STAGES.map((s) => ({
    stage: s.label,
    count: byStage[s.key],
    color: s.color,
  }));
  return (
    <ResponsiveContainer width="100%" height={rows.length * 36 + 40}>
      <BarChart data={rows} layout="vertical" margin={{ left: 8, right: 40 }}>
        <CartesianGrid horizontal={false} stroke="#e7e4df" />
        <XAxis type="number" tick={AXIS} axisLine={false} tickLine={false} />
        <YAxis
          type="category"
          dataKey="stage"
          width={130}
          tick={{ fontSize: 13, fill: "#171717" }}
          axisLine={false}
          tickLine={false}
        />
        <Tooltip contentStyle={TOOLTIP_STYLE} cursor={{ fill: "#fafafa" }} />
        <Bar
          dataKey="count"
          name="Deals"
          barSize={15}
          label={{ position: "right", fontSize: 12, fontWeight: 600, fill: "#171717" }}
        >
          {rows.map((r) => (
            <Cell key={r.stage} fill={r.color} stroke="#e7e4df" />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

/** Compact quarterly trend used inside the school detail panel. */
export function MiniTrend({ quarters }: { quarters: QuarterCount[] }) {
  return (
    <ResponsiveContainer width="100%" height={160}>
      <LineChart data={quarters} margin={{ left: 0, right: 8, top: 8 }}>
        <CartesianGrid vertical={false} stroke="#e7e4df" />
        <XAxis
          dataKey="label"
          tick={{ ...AXIS, fontSize: 10 }}
          axisLine={false}
          tickLine={false}
          interval={3}
        />
        <YAxis
          tick={{ ...AXIS, fontSize: 10 }}
          axisLine={false}
          tickLine={false}
          width={26}
          allowDecimals={false}
        />
        <Tooltip contentStyle={TOOLTIP_STYLE} />
        <Line
          type="monotone"
          dataKey="count"
          name="Deals added"
          stroke="var(--brand-red-500)"
          strokeWidth={2}
          dot={false}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}

