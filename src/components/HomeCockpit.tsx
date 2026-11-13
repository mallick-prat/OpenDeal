"use client";

import { GranolaMark } from "@/components/GranolaMark";
import { useEffect, useState } from "react";
import Link from "next/link";
import { Calendar, Email, Launch } from "@carbon/icons-react";
import { etWeekdayDay } from "@/lib/etDates";

/**
 * Home's working panels: the inbox queue and the personal meeting strip.
 * Home is where the day starts, so it shows the three live surfaces side by
 * side — what arrived (inbox), where you'll be (calendar), what's moving
 * (live deals, rendered by the parent). Everything links into the full
 * surface it previews; nothing here duplicates an action that lives there.
 */

export interface CockpitData {
  granola: {
    id: string;
    title: string | null;
    dealGid: string;
    dealName: string | null;
    count: number;
    state: "ready" | "applied";
  }[];
  changes: { dealGid: string | null; dealName: string | null; rest: string; at: string }[];
  queue: {
    id: string;
    company: string | null;
    subject: string | null;
    fromName: string | null;
    status: string;
    confidence: number | null;
    receivedAt: string | null;
  }[];
  meetings: {
    id: string;
    title: string;
    startsAt: string | null;
    upcoming: boolean;
    companies: {
      domain: string;
      investor: boolean;
      dealGid: string | null;
      dealName: string | null;
      candidateId: string | null;
    }[];
  }[];
}

function ago(iso: string | null): string {
  if (!iso) return "";
  const days = Math.round((Date.now() - Date.parse(iso)) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  return `${days}d ago`;
}

function dayTime(iso: string | null): string {
  if (!iso) return "";
  return etWeekdayDay(iso);
}

/** Rows per page in the two cockpit lists — enough to scan, never scrolls. */
const INBOX_PAGE = 7;
const MEETINGS_PAGE = 6;

function MiniPager({
  page,
  pages,
  onPage,
}: {
  page: number;
  pages: number;
  onPage: (p: number) => void;
}) {
  if (pages <= 1) return null;
  return (
    <div className="mt-auto flex items-center justify-end gap-2 border-t border-line pt-2">
      <button
        className="tag shrink-0"
        disabled={page === 0}
        style={page === 0 ? { opacity: 0.4, cursor: "default" } : undefined}
        onClick={() => onPage(page - 1)}
        aria-label="Previous page"
      >
        ←
      </button>
      <span className="whitespace-nowrap text-[11px] text-faint">
        {page + 1} / {pages}
      </span>
      <button
        className="tag shrink-0"
        disabled={page >= pages - 1}
        style={page >= pages - 1 ? { opacity: 0.4, cursor: "default" } : undefined}
        onClick={() => onPage(page + 1)}
        aria-label="Next page"
      >
        →
      </button>
    </div>
  );
}

function PanelSearch({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
}) {
  return (
    <input
      className="field mb-2 !h-7 !text-[12px]"
      placeholder={placeholder}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

export function useCockpit(active: boolean) {
  const [data, setData] = useState<CockpitData | null>(null);
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch("/api/home/cockpit");
        if (!res.ok) return;
        const json = (await res.json()) as { ok: boolean } & CockpitData;
        if (!cancelled && json.ok) {
          setData({
            queue: json.queue,
            meetings: json.meetings,
            granola: json.granola ?? [],
            changes: json.changes ?? [],
          });
        }
      } catch {
        // Home still renders live deals; panels show their loading line.
      }
    };
    const t = setTimeout(load, 0);
    // Boarding a deal in another tab (or on /inbox) must not leave a stale
    // queue here — refresh whenever the user comes back to this tab.
    const onWake = () => {
      if (document.visibilityState === "visible") void load();
    };
    window.addEventListener("focus", onWake);
    document.addEventListener("visibilitychange", onWake);
    return () => {
      cancelled = true;
      clearTimeout(t);
      window.removeEventListener("focus", onWake);
      document.removeEventListener("visibilitychange", onWake);
    };
  }, [active]);
  return data;
}

