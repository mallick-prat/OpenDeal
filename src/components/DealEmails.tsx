"use client";

import { crm } from "@/config/crm.config";
import { useEffect, useRef, useState } from "react";
import { Attachment, ChevronDown, Launch } from "@carbon/icons-react";
import { getDealEmailsAction } from "@/app/actions";
import type {
  DealEmailHistory,
  HistoryMessage,
  DealDocument,
} from "@/lib/dealEmails";
import { etFullDate, etFullDateTime, etShortDate } from "@/lib/etDates";

/**
 * ── Email history: the deal's relationship with its founders, readable ─────
 * Collapsed: one white section — count, split, date range, whose turn it is,
 * the three latest messages, "View all N". Expanded: an inline reader with a
 * sticky header, conversations grouped by subject, and every message's FULL
 * body — quoted history folded behind a toggle, attachments beneath. Plain
 * typography over chrome: this is an email reader, not a messaging app.
 * (Documents & decks keeps its own block above, fed by the same fetch.)
 */

function day(iso: string | null): string {
  if (!iso) return "";
  return etShortDate(iso);
}
function dayYear(iso: string | null): string {
  if (!iso) return "";
  return etFullDate(iso);
}
function stampFull(iso: string | null): string {
  if (!iso) return "";
  return etFullDateTime(iso);
}

const CATEGORY_LABEL: Record<HistoryMessage["sender"]["category"], string> = {
  founder: "Founder",
  internal: crm.org.name,
  external: "External",
};

function Initials({ name, email }: { name: string | null; email: string | null }) {
  const src = (name ?? email ?? "?").trim();
  const parts = src.split(/\s+/);
  const initials =
    parts.length > 1
      ? (parts[0][0] ?? "") + (parts[parts.length - 1][0] ?? "")
      : src.slice(0, 2);
  return (
    <span
      aria-hidden
      className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-line bg-bg-soft text-[10px] font-semibold uppercase text-sub"
    >
      {initials.toUpperCase()}
    </span>
  );
}

function prettyUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.hostname.includes("urldefense")) {
      const inner = url.match(/url\?u=([^&]+)/)?.[1];
      if (inner) {
        const decoded = decodeURIComponent(inner).replace(/-2D/g, "-").replace(/_/g, "/").replace(/-3A/g, ":");
        try {
          return new URL(decoded).hostname.replace(/^www\./, "");
        } catch {
          /* fall through */
        }
      }
      return "protected link";
    }
    return u.hostname.replace(/^www\./, "") + (u.pathname.length > 1 ? "/…" : "");
  } catch {
    return url.slice(0, 40);
  }
}

