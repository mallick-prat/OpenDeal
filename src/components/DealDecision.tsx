"use client";

import { useCallback, useEffect, useState } from "react";
import { getDealDecisions, setDealDecisionAction, type DealDecisionView } from "@/app/actions";
import { DECISIONS, decisionMeta, type DecisionKey } from "@/lib/decisionsPure";
import { DecisionChip } from "./DecisionChip";
import { etShortDate } from "@/lib/etDates";

function timeAgo(iso: string): string {
  const secs = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 45) return "just now";
  if (secs < 3600) return `${Math.round(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.round(secs / 3600)}h ago`;
  if (secs < 7 * 86400) return `${Math.round(secs / 86400)}d ago`;
  return etShortDate(iso);
}

/**
 * The deal's verdict, separate from its board column: a member picks
 * watch/diligence/invest/pass/lost, writes a required reason, and it's recorded
 * with who + when. Prior decisions stay as history so "why did we pass" always
 * has an answer. Commits instantly (its own Save), like owners and comments.
 */
export function DealDecision({
  gid,
}: {
  gid: string;
  viewer?: { email: string; name: string; image: string | null; role: string };
}) {
  const [current, setCurrent] = useState<DealDecisionView | null>(null);
  const [history, setHistory] = useState<DealDecisionView[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [picked, setPicked] = useState<DecisionKey | null>(null);
  const [rationale, setRationale] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [showHistory, setShowHistory] = useState(false);

  const load = useCallback(async () => {
    const res = await getDealDecisions(gid);
    if (res.ok) {
      setCurrent(res.current);
      setHistory(res.history);
    } else {
      setError(res.error);
    }
    setLoaded(true);
  }, [gid]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await getDealDecisions(gid);
      if (cancelled) return;
      if (res.ok) {
        setCurrent(res.current);
        setHistory(res.history);
      } else setError(res.error);
      setLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [gid]);

  const save = async () => {
    if (!picked || busy) return;
    const reason = rationale.trim();
    if (!reason) {
      setError("Add a short reason for this decision.");
      return;
    }
    setBusy(true);
    setError("");
    const res = await setDealDecisionAction(gid, picked, reason);
    setBusy(false);
    if (!res.ok) {
      setError(res.error ?? "Couldn't save the decision.");
      return;
    }
    setPicked(null);
    setRationale("");
    await load();
  };

  // Older-than-current entries make up the history list.
  const past = history.slice(current ? 1 : 0);

  return (
    <div>
      <div className="mb-1 flex items-center gap-2">
        <span className="text-[12px] font-semibold text-sub">Decision</span>
        {current && <DecisionChip decision={current.decision} size="md" />}
      </div>

      {current ? (
        <p className="mb-2 text-[12px] text-faint">
          {decisionMeta(current.decision)?.label} · set by {current.actorName} {timeAgo(current.at)}
          <span className="mx-1">·</span>
          <span className="text-body">{current.rationale}</span>
        </p>
      ) : loaded ? (
        <p className="mb-2 text-[12px] text-faint">No decision yet.</p>
      ) : (
        <p className="mb-2 text-[12px] text-faint">Loading…</p>
      )}

      {/* Pick (or change) the verdict */}
      <div className="flex flex-wrap gap-1.5">
        {DECISIONS.map((d) => {
          const active = picked === d.key;
          return (
            <button
              key={d.key}
              type="button"
              onClick={() => {
                setPicked(active ? null : d.key);
                setError("");
              }}
              title={d.hint}
              className={`rounded px-2.5 py-1 text-[12px] font-semibold transition-colors ${
                active ? "text-white" : "text-body hover:bg-bg-soft"
              }`}
              style={
                active
                  ? { backgroundColor: d.color }
                  : { border: `1px solid ${d.color}55`, color: d.color }
              }
            >
              {d.label}
            </button>
          );
        })}
      </div>

      {picked && (
        <div className="mt-2 flex flex-col gap-2">
          <textarea
            className="field resize-y py-2 leading-relaxed"
            rows={2}
            autoFocus
            placeholder={`Why ${decisionMeta(picked)?.label.toLowerCase()}? (required)`}
            value={rationale}
            onChange={(e) => setRationale(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                e.preventDefault();
                void save();
              }
            }}
          />
          <div className="flex items-center gap-2">
            <button
              className="btn-primary !text-[13px]"
              onClick={save}
              disabled={busy || !rationale.trim()}
            >
              {busy ? "Saving…" : current ? "Change decision" : "Record decision"}
            </button>
            <button
              className="text-[13px] font-medium text-sub hover:text-primary"
              onClick={() => {
                setPicked(null);
                setRationale("");
                setError("");
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {error && <p className="mt-2 text-[12px] text-primary">{error}</p>}

      {past.length > 0 && (
        <div className="mt-3">
          <button
            className="text-[12px] font-medium text-sub hover:text-primary"
            onClick={() => setShowHistory((v) => !v)}
          >
            {showHistory ? "Hide" : "Show"} previous decisions ({past.length})
          </button>
          {showHistory && (
            <ul className="mt-2 flex flex-col gap-2 border-l border-line pl-3">
              {past.map((h, i) => (
                <li key={i} className="text-[12px]">
                  <span className="mr-2 align-middle">
                    <DecisionChip decision={h.decision} />
                  </span>
                  <span className="text-faint">
                    {h.actorName} {timeAgo(h.at)}
                  </span>
                  <div className="text-body">{h.rationale}</div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
