"use client";

import { crm } from "@/config/crm.config";
import { useMemo, useState } from "react";
import { Edit, Launch } from "@carbon/icons-react";
import type { Deal } from "@/lib/types";
import { STAGE_BY_KEY } from "@/lib/stages";
import { formatDate } from "@/lib/aggregate";
import { SchoolChip, StagePill } from "./charts";
import { DecisionChip } from "./DecisionChip";
import { OwnerAvatar } from "./OwnerPicker";

const PAGE = 40;

/** A deal is "stale" if nothing has touched it in this many days. */
const STALE_DAYS = 30;
function daysSince(iso: string): number {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return 0;
  return Math.floor((Date.now() - t) / 86_400_000);
}
/** Only live-pipeline deals can go "stale" — passed/dead deals sit by design. */
function isLive(stage: Deal["stage"]): boolean {
  return STAGE_BY_KEY[stage]?.active ?? false;
}

type ColumnKey = "name" | "school" | "stage" | "owner" | "activity";

const COLUMN_SORTERS: Record<ColumnKey, (a: Deal, b: Deal) => number> = {
  name: (a, b) => a.name.localeCompare(b.name),
  school: (a, b) =>
    (a.schools[0] ?? "zzz").localeCompare(b.schools[0] ?? "zzz"),
  stage: (a, b) =>
    STAGE_BY_KEY[a.stage].order - STAGE_BY_KEY[b.stage].order,
  owner: (a, b) => a.owner.localeCompare(b.owner),
  activity: (a, b) => a.modified.localeCompare(b.modified),
};

function SortHeader({
  label,
  col,
  sortKey,
  dir,
  onSort,
  className = "",
}: {
  label: string;
  col: ColumnKey;
  sortKey: ColumnKey;
  dir: 1 | -1;
  onSort: (col: ColumnKey) => void;
  className?: string;
}) {
  const isActive = sortKey === col;
  const alignRight = className.includes("text-right");
  return (
    <th
      className={`px-4 py-3 align-middle ${className}`}
      aria-sort={isActive ? (dir === 1 ? "ascending" : "descending") : "none"}
    >
      <button
        className={`inline-flex items-center gap-1 text-[12px] font-semibold uppercase tracking-wide outline-none transition-colors hover:text-primary focus-visible:text-primary ${
          isActive ? "text-primary" : "text-sub"
        } ${alignRight ? "flex-row-reverse" : ""}`}
        onClick={() => onSort(col)}
        title={`Sort by ${label.toLowerCase()}`}
      >
        {label}
        <span className="inline-block w-2.5 text-[9px] leading-none">
          {isActive ? (dir === 1 ? "▲" : "▼") : ""}
        </span>
      </button>
    </th>
  );
}

