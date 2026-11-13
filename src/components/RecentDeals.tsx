"use client";

import { Fragment, useMemo, useState } from "react";
import { Attachment, ChevronDown, Edit, Launch } from "@carbon/icons-react";
import type { Deal, StageKey } from "@/lib/types";
import { formatDate } from "@/lib/aggregate";
import { STAGE_BY_KEY } from "@/lib/stages";
import { SchoolChip, StagePill } from "./charts";
import { OwnerAvatar } from "./OwnerPicker";

/** Deep-funnel stages that count as live deals on the home page. */
const LIVE_STAGES = new Set(["elevate", "diligence"]);
const PAGE_SIZE = 10;

export function LiveDeals({
  deals,
  onEdit,
  onOpenCrm,
  onMove,
  stageKeys = [],
  mineFor,
}: {
  deals: Deal[];
  onEdit: (deal: Deal) => void;
  /** Jump to the CRM board focused on this deal's column. */
  onOpenCrm: (deal: Deal) => void;
  /** Move a deal to another stage (optimistic, same handler as the board). */
  onMove?: (gid: string, stage: StageKey) => void;
  /** The board's real columns, in order — the dropdown's option set. */
  stageKeys?: StageKey[];
  /**
   * Contributor mode: instead of the team's Elevate/Diligence view, show THIS
   * member's deals — submitted by them or tagged as an owner — across every
   * stage, so they can follow their opportunities end to end.
   */
  mineFor?: { email: string; name: string };
}) {
  const [page, setPage] = useState(0);
  const [q, setQ] = useState("");
  // One row unfolds at a time — the full record, right in the table.
  const [openGid, setOpenGid] = useState<string | null>(null);
  const live = useMemo(() => {
    const email = mineFor?.email.toLowerCase();
    const pick = mineFor
      ? (d: Deal) =>
          d.createdBy?.toLowerCase() === email ||
          d.owners.some((o) => o.email.toLowerCase() === email) ||
          (mineFor.name !== "" && d.owner === mineFor.name)
      : (d: Deal) => LIVE_STAGES.has(d.stage);
    return deals.filter(pick).sort((a, b) => b.modified.localeCompare(a.modified));
  }, [deals, mineFor]);
  // Filter changes hand us a new array — snap back to the first page.
  const [seenDeals, setSeenDeals] = useState(deals);
  if (seenDeals !== deals) {
    setSeenDeals(deals);
    setPage(0);
  }
  const needle = q.trim().toLowerCase();
  const hits = needle
    ? live.filter((d) =>
        [
          d.name,
          d.note,
          d.stage,
          d.financing,
          d.round,
          d.owner,
          ...d.schools,
          ...d.owners.map((o) => o.name),
        ].some((s) => s?.toLowerCase().includes(needle))
      )
    : live;
  const pageCount = Math.max(1, Math.ceil(hits.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const start = safePage * PAGE_SIZE;
  const visible = hits.slice(start, start + PAGE_SIZE);

  if (live.length === 0) {
    return (
      <div className="flex h-full items-center justify-center border border-line bg-bg p-6 text-center text-[14px] text-sub">
        {mineFor
          ? "No deals yet. Add a deal from the Deals page, or forward a pitch to the inbound mailbox, and it will show up here with its status."
          : `Nothing in ${STAGE_BY_KEY.elevate.label} or ${STAGE_BY_KEY.diligence.label} right now.`}
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col border border-line bg-bg">
      {/* Keep the input mounted while a query is active — otherwise a school
          switch that shrinks the list would strand an invisible filter. */}
      {(live.length > 5 || needle) && (
        <div className="border-b border-line-strong px-4 py-2.5">
          <input
            className="field !h-8 !text-[13px]"
            placeholder="Filter live deals…"
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setPage(0);
            }}
          />
        </div>
      )}
      {hits.length === 0 ? (
        <p className="px-4 py-6 text-[14px] text-sub">
          Nothing matches “{q.trim()}”.
        </p>
      ) : (
      <div className="min-h-0 flex-1 overflow-auto">
      <table className="table w-full table-fixed">
        <thead>
          <tr>
            <th className="w-7">
              <span className="sr-only">Expand</span>
            </th>
            {/* A half-width card is ~650px: only what identifies a deal gets
                a column; school, owner names, and dates live in the expanded
                row. Budgets sum to ~350px so the name always has room. */}
            <th>Deal</th>
            <th className="hidden w-[110px] md:table-cell">Financing</th>
            <th className="hidden w-[118px] sm:table-cell">Stage</th>
            <th className="hidden w-[64px] md:table-cell">Owner</th>
            <th className="w-[44px]">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {visible.map((d) => (
            <Fragment key={d.gid}>
            <tr
              className="cursor-pointer transition-colors hover:bg-bg-soft"
              onClick={() => setOpenGid(openGid === d.gid ? null : d.gid)}
            >
              <td className="!pr-0">
                <ChevronDown
                  size={16}
                  className={`text-sub transition-transform ${openGid === d.gid ? "rotate-180" : ""}`}
                  aria-hidden
                />
              </td>
              <td className="max-w-0">
                <div className="flex items-center gap-1.5">
                  <span className="truncate text-[14px] font-medium text-ink">
                    {d.name || "(untitled)"}
                  </span>
                  {d.attachmentCount > 0 && (
                    <span
                      className="flex shrink-0 items-center gap-0.5 text-[11px] text-faint"
                      title={`${d.attachmentCount} attachment${d.attachmentCount === 1 ? "" : "s"}`}
                    >
                      <Attachment size={13} />
                      {d.attachmentCount}
                    </span>
                  )}
                </div>
                {d.note && (
                  <div className="truncate text-[12px] text-faint">{d.note}</div>
                )}
              </td>
              <td className="hidden text-[12.5px] md:table-cell">
                {d.financing || d.round ? (
                  <span className="block truncate font-medium text-primary">
                    {d.financing ?? ""}
                    {d.financing && d.round ? " · " : ""}
                    {d.round ?? ""}
                  </span>
                ) : (
                  <span className="text-faint">—</span>
                )}
              </td>
              <td className="hidden sm:table-cell">
                {onMove && stageKeys.length > 0 ? (
                  // The stage pill as a control: same swatch color and short
                  // label as everywhere else, chevron says it opens, and an
                  // invisible native select on top does the actual picking.
                  // A move out of Elevate/Diligence drops the row from this
                  // list, exactly like dragging it on the board.
                  <span
                    className="relative inline-flex"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <span
                      className="inline-flex items-center gap-1.5 whitespace-nowrap border border-line bg-bg px-2 py-1 text-[12px] font-medium text-body"
                      title={STAGE_BY_KEY[d.stage]?.label ?? d.stage}
                    >
                      <span
                        className="inline-block h-2 w-2 shrink-0"
                        style={{ background: STAGE_BY_KEY[d.stage]?.color }}
                      />
                      {STAGE_BY_KEY[d.stage]?.short ?? d.stage}
                      <ChevronDown size={12} className="shrink-0 text-sub" aria-hidden />
                    </span>
                    <select
                      className="absolute inset-0 cursor-pointer opacity-0"
                      aria-label={`Stage for ${d.name}`}
                      value={d.stage}
                      onChange={(e) => onMove(d.gid, e.target.value as StageKey)}
                    >
                      {stageKeys.map((k) => (
                        <option key={k} value={k}>
                          {STAGE_BY_KEY[k]?.short ?? k}
                        </option>
                      ))}
                    </select>
                  </span>
                ) : (
                  <StagePill stage={d.stage} short />
                )}
              </td>
              <td className="hidden md:table-cell">
                {d.owners.length > 0 ? (
                  <span
                    className="flex items-center gap-1"
                    title={d.owners.map((o) => o.name).join(", ")}
                  >
                    <OwnerAvatar owner={d.owners[0]} size={22} />
                    {d.owners.length > 1 && (
                      <span className="text-[11px] text-faint">
                        +{d.owners.length - 1}
                      </span>
                    )}
                  </span>
                ) : (
                  <span
                    className="block truncate text-[12px] text-sub"
                    title={d.owner}
                  >
                    {d.owner}
                  </span>
                )}
              </td>
              <td className="whitespace-nowrap !px-2 text-right">
                <button
                  className="p-1.5 align-middle text-sub transition-colors hover:text-primary"
                  title="Edit this deal"
                  aria-label={`Edit ${d.name}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onEdit(d);
                  }}
                >
                  <Edit size={18} />
                </button>
              </td>
            </tr>
            {openGid === d.gid && (
              <tr className="!border-t-0">
                <td colSpan={6} className="!p-0">
                  <div className="border-t border-line bg-bg-soft px-5 py-4">
                    <p className="text-[16px] font-medium text-ink">
                      {d.name || "(untitled)"}
                    </p>
                    {d.note && (
                      <p className="mt-1.5 max-w-3xl whitespace-pre-wrap text-[13px] leading-relaxed text-body">
                        {d.note.length > 700 ? d.note.slice(0, 700) + "…" : d.note}
                      </p>
                    )}
                    <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-2 text-[13px]">
                      <span className="font-medium text-primary">
                        {d.financing || d.round
                          ? `${d.financing ?? ""}${d.financing && d.round ? " · " : ""}${d.round ?? ""}`
                          : "No financing yet"}
                      </span>
                      <StagePill stage={d.stage} />
                      {d.schools.length > 0 && (
                        <span className="flex flex-wrap items-center gap-1">
                          {d.schools.map((sc) => (
                            <SchoolChip key={sc} name={sc} />
                          ))}
                        </span>
                      )}
                      {d.owners.length > 0 ? (
                        <span className="flex items-center gap-1.5 text-sub">
                          {d.owners.map((o) => (
                            <span key={o.email} className="flex items-center gap-1">
                              <OwnerAvatar owner={o} size={20} />
                              {o.name}
                            </span>
                          ))}
                        </span>
                      ) : (
                        <span className="text-sub">{d.owner}</span>
                      )}
                      <span className="text-faint">
                        Last activity {formatDate(d.modified)}
                        {d.attachmentCount > 0 &&
                          ` · ${d.attachmentCount} attachment${d.attachmentCount === 1 ? "" : "s"}`}
                      </span>
                    </div>
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      <button
                        className="border border-primary bg-primary px-3 py-1 text-[13px] font-medium text-white hover:bg-primary-pressed"
                        onClick={() => onEdit(d)}
                      >
                        Open deal
                      </button>
                      <button
                        className="border border-line px-3 py-1 text-[13px] font-medium text-body hover:border-primary"
                        onClick={() => onOpenCrm(d)}
                      >
                        See on the board
                      </button>
                      {d.url && (
                        <a
                          className="inline-flex items-center gap-1 px-1 text-[13px] font-medium text-sub hover:text-primary"
                          href={d.url}
                          target="_blank"
                          rel="noreferrer"
                        >
                          <Launch size={14} /> Link
                        </a>
                      )}
                    </div>
                  </div>
                </td>
              </tr>
            )}
            </Fragment>
          ))}
        </tbody>
      </table>
      </div>
      )}
      {hits.length > PAGE_SIZE && (
        <div className="flex flex-wrap items-center gap-3 border-t border-line-strong bg-bg-soft px-4 py-2.5">
          <span className="text-[13px] text-sub">
            {(start + 1).toLocaleString()}–
            {Math.min(start + PAGE_SIZE, hits.length).toLocaleString()} of{" "}
            {hits.length.toLocaleString()}
          </span>
          <div className="ml-auto flex items-center gap-2">
            <button
              className="tag shrink-0"
              disabled={safePage === 0}
              style={safePage === 0 ? { opacity: 0.4, cursor: "default" } : undefined}
              onClick={() => setPage(Math.max(0, safePage - 1))}
              aria-label="Previous page"
            >
              ←
            </button>
            <span className="whitespace-nowrap text-[13px] text-sub">
              {safePage + 1} / {pageCount}
            </span>
            <button
              className="tag shrink-0"
              disabled={safePage >= pageCount - 1}
              style={safePage >= pageCount - 1 ? { opacity: 0.4, cursor: "default" } : undefined}
              onClick={() => setPage(Math.min(pageCount - 1, safePage + 1))}
              aria-label="Next page"
            >
              →
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