/** One full message in the reader. */
function MessageView({ m, anchorId }: { m: HistoryMessage; anchorId: string }) {
  const [showQuoted, setShowQuoted] = useState(false);
  const isTeam = m.sender.category === "internal";

  if (m.isEvent) {
    return (
      <div id={anchorId} className="px-4 py-2">
        <p className="text-[12px] text-faint">
          Calendar · {m.subject ?? "(event)"} · {day(m.sentAt)}
        </p>
      </div>
    );
  }

  return (
    <article
      id={anchorId}
      className={`px-4 py-3 ${isTeam ? "border-l-2 border-line-strong bg-bg-soft/50" : ""}`}
    >
      <div className="flex items-center gap-2">
        <Initials name={m.sender.name} email={m.sender.email} />
        <span className="min-w-0 flex-1 truncate text-[14px] font-medium text-ink">
          {m.sender.name || m.sender.email || "Unknown sender"}
          {m.sender.category === "external" && (
            <span className="ml-1.5 align-middle text-[10px] font-semibold uppercase tracking-wide text-faint">
              External
            </span>
          )}
        </span>
        <span className="shrink-0 text-[12px] tabular-nums text-faint">
          {stampFull(m.sentAt)}
        </span>
        {m.gmailUrl && (
          <a
            href={m.gmailUrl}
            target="_blank"
            rel="noreferrer"
            aria-label="Open this message in Gmail"
            className="shrink-0 text-sub hover:text-primary"
          >
            <Launch size={13} />
          </a>
        )}
      </div>
      <div className="mt-1 pl-8 text-[12px] leading-relaxed text-sub">
        {m.sender.email && <p className="m-0">From: {m.sender.email}</p>}
        {m.to.length > 0 && (
          <p className="m-0">To: {m.to.map((a) => a.email).join(", ")}</p>
        )}
        {m.cc.length > 0 && (
          <p className="m-0">Cc: {m.cc.map((a) => a.email).join(", ")}</p>
        )}
        {m.subject && <p className="m-0">Subject: {m.subject}</p>}
      </div>
      {m.body && (
        <div className="mt-2 max-w-[760px] whitespace-pre-wrap pl-8 text-[14px] leading-relaxed text-body">
          {m.body}
        </div>
      )}
      {m.quoted && (
        <div className="mt-2 pl-8">
          <button
            type="button"
            className="text-[12px] font-medium text-sub hover:text-primary"
            aria-expanded={showQuoted}
            onClick={() => setShowQuoted((v) => !v)}
          >
            {showQuoted ? "Hide quoted text" : "Show quoted text"}
          </button>
          {showQuoted && (
            <div className="mt-1.5 max-w-[760px] whitespace-pre-wrap border-l-2 border-line pl-3 text-[13px] leading-relaxed text-sub">
              {m.quoted}
            </div>
          )}
        </div>
      )}
      {(m.attachments.length > 0 || m.deckLinks.length > 0) && (
        <div className="mt-2 flex flex-wrap gap-1.5 pl-8">
          {m.deckLinks.map((l) => (
            <a
              key={l.url}
              href={l.url}
              target="_blank"
              rel="noreferrer"
              aria-label={`Open ${l.kind ?? "document"} link`}
              className="inline-flex items-center gap-1 rounded-md border border-line px-2 py-0.5 text-[12px] font-medium text-primary hover:border-primary"
            >
              <Launch size={12} /> {l.kind ? `${l.kind} · ` : ""}
              {prettyUrl(l.url)}
            </a>
          ))}
          {m.attachments.map((a) => (
            <span
              key={a.name}
              className="inline-flex items-center gap-1 rounded-md border border-line px-2 py-0.5 text-[12px] text-body"
            >
              <Attachment size={12} /> {a.name}
            </span>
          ))}
        </div>
      )}
    </article>
  );
}

