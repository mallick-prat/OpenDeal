"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Attachment, Calendar, Checkmark, TrashCan } from "@carbon/icons-react";
import type { Deal, StageKey } from "@/lib/types";
import { STAGES } from "@/lib/stages";
import { formatDate } from "@/lib/aggregate";
import { etShortDate } from "@/lib/etDates";
import { SchoolChip } from "./charts";
import { DecisionChip } from "./DecisionChip";
import { DealActionsMenu } from "./DealActionsMenu";
import { DealHistoryButton } from "./DealHistoryButton";

const COLUMN_PAGE = 20;
const DRAG_THRESHOLD = 5; // px before a MOUSE press becomes a drag (vs. a click)
const MAX_TILT = 5; // deg — kept deliberately subtle
// Touch: hold this long (finger still) to pick a card up; move sooner = scroll.
const LONG_PRESS_MS = 420;
const TOUCH_MOVE_CANCEL = 12; // px of movement before pickup = the user is scrolling

/** Default seed order before any manual placement: newest first, then name. */
function defaultCmp(a: Deal, b: Deal): number {
  return b.created.localeCompare(a.created) || a.name.localeCompare(b.name);
}

/** The visual body of a card — shared by in-column cards and the drag clone. */
function CardBody({ deal }: { deal: Deal }) {
  return (
    <>
      <div className="text-[13px] font-medium leading-snug text-ink">
        {deal.name || "(untitled)"}
      </div>
      {(deal.financing || deal.round) && (
        <div className="mt-1 text-[12px] font-medium text-primary">
          {deal.financing ?? ""}
          {deal.financing && deal.round ? " · " : ""}
          {deal.round ?? ""}
        </div>
      )}
      {deal.note && (
        <div className="mt-1 line-clamp-2 text-[12px] leading-snug text-faint">
          {deal.note}
        </div>
      )}
      {(deal.decision || deal.schools.length > 0) && (
        <div className="mt-2 flex flex-wrap items-center gap-1">
          <DecisionChip decision={deal.decision} />
          {deal.schools.map((s) => (
            <SchoolChip key={s} name={s} size="sm" />
          ))}
        </div>
      )}
      <div className="mt-2 flex items-center justify-between gap-2 text-[11px] text-faint">
        <span className="truncate">
          {deal.owners.length > 0 ? deal.owners[0].name : deal.owner}
          {deal.owners.length > 1 ? ` +${deal.owners.length - 1}` : ""}
        </span>
        <span className="flex shrink-0 items-center gap-2">
          {deal.nextMeetingAt && (
            <span
              className="flex items-center gap-0.5 text-sub"
              title={`Meeting ${etShortDate(deal.nextMeetingAt)}`}
            >
              <Calendar size={12} />
              {etShortDate(deal.nextMeetingAt)}
            </span>
          )}
          {deal.attachmentCount > 0 && (
            <span
              className="flex items-center gap-0.5"
              title={`${deal.attachmentCount} attachment${deal.attachmentCount === 1 ? "" : "s"}`}
            >
              <Attachment size={12} />
              {deal.attachmentCount}
            </span>
          )}
          {formatDate(deal.created)}
        </span>
      </div>
    </>
  );
}

interface DropSpot {
  stage: StageKey;
  index: number;
}

