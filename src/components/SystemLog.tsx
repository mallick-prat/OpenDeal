"use client";

import { useMemo, useState } from "react";
import { etShortDateTime } from "@/lib/etDates";

export interface SystemEventView {
  id: number;
  level: "debug" | "info" | "warn" | "error";
  source: string;
  message: string;
  detail: Record<string, unknown>;
  duration_ms: number | null;
  created_at: string;
}

const PAGE_SIZE = 10;

const LEVEL_BADGE: Record<string, string> = {
  error: "bg-primary text-white",
  warn: "bg-[#b88746] text-white",
  info: "bg-bg-soft text-body",
  debug: "bg-bg-soft text-faint",
};

export function SystemLog({ rows }: { rows: SystemEventView[] }) {
  const [page, setPage] = useState(0);
  const [level, setLevel] = useState<string>("all");
  const [source, setSource] = useState<string>("all");
  const [newestFirst, setNewestFirst] = useState(true);

  const sources = useMemo(
    () => [...new Set(rows.map((r) => r.source))].sort(),
    [rows]
  );

  const filtered = useMemo(() => {
    let out = rows;
    if (level !== "all") out = out.filter((r) => r.level === level);
    if (source !== "all") out = out.filter((r) => r.source === source);
    // rows arrive newest-first from the server
    return newestFirst ? out : [...out].reverse();
  }, [rows, level, source, newestFirst]);

  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, pages - 1);
  const start = safePage * PAGE_SIZE;

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="flex" role="group" aria-label="Filter by level">
          {["all", "error", "warn", "info"].map((l) => (
            <button
              key={l}
              className={`tag ${l !== "all" ? "-ml-px" : ""} ${level === l ? "active" : ""}`}
              onClick={() => {
                setLevel(l);
                setPage(0);
              }}
            >
              {l}
            </button>
          ))}
        </div>
        <select
          className="field !h-9 !w-auto !text-[13px]"
          value={source}
          onChange={(e) => {
            setSource(e.target.value);
            setPage(0);
          }}
          aria-label="Filter by source"
        >
          <option value="all">All sources</option>
          {sources.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <button
          className="tag"
          onClick={() => {
            setNewestFirst((v) => !v);
            setPage(0);
          }}
        >
          {newestFirst ? "Newest first ↓" : "Oldest first ↑"}
        </button>
        <span className="ml-auto text-[12px] text-faint">
          {filtered.length.toLocaleString()} events
        </span>
      </div>

      <div className="flex flex-col divide-y divide-line">
        {filtered.length === 0 && (
          <p className="py-3 text-[13px] text-sub">Nothing logged yet.</p>
        )}
        {filtered.slice(start, start + PAGE_SIZE).map((r) => {
          const detail = Object.entries(r.detail ?? {})
            .map(([k, v]) => `${k}: ${String(v)}`)
            .join("\n");
          return (
            <div key={r.id} className="py-2.5">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="w-32 shrink-0 text-[12px] tabular-nums text-faint">
                  {etShortDateTime(r.created_at)}
                </span>
                <span
                  className={`shrink-0 px-1.5 py-0.5 text-[10px] font-bold uppercase ${LEVEL_BADGE[r.level] ?? LEVEL_BADGE.info}`}
                >
                  {r.level}
                </span>
                <span className="shrink-0 text-[12px] font-semibold text-sub">
                  {r.source}
                </span>
                <span className="min-w-0 flex-1 truncate text-[13px] text-ink">
                  {r.message}
                </span>
                {r.duration_ms != null && (
                  <span className="shrink-0 text-[12px] tabular-nums text-faint">
                    {r.duration_ms.toLocaleString()} ms
                  </span>
                )}
              </div>
              {detail && (
                <details className="mt-1 sm:ml-32">
                  <summary className="cursor-pointer text-[12px] text-faint hover:text-primary">
                    detail
                  </summary>
                  <pre className="mt-1 overflow-x-auto whitespace-pre-wrap bg-bg-soft p-2 text-[11px] leading-relaxed text-body">
{detail}
                  </pre>
                </details>
              )}
            </div>
          );
        })}
      </div>

      {pages > 1 && (
        <div className="mt-4 flex items-center gap-4 border-t border-line pt-3">
          <button
            className="btn-secondary !h-8 !px-3 !text-[12px]"
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            disabled={safePage === 0}
          >
            ← Back
          </button>
          <span className="text-[12px] text-faint">
            Page {safePage + 1} of {pages}
          </span>
          <button
            className="btn-secondary !h-8 !px-3 !text-[12px]"
            onClick={() => setPage((p) => Math.min(pages - 1, p + 1))}
            disabled={safePage >= pages - 1}
          >
            Next →
          </button>
        </div>
      )}
    </div>
  );
}
