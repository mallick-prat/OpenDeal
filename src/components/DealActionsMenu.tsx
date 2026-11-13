"use client";

import { useEffect, useRef, useState } from "react";
import {
  OverflowMenuHorizontal,
  OverflowMenuVertical,
  Share,
  Time,
  Copy,
  Checkmark,
  Download,
  TrashCan,
} from "@carbon/icons-react";
import type { Deal } from "@/lib/types";
import { schoolColor } from "@/lib/stages";
import { formatDate } from "@/lib/aggregate";
import { Overlay } from "./Overlay";
import { DealHistoryPanel } from "./DealHistoryButton";


/** Split "Founders // Company" into its two halves. */
function splitName(name: string): { founder: string; company: string } {
  const i = name.indexOf("//");
  if (i < 0) return { founder: "", company: name.trim() || "Untitled deal" };
  return {
    founder: name.slice(0, i).trim(),
    company: name.slice(i + 2).trim() || "Untitled deal",
  };
}

/** The "⋯" menu: Share and Activity. `variant="card"` uses vertical dots, a
 *  compact button, and a right-aligned dropdown for the Kanban card corner. */
export function DealActionsMenu({
  deal,
  variant = "modal",
  onDelete,
}: {
  deal: Deal;
  variant?: "modal" | "card";
  /** When provided, the overflow gains a Delete item (spec: not in footer). */
  onDelete?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [panel, setPanel] = useState<null | "share" | "activity">(null);
  const ref = useRef<HTMLDivElement>(null);
  const card = variant === "card";

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const item =
    "flex w-full items-center gap-2.5 px-3 py-2 text-left text-[13px] text-body hover:bg-bg-soft";

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-label="Deal actions"
        aria-haspopup="menu"
        aria-expanded={open}
        className={
          card
            ? "tap flex items-center justify-center p-1 text-sub transition-colors hover:text-primary"
            : "flex h-9 w-9 items-center justify-center rounded-full text-sub hover:bg-bg-soft hover:text-primary"
        }
      >
        {card ? <OverflowMenuVertical size={16} /> : <OverflowMenuHorizontal size={20} />}
      </button>

      {open && (
        <div
          className={`absolute top-full z-40 mt-1 w-44 overflow-hidden rounded-lg border border-line bg-bg py-1 shadow-lg ${
            card ? "right-0" : "left-0"
          }`}
        >
          <button
            className={item}
            onClick={() => {
              setPanel("share");
              setOpen(false);
            }}
          >
            <Share size={16} /> Share
          </button>
          <button
            className={item}
            onClick={() => {
              setPanel("activity");
              setOpen(false);
            }}
          >
            <Time size={16} /> History
          </button>
          {/* Everything on the deal as one zip, structured for AI diligence. */}
          <button
            className={item}
            onClick={() => {
              window.location.href = `/api/deals/${deal.gid}/export`;
              setOpen(false);
            }}
          >
            <Download size={16} /> Export data
          </button>
          {onDelete && (
            <button
              className="flex w-full items-center gap-2.5 border-t border-line px-3 py-2 text-left text-[13px] text-primary hover:bg-bg-soft"
              onClick={() => {
                onDelete();
                setOpen(false);
              }}
            >
              <TrashCan size={16} /> Delete deal…
            </button>
          )}
        </div>
      )}

      {panel === "share" && <SharePanel deal={deal} onClose={() => setPanel(null)} />}
      {panel === "activity" && (
        <DealHistoryPanel gid={deal.gid} name={deal.name} onClose={() => setPanel(null)} />
      )}
    </div>
  );
}

/** A sub-overlay above the deal modal; Escape/backdrop/Close all dismiss it. */

function SharePanel({ deal, onClose }: { deal: Deal; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const { founder, company } = splitName(deal.name);
  const school = deal.schools[0] ?? "";
  const accent = school ? schoolColor(school) : "#101828";
  const financing = [deal.financing, deal.round].filter(Boolean).join(" · ");
  const link =
    typeof window !== "undefined"
      ? `${window.location.origin}/deals/${deal.gid}`
      : `/deals/${deal.gid}`;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  };

  return (
    <Overlay title="Share deal" onClose={onClose}>
      {/* Link-preview card: school color sets the accent. */}
      <div
        className="relative aspect-[1.9/1] w-full overflow-hidden rounded-xl text-white"
        style={{ background: `linear-gradient(135deg, ${accent} 0%, #12100e 92%)` }}
      >
        <div
          className="pointer-events-none absolute -left-10 -top-10 h-40 w-40 rounded-full"
          style={{ background: "radial-gradient(closest-side, rgba(255,255,255,0.28), transparent)" }}
        />
        <div className="relative flex h-full flex-col justify-between p-5">
          <div className="flex items-start justify-between">
            {school ? (
              <span className="rounded-full bg-white/15 px-2.5 py-1 text-[11px] font-semibold backdrop-blur-sm">
                {school}
              </span>
            ) : (
              <span />
            )}
            <span className="text-[13px] font-bold tracking-tight text-white/90">Xf</span>
          </div>
          <div>
            {founder && (
              <div className="mb-1 truncate text-[12px] font-medium text-white/70">{founder}</div>
            )}
            <div className="line-clamp-2 text-[24px] font-light leading-tight">{company}</div>
            <div className="mt-3 flex items-center gap-2 text-[12px] text-white/80">
              {financing && <span className="font-semibold text-white">{financing}</span>}
              {financing && <span className="text-white/40">·</span>}
              <span>{formatDate(deal.created)}</span>
            </div>
          </div>
        </div>
      </div>

      <div className="mt-4 flex items-center gap-2">
        <input
          readOnly
          value={link}
          onFocus={(e) => e.currentTarget.select()}
          className="field min-w-0 flex-1 !py-2 text-[13px] text-sub"
        />
        <button className="btn-primary shrink-0 !text-[13px]" onClick={copy}>
          <span className="flex items-center gap-1.5">
            {copied ? <Checkmark size={16} /> : <Copy size={16} />}
            {copied ? "Copied" : "Copy link"}
          </span>
        </button>
      </div>
      <p className="mt-2 text-[12px] text-faint">
        Anyone on the team with the link opens straight to this deal.
      </p>
    </Overlay>
  );
}

