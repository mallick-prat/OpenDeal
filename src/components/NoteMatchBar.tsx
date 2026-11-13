"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Search } from "@carbon/icons-react";
import { attachNoteToDealAction, recentDealsAction } from "@/app/actions";
import { STAGE_BY_KEY } from "@/lib/stages";
import type { StageKey } from "@/lib/types";

type DealHit = { gid: string; name: string; stage: string };
const NEW_DEAL = "__new__";

/** What the note's own content proposes when the server has no match. */
export type MatchProposal =
  | { kind: "create"; name: string; detail: string | null }
  | { kind: "attach"; dealGid: string; label: string; detail: string | null };

/** The matcher's stored evidence as one short clause. */
function evidenceClause(ev: { kind?: string; value?: string; via?: string } | null): string | null {
  if (!ev) return null;
  if (ev.via === "manual") return "attached by hand";
  switch (ev.kind) {
    case "calendar_event": return "from the calendar invite";
    case "attendee_email": return `${ev.value} attended`;
    case "attendee_domain": return `someone from @${ev.value} attended`;
    case "attendee_name": return `founder ${ev.value} attended`;
    case "title_company": return `title mentions ${ev.value}`;
    case "title_founder": return `title names ${ev.value}`;
    case "content_company": return `notes mention ${ev.value}`;
    case "content_founder": return `notes mention ${ev.value}`;
    default: return null;
  }
}

const companyOf = (name: string) => name.split("//").pop()?.trim() || name;
const stageLabel = (stage: string) => STAGE_BY_KEY[stage as StageKey]?.label ?? stage;

/**
 * ── Where this meeting lives ─────────────────────────────────────────────
 * One line at the top of a Granola note. Attached: the deal, the reason,
 * and Change. Suggested: the deal, the reason, and one Attach click.
 * Unmatched: a picker that already shows the freshest live deals, searches
 * as you type, and attaches on Enter. Every path is one click.
 */
