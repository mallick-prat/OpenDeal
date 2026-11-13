"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Bot } from "@carbon/icons-react";
import { enrichCandidateAction } from "@/app/actions";
import { useTriageSession } from "./TriageSessionContext";

const STEPS = [
  "Spinning up web research…",
  "Reading the open web…",
  "Hunting founder LinkedIns…",
  "Writing verified claims…",
];

/**
 * The "get me more" button: enriches the candidate IN PLACE — re-extraction,
 * deck re-read, founder network enrichment — with a narrated progress line.
 * It never triages and never navigates away.
 */
export function EnrichButton({ id }: { id: string }) {
  const router = useRouter();
  const session = useTriageSession();
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState(0);
  const [note, setNote] = useState("");
  const [deckNote, setDeckNote] = useState("");
  const [askPass, setAskPass] = useState(false);
  const [passcode, setPasscode] = useState("");

  // Rotate the narration while the run is in flight.
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => setStep((s) => (s + 1) % STEPS.length), 2600);
    return () => clearInterval(t);
  }, [busy]);

  const run = async (docsendPasscode?: string) => {
    setBusy(true);
    setStep(0);
    setNote("");
    setDeckNote("");
    const res = await enrichCandidateAction(id, docsendPasscode ? { docsendPasscode } : undefined);
    setBusy(false);
    const ds = (res as { docsend?: { status: string; note: string } }).docsend;
    if (ds) {
      setDeckNote(ds.note);
      setAskPass(ds.status === "gated");
      if (ds.status !== "gated") setPasscode("");
    }
    if (!res.ok) {
      setNote(res.error ?? "Enrichment didn't go through — try again.");
      return;
    }
    const r = res as {
      claims?: number;
      foundersLinked?: number;
      linkedinCandidates?: number;
    };
    const bits = [
      r.claims ? `${r.claims} verified claim${r.claims === 1 ? "" : "s"}` : null,
      r.foundersLinked ? `${r.foundersLinked} founder${r.foundersLinked === 1 ? "" : "s"} enriching` : null,
      r.linkedinCandidates ? `${r.linkedinCandidates} LinkedIn candidate${r.linkedinCandidates === 1 ? "" : "s"}` : null,
    ].filter(Boolean);
    setNote(bits.length > 0 ? `Found: ${bits.join(" · ")}.` : "Nothing new found.");
    if (session) void session.refreshCurrent();
    else router.refresh();
  };

  return (
    <span className="flex flex-col items-end gap-1">
      <button
        className="btn-secondary tap flex items-center gap-1.5 !h-10 !text-[13px]"
        disabled={busy}
        title="Gather more: re-read the pitch and enrich the founders"
        onClick={() => void run()}
      >
        <Bot size={16} className={busy ? "animate-pulse" : undefined} />
        {busy ? STEPS[step] : "Enrich"}
      </button>
      {note && (
        <span className="anim-fade-up text-[12px] text-sub" role="status" aria-live="polite">
          {note}
        </span>
      )}
      {deckNote && (
        <span className="anim-fade-up max-w-[340px] text-right text-[12px] text-sub" role="status">
          {deckNote}
        </span>
      )}
      {askPass && (
        <span className="anim-fade-up flex items-center gap-1.5">
          <input
            type="text"
            className="field !h-8 !w-44 !text-[12.5px]"
            placeholder="Deck password"
            aria-label="DocSend deck password"
            value={passcode}
            onChange={(e) => setPasscode(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && passcode.trim() && !busy) void run(passcode.trim());
            }}
          />
          <button
            className="btn-primary !h-8 !px-2.5 !text-[12px]"
            disabled={busy || !passcode.trim()}
            onClick={() => void run(passcode.trim())}
          >
            Unlock
          </button>
        </span>
      )}
    </span>
  );
}
