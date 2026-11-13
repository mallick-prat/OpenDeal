"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Close } from "@carbon/icons-react";
import { attachNoteToDealAction, dismissNoteAction } from "@/app/actions";
import { etWeekdayDay } from "@/lib/etDates";

/**
 * One unmatched Granola note in the Meetings → Unmatched queue: who was
 * there, when, and the plain-language deal suggestions. Attaching triggers
 * update extraction; "Not a deal" is remembered and never re-suggested.
 */
export function UnmatchedNoteCard({
  noteId,
  title,
  startsAt,
  participants,
  suggestions,
}: {
  noteId: string;
  title: string | null;
  startsAt: string | null;
  participants: { name: string | null; email: string | null }[];
  suggestions: { gid: string; name: string; reason: string }[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState("");

  const run = (fn: () => Promise<{ ok: boolean; error?: string }>) =>
    start(async () => {
      setError("");
      const res = await fn();
      if (!res.ok) setError(res.error ?? "Didn't go through.");
      else router.refresh();
    });

  const when = startsAt
    ? etWeekdayDay(startsAt)
    : null;
  const people = participants
    .map((p) => p.name ?? p.email)
    .filter(Boolean)
    .slice(0, 4)
    .join(", ");

  return (
    <li className="card-flat p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-[14px] font-medium text-ink">
            {title ?? "(untitled note)"}
          </p>
          <p className="mt-0.5 truncate text-[12px] text-sub">
            {[when, people].filter(Boolean).join(" · ")}
          </p>
        </div>
        <button
          disabled={pending}
          className="inline-flex shrink-0 items-center gap-1 text-[12px] text-faint hover:text-primary disabled:opacity-50"
          title="Not a deal — never suggest this note again"
          onClick={() => run(() => dismissNoteAction(noteId))}
        >
          <Close size={13} /> Not a deal
        </button>
      </div>

      {suggestions.length > 0 ? (
        <ul className="mt-2.5 flex flex-col gap-2 border-t border-line pt-2.5">
          {suggestions.slice(0, 3).map((s) => (
            <li key={s.gid} className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="min-w-0 flex-1 text-[13px] text-body">
                <span className="font-medium text-ink">
                  {s.name.split("//").pop()?.trim() ?? s.name}
                </span>
                <span className="block text-[12px] text-faint">{s.reason}</span>
              </span>
              <button
                disabled={pending}
                className="shrink-0 border border-line px-2 py-0.5 text-[12px] font-medium text-primary hover:border-primary disabled:opacity-50"
                onClick={() => run(() => attachNoteToDealAction(noteId, s.gid))}
              >
                Attach
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-[12px] text-faint">
          No confident deal match — attach it from the deal page, or dismiss.
        </p>
      )}
      {error && <p className="mt-1.5 text-[12px] text-primary">{error}</p>}
    </li>
  );
}