export function NoteMatchBar({
  noteId,
  matchState,
  dealGid,
  dealName,
  evidence,
  confidence,
  proposal = null,
  onCreate,
  creating = false,
}: {
  noteId: string;
  matchState: string;
  dealGid: string | null;
  dealName: string | null;
  evidence: { kind?: string; value?: string; via?: string } | null;
  confidence: number | null;
  /** From the note's content: a new deal to mint, or an existing one to join. */
  proposal?: MatchProposal | null;
  /** Mint a deal named this from the note (the proposal, or a typed name). */
  onCreate?: (name: string) => void;
  creating?: boolean;
}) {
  const router = useRouter();
  const attached = (matchState === "confirmed" || matchState === "attached") && !!dealGid;
  const suggested = matchState === "suggested" && !!dealGid;
  const [picking, setPicking] = useState(!attached && !suggested && matchState !== "dismissed");
  // The proposal lands after the bootstrap: it takes over an untouched picker.
  const userOpened = useRef(false);
  useEffect(() => {
    if (proposal && picking && !userOpened.current) setPicking(false);
  }, [proposal, picking]);
  const openPicker = () => {
    userOpened.current = true;
    setPicking(true);
  };
  const [q, setQ] = useState("");
  const [recent, setRecent] = useState<DealHit[] | null>(null);
  const [hits, setHits] = useState<DealHit[]>([]);
  const [cursor, setCursor] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  // The picker's first screen: live deals by recency, fetched once.
  useEffect(() => {
    if (!picking || recent !== null) return;
    let alive = true;
    void recentDealsAction(8).then((r) => {
      if (alive && r.ok && r.deals) setRecent(r.deals);
    });
    return () => {
      alive = false;
    };
  }, [picking, recent]);

  // Search as you type: 150ms debounce, stale answers never render.
  useEffect(() => {
    const query = q.trim();
    if (query.length < 2) {
      setHits([]);
      return;
    }
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      void fetch(`/api/deals/search?q=${encodeURIComponent(query)}`, { signal: ctrl.signal })
        .then((r) => (r.ok ? r.json() : null))
        .then((j: { results?: DealHit[] } | null) => {
          if (j?.results) {
            setHits(j.results.slice(0, 8));
            setCursor(0);
          }
        })
        .catch(() => {});
    }, 150);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [q]);

  useEffect(() => {
    if (picking) inputRef.current?.focus();
  }, [picking]);

  /** Closing the picker forgets what was typed: it reopens on recent deals. */
  const close = () => {
    setPicking(false);
    setQ("");
    setHits([]);
    setCursor(0);
  };

  const attach = async (gid: string) => {
    if (busy) return;
    setBusy(gid);
    setError("");
    const res = await attachNoteToDealAction(noteId, gid, { repoint: true });
    setBusy(null);
    if (!res.ok) {
      setError(res.error ?? "Couldn't attach the note.");
      return;
    }
    close();
    router.refresh();
  };

  const typed = q.trim();
  const list: DealHit[] =
    typed.length >= 2
      ? [...hits, ...(onCreate ? [{ gid: NEW_DEAL, name: `New deal: ${typed}`, stage: "" }] : [])]
      : (recent ?? []);
  const choose = (d: DealHit) => {
    if (d.gid === NEW_DEAL) {
      if (onCreate) onCreate(typed);
      return;
    }
    void attach(d.gid);
  };
  const clause = evidenceClause(evidence);
  const pct = confidence !== null ? Math.round(confidence * 100) : null;

  return (
    <div className="anim-fade-up mt-3 border-l-2 border-l-primary pl-3 text-[13.5px]" aria-label="Deal match">
      {attached && dealGid && !picking && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="min-w-0 flex-1">
            <span className="font-semibold text-ink">On the board:</span>{" "}
            <Link href={`/deals/${dealGid}`} className="font-medium text-ink hover:underline">
              {companyOf(dealName ?? "")}
            </Link>
            {clause && <span className="text-sub"> · {clause}</span>}
          </span>
          <button className="tap-sm text-[12px] font-medium text-sub hover:text-primary" onClick={openPicker}>
            Change
          </button>
        </div>
      )}

      {suggested && dealGid && !picking && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <span className="min-w-0 flex-1">
            <span className="font-semibold text-ink">Looks like</span>{" "}
            <Link href={`/deals/${dealGid}`} className="font-medium text-ink hover:underline">
              {companyOf(dealName ?? "")}
            </Link>
            {clause && <span className="text-sub"> · {clause}</span>}
            {pct !== null && <span className="text-faint"> · {pct}%</span>}
          </span>
          <button
            className="btn-primary tap !h-8 !px-3 !text-[12.5px]"
            disabled={busy !== null}
            onClick={() => void attach(dealGid)}
          >
            {busy === dealGid ? "Attaching…" : "Attach"}
          </button>
          <button className="tap-sm text-[12px] font-medium text-sub hover:text-primary" onClick={openPicker}>
            Pick another
          </button>
        </div>
      )}

      {!attached && !suggested && !picking && proposal?.kind === "create" && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <span className="min-w-0 flex-1">
            <span className="font-semibold text-ink">New deal:</span>{" "}
            <span className="font-medium text-ink">{proposal.name}</span>
            {proposal.detail && <span className="text-sub"> · {proposal.detail}</span>}
          </span>
          <button
            className="btn-primary tap !h-8 !px-3 !text-[12.5px]"
            disabled={creating || busy !== null}
            onClick={() => onCreate?.(proposal.name)}
          >
            {creating ? "Adding…" : "Add to pipeline"}
          </button>
          <button className="tap-sm text-[12px] font-medium text-sub hover:text-primary" onClick={openPicker}>
            Pick a deal instead
          </button>
        </div>
      )}

      {!attached && !suggested && !picking && proposal?.kind === "attach" && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <span className="min-w-0 flex-1">
            <span className="font-semibold text-ink">Looks like</span>{" "}
            <Link href={`/deals/${proposal.dealGid}`} className="font-medium text-ink hover:underline">
              {companyOf(proposal.label)}
            </Link>
            {proposal.detail && <span className="text-sub"> · {proposal.detail}</span>}
          </span>
          <button
            className="btn-primary tap !h-8 !px-3 !text-[12.5px]"
            disabled={busy !== null}
            onClick={() => void attach(proposal.dealGid)}
          >
            {busy === proposal.dealGid ? "Attaching…" : "Attach"}
          </button>
          <button className="tap-sm text-[12px] font-medium text-sub hover:text-primary" onClick={openPicker}>
            Pick another
          </button>
        </div>
      )}

      {!attached && !suggested && !picking && !proposal && (
        <button className="tap-sm text-[13px] font-medium text-primary hover:underline" onClick={openPicker}>
          Attach to a deal
        </button>
      )}

      {picking && (
        <div className="max-w-[480px]">
          <div className="relative">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-faint" aria-hidden />
            <input
              ref={inputRef}
              className="field !h-9 w-full !pl-8 !text-[13px]"
              placeholder="Attach to a deal"
              aria-label="Attach to a deal"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setCursor((c) => Math.min(c + 1, Math.max(list.length - 1, 0)));
                } else if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setCursor((c) => Math.max(c - 1, 0));
                } else if (e.key === "Enter" && list[cursor]) {
                  e.preventDefault();
                  choose(list[cursor]);
                } else if (e.key === "Escape") {
                  close();
                }
              }}
            />
          </div>
          {list.length > 0 && (
            <ul className="mt-1 divide-y divide-line border border-line" role="listbox" aria-label="Deals">
              {list.map((d, i) => (
                <li key={d.gid} role="option" aria-selected={i === cursor}>
                  <button
                    className={`pressable flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[13px] ${
                      i === cursor ? "bg-bg-soft text-ink" : "text-body hover:bg-bg-soft"
                    }`}
                    disabled={busy !== null || creating}
                    onMouseEnter={() => setCursor(i)}
                    onClick={() => choose(d)}
                  >
                    <span className={`min-w-0 flex-1 truncate ${d.gid === NEW_DEAL ? "font-medium text-primary" : ""}`}>{d.name}</span>
                    <span className="shrink-0 text-[11.5px] text-faint">
                      {d.gid === NEW_DEAL ? (creating ? "Adding…" : "prefilled from the note") : busy === d.gid ? "Attaching…" : stageLabel(d.stage)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="mt-1 flex items-center gap-3 text-[11.5px] text-faint">
            <span>{q.trim().length >= 2 ? "Enter attaches the highlighted deal" : "Recent deals. Type to search."}</span>
            {(attached || suggested || proposal) && (
              <button className="font-medium text-sub hover:text-primary" onClick={close}>
                Cancel
              </button>
            )}
          </div>
          {error && <p className="mt-1 text-[12px] text-primary">{error}</p>}
        </div>
      )}
    </div>
  );
}
