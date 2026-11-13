"use client";

import { crm } from "@/config/crm.config";
import { useEffect, useRef, useState } from "react";
import { Add, Close } from "@carbon/icons-react";

/**
 * Schools as editable tags: the selected schools render as chips, and
 * "+ School" opens one small searchable picker (known schools first, free
 * text as a fallback). Replaces the checkbox matrix in the edit card — all
 * options stay hidden until asked for.
 */
export function SchoolTags({
  selected,
  known,
  onToggle,
  extras,
  onExtras,
}: {
  /** Schools ticked from the known list. */
  selected: Set<string>;
  known: string[];
  onToggle: (name: string) => void;
  /** Free-text schools (comma-joined upstream). */
  extras: string[];
  onExtras: (list: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        setQ("");
      }
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const chips = [...selected, ...extras];
  const needle = q.trim().toLowerCase();
  const options = known.filter(
    (s) => !selected.has(s) && (!needle || s.toLowerCase().includes(needle))
  );
  const canFreeAdd =
    needle.length > 1 &&
    !options.some((o) => o.toLowerCase() === needle) &&
    !chips.some((c) => c.toLowerCase() === needle);

  const add = (name: string, free: boolean) => {
    if (free) onExtras([...extras, name]);
    else onToggle(name);
    setQ("");
  };

  return (
    <div>
      <span className="mb-1 block text-[12px] font-semibold text-sub">
        {crm.tags.plural}
      </span>
      <div className="flex flex-wrap items-center gap-1.5">
        {chips.map((s) => (
          <span
            key={s}
            className="inline-flex items-center gap-1 border border-line bg-bg-soft px-2 py-1 text-[13px] text-body"
          >
            {s}
            <button
              aria-label={`Remove ${s}`}
              className="text-faint hover:text-primary"
              onClick={() =>
                selected.has(s)
                  ? onToggle(s)
                  : onExtras(extras.filter((x) => x !== s))
              }
            >
              <Close size={13} />
            </button>
          </span>
        ))}
        <div ref={ref} className="relative">
          <button
            className="inline-flex items-center gap-1 border border-dashed border-line px-2 py-1 text-[13px] font-medium text-sub hover:border-primary hover:text-primary"
            onClick={() => setOpen((v) => !v)}
          >
            <Add size={14} /> {crm.tags.singular}
          </button>
          {open && (
            <div className="absolute left-0 top-full z-30 mt-1 w-56 overflow-hidden rounded-lg border border-line bg-bg shadow-lg">
              <input
                className="w-full border-b border-line bg-transparent px-3 py-2 text-[13px] text-ink outline-none placeholder:text-faint"
                placeholder="Search schools…"
                autoFocus
                value={q}
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    if (options.length > 0) add(options[0], false);
                    else if (canFreeAdd) add(q.trim(), true);
                  }
                }}
              />
              <div className="max-h-52 overflow-y-auto py-1">
                {options.map((s) => (
                  <button
                    key={s}
                    className="block w-full px-3 py-1.5 text-left text-[13px] text-body hover:bg-bg-soft"
                    onClick={() => add(s, false)}
                  >
                    {s}
                  </button>
                ))}
                {canFreeAdd && (
                  <button
                    className="block w-full px-3 py-1.5 text-left text-[13px] font-medium text-primary hover:bg-bg-soft"
                    onClick={() => add(q.trim(), true)}
                  >
                    Add “{q.trim()}”
                  </button>
                )}
                {options.length === 0 && !canFreeAdd && (
                  <p className="px-3 py-1.5 text-[12px] text-faint">
                    Type to search or add.
                  </p>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
