"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Checkmark, ChevronDown } from "@carbon/icons-react";
import { OwnerAvatar } from "./OwnerPicker";

/**
 * The owner filter as a real control: faces, counts, multi-select. The
 * trigger shows who's picked (avatar stack + label); the panel lists every
 * owner with their avatar and live deal count, checks toggle independently,
 * and "All owners" clears in one tap. Empty selection means everyone.
 */
export function OwnerFilter({
  owners,
  counts,
  members,
  selected,
  onChange,
}: {
  /** Owner display names, busiest first (includes "Unassigned"). */
  owners: string[];
  counts: Map<string, number>;
  members: { email: string; name: string; image: string | null }[];
  selected: Set<string>;
  onChange: (next: Set<string>) => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (
        ref.current && !ref.current.contains(t) &&
        panelRef.current && !panelRef.current.contains(t)
      ) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const avatarFor = (name: string) => {
    const m = members.find((mm) => mm.name === name);
    return { email: m?.email ?? name, name, image: m?.image ?? null };
  };

  const picked = owners.filter((o) => selected.has(o));
  const label =
    picked.length === 0
      ? "All owners"
      : picked.length === 1
        ? picked[0]
        : `${picked.length} owners`;

  const toggle = (name: string) => {
    const next = new Set(selected);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    onChange(next);
  };

  // Ten faces by default — the picked ones always visible, the busiest
  // filling the rest. Typing searches the whole roster.
  const needle = q.trim().toLowerCase();
  const shown = needle
    ? owners.filter((o) => o.toLowerCase().includes(needle)).slice(0, 12)
    : [
        ...owners.filter((o) => selected.has(o)),
        ...owners.filter((o) => !selected.has(o)),
      ].slice(0, Math.max(10, selected.size));

  return (
    <div ref={ref} className="relative min-w-0 flex-1 basis-32 !max-w-[11rem] md:!max-w-none md:!flex-none md:!basis-auto">
      <button
        type="button"
        className="field flex w-full items-center gap-1.5 text-left md:w-40"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="Filter by owner"
        onClick={(e) => {
          setQ("");
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          setPos({ top: r.bottom + 4, left: r.left });
          setOpen((v) => !v);
        }}
      >
        {picked.length > 0 && (
          <span className="flex shrink-0 -space-x-1.5">
            {picked.slice(0, 3).map((o) => (
              <span key={o} className="rounded-full ring-2 ring-bg">
                <OwnerAvatar owner={avatarFor(o)} size={18} />
              </span>
            ))}
          </span>
        )}
        <span className="min-w-0 flex-1 truncate text-[14px]">{label}</span>
        <ChevronDown
          size={14}
          className={`shrink-0 text-sub transition-transform ${open ? "rotate-180" : ""}`}
          aria-hidden
        />
      </button>

      {open && pos !== null &&
        createPortal(
        <div
          ref={panelRef}
          role="listbox"
          aria-multiselectable
          style={{ position: "fixed", top: pos.top, left: pos.left }}
          className="z-[90] w-60 overflow-hidden rounded-lg border border-line bg-bg py-1 shadow-lg"
        >
          <button
            type="button"
            role="option"
            aria-selected={selected.size === 0}
            className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-[13px] font-medium text-body hover:bg-bg-soft"
            onClick={() => {
              onChange(new Set());
              setOpen(false);
            }}
          >
            <span className="flex w-[18px] justify-center">
              {selected.size === 0 && <Checkmark size={14} className="text-primary" />}
            </span>
            All owners
          </button>
          <div className="my-1 border-t border-line" />
          {owners.length > 10 && (
            <div className="px-2 pb-1">
              <input
                className="field !h-8 w-full !text-[13px]"
                placeholder="Search owners…"
                autoFocus
                value={q}
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && shown.length === 1) toggle(shown[0]);
                }}
              />
            </div>
          )}
          <div>
            {shown.length === 0 && (
              <p className="px-3 py-2 text-[12px] text-faint">
                Nobody matches “{q.trim()}”.
              </p>
            )}
            {shown.map((o) => {
              const on = selected.has(o);
              return (
                <button
                  key={o}
                  type="button"
                  role="option"
                  aria-selected={on}
                  className={`flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-[13px] hover:bg-bg-soft ${
                    on ? "text-ink" : "text-body"
                  }`}
                  onClick={() => toggle(o)}
                >
                  <span className="flex w-[18px] shrink-0 justify-center">
                    {on && <Checkmark size={14} className="text-primary" />}
                  </span>
                  <OwnerAvatar owner={avatarFor(o)} size={22} />
                  <span className="min-w-0 flex-1 truncate">{o}</span>
                  <span className="shrink-0 text-[11px] text-faint">
                    {counts.get(o) ?? 0}
                  </span>
                </button>
              );
            })}
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}