export function DealTable({
  deals,
  onEdit,
}: {
  deals: Deal[];
  onEdit: (deal: Deal) => void;
}) {
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(PAGE);
  const [sortKey, setSortKey] = useState<ColumnKey>("activity");
  const [dir, setDir] = useState<1 | -1>(-1); // most-recently-active first

  // Changing filters hands us a new deals array — jump back to page 1.
  const [seenDeals, setSeenDeals] = useState(deals);
  if (seenDeals !== deals) {
    setSeenDeals(deals);
    setPage(0);
  }

  const onSort = (col: ColumnKey) => {
    if (col === sortKey) {
      setDir(dir === 1 ? -1 : 1);
    } else {
      setSortKey(col);
      setDir(col === "activity" ? -1 : 1);
    }
    setPage(0);
  };

  const sorted = useMemo(() => {
    const base = COLUMN_SORTERS[sortKey];
    return [...deals].sort((a, b) => dir * base(a, b));
  }, [deals, sortKey, dir]);

  const pageCount = Math.max(1, Math.ceil(sorted.length / pageSize));
  const safePage = Math.min(page, pageCount - 1);
  const start = safePage * pageSize;
  const visible = sorted.slice(start, start + pageSize);

  return (
    <div className="card-flat overflow-hidden">
      {/* Mobile: a card per deal, so the key fields aren't hidden columns. */}
      <ul className="divide-y divide-line md:hidden">
        {visible.map((d) => (
          <li key={d.gid}>
            <button
              className="tap flex w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-bg-soft"
              onClick={() => onEdit(d)}
            >
              <div className="min-w-0 flex-1">
                <div className="truncate text-[14px] font-medium text-ink">
                  {d.name || "(untitled)"}
                </div>
                {d.note && (
                  <div className="truncate text-[12px] text-faint">{d.note}</div>
                )}
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                  <StagePill stage={d.stage} />
                  <DecisionChip decision={d.decision} />
                  {d.schools.map((s) => (
                    <SchoolChip key={s} name={s} size="sm" />
                  ))}
                </div>
                <div className="mt-1.5 flex items-center gap-2 text-[12px] text-sub">
                  {d.owners.length > 0 && (
                    <span className="flex items-center gap-1">
                      <OwnerAvatar owner={d.owners[0]} size={18} />
                      {d.owners[0].name}
                      {d.owners.length > 1 && (
                        <span className="text-faint">+{d.owners.length - 1}</span>
                      )}
                    </span>
                  )}
                  <span className="text-faint">Updated {formatDate(d.modified)}</span>
                  {isLive(d.stage) && daysSince(d.modified) >= STALE_DAYS && (
                    <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-700">
                      {daysSince(d.modified)}d
                    </span>
                  )}
                </div>
              </div>
              {d.url && (
                <a
                  className="tap -mr-1 mt-0.5 flex shrink-0 items-center text-sub transition-colors hover:text-primary"
                  title="Open linked page"
                  href={d.url}
                  target="_blank"
                  rel="noreferrer"
                  onClick={(e) => e.stopPropagation()}
                >
                  <Launch size={18} />
                </a>
              )}
            </button>
          </li>
        ))}
      </ul>

      <table className="hidden w-full md:table">
        <thead>
          <tr className="border-b border-line-strong bg-bg-soft text-left">
            <SortHeader label="Deal" col="name" sortKey={sortKey} dir={dir} onSort={onSort} />
            <SortHeader label={crm.tags.singular} col="school" sortKey={sortKey} dir={dir} onSort={onSort} className="hidden md:table-cell" />
            <SortHeader label="Stage" col="stage" sortKey={sortKey} dir={dir} onSort={onSort} />
            <SortHeader label="Owner" col="owner" sortKey={sortKey} dir={dir} onSort={onSort} className="hidden lg:table-cell" />
            <SortHeader label="Updated" col="activity" sortKey={sortKey} dir={dir} onSort={onSort} className="hidden text-right sm:table-cell" />
            <th className="px-2 py-3 text-right">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {visible.map((d) => (
            <tr
              key={d.gid}
              className="cursor-pointer border-b border-line transition-colors last:border-0 hover:bg-bg-soft"
              onClick={() => onEdit(d)}
            >
              <td className="max-w-0 px-4 py-3.5 align-middle" style={{ width: "40%" }}>
                <div className="truncate text-[14px] font-medium text-ink">
                  {d.name || "(untitled)"}
                </div>
                {d.note && (
                  <div className="truncate text-[12px] text-faint">
                    {d.note}
                  </div>
                )}
                <div className="mt-1 flex flex-wrap gap-1 md:hidden">
                  {d.schools.map((s) => (
                    <SchoolChip key={s} name={s} size="sm" />
                  ))}
                </div>
              </td>
              <td className="hidden px-4 py-3.5 align-middle md:table-cell">
                <div className="flex flex-wrap gap-1">
                  {d.schools.map((s) => (
                    <SchoolChip key={s} name={s} />
                  ))}
                </div>
              </td>
              <td className="px-4 py-3.5 align-middle">
                <div className="flex flex-wrap items-center gap-1.5">
                  <StagePill stage={d.stage} />
                  <DecisionChip decision={d.decision} />
                </div>
              </td>
              <td className="hidden whitespace-nowrap px-4 py-3.5 align-middle text-[13px] text-sub lg:table-cell">
                {d.owners.length > 0 ? (
                  <span className="flex items-center gap-1.5">
                    <OwnerAvatar owner={d.owners[0]} size={22} />
                    {d.owners[0].name}
                    {d.owners.length > 1 && (
                      <span className="text-faint">+{d.owners.length - 1}</span>
                    )}
                  </span>
                ) : (
                  d.owner
                )}
              </td>
              <td className="hidden whitespace-nowrap px-4 py-3.5 align-middle text-right text-[13px] text-sub sm:table-cell">
                {formatDate(d.modified)}
                {isLive(d.stage) && daysSince(d.modified) >= STALE_DAYS && (
                  <span
                    className="ml-1.5 inline-block rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 align-middle"
                    title={`No activity in ${daysSince(d.modified)} days`}
                  >
                    {daysSince(d.modified)}d
                  </span>
                )}
              </td>
              <td className="whitespace-nowrap px-2 py-2.5 align-middle text-right">
                <button
                  className="p-1.5 text-sub transition-colors hover:text-primary"
                  title="Edit this deal"
                  onClick={(e) => {
                    e.stopPropagation();
                    onEdit(d);
                  }}
                >
                  <Edit size={18} />
                </button>
                {d.url && (
                <a
                  className="inline-block p-1.5 align-middle text-sub transition-colors hover:text-primary"
                  title="Open linked page"
                  href={d.url}
                  target="_blank"
                  rel="noreferrer"
                  onClick={(e) => e.stopPropagation()}
                >
                  <Launch size={18} />
                </a>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {sorted.length === 0 && (
        <div className="p-10 text-center text-sub">
          No deals match these filters.
        </div>
      )}
      {sorted.length > 0 && (
        <div className="flex flex-wrap items-center gap-3 border-t border-line-strong bg-bg-soft px-4 py-2.5">
          <span className="text-[13px] text-sub">
            Showing {(start + 1).toLocaleString()}–
            {Math.min(start + pageSize, sorted.length).toLocaleString()} of{" "}
            {sorted.length.toLocaleString()}
          </span>
          <label className="flex items-center gap-2 text-[13px] text-sub">
            Rows per page
            <select
              className="border border-line bg-bg px-2 py-1.5 text-[13px] text-ink outline-none focus:border-primary"
              value={pageSize}
              onChange={(e) => {
                setPageSize(Number(e.target.value));
                setPage(0);
              }}
            >
              <option value={20}>20</option>
              <option value={40}>40</option>
              <option value={100}>100</option>
            </select>
          </label>
          <div className="ml-auto flex items-center gap-2">
            <button
              className="tag"
              disabled={safePage === 0}
              style={safePage === 0 ? { opacity: 0.4, cursor: "default" } : undefined}
              onClick={() => setPage(Math.max(0, safePage - 1))}
            >
              ← Previous
            </button>
            <span className="whitespace-nowrap text-[13px] text-sub">
              Page {safePage + 1} of {pageCount.toLocaleString()}
            </span>
            <button
              className="tag"
              disabled={safePage >= pageCount - 1}
              style={
                safePage >= pageCount - 1
                  ? { opacity: 0.4, cursor: "default" }
                  : undefined
              }
              onClick={() => setPage(Math.min(pageCount - 1, safePage + 1))}
            >
              Next →
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
