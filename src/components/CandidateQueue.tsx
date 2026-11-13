"use client";

import { GranolaMark } from "@/components/GranolaMark";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { bulkIgnoreInboxAction } from "@/app/actions";
import Link from "next/link";
import { Attachment } from "@carbon/icons-react";
import {
  compareCandidates,
  isOpen,
  type CandidateStatus,
  type RankableCandidate,
} from "@/lib/candidatesPure";
import { etDayKey, etShortDate, etTime } from "@/lib/etDates";

/** Serializable card model the /inbox server page hands the client. */
export interface CandidateCard {
  id: string;
  status: CandidateStatus;
  assignedTo: string | null;
  classification: string | null;
  confidence: number | null;
  receivedAt: string | null;
  snoozedUntil: string | null;
  companyName: string | null;
  oneLiner: string | null;
  fromName: string | null;
  fromEmail: string | null;
  subject: string | null;
  round: string | null;
  raiseAmount: string | null;
  deckCount: number;
  attachmentCount: number;
  missing: string[];
  promotedDealGid: string | null;
  /** Founder names from the extraction, comma-joined. */
  founders?: string | null;
  /** Where the item came from — email is the unmarked default. */
  source?: "email" | "calendar" | "granola";
  /** Detail route override (granola notes live at /inbox/note/<id>). */
  href?: string;
}

type Filter = "open" | "mine" | "low" | "done" | "all";

const FILTERS: { key: Filter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "open", label: "Open" },
  { key: "mine", label: "Assigned to me" },
  { key: "low", label: "Low confidence" },
  { key: "done", label: "Reviewed" },
];

function received(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  // "Today" in Eastern, like the labels themselves — comparing runtime-local
  // calendar days made the server pick one branch and the browser the other.
  const sameDay = etDayKey(d) === etDayKey(new Date());
  return sameDay ? etTime(d) : etShortDate(d);
}

/**
 * The pitch queue: underline tabs with counts, a compact search, and dense
 * divider-separated rows. Standalone it links each row to /inbox/<id>; with
 * selectedId/onSelect it is the master list of the split view and swaps the
 * detail panel in place.
 */
