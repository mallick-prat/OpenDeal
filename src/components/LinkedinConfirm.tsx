"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Checkmark, Close } from "@carbon/icons-react";
import { resolveFounderLinkedinAction } from "@/app/actions";
import { useTriageSession } from "./TriageSessionContext";

/**
 * One hunted LinkedIn, one human verdict: confirm links the profile to the
 * founder's name (and their network record); deny buries the suggestion.
 */
export function LinkedinConfirm({
  candidateId,
  name,
  options,
}: {
  candidateId: string;
  name: string;
  /** "https://linkedin.com/in/x (78%)" strings from the hunt claim. */
  options: string[];
}) {
  const router = useRouter();
  const session = useTriageSession();
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState("");

  const resolve = async (url: string | null) => {
    setBusy(true);
    const res = await resolveFounderLinkedinAction(candidateId, name, url);
    setBusy(false);
    if (!res.ok) {
      setDone(res.error ?? "Didn't go through — try again.");
      return;
    }
    setDone(url ? "Linked." : "Dismissed.");
    if (session) void session.refreshCurrent();
    else router.refresh();
  };

  if (done) return <span className="text-[12px] text-sub">{done}</span>;

  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      {options.map((o) => {
        const url = o.split(" ")[0];
        return (
          <span key={o} className="inline-flex items-center gap-1">
            <a
              href={url}
              target="_blank"
              rel="noreferrer"
              className="text-primary hover:underline"
            >
              {o}
            </a>
            <button
              className="tap inline-flex items-center gap-0.5 border border-line px-1.5 py-0.5 text-[11px] font-medium text-body hover:border-primary hover:text-primary"
              disabled={busy}
              title={`This is ${name}'s LinkedIn`}
              onClick={() => void resolve(url)}
            >
              <Checkmark size={12} /> Confirm
            </button>
          </span>
        );
      })}
      <button
        className="tap inline-flex items-center gap-0.5 border border-line px-1.5 py-0.5 text-[11px] font-medium text-sub hover:border-strong"
        disabled={busy}
        title="None of these are right"
        onClick={() => void resolve(null)}
      >
        <Close size={12} /> Not them
      </button>
    </span>
  );
}
