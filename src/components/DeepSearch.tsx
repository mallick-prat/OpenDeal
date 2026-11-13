"use client";

import { Fragment, useEffect, useRef, useState } from "react";
import { StagePill } from "./charts";
import type { StageKey } from "@/lib/types";

/**
 * The body-search dropdown under the deals search box. The instant filter
 * above matches names as you type; this panel digs the deal BODIES — notes,
 * pitch lines, merged history — with stemmed full-text search plus a model-
 * expanded query, and says what it also searched. Debounced, abortable,
 * dismissed on Escape or pick.
 */

interface Hit {
  gid: string;
  name: string;
  stage: string;
  snippet: string | null;
  via?: string;
}

/** ts_headline marks hits with [[ ]]; render them as real highlights. */
function Snippet({ text }: { text: string }) {
  const parts = text.split(/\[\[|\]\]/);
  return (
    <>
      {parts.map((p, i) =>
        i % 2 === 1 ? (
          <mark key={i} className="bg-transparent font-semibold text-primary">
            {p}
          </mark>
        ) : (
          <Fragment key={i}>{p}</Fragment>
        )
      )}
    </>
  );
}

export function DeepSearch({
  query,
  onOpen,
}: {
  query: string;
  onOpen: (gid: string) => void;
}) {
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [expanded, setExpanded] = useState<string[]>([]);
  const [dismissed, setDismissed] = useState(false);
  const requestId = useRef(0);

  const q = query.trim();

  useEffect(() => {
    setDismissed(false);
    if (q.length < 3) {
      requestId.current += 1;
      setHits(null);
      setExpanded([]);
      return;
    }
    const ctrl = new AbortController();
    const id = ++requestId.current;
    const t = setTimeout(async () => {
      try {
        const base = `/api/deals/search?q=${encodeURIComponent(q)}`;
        const res = await fetch(base, {
          signal: ctrl.signal,
        });
        if (!res.ok) return;
        const json = (await res.json()) as {
          ok: boolean;
          results: Hit[];
          expanded: string[];
          expansionPending?: boolean;
        };
        if (json.ok && id === requestId.current) {
          setHits(json.results);
          setExpanded(json.expanded);
        }
        if (!json.ok || !json.expansionPending) return;

        const enriched = await fetch(`${base}&phase=expanded`, {
          signal: ctrl.signal,
        });
        if (!enriched.ok) return;
        const enrichedJson = (await enriched.json()) as {
          ok: boolean;
          results: Hit[];
          expanded: string[];
        };
        if (enrichedJson.ok && id === requestId.current) {
          setHits(enrichedJson.results);
          setExpanded(enrichedJson.expanded);
        }
      } catch {
        // aborted or offline — the instant filter above still works
      }
    }, 450);
    return () => {
      ctrl.abort();
      clearTimeout(t);
    };
  }, [q]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDismissed(true);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  if (dismissed || q.length < 3 || hits === null || hits.length === 0) return null;

  return (
    <div className="absolute left-0 right-0 top-full z-40 mt-1 overflow-hidden rounded-lg border border-line bg-bg shadow-lg">
      <p className="border-b border-line bg-bg-soft px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-sub">
        Search
      </p>
      <ul className="max-h-80 overflow-y-auto">
        {hits.map((h) => (
          <li key={h.gid}>
            <button
              type="button"
              className="flex w-full flex-col gap-0.5 px-3 py-2 text-left hover:bg-bg-soft"
              onClick={() => {
                setDismissed(true);
                onOpen(h.gid);
              }}
            >
              <span className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink">
                  {h.name}
                </span>
                {h.via === "meaning" && (
                  <span
                    className="shrink-0 text-[10px] font-semibold uppercase tracking-wide text-faint"
                    title="Found by meaning, not exact words"
                  >
                    ≈ meaning
                  </span>
                )}
                <StagePill stage={h.stage as StageKey} short />
              </span>
              {h.snippet && (
                <span className="line-clamp-2 text-[12px] leading-snug text-sub">
                  …<Snippet text={h.snippet} />…
                </span>
              )}
            </button>
          </li>
        ))}
      </ul>
      {expanded.length > 0 && (
        <p className="border-t border-line px-3 py-1.5 text-[11px] text-faint">
          Also searched: {expanded.join(", ")}
        </p>
      )}
    </div>
  );
}