export function CandidateQueue({
  items,
  viewerEmail,
  selectedId,
  onSelect,
}: {
  items: CandidateCard[];
  viewerEmail: string;
  selectedId?: string;
  onSelect?: (id: string) => void;
}) {
  const [filter, setFilter] = useState<Filter>("open");
  const [q, setQ] = useState("");
  // Cmd-click (ctrl on Windows) collects rows for a bulk Ignore; ignored
  // rows drop out at once and the server catches up behind.
  const router = useRouter();
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const togglePick = (id: string) =>
    setPicked((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const ignorePicked = async () => {
    if (picked.size === 0 || bulkBusy) return;
    const chosen = items.filter((c) => picked.has(c.id));
    setBulkBusy(true);
    setHidden((cur) => new Set([...cur, ...chosen.map((c) => c.id)]));
    setPicked(new Set());
    await bulkIgnoreInboxAction(
      chosen.map((c) => ({ kind: c.source === "granola" ? ("granola" as const) : ("email" as const), id: c.id }))
    ).catch(() => null);
    setBulkBusy(false);
    router.refresh();
  };

  const matchFilter = (c: CandidateCard, f: Filter): boolean => {
    switch (f) {
      case "open":
        return isOpen(c.status) && c.status !== "snoozed";
      case "mine":
        return (
          isOpen(c.status) &&
          (c.assignedTo ?? "").toLowerCase() === viewerEmail.toLowerCase()
        );
      case "low":
        return isOpen(c.status) && (c.confidence ?? 0) < 0.7;
      case "done":
        return !isOpen(c.status);
      case "all":
        return true;
    }
  };

  const counts = useMemo(() => {
    const m = new Map<Filter, number>();
    for (const f of FILTERS) {
      m.set(f.key, items.filter((c) => matchFilter(c, f.key)).length);
    }
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, viewerEmail]);

  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const rank = (c: CandidateCard): RankableCandidate => ({
      status: c.status,
      assignedTo: c.assignedTo,
      classification: c.classification,
      confidence: c.confidence,
      meetingScheduled: false,
      receivedAt: c.receivedAt,
      snoozedUntil: c.snoozedUntil,
    });
    return items
      .filter((c) => matchFilter(c, filter))
      .filter(
        (c) =>
          !needle ||
          [c.companyName, c.subject, c.fromName, c.fromEmail, c.oneLiner, c.founders].some(
            (s) => s?.toLowerCase().includes(needle)
          )
      )
      .sort((a, b) => compareCandidates(rank(a), rank(b), viewerEmail));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, filter, q, viewerEmail]);

  const Row = ({ c }: { c: CandidateCard }) => {
    const selected = c.id === selectedId;
    const open = isOpen(c.status) && c.status !== "snoozed";
    const lowConf = open && typeof c.confidence === "number" && c.confidence < 0.7;
    const mine = (c.assignedTo ?? "").toLowerCase() === viewerEmail.toLowerCase();
    const body = (
      <>
        <div className="flex items-baseline justify-between gap-3">
          <span
            className={`min-w-0 flex-1 truncate text-[14px] ${
              open ? "font-semibold" : "font-medium"
            } text-ink`}
          >
            {c.companyName || c.subject || "(no subject)"}
          </span>
          {c.source === "granola" && (
            <span className="flex shrink-0 items-center gap-1 border border-line px-1 py-px text-[10.5px] font-medium text-sub" title="From a Granola meeting note">
              <GranolaMark size={10} className="" />
              Granola
            </span>
          )}
          {c.source === "calendar" && (
            <span className="shrink-0 border border-line px-1 py-px text-[10.5px] font-medium text-sub" title="Minted from a calendar meeting">
              Calendar
            </span>
          )}
          <span className="shrink-0 text-[12px] tabular-nums text-faint">
            {received(c.receivedAt)}
          </span>
        </div>
        {(c.founders || c.fromName || c.fromEmail) && (
          <p className="truncate text-[12.5px] text-sub">
            {c.founders || c.fromName || c.fromEmail}
          </p>
        )}
        {c.oneLiner && (
          <p className="truncate text-[12.5px] text-faint">{c.oneLiner}</p>
        )}
        {(lowConf || mine || c.attachmentCount + c.deckCount > 0 || !open) && (
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px]">
            {lowConf && (
              <span className="border border-line px-1 py-px text-sub">
                Low confidence
              </span>
            )}
            {mine && open && (
              <span className="border border-line px-1 py-px text-sub">
                Assigned to me
              </span>
            )}
            {c.attachmentCount + c.deckCount > 0 && (
              <span
                className="flex items-center gap-0.5 text-faint"
                aria-label="Has attachments"
              >
                <Attachment size={11} />
                {c.attachmentCount + c.deckCount}
              </span>
            )}
            {!open && (
              <span className="text-faint">
                {c.status === "approved"
                  ? "On the board"
                  : c.status[0].toUpperCase() + c.status.slice(1).replace("_", " ")}
              </span>
            )}
          </div>
        )}
      </>
    );

    const rowClass = `block w-full px-3 py-2.5 text-left transition-colors ${
      selected
        ? "border-l-2 border-primary bg-bg-soft"
        : "border-l-2 border-transparent hover:bg-bg-soft/60"
    }`;

    // Rows with their own destination (Granola notes) always navigate —
    // the split view's in-pane selection is for email candidates only.
    const pickedRow = picked.has(c.id);
    const pickClass = pickedRow ? " bg-brand-red-50/60 !border-l-primary" : "";
    const onPickClick = (e: React.MouseEvent) => {
      if (e.metaKey || e.ctrlKey) {
        e.preventDefault();
        togglePick(c.id);
        return true;
      }
      return false;
    };
    return onSelect && !c.href ? (
      <button
        type="button"
        className={rowClass + pickClass}
        aria-current={selected ? "true" : undefined}
        aria-pressed={pickedRow || undefined}
        onClick={(e) => {
          if (!onPickClick(e)) onSelect(c.id);
        }}
      >
        {body}
      </button>
    ) : (
      <Link
        href={c.href ?? `/inbox/${c.id}`}
        className={rowClass + pickClass}
        aria-pressed={pickedRow || undefined}
        onClick={(e) => {
          onPickClick(e);
        }}
      >
        {body}
      </Link>
    );
  };

  return (
    <div className="flex min-h-0 flex-col">
      <div className="sticky top-0 z-10 bg-bg">
        {picked.size > 0 && (
          <div className="anim-fade flex items-center gap-3 border-b border-line bg-bg-soft px-2 py-1.5 text-[12.5px]" role="status">
            <span className="font-semibold text-ink">{picked.size} selected</span>
            <button className="btn-secondary tap !h-7 !px-2.5 !text-[12px]" disabled={bulkBusy} onClick={() => void ignorePicked()}>
              {bulkBusy ? "Ignoring…" : "Ignore"}
            </button>
            <button className="text-[12px] font-medium text-sub hover:text-primary" onClick={() => setPicked(new Set())}>
              Clear
            </button>
            <span className="ml-auto text-[11px] text-faint">⌘-click to add more</span>
          </div>
        )}
        <nav
          className="flex min-h-11 flex-wrap items-end gap-x-4 gap-y-1 border-b border-line px-1"
          role="tablist"
          aria-label="Inbox filters"
        >
          {FILTERS.map((f, i) => {
            const n = counts.get(f.key) ?? 0;
            const active = filter === f.key;
            return (
              <span key={f.key} className="flex items-end gap-x-4">
              <button
                role="tab"
                aria-selected={active}
                className={`-mb-px whitespace-nowrap border-b-2 pb-2 text-[13px] font-medium transition-colors ${
                  active
                    ? "border-primary text-primary"
                    : "border-transparent text-sub hover:text-ink"
                }`}
                onClick={() => setFilter(f.key)}
              >
                {f.label}
                {n > 0 && (
                  <span className={`ml-1 tabular-nums ${active ? "" : "text-faint"}`}>
                    {n}
                  </span>
                )}
              </button>
              {i === 0 && (
                <span aria-hidden className="pb-2 text-[13px] text-line-strong">
                  |
                </span>
              )}
              </span>
            );
          })}
        </nav>
        <div className="px-1 py-2">
          <input
            className="field !h-8 w-full !text-[13px]"
            placeholder="Search pitches"
            aria-label="Search pitches"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
      </div>

      {visible.length === 0 ? (
        <p className="px-3 py-6 text-[13px] text-sub">
          {q.trim() ? "No matching pitches." : "No open pitches."}
        </p>
      ) : (
        <ul className="divide-y divide-line">
          {visible.filter((c) => !hidden.has(c.id)).map((c, i) => (
            <li key={c.id} className="row-in" style={{ animationDelay: `${Math.min(i, 12) * 16}ms` }}>
              <Row c={c} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