export function DealEmails({ gid }: { gid: string }) {
  const [history, setHistory] = useState<DealEmailHistory | null>(null);
  const [failed, setFailed] = useState(false);
  const [reload, setReload] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const [docsOpen, setDocsOpen] = useState(true);
  const scrollTo = useRef<string | null>(null);
  const readerRef = useRef<HTMLDivElement>(null);

  // Expanded/collapsed survives while the user stays on this deal.
  useEffect(() => {
    try {
      setExpanded(sessionStorage.getItem(`dealmail:${gid}`) === "1");
    } catch {
      /* private mode */
    }
  }, [gid]);
  const setOpen = (v: boolean) => {
    setExpanded(v);
    try {
      sessionStorage.setItem(`dealmail:${gid}`, v ? "1" : "0");
    } catch {
      /* private mode */
    }
  };

  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    (async () => {
      const res = await getDealEmailsAction(gid).catch(() => null);
      if (cancelled) return;
      if (res?.ok) setHistory(res.history);
      else setFailed(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [gid, reload]);

  // After expanding from a row click, bring that message into view.
  useEffect(() => {
    if (!expanded || !scrollTo.current) return;
    const id = scrollTo.current;
    scrollTo.current = null;
    const t = setTimeout(() => {
      document.getElementById(id)?.scrollIntoView({ block: "center", behavior: "smooth" });
    }, 180);
    return () => clearTimeout(t);
  }, [expanded, history]);

  if (failed) {
    return (
      <div className="border-t border-line pt-5">
        <p className="text-[13px] text-sub">
          Email history could not be loaded.{" "}
          <button
            type="button"
            className="font-medium text-primary hover:underline"
            onClick={() => setReload((n) => n + 1)}
          >
            Retry
          </button>
        </p>
      </div>
    );
  }

  if (history === null) {
    return (
      <div className="border-t border-line pt-5" aria-busy="true">
        <p className="text-[12px] font-semibold text-sub">Email history</p>
        <div className="mt-2 flex flex-col gap-2">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-9 animate-pulse rounded-md bg-bg-soft" />
          ))}
        </div>
      </div>
    );
  }

  const { messages, stats, documents, foundersKnown } = history;

  const documentsBlock =
    documents.length > 0 ? (
      <div className="border-t border-line pt-5">
        <button
          type="button"
          className="flex w-full items-center gap-1.5 text-left"
          aria-expanded={docsOpen}
          onClick={() => setDocsOpen((v) => !v)}
        >
          <ChevronDown
            size={14}
            className={`text-sub transition-transform ${docsOpen ? "rotate-180" : ""}`}
            aria-hidden
          />
          <span className="text-[12px] font-semibold text-sub">
            Documents &amp; decks ({documents.length})
          </span>
        </button>
        {docsOpen && (
          <ul className="mt-2 flex flex-col gap-1.5">
            {documents.map((d: DealDocument, i: number) => (
              <li key={i} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[13px]">
                {d.url ? (
                  <a
                    href={d.url}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex min-w-0 items-center gap-1 font-medium text-primary hover:underline"
                    title={d.url}
                  >
                    <Launch size={12} className="shrink-0" />
                    <span className="truncate">
                      {d.kind ? `${d.kind} · ` : ""}
                      {prettyUrl(d.url)}
                    </span>
                  </a>
                ) : (
                  <span className="inline-flex min-w-0 items-center gap-1 font-medium text-body">
                    <Attachment size={12} className="shrink-0" />
                    <span className="truncate">{d.filename}</span>
                  </span>
                )}
                <span className="text-[11px] text-faint">
                  {d.fromSubject ? `from “${d.fromSubject.slice(0, 48)}”` : ""}
                  {d.receivedAt ? ` · ${dayYear(d.receivedAt)}` : ""}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    ) : null;

  if (stats.total === 0) {
    return (
      <>
        {documentsBlock}
        <div className="border-t border-line pt-5">
          <p className="text-[12px] font-semibold text-sub">Email history</p>
          <p className="mt-1.5 text-[13px] text-sub">
            {foundersKnown
              ? "No email history found for the founder emails attached to this deal."
              : "Add a founder email to connect email history."}
          </p>
        </div>
      </>
    );
  }

  const substantive = messages.filter((m) => !m.isEvent);
  const recent = [...substantive].reverse().slice(0, 3);

  // Conversations: newest activity first; messages oldest-first inside.
  const threads = (() => {
    const map = new Map<string, HistoryMessage[]>();
    for (const m of messages) {
      const cur = map.get(m.threadKey);
      if (cur) cur.push(m);
      else map.set(m.threadKey, [m]);
    }
    return [...map.values()].sort((a, b) =>
      (b[b.length - 1].sentAt ?? "").localeCompare(a[a.length - 1].sentAt ?? "")
    );
  })();

  const awaitingChip =
    stats.awaiting === "team"
      ? `Awaiting ${crm.org.name}`
      : stats.awaiting === "founder"
        ? "Awaiting founder"
        : null;

  const statsLine = (
    <p className="text-[13px] tabular-nums text-sub">
      {stats.total} message{stats.total === 1 ? "" : "s"}
      {" · "}
      {stats.founder} founder · {stats.team} {crm.org.name}
      {stats.first && stats.last && (
        <>
          {" · "}
          {day(stats.first)} to {day(stats.last)}
        </>
      )}
    </p>
  );

  return (
    <>
      {documentsBlock}
      <div className="border-t border-line pt-5">
        {!expanded ? (
          <div className="rounded-lg border border-line">
            <button
              type="button"
              className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left"
              aria-expanded={false}
              aria-label="Expand email history"
              onClick={() => setOpen(true)}
            >
              <span className="min-w-0">
                <span className="block text-[14px] font-semibold text-ink">
                  Email history
                </span>
                {statsLine}
              </span>
              <span className="flex shrink-0 items-center gap-2.5">
                {awaitingChip && (
                  <span className="rounded-md border border-line bg-bg-soft px-2 py-0.5 text-[12px] font-medium text-body">
                    {awaitingChip}
                  </span>
                )}
                <ChevronDown size={16} className="text-sub" aria-hidden />
              </span>
            </button>

            <ul className="border-t border-line">
              {recent.map((m) => (
                <li key={m.id}>
                  <button
                    type="button"
                    className="flex w-full items-baseline gap-3 px-4 py-2 text-left hover:bg-bg-soft"
                    onClick={() => {
                      scrollTo.current = `mail-${m.id}`;
                      setOpen(true);
                    }}
                  >
                    <span className="w-12 shrink-0 text-[12px] tabular-nums text-faint">
                      {day(m.sentAt)}
                    </span>
                    <span className="w-14 shrink-0 text-[12px] text-sub">
                      {CATEGORY_LABEL[m.sender.category]}
                    </span>
                    <span className="w-28 shrink-0 truncate text-[13px] font-medium text-ink">
                      {(m.sender.name || m.sender.email || "?").split("<")[0]}
                    </span>
                    <span className="min-w-0 flex-[2] truncate text-[13px] text-body">
                      {m.subject || "(no subject)"}
                    </span>
                    <span className="hidden min-w-0 flex-[2] truncate text-[12px] text-faint sm:block">
                      {m.preview}
                    </span>
                    {(m.attachments.length > 0 || m.deckLinks.length > 0) && (
                      <Attachment size={12} className="shrink-0 text-faint" aria-label="Has attachments" />
                    )}
                  </button>
                </li>
              ))}
            </ul>

            <button
              type="button"
              className="block w-full border-t border-line px-4 py-2 text-left text-[12px] font-medium text-sub transition-colors hover:text-primary"
              onClick={() => setOpen(true)}
            >
              View all {stats.total} messages
            </button>
          </div>
        ) : (
          <div className="rounded-lg border border-line transition-all duration-150">
            <div
              ref={readerRef}
              className="max-h-[600px] overflow-y-auto overscroll-contain"
            >
              <div className="sticky top-0 z-10 flex items-start justify-between gap-3 border-b border-line bg-bg px-4 py-3">
                <div className="min-w-0">
                  <p className="text-[14px] font-semibold text-ink">Email history</p>
                  <p className="text-[12px] tabular-nums text-sub">
                    {stats.total} messages across {stats.threads} conversation
                    {stats.threads === 1 ? "" : "s"}
                    {stats.first && ` · first ${dayYear(stats.first)}`}
                    {stats.last && ` · last ${dayYear(stats.last)}`}
                  </p>
                </div>
                <span className="flex shrink-0 items-center gap-2">
                  {history.messages.find((m) => m.sender.category === "founder" && m.sender.email) && (
                    <a
                      href={`https://mail.google.com/mail/u/0/#search/${encodeURIComponent(
                        history.messages.find((m) => m.sender.category === "founder" && m.sender.email)!
                          .sender.email!
                      )}`}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-[12px] font-medium text-sub hover:text-primary"
                    >
                      <Launch size={13} /> Open in Gmail
                    </a>
                  )}
                  <button
                    type="button"
                    aria-label="Collapse email history"
                    className="text-sub hover:text-primary"
                    onClick={() => setOpen(false)}
                  >
                    <ChevronDown size={16} className="rotate-180" aria-hidden />
                  </button>
                </span>
              </div>

              {threads.map((t) => {
                const sub = t.filter((m) => !m.isEvent);
                const heading =
                  (t[t.length - 1].subject ?? "(no subject)")
                    .replace(/^\s*(?:(?:re|fwd?|fw)\s*:\s*)+/i, "")
                    .trim() || "(no subject)";
                return (
                  <section key={t[0].threadKey} className="border-b border-line last:border-b-0">
                    <header className="px-4 pb-1 pt-3">
                      <h4 className="text-[13px] font-semibold text-ink">{heading}</h4>
                      <p className="text-[12px] tabular-nums text-faint">
                        {sub.length || t.length} message{(sub.length || t.length) === 1 ? "" : "s"}
                        {t[0].sentAt && t[t.length - 1].sentAt && (
                          <>
                            {" · "}
                            {day(t[0].sentAt)} to {day(t[t.length - 1].sentAt)}
                          </>
                        )}
                      </p>
                    </header>
                    <div className="divide-y divide-line/60">
                      {t.map((m) => (
                        <MessageView key={m.id} m={m} anchorId={`mail-${m.id}`} />
                      ))}
                    </div>
                  </section>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </>
  );
}