export function KanbanBoard({
  deals,
  onOpen,
  onMove,
  onBulkMove,
  onBulkDelete,
  onNewInStage,
  stageFilter = null,
  movingGids,
  pinnedGids = [],
  searchActive = false,
  searchKey = "",
  onClearSearch,
}: {
  deals: Deal[];
  onOpen: (deal: Deal) => void;
  onMove: (gid: string, stage: StageKey) => void;
  /** Move several deals to a stage at once (multi-select drag / action bar). */
  onBulkMove?: (gids: string[], stage: StageKey) => void;
  /** Delete several deals at once (multi-select action bar). */
  onBulkDelete?: (gids: string[]) => void;
  onNewInStage: (stage: StageKey) => void;
  stageFilter?: StageKey | null;
  movingGids: Set<string>;
  /** Freshly-created deals, kept at the very top of their column. */
  pinnedGids?: string[];
  /** A search/filter is narrowing the board (used for the no-match state). */
  searchActive?: boolean;
  /** The active query. A CHANGE to this snaps the board to the first hit. */
  searchKey?: string;
  /** Clear the active search from the board-level no-match banner. */
  onClearSearch?: () => void;
}) {
  const [limits, setLimits] = useState<Partial<Record<StageKey, number>>>({});
  // Manual placement — a global gid sequence the user builds by dragging.
  const [manualOrder, setManualOrder] = useState<string[] | null>(null);

  const [dragGid, setDragGid] = useState<string | null>(null);
  const [drop, setDrop] = useState<DropSpot | null>(null);
  const [clone, setClone] = useState<{
    width: number;
    x: number;
    y: number;
    count: number;
  } | null>(null);
  // Multi-select: cmd/ctrl-click toggles, shift-click ranges. Held in a ref too
  // so the pointer-drag closures see the current selection without re-binding.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const selectedRef = useRef(selected);
  useEffect(() => {
    selectedRef.current = selected;
  }, [selected]);
  const anchorRef = useRef<string | null>(null);
  const cloneRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{
    gid: string;
    origin: StageKey;
    /** All gids being dragged (the selection when a selected card is grabbed). */
    group: string[];
    grabX: number;
    grabY: number;
    width: number;
    started: boolean;
    lastX: number;
    vel: number;
    rot: number;
    x: number;
    y: number;
  } | null>(null);
  const rafRef = useRef<number | null>(null);
  // True only while a card is actively being dragged — used to block the
  // browser's touch scrolling for the duration (touch-action stays free so
  // normal swipes scroll the board/column).
  const dragActiveRef = useRef(false);
  const longPressRef = useRef<number | null>(null);
  // The horizontal board scroller + the live pointer, so a held card dragged
  // to the left/right edge auto-scrolls the board to reveal more columns.
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const pointerRef = useRef({ x: 0, y: 0 });

  // Non-passive touchmove: suppress scrolling ONLY while a card is picked up.
  useEffect(() => {
    const onTouchMove = (e: TouchEvent) => {
      if (dragActiveRef.current) e.preventDefault();
    };
    document.addEventListener("touchmove", onTouchMove, { passive: false });
    return () => document.removeEventListener("touchmove", onTouchMove);
  }, []);

  // Freshly-created deals first, then manual placement, then newest-first.
  const orderedDeals = useMemo(() => {
    const pinned = new Map(pinnedGids.map((g, i) => [g, i]));
    const pos = manualOrder
      ? new Map(manualOrder.map((g, i) => [g, i]))
      : null;
    return [...deals].sort((a, b) => {
      const pinA = pinned.has(a.gid) ? pinned.get(a.gid)! : Infinity;
      const pinB = pinned.has(b.gid) ? pinned.get(b.gid)! : Infinity;
      if (pinA !== pinB) return pinA - pinB;
      if (pos) {
        const pa = pos.has(a.gid) ? pos.get(a.gid)! : Infinity;
        const pb = pos.has(b.gid) ? pos.get(b.gid)! : Infinity;
        if (pa !== pb) return pa - pb;
      }
      return defaultCmp(a, b);
    });
  }, [deals, manualOrder, pinnedGids]);

  const stageByGid = useMemo(
    () => new Map(deals.map((d) => [d.gid, d.stage])),
    [deals]
  );

  const columns = useMemo(() => {
    const byStage = new Map<StageKey, Deal[]>(
      STAGES.map((s) => [s.key, [] as Deal[]])
    );
    for (const d of orderedDeals) byStage.get(d.stage)?.push(d);
    return STAGES.filter((s) => !stageFilter || s.key === stageFilter).map(
      (s) => ({ stage: s, deals: byStage.get(s.key)! })
    );
  }, [orderedDeals, stageFilter]);

  // ── Search snaps the board to the leftmost column holding a hit ───────────
  // The board is wider than the viewport, so a match in a right-hand column
  // (Passed/Dead, Offered) is invisible from the left — a search that DID
  // match reads as "no results". Snap once per query, then let go: the user
  // scrolls freely afterwards, and the next query re-arms it.
  const snappedFor = useRef<string | null>(null);
  useEffect(() => {
    const key = searchKey.trim();
    if (!key) {
      snappedFor.current = null; // cleared search re-arms the snap
      return;
    }
    if (snappedFor.current === key) return; // already snapped for this query

    // Claim the query only once we've actually snapped. The filtered columns
    // land a render after the query does (useDeferredValue), so the first pass
    // can legitimately find no hit — marking it snapped there would swallow
    // the real one when it arrives.
    const hit = columns.find((c) => c.deals.length > 0);
    const sc = scrollerRef.current;
    if (!hit || !sc) return;
    const col = sc.querySelector<HTMLElement>(`[data-stage="${hit.stage.key}"]`);
    if (!col) return;
    snappedFor.current = key;

    // Measure against the scroller rather than offsetParent — the column's
    // positioning ancestor isn't guaranteed to be the scroll container.
    const left =
      col.getBoundingClientRect().left -
      sc.getBoundingClientRect().left +
      sc.scrollLeft;
    const target = Math.max(0, left - 12);
    sc.scrollTo({ left: target, behavior: "smooth" });
    // Smooth scrolling is silently a no-op in some environments (embedded
    // panes, reduced-motion, zero-height layout) — the call returns and
    // nothing moves. Land the position outright if the animation didn't take.
    const settle = window.setTimeout(() => {
      if (Math.abs(sc.scrollLeft - target) > 8) sc.scrollLeft = target;
    }, 400);

    // Brief ring so it's obvious where we landed. Applied to the DOM directly
    // so the effect stays render-free (no state, no re-entrant scroll).
    col.classList.add("ring-2", "ring-primary");
    const t = window.setTimeout(
      () => col.classList.remove("ring-2", "ring-primary"),
      1400
    );
    return () => {
      window.clearTimeout(settle);
      window.clearTimeout(t);
    };
  }, [searchKey, columns]);

  const toggleSelect = (gid: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(gid)) next.delete(gid);
      else next.add(gid);
      return next;
    });
    anchorRef.current = gid;
  };
  // Shift-range stays WITHIN one column: never let a range sweep up cards in
  // other columns. If the anchor is in a different column (or missing), this
  // just toggles the clicked card.
  const rangeSelect = (gid: string) => {
    const a = anchorRef.current;
    const stageA = a ? stageByGid.get(a) : undefined;
    const stageB = stageByGid.get(gid);
    if (!a || !stageA || stageA !== stageB) {
      toggleSelect(gid);
      return;
    }
    const col = columns.find((c) => c.stage.key === stageA);
    const order = (col?.deals ?? []).map((d) => d.gid);
    const i = order.indexOf(a);
    const j = order.indexOf(gid);
    if (i < 0 || j < 0) {
      toggleSelect(gid);
      return;
    }
    const [lo, hi] = i < j ? [i, j] : [j, i];
    setSelected((prev) => {
      const next = new Set(prev);
      for (let k = lo; k <= hi; k++) next.add(order[k]);
      return next;
    });
  };
  const clearSelection = () => setSelected(new Set());

  // Esc clears the selection.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSelected((s) => (s.size ? new Set() : s));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const computeDrop = (clientX: number, clientY: number): DropSpot | null => {
    const colEl = document
      .elementFromPoint(clientX, clientY)
      ?.closest<HTMLElement>("[data-stage]");
    if (!colEl) return null;
    const stage = colEl.dataset.stage as StageKey;
    const cards = [...colEl.querySelectorAll<HTMLElement>("[data-card]")];
    let index = cards.length;
    for (let i = 0; i < cards.length; i++) {
      const r = cards[i].getBoundingClientRect();
      if (clientY < r.top + r.height / 2) {
        index = i;
        break;
      }
    }
    return { stage, index };
  };

  // Continuous tilt loop (+ edge auto-scroll): relaxes rotation toward 0 as
  // motion slows, and scrolls the board when a held card nears an edge.
  useEffect(() => {
    if (!dragGid) return;
    const EDGE = 64; // px hot-zone at each board edge
    const MAX_SPEED = 20; // px per frame at the very edge
    const tick = () => {
      const d = dragRef.current;
      const el = cloneRef.current;
      if (d && el) {
        d.vel *= 0.86;
        d.rot = Math.max(-MAX_TILT, Math.min(MAX_TILT, d.rot * 0.8 + d.vel * 0.35));
        el.style.transform = `translate(${d.x}px, ${d.y}px) rotate(${d.rot.toFixed(2)}deg)`;
      }
      // Auto-scroll the board while a held card sits near either edge.
      const sc = scrollerRef.current;
      if (d && sc) {
        const r = sc.getBoundingClientRect();
        const { x, y } = pointerRef.current;
        let dv = 0;
        if (x < r.left + EDGE) dv = -MAX_SPEED * Math.min(1, (r.left + EDGE - x) / EDGE);
        else if (x > r.right - EDGE) dv = MAX_SPEED * Math.min(1, (x - (r.right - EDGE)) / EDGE);
        if (dv) {
          const before = sc.scrollLeft;
          sc.scrollLeft += dv;
          // Columns slid under the finger — refresh where the drop would land.
          if (sc.scrollLeft !== before) setDrop(computeDrop(x, y));
        }
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [dragGid]);

  /** Place a card at exactly the dropped position and persist any stage change. */
  const handleDrop = (gid: string, target: DropSpot) => {
    const originStage = stageByGid.get(gid);
    const col = columns.find((c) => c.stage.key === target.stage);
    const listGids = (col?.deals ?? [])
      .map((d) => d.gid)
      .filter((g) => g !== gid);
    const refGid = listGids[target.index];

    const order = orderedDeals.map((d) => d.gid).filter((g) => g !== gid);
    if (refGid) {
      order.splice(order.indexOf(refGid), 0, gid);
    } else {
      // Dropped at the end of the column — sit after the last same-stage card.
      let lastIdx = -1;
      for (let i = 0; i < order.length; i++) {
        if (stageByGid.get(order[i]) === target.stage) lastIdx = i;
      }
      if (lastIdx >= 0) order.splice(lastIdx + 1, 0, gid);
      else order.push(gid);
    }
    setManualOrder(order);
    if (originStage !== target.stage) onMove(gid, target.stage);
  };

  /** Drop a whole multi-select cluster into a stage (moves every card in it). */
  const handleGroupDrop = (gids: string[], stage: StageKey) => {
    const toMove = gids.filter((g) => stageByGid.get(g) !== stage);
    if (toMove.length === 0) return;
    if (onBulkMove) onBulkMove(toMove, stage);
    else for (const g of toMove) onMove(g, stage);
    clearSelection();
  };

  const onPointerDownCard = (e: React.PointerEvent, deal: Deal) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    // Modifier-click is selection, not drag/open: cmd/ctrl toggles one, shift
    // extends a range. Handled up front so it never starts a drag.
    if (e.metaKey || e.ctrlKey) {
      // Toggle exactly this one card; never start a drag or bubble further.
      e.preventDefault();
      e.stopPropagation();
      toggleSelect(deal.gid);
      return;
    }
    if (e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      rangeSelect(deal.gid);
      return;
    }
    const isTouch = e.pointerType === "touch";
    const card = e.currentTarget as HTMLElement;
    const rect = card.getBoundingClientRect();
    const startX = e.clientX;
    const startY = e.clientY;
    const pointerId = e.pointerId;
    // Grabbing a selected card drags the whole selection as a cluster.
    const sel = selectedRef.current;
    const group = sel.has(deal.gid) && sel.size > 1 ? [...sel] : [deal.gid];
    dragRef.current = {
      gid: deal.gid,
      origin: deal.stage,
      group,
      grabX: e.clientX - rect.left,
      grabY: e.clientY - rect.top,
      width: rect.width,
      started: false,
      lastX: e.clientX,
      vel: 0,
      rot: 0,
      x: rect.left,
      y: rect.top,
    };
    let moved = false; // finger travelled before pickup ⇒ this was a scroll

    const clearLongPress = () => {
      if (longPressRef.current) {
        clearTimeout(longPressRef.current);
        longPressRef.current = null;
      }
    };

    // Pick the card up: on touch this is the long-press payoff (with a haptic
    // tick); on mouse it fires as soon as the pointer crosses the drag threshold.
    const activate = () => {
      const d = dragRef.current;
      if (!d || d.started) return;
      clearLongPress();
      d.started = true;
      dragActiveRef.current = true;
      if (isTouch && typeof navigator !== "undefined" && navigator.vibrate) {
        navigator.vibrate(25); // Android/most; iOS Safari ignores it (no web haptics)
      }
      setDragGid(d.gid);
      setClone({ width: d.width, x: d.x, y: d.y, count: d.group.length });
      try {
        card.setPointerCapture(pointerId);
      } catch {
        // capture is best-effort
      }
    };

    if (isTouch) longPressRef.current = window.setTimeout(activate, LONG_PRESS_MS);

    const move = (ev: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      pointerRef.current = { x: ev.clientX, y: ev.clientY };
      if (!d.started) {
        const dx = Math.abs(ev.clientX - startX);
        const dy = Math.abs(ev.clientY - startY);
        if (isTouch) {
          // Movement before the long-press fires means the user is scrolling —
          // stand down and let the browser scroll the board/column.
          if (dx > TOUCH_MOVE_CANCEL || dy > TOUCH_MOVE_CANCEL) {
            moved = true;
            clearLongPress();
          }
          return;
        }
        if (dx < DRAG_THRESHOLD && dy < DRAG_THRESHOLD) return;
        activate();
      }
      const dxv = ev.clientX - d.lastX;
      d.vel = d.vel * 0.6 + dxv * 0.4;
      d.lastX = ev.clientX;
      d.x = ev.clientX - d.grabX;
      d.y = ev.clientY - d.grabY;
      setDrop(computeDrop(ev.clientX, ev.clientY));
    };

    const teardown = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      clearLongPress();
      dragActiveRef.current = false;
    };

    const up = (ev: PointerEvent) => {
      const d = dragRef.current;
      const wasDragging = !!d?.started;
      teardown();
      dragRef.current = null;
      setDragGid(null);
      setDrop(null);
      setClone(null);
      if (!d) return;
      if (!wasDragging) {
        // A clean tap (no scroll, no pickup) opens the deal.
        if (!moved) onOpen(deal);
        return;
      }
      const target = computeDrop(ev.clientX, ev.clientY);
      if (target) {
        if (d.group.length > 1) handleGroupDrop(d.group, target.stage);
        else handleDrop(d.gid, target);
      }
    };

    const cancel = () => {
      teardown();
      dragRef.current = null;
      setDragGid(null);
      setDrop(null);
      setClone(null);
    };

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
  };

  const draggedDeal = dragGid
    ? deals.find((d) => d.gid === dragGid) ?? null
    : null;

  return (
    <div>
      {selected.size > 0 && (
        <div className="sticky top-0 z-30 mb-2 flex flex-wrap items-center gap-2 rounded-lg border border-primary bg-red-50 px-3 py-2">
          <span className="text-[13px] font-semibold text-primary">
            {selected.size} selected
          </span>
          <span className="mx-1 h-4 w-px bg-line" />
          <label className="flex items-center gap-1.5 text-[12px] text-body">
            Move to
            <select
              className="rounded border border-line bg-bg px-2 py-1 text-[12px]"
              value=""
              onChange={(e) => {
                const st = e.target.value as StageKey;
                if (st) handleGroupDrop([...selected], st);
              }}
            >
              <option value="">Choose stage…</option>
              {STAGES.map((s) => (
                <option key={s.key} value={s.key}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
          {onBulkDelete && (
            <button
              className="inline-flex items-center gap-1 rounded border border-line bg-bg px-2.5 py-1 text-[12px] font-medium text-body hover:border-primary hover:text-primary"
              onClick={() => {
                if (
                  typeof window !== "undefined" &&
                  window.confirm(`Delete ${selected.size} deal(s)? This can't be undone.`)
                ) {
                  onBulkDelete([...selected]);
                  clearSelection();
                }
              }}
            >
              <TrashCan size={14} /> Delete
            </button>
          )}
          <button
            className="ml-auto text-[12px] font-medium text-sub hover:text-primary"
            onClick={clearSelection}
          >
            Clear
          </button>
        </div>
      )}
      {searchActive && deals.length === 0 && (
        <div className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-line bg-bg-soft px-4 py-3 text-[13px]">
          <span className="font-semibold text-ink">
            No deals match your search or filters.
          </span>
          <span className="text-sub">The columns below are empty for now.</span>
          {onClearSearch && (
            <button
              className="font-medium text-primary hover:text-primary-pressed"
              onClick={onClearSearch}
            >
              Clear all
            </button>
          )}
        </div>
      )}
      <div ref={scrollerRef} className="overflow-x-auto pb-4">
        <div className="flex gap-3" style={{ minWidth: "max-content" }}>
          {columns.map(({ stage, deals: colDeals }) => {
            const limit = limits[stage.key] ?? COLUMN_PAGE;
            const visible = colDeals.slice(0, limit);
            const isDropCol = drop?.stage === stage.key && dragGid;
            return (
              <div
                key={stage.key}
                data-stage={stage.key}
                className={`flex w-72 shrink-0 flex-col border bg-bg-soft transition-colors ${
                  isDropCol ? "border-primary" : "border-line"
                }`}
              >
                <div
                  className="flex items-center justify-between gap-2 border-b border-line bg-bg px-3 py-2.5"
                  style={{ borderTop: `3px solid ${stage.color}` }}
                >
                  <span className="text-[13px] font-semibold text-ink">
                    {stage.label}
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span className="text-[12px] font-medium text-sub">
                      {colDeals.length.toLocaleString()}
                    </span>
                    <button
                      className="tap flex h-5 w-5 items-center justify-center border border-line text-[14px] leading-none text-sub transition-colors hover:border-primary hover:text-primary"
                      title={`New deal in ${stage.label}`}
                      aria-label={`New deal in ${stage.label}`}
                      onClick={() => onNewInStage(stage.key)}
                    >
                      +
                    </button>
                  </span>
                </div>
                <div className="flex max-h-[62vh] flex-col gap-2 overflow-y-auto p-2">
                  {visible.map((d, i) => (
                    <div key={d.gid} className="contents">
                      {isDropCol && drop!.index === i && <DropGap />}
                      <div
                        data-card
                        onPointerDown={(e) => onPointerDownCard(e, d)}
                        className={`card card-lift group relative cursor-grab select-none p-3 transition-[opacity,transform] ${
                          dragGid === d.gid ||
                          (dragGid !== null && selected.size > 1 && selected.has(dragGid) && selected.has(d.gid))
                            ? "scale-[1.02] opacity-30"
                            : ""
                        } ${
                          selected.has(d.gid)
                            ? "outline outline-2 outline-primary"
                            : ""
                        }`}
                        role="button"
                        aria-label={`Open ${d.name}`}
                      >
                        {selected.has(d.gid) && (
                          <span className="absolute -left-1.5 -top-1.5 z-10 flex h-4 w-4 items-center justify-center rounded-full bg-primary text-white">
                            <Checkmark size={12} />
                          </span>
                        )}
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0 flex-1">
                            <CardBody deal={d} />
                          </div>
                          {/* History · vertical ⋯ (Share/Activity).
                              The row stops pointerdown so none start a drag. */}
                          <div
                            className={`flex shrink-0 items-center gap-0.5 transition-opacity ${
                              // Hover reveals on desktop; touch screens have no
                              // hover, so the actions stay visible there.
                              "opacity-0 group-hover:opacity-100 [@media(hover:none)]:opacity-100"
                            }`}
                            onPointerDown={(e) => e.stopPropagation()}
                          >
                            <DealHistoryButton gid={d.gid} name={d.name} />
                            <DealActionsMenu deal={d} variant="card" />
                          </div>
                        </div>
                        {movingGids.has(d.gid) && (
                          <div className="mt-1 text-[11px] text-primary">
                            Saving…
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                  {isDropCol && drop!.index >= visible.length && <DropGap />}
                  {colDeals.length === 0 && !isDropCol && (
                    <div className="p-3 text-center text-[12px] text-faint">
                      No deals
                    </div>
                  )}
                  {colDeals.length > limit && (
                    <button
                      className="tag justify-center"
                      onClick={() =>
                        setLimits({
                          ...limits,
                          [stage.key]: limit + COLUMN_PAGE,
                        })
                      }
                    >
                      Show {Math.min(COLUMN_PAGE, colDeals.length - limit)} more
                      of {(colDeals.length - limit).toLocaleString()}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Floating tilt clone that follows the cursor. Portaled to <body>:
          any transformed ancestor (e.g. the view fade-in wrapper) would
          otherwise hijack position:fixed and shove the clone sideways. */}
      {draggedDeal &&
        clone &&
        createPortal(
          <div
            ref={cloneRef}
            className="pointer-events-none fixed left-0 top-0 z-50"
            style={{
              width: clone.width,
              transform: `translate(${clone.x}px, ${clone.y}px)`,
            }}
          >
            {/* Stacked "cluster" backing cards when dragging a multi-selection. */}
            {clone.count > 1 && (
              <>
                <div className="absolute inset-0 translate-x-2 translate-y-2 border border-primary/40 bg-bg" />
                <div className="absolute inset-0 translate-x-1 translate-y-1 border border-primary/60 bg-bg" />
              </>
            )}
            <div className="relative border border-primary bg-bg p-3 shadow-lg">
              <CardBody deal={draggedDeal} />
              {clone.count > 1 && (
                <span className="absolute -right-2 -top-2 flex h-6 min-w-6 items-center justify-center rounded-full bg-primary px-1.5 text-[12px] font-bold text-white shadow">
                  {clone.count}
                </span>
              )}
            </div>
          </div>,
          document.body
        )}
    </div>
  );
}

/** The shaded slot that opens between cards to show where the drop lands. */
function DropGap() {
  return (
    <div className="h-16 border border-dashed border-primary bg-red-50" />
  );
}
