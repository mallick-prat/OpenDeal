"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { confirmClaimAction } from "@/app/actions";
import { useTriageSession } from "./TriageSessionContext";

/**
 * A directly editable fact: the value IS the control — click it, type, Enter.
 * No pencils, no provenance chips; edits land as team-confirmed claims that
 * permanently outrank the machine. A machine-vs-team disagreement still shows
 * as one quiet line.
 */
export function ClaimChip({
  candidateId,
  field,
  conflict,
  value,
}: {
  candidateId: string;
  field: string;
  /** Both sides of a machine-vs-team disagreement, when one exists. */
  conflict: { claimed: string; confirmed: string } | null;
  /** The currently displayed value ("—" when empty). */
  value: string;
}) {
  const router = useRouter();
  const session = useTriageSession();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    const v = draft.trim();
    if (!v || busy) return;
    setBusy(true);
    setError(null);
    const r = await confirmClaimAction("candidate", candidateId, field, v);
    setBusy(false);
    if (r.ok) {
      setEditing(false);
      if (session) void session.refreshCurrent();
      else router.refresh();
    } else {
      setError(r.error ?? "Couldn't save.");
    }
  };

  if (editing) {
    return (
      <span className="flex items-center gap-1.5">
        <input
          className="field !h-8 max-w-52 !px-2 !text-[14px]"
          autoFocus
          aria-label={`Value for ${field}`}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
            if (!busy && draft.trim() && draft.trim() !== value) void save();
            else setEditing(false);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") void save();
            if (e.key === "Escape") setEditing(false);
          }}
        />
        {busy && <span className="text-[11px] text-faint">Saving…</span>}
        {error && <span className="text-[11px] text-faint">{error}</span>}
      </span>
    );
  }

  return (
    <span className="inline-flex flex-col items-start">
      <button
        className="tap -mx-1 rounded-none px-1 text-left text-[14px] text-ink underline decoration-line decoration-dotted underline-offset-4 transition-colors hover:decoration-primary"
        title="Click to edit"
        aria-label={`Edit ${field}`}
        onClick={() => {
          setDraft(value === "—" ? "" : value);
          setEditing(true);
        }}
      >
        {value}
      </button>
      {conflict && (
        <span className="mt-0.5 text-[11px] text-sub">
          Founder claims {conflict.claimed} · Team confirmed {conflict.confirmed}
        </span>
      )}
    </span>
  );
}
