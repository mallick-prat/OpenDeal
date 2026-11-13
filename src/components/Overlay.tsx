"use client";

import { useEffect } from "react";
import { createPortal } from "react-dom";
import { Close } from "@carbon/icons-react";

/**
 * A centred panel over the whole viewport.
 *
 * Extracted so every deal-level panel shares one implementation.
 *
 * Rendered through a portal, which is load-bearing rather than tidiness:
 * position:fixed is relative to the viewport ONLY while no ancestor has a
 * transform, and the kanban cards are transformed for drag tilt. That turns
 * each card into the containing block, so a "fixed" panel inside one gets
 * pinned to the card and clipped by the column — 32px wide, unreadable.
 * Portalling to <body> leaves that subtree entirely, so no ancestor's
 * transform or overflow can reach it.
 */
export function Overlay({
  title,
  subtitle,
  onClose,
  children,
}: {
  title: string;
  /** Optional context line under the title (counts, dates, what was matched). */
  subtitle?: React.ReactNode;
  onClose: () => void;
  children: React.ReactNode;
}) {
  useEffect(() => {
    // Capture + stop so Escape closes THIS panel, not the deal modal behind it.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopImmediatePropagation();
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  // Portals need a DOM node. Callers only mount this in response to a click,
  // so there's no server pass to mismatch — a plain guard beats mount state.
  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      className="anim-fade fixed inset-0 z-[60] flex items-start justify-center bg-navy/50 p-4 pt-[max(1rem,env(safe-area-inset-top))] sm:items-center"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      // The board underneath is drag-and-drop; a press inside the panel must
      // never be read as picking up a card.
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="card anim-pop max-h-[90dvh] w-full max-w-md overflow-y-auto overscroll-contain bg-bg p-5">
        <div className="mb-3 flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h3 className="text-[16px] font-semibold text-ink">{title}</h3>
            {subtitle && (
              <div className="mt-0.5 text-[12px] text-faint">{subtitle}</div>
            )}
          </div>
          <button
            className="shrink-0 text-sub hover:text-ink"
            onClick={onClose}
            aria-label="Close"
          >
            <Close size={20} />
          </button>
        </div>
        {children}
      </div>
    </div>,
    document.body
  );
}
