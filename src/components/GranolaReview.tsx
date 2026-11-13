"use client";

import { GranolaMark } from "@/components/GranolaMark";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Checkmark, Close, Undo } from "@carbon/icons-react";
import {
  applyGranolaUpdatesAction,
  dismissGranolaUpdatesAction,
  undoGranolaApplyAction,
} from "@/app/actions";
import type { ProposedUpdate } from "@/lib/meetingNoteUpdates";

/**
 * "Granola found N updates" — the banner and its review panel. Collapsed, it
 * is one quiet line with Apply all / Review / Dismiss. Expanded, each update
 * is a checkbox row with plain before → after text. Applied notes show Undo
 * for three days. No scores, no jargon — just what would change.
 */
export function GranolaReviewCard({
  noteId,
  title,
  dealGid,
  dealName,
  updates,
  state,
}: {
  noteId: string;
  title: string | null;
  dealGid: string;
  dealName: string | null;
  updates: ProposedUpdate[];
  state: "ready" | "applied";
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<Set<number>>(
    () => new Set(updates.map((_, i) => i))
  );
  const [pending, start] = useTransition();
  const [error, setError] = useState("");

  const company = dealName ? dealName.split("//").pop()?.trim() : null;

  const run = (fn: () => Promise<{ ok: boolean; error?: string }>) =>
    start(async () => {
      setError("");
      const res = await fn();
      if (!res.ok) setError(res.error ?? "Didn't go through.");
      else router.refresh();
    });

  if (state === "applied") {
    return (
      <div className="callout-parchment flex flex-wrap items-center gap-x-3 gap-y-1 p-3">
        <Checkmark size={14} className="shrink-0 text-primary" />
        <span className="min-w-0 flex-1 text-[13px] text-body">
          Updates applied to{" "}
          {company ? (
            <Link href={`/deals/${dealGid}`} className="font-medium text-primary hover:underline">
              {company}
            </Link>
          ) : (
            "the deal"
          )}
          {title ? ` from “${title}”` : ""}. Undo restores the changed
          fields; founders added stay.
        </span>
        <button
          disabled={pending}
          className="inline-flex items-center gap-1 text-[12px] font-medium text-sub hover:text-primary disabled:opacity-50"
          onClick={() => run(() => undoGranolaApplyAction(noteId))}
        >
          <Undo size={13} /> Undo
        </button>
        {error && <span className="text-[12px] text-primary">{error}</span>}
      </div>
    );
  }

  return (
    <div className="callout-parchment p-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className="min-w-0 flex-1 text-[13px] font-medium text-ink">
          <GranolaMark size={15} className="mr-1.5 inline-block  align-[-2px]" />
          Granola found {updates.length} update{updates.length === 1 ? "" : "s"}
          {company ? (
            <>
              {" for "}
              <Link href={`/deals/${dealGid}`} className="text-primary hover:underline">
                {company}
              </Link>
            </>
          ) : null}
          {title ? <span className="font-normal text-sub"> · {title}</span> : null}
        </span>
        <span className="flex shrink-0 items-center gap-2">
          <button
            disabled={pending}
            className="border border-primary bg-primary px-2.5 py-1 text-[12px] font-medium text-white hover:bg-primary-pressed disabled:opacity-50"
            onClick={() => run(() => applyGranolaUpdatesAction(noteId, "all"))}
          >
            {pending ? "Applying…" : "Apply all"}
          </button>
          <button
            className="border border-line px-2.5 py-1 text-[12px] font-medium text-body hover:border-primary"
            onClick={() => setOpen((v) => !v)}
          >
            {open ? "Hide changes" : "Review changes"}
          </button>
          <button
            disabled={pending}
            className="inline-flex items-center gap-1 text-[12px] text-faint hover:text-primary disabled:opacity-50"
            onClick={() => run(() => dismissGranolaUpdatesAction(noteId))}
          >
            <Close size={13} /> Dismiss
          </button>
        </span>
      </div>

      {open && (
        <div className="mt-2.5 border-t border-line pt-2.5">
          <ul className="flex flex-col gap-2">
            {updates.map((u, i) => (
              <li key={i} className="flex items-start gap-2.5">
                <input
                  type="checkbox"
                  className="mt-0.5 accent-[var(--brand-red-500)]"
                  checked={picked.has(i)}
                  onChange={(e) => {
                    const next = new Set(picked);
                    if (e.target.checked) next.add(i);
                    else next.delete(i);
                    setPicked(next);
                  }}
                />
                <span className="min-w-0 text-[13px] text-body">
                  {u.label}
                  {u.before != null && (
                    <span className="block text-[12px] text-faint">
                      <s>{u.before}</s> → {u.after}
                    </span>
                  )}
                  {u.before == null && u.kind === "summary" && (
                    <span className="block whitespace-pre-wrap text-[12px] text-sub">
                      {u.after}
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ul>
          <div className="mt-2.5 flex items-center gap-2">
            <button
              disabled={pending || picked.size === 0}
              className="border border-line px-2.5 py-1 text-[12px] font-medium text-body hover:border-primary disabled:opacity-50"
              onClick={() => run(() => applyGranolaUpdatesAction(noteId, [...picked]))}
            >
              Apply {picked.size === updates.length ? "all" : `${picked.size} selected`}
            </button>
            {error && <span className="text-[12px] text-primary">{error}</span>}
          </div>
        </div>
      )}
      {!open && error && <p className="mt-1 text-[12px] text-primary">{error}</p>}
    </div>
  );
}