export function InboxPanel({ data }: { data: CockpitData | null }) {
  const [q, setQ] = useState("");
  const [page, setPage] = useState(0);
  const queue = data?.queue ?? [];
  const needle = q.trim().toLowerCase();
  const hits = needle
    ? queue.filter((c) =>
        [c.company, c.subject, c.fromName].some((s) =>
          s?.toLowerCase().includes(needle)
        )
      )
    : queue;
  const pages = Math.max(1, Math.ceil(hits.length / INBOX_PAGE));
  const safePage = Math.min(page, pages - 1);
  const visible = hits.slice(
    safePage * INBOX_PAGE,
    safePage * INBOX_PAGE + INBOX_PAGE
  );

  return (
    <div className="card-flat flex min-h-0 flex-1 flex-col p-4">
      <div className="mb-3 flex items-baseline justify-between">
        <h3 className="flex items-center gap-2 text-[15px] font-semibold text-ink">
          <Email size={16} /> Inbox
        </h3>
        <Link
          href="/inbox"
          className="text-[12px] font-medium text-primary hover:text-primary-pressed"
        >
          Open queue →
        </Link>
      </div>
      {queue.length > INBOX_PAGE && (
        <PanelSearch
          value={q}
          onChange={(v) => {
            setQ(v);
            setPage(0);
          }}
          placeholder="Filter the queue…"
        />
      )}
      {data === null ? (
        <p className="text-[13px] text-faint">Loading the queue…</p>
      ) : queue.length === 0 ? (
        <p className="text-[13px] text-sub">
          Queue clear — nothing waiting on you.
        </p>
      ) : hits.length === 0 ? (
        <p className="text-[13px] text-sub">Nothing matches “{q.trim()}”.</p>
      ) : (
        <ul className="min-h-0 flex-1 divide-y divide-line overflow-y-auto">
          {visible.map((c) => (
            <li key={c.id}>
              <Link
                href={`/inbox/${c.id}`}
                className="flex items-baseline justify-between gap-3 py-2 hover:bg-bg-soft"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-medium text-ink">
                    {c.company ?? c.subject ?? "(untitled pitch)"}
                  </span>
                  <span className="block truncate text-[11px] text-faint">
                    {c.fromName ?? ""}
                    {c.status === "parsing" && " · parsing…"}
                  </span>
                </span>
                <span className="shrink-0 text-[11px] text-faint">
                  {ago(c.receivedAt)}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      <MiniPager page={safePage} pages={pages} onPage={setPage} />
    </div>
  );
}

export function CalendarPanel({ data }: { data: CockpitData | null }) {
  const [q, setQ] = useState("");
  const [page, setPage] = useState(0);
  const meetings = data?.meetings ?? null;
  // Soonest upcoming first, then the most recent past — the triage order.
  const ordered = [
    ...(meetings ?? []).filter((m) => m.upcoming).reverse(),
    ...(meetings ?? []).filter((m) => !m.upcoming),
  ];
  const needle = q.trim().toLowerCase();
  const hits = needle
    ? ordered.filter(
        (m) =>
          m.title.toLowerCase().includes(needle) ||
          m.companies.some(
            (c) =>
              c.domain.toLowerCase().includes(needle) ||
              c.dealName?.toLowerCase().includes(needle)
          )
      )
    : ordered;
  const pages = Math.max(1, Math.ceil(hits.length / MEETINGS_PAGE));
  const safePage = Math.min(page, pages - 1);
  const rows = hits.slice(
    safePage * MEETINGS_PAGE,
    safePage * MEETINGS_PAGE + MEETINGS_PAGE
  );

  return (
    <div className="card-flat flex min-h-0 flex-1 flex-col p-4">
      <div className="mb-3 flex items-baseline justify-between">
        <h3 className="flex items-center gap-2 text-[15px] font-semibold text-ink">
          <Calendar size={16} /> Meetings
        </h3>
        <Link
          href="/inbox"
          className="text-[12px] font-medium text-primary hover:text-primary-pressed"
        >
          Triage →
        </Link>
      </div>
      {ordered.length > MEETINGS_PAGE && (
        <PanelSearch
          value={q}
          onChange={(v) => {
            setQ(v);
            setPage(0);
          }}
          placeholder="Filter meetings…"
        />
      )}
      {meetings === null ? (
        <p className="text-[13px] text-faint">Reading the calendar…</p>
      ) : ordered.length === 0 ? (
        <p className="text-[13px] text-sub">No external meetings in range.</p>
      ) : rows.length === 0 ? (
        <p className="text-[13px] text-sub">Nothing matches “{q.trim()}”.</p>
      ) : (
        <ul className="min-h-0 flex-1 divide-y divide-line overflow-y-auto">
          {rows.map((m) => {
            const tied = m.companies.find((c) => c.dealGid);
            const openPitch = m.companies.find((c) => c.candidateId);
            return (
              <li
                key={m.id}
                className="flex items-baseline justify-between gap-3 py-2"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] text-ink">
                    {m.upcoming && (
                      <span className="mr-1.5 font-semibold text-primary">•</span>
                    )}
                    {m.title}
                  </span>
                  <span className="block truncate text-[11px] text-faint">
                    {dayTime(m.startsAt)}
                    {tied?.dealName &&
                      ` · ${tied.dealName.split("//").pop()?.trim()}`}
                  </span>
                </span>
                {tied?.dealGid ? (
                  <Link
                    href={`/deals/${tied.dealGid}`}
                    className="shrink-0 text-primary hover:text-primary-pressed"
                    title={tied.dealName ?? "Open deal"}
                  >
                    <Launch size={13} />
                  </Link>
                ) : openPitch?.candidateId ? (
                  <Link
                    href={`/inbox/${openPitch.candidateId}`}
                    className="shrink-0 text-[11px] font-medium text-primary hover:text-primary-pressed"
                  >
                    pitch →
                  </Link>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      <MiniPager page={safePage} pages={pages} onPage={setPage} />
    </div>
  );
}

export function GranolaPanel({ data }: { data: CockpitData | null }) {
  const notes = (data?.granola ?? []).filter((g) => g.state === "ready");
  if (notes.length === 0) return null;
  return (
    <div className="card-flat shrink-0 p-4">
      <div className="mb-2 flex items-baseline justify-between">
        <h3 className="flex items-center gap-2 text-[15px] font-semibold text-ink">
          <GranolaMark size={16} className="" />
          Granola updates
        </h3>
        <Link
          href="/inbox?source=granola"
          className="text-[12px] font-medium text-primary hover:text-primary-pressed"
        >
          Review →
        </Link>
      </div>
      <ul className="flex flex-col divide-y divide-line">
        {notes.map((g) => (
          <li key={g.id}>
            <Link
              href={`/inbox/note/${g.id}`}
              className="flex items-baseline justify-between gap-3 py-1.5 hover:bg-bg-soft"
            >
              <span className="min-w-0 flex-1 truncate text-[13px] text-ink">
                {g.dealName ? g.dealName.split("//").pop()?.trim() : g.title}
              </span>
              <span className="shrink-0 text-[12px] font-medium text-primary">
                {g.count} update{g.count === 1 ? "" : "s"}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function ChangesPanel({ data }: { data: CockpitData | null }) {
  const changes = data?.changes ?? [];
  if (changes.length === 0) return null;
  return (
    <div className="card-flat flex min-h-0 flex-1 flex-col p-4">
      <h3 className="mb-2 text-[15px] font-semibold text-ink">Recent changes</h3>
      <ul className="min-h-0 flex-1 divide-y divide-line overflow-y-auto">
        {changes.map((c, i) => (
          <li key={i}>
            {c.dealGid ? (
              <Link
                href={`/deals/${c.dealGid}`}
                className="flex items-baseline justify-between gap-3 py-1.5 hover:bg-bg-soft"
              >
                <span className="min-w-0 flex-1 truncate text-[13px]">
                  <span className="font-medium text-ink">{c.dealName ?? "A deal"}</span>{" "}
                  <span className="text-sub">{c.rest}</span>
                </span>
                <span className="shrink-0 text-[11px] text-faint">{ago(c.at)}</span>
              </Link>
            ) : (
              <span className="flex items-baseline justify-between gap-3 py-1.5">
                <span className="min-w-0 flex-1 truncate text-[13px]">
                  <span className="font-medium text-ink">{c.dealName ?? "A deal"}</span>{" "}
                  <span className="text-sub">{c.rest}</span>
                </span>
                <span className="shrink-0 text-[11px] text-faint">{ago(c.at)}</span>
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
