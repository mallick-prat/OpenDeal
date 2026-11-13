"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Time,
  Calendar,
  Email,
  Edit,
  UserMultiple,
  Chat,
  CheckmarkOutline,
  Launch,
} from "@carbon/icons-react";
import { Overlay } from "./Overlay";
import { getDealActivity, type DealActivityView } from "@/app/actions";
import { describeActivity } from "@/lib/activityPure";
import { etLongMonthYear, etTime, etWeekdayDate } from "@/lib/etDates";

/**
 * Everything that has happened on a deal, in one panel.
 *
 * Meetings, mail and the audit trail answer the same question — "what has gone
 * on with this company?" — so they share one chronological stream rather than
 * three surfaces. Meetings and mail are matched on the founders' email
 * addresses; the audit trail is our own activity log.
 *
 * The layout is built for scanning: entries group by month so the shape of a
 * relationship is visible at a glance, timestamps are absolute (a real date —
 * "3mo ago" cannot answer "when exactly did we meet them?"), and meetings name
 * who was in the room rather than counting them.
 */

interface Interactions {
  matchedOn: string[];
  matchedDomains: string[];
  confirmed: string[];
  companyCount: number;
  lastContactAt: string | null;
  emailCount: number;
  meetingCount: number;
  messages: {
    id: string;
    sentAt: string | null;
    snippet: string;
    fromName: string;
    fromEmail: string;
  }[];
  meetings: {
    id: string;
    title: string;
    startsAt: string | null;
    endsAt: string | null;
    conferenceUrl: string | null;
    status: string | null;
    attendeeCount: number;
    attendees: string[];
  }[];
}

type Kind = "meeting" | "email" | "activity";
type Filter = "all" | Kind;

interface Item {
  key: string;
  kind: Kind;
  at: string;
  title: string;
  /** Second line: who was there, or what the mail said. */
  context?: string;
  meta?: string;
  cancelled?: boolean;
}

const PAGE = 12;

/* ── Time ─────────────────────────────────────────────────────────────────── */

function dateLabel(iso: string): string {
  return etWeekdayDate(iso);
}

function timeRange(startIso: string, endIso: string | null): string {
  const start = etTime(startIso);
  if (!endIso) return start;
  return `${start}–${etTime(endIso)}`;
}

function relative(iso: string, now: number): string {
  const days = Math.round((now - Date.parse(iso)) / 86_400_000);
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 0) return `in ${Math.abs(days)} days`;
  if (days < 30) return `${days} days ago`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months} months ago`;
  return `${Math.round(days / 365)} years ago`;
}

/** "May 2026" — the grouping key and its heading. */
function monthKey(iso: string): string {
  return etLongMonthYear(iso);
}

function KindIcon({ kind, title }: { kind: Kind; title: string }) {
  const cls = "shrink-0 text-faint";
  if (kind === "meeting") return <Calendar size={14} className={cls} />;
  if (kind === "email") return <Email size={14} className={cls} />;
  if (title.includes("owner")) return <UserMultiple size={14} className={cls} />;
  if (title.includes("comment")) return <Chat size={14} className={cls} />;
  if (title.includes("decision")) return <CheckmarkOutline size={14} className={cls} />;
  return <Edit size={14} className={cls} />;
}

/** Names, trimmed to what fits, with the remainder counted. */
function attendeeLine(names: string[], total: number): string {
  if (names.length === 0) return total > 0 ? `${total} guests` : "";
  const shown = names.slice(0, 3).join(", ");
  const rest = total - Math.min(names.length, 3);
  return rest > 0 ? `${shown} +${rest}` : shown;
}

export function DealHistoryPanel({
  gid,
  name,
  onClose,
}: {
  gid: string;
  name: string;
  onClose: () => void;
}) {
  const [inter, setInter] = useState<Interactions | null>(null);
  const [acts, setActs] = useState<DealActivityView[] | null>(null);
  const [state, setState] = useState<"loading" | "idle" | "error">("loading");
  const [nowTs, setNowTs] = useState(0);
  const [filter, setFilter] = useState<Filter>("all");
  const [oldestFirst, setOldestFirst] = useState(false);
  const [shown, setShown] = useState(PAGE);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [i, a] = await Promise.all([
        fetch(`/api/deals/${encodeURIComponent(gid)}/interactions`)
          .then((r) => (r.ok ? r.json() : null))
          .catch(() => null),
        getDealActivity(gid).catch(() => null),
      ]);
      if (cancelled) return;
      setNowTs(Date.now());
      setInter(i as Interactions | null);
      setActs(a && a.ok ? a.items : []);
      setState(i || a ? "idle" : "error");
    })();
    return () => {
      cancelled = true;
    };
  }, [gid]);

  const { upcoming, stream, counts } = useMemo(() => {
    const meetings = inter?.meetings ?? [];
    const up = meetings.filter((m) => m.startsAt && Date.parse(m.startsAt) > nowTs);

    const all: Item[] = [
      ...meetings
        .filter((m) => m.startsAt && Date.parse(m.startsAt) <= nowTs)
        .map((m) => ({
          key: `m-${m.id}`,
          kind: "meeting" as const,
          at: m.startsAt!,
          title: m.title,
          context: attendeeLine(m.attendees, m.attendeeCount),
          meta: timeRange(m.startsAt!, m.endsAt),
          cancelled: m.status === "cancelled",
        })),
      ...(inter?.messages ?? [])
        .filter((m) => m.sentAt)
        .map((m) => ({
          key: `e-${m.id}`,
          kind: "email" as const,
          at: m.sentAt!,
          title: m.fromName || m.fromEmail,
          context: m.snippet || undefined,
        })),
      ...(acts ?? []).map((a, i) => ({
        key: `a-${i}-${a.at}`,
        kind: "activity" as const,
        at: a.at,
        title: `${a.actorName} ${describeActivity(a.action, a.detail)}`,
      })),
    ];

    const c = {
      all: all.length,
      meeting: all.filter((x) => x.kind === "meeting").length,
      email: all.filter((x) => x.kind === "email").length,
      activity: all.filter((x) => x.kind === "activity").length,
    };

    const filtered = filter === "all" ? all : all.filter((x) => x.kind === filter);
    filtered.sort((x, y) =>
      oldestFirst
        ? Date.parse(x.at) - Date.parse(y.at)
        : Date.parse(y.at) - Date.parse(x.at)
    );
    return { upcoming: up, stream: filtered, counts: c };
  }, [inter, acts, nowTs, filter, oldestFirst]);

  const page = stream.slice(0, shown);

  // Month headings give the stream shape without a label on every row.
  const grouped: { month: string; items: Item[] }[] = [];
  for (const it of page) {
    const m = monthKey(it.at);
    const last = grouped[grouped.length - 1];
    if (last && last.month === m) last.items.push(it);
    else grouped.push({ month: m, items: [it] });
  }

  const tab = (id: Filter, label: string, n: number) => (
    <button
      key={id}
      onClick={() => {
        setFilter(id);
        setShown(PAGE);
      }}
      className={`px-2 py-0.5 text-[11px] transition-colors ${
        filter === id
          ? "bg-primary font-medium text-white"
          : "text-sub hover:text-primary"
      }`}
    >
      {label}
      {n > 0 && <span className="ml-1 opacity-70">{n}</span>}
    </button>
  );

  return (
    <Overlay
      title="History"
      subtitle={
        inter
          ? `${inter.meetingCount} meeting${inter.meetingCount === 1 ? "" : "s"} · ${inter.emailCount} email${inter.emailCount === 1 ? "" : "s"} · last contact ${
              inter.lastContactAt ? dateLabel(inter.lastContactAt) : "never"
            }`
          : name
      }
      onClose={onClose}
    >
      {state === "loading" && (
        <p className="py-2 text-[13px] text-faint">
          Looking through mail, calendar and activity…
        </p>
      )}
      {state === "error" && (
        <div className="callout p-3 text-[13px]">
          Couldn&rsquo;t load this. Close and try again.
        </div>
      )}

      {state === "idle" && (
        <div className="flex flex-col gap-3">
          {inter && inter.matchedOn.length === 0 ? (
            <div className="callout-parchment p-2.5 text-[12px] leading-snug text-sub">
              No founder email yet, so meetings and mail can&rsquo;t be matched.
              Add one on a founder row.
            </div>
          ) : (
            inter && (
              // Provenance, not headline — one quiet line that opens on demand.
              <details className="text-[11px] text-faint">
                <summary className="cursor-pointer select-none hover:text-sub">
                  Matched on {inter.matchedOn.length} address
                  {inter.matchedOn.length === 1 ? "" : "es"}
                  {inter.confirmed.length === 0 && " · unverified"}
                </summary>
                <p className="mt-1 leading-relaxed">
                  {inter.matchedOn.join(", ")}
                  {inter.matchedDomains.length > 0 &&
                    ` · plus anyone at ${inter.matchedDomains.join(", ")}`}
                </p>
              </details>
            )
          )}

          {/* Filter and sort share one row — height is the scarce resource. */}
          <div className="flex items-center justify-between gap-2 border-y border-line py-1.5">
            <div className="flex items-center gap-0.5">
              {tab("all", "All", counts.all)}
              {counts.meeting > 0 && tab("meeting", "Meetings", counts.meeting)}
              {counts.email > 0 && tab("email", "Email", counts.email)}
              {counts.activity > 0 && tab("activity", "Activity", counts.activity)}
            </div>
            <button
              onClick={() => setOldestFirst((v) => !v)}
              className="shrink-0 text-[11px] text-sub hover:text-primary"
              title="Reverse the order"
            >
              {oldestFirst ? "Oldest ↑" : "Newest ↓"}
            </button>
          </div>

          {upcoming.length > 0 && filter !== "email" && filter !== "activity" && (
            <section>
              <h4 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-primary">
                Upcoming
              </h4>
              <ul className="flex flex-col gap-2">
                {upcoming.map((m) => (
                  <li key={m.id} className="flex items-start gap-2">
                    <Calendar size={14} className="mt-0.5 shrink-0 text-primary" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink">
                          {m.title}
                        </span>
                        {m.conferenceUrl && (
                          <a
                            href={m.conferenceUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="shrink-0 text-primary hover:text-primary-pressed"
                            title="Join"
                          >
                            <Launch size={12} />
                          </a>
                        )}
                      </div>
                      <div className="text-[11px] text-sub">
                        {dateLabel(m.startsAt!)} · {timeRange(m.startsAt!, m.endsAt)}
                      </div>
                      {m.attendeeCount > 0 && (
                        <div className="truncate text-[11px] text-faint">
                          {attendeeLine(m.attendees, m.attendeeCount)}
                        </div>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {grouped.length > 0 ? (
            <div className="flex flex-col gap-3">
              {grouped.map((g) => (
                <section key={g.month}>
                  <h4 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-faint">
                    {g.month}
                  </h4>
                  <ul className="flex flex-col gap-2.5">
                    {g.items.map((it) => (
                      <li key={it.key} className="flex items-start gap-2">
                        <span className="mt-0.5">
                          <KindIcon kind={it.kind} title={it.title} />
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-baseline justify-between gap-2">
                            <span
                              className={`min-w-0 flex-1 truncate text-[13px] ${
                                it.kind === "activity"
                                  ? "text-body"
                                  : "font-medium text-ink"
                              } ${it.cancelled ? "line-through opacity-60" : ""}`}
                            >
                              {it.title}
                            </span>
                            {/* Absolute date, with the relative one on hover. */}
                            <span
                              className="shrink-0 text-[11px] text-faint"
                              title={relative(it.at, nowTs)}
                            >
                              {dateLabel(it.at)}
                            </span>
                          </div>
                          {(it.meta || it.context) && (
                            <div className="truncate text-[11px] text-faint">
                              {it.meta}
                              {it.meta && it.context ? " · " : ""}
                              {it.context}
                            </div>
                          )}
                        </div>
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          ) : (
            <p className="py-1 text-[13px] text-sub">
              {filter === "all"
                ? "Nothing recorded yet — no meetings, mail or changes."
                : `No ${filter === "meeting" ? "meetings" : filter} recorded.`}
            </p>
          )}

          {stream.length > shown && (
            <button
              onClick={() => setShown((n) => n + PAGE)}
              className="w-full border border-dashed border-line py-1.5 text-[12px] text-sub transition-colors hover:border-primary hover:text-primary"
            >
              Show {Math.min(PAGE, stream.length - shown)} more · {shown} of{" "}
              {stream.length}
            </button>
          )}

          {inter && inter.companyCount > 0 && (
            <p className="border-t border-line pt-2.5 text-[11px] text-faint">
              {inter.companyCount} further exchange
              {inter.companyCount === 1 ? "" : "s"} with others at{" "}
              {inter.matchedDomains.join(", ")}, counted separately.
            </p>
          )}
        </div>
      )}
    </Overlay>
  );
}

/** The clock affordance on a deal card. */
export function DealHistoryButton({ gid, name }: { gid: string; name: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        className="tap flex items-center justify-center p-1 text-sub transition-colors hover:text-primary"
        title="History — meetings, email and activity"
        aria-label={`History for ${name}`}
        onClick={(e) => {
          e.stopPropagation();
          setOpen(true);
        }}
      >
        <Time size={16} />
      </button>
      {open && (
        <DealHistoryPanel gid={gid} name={name} onClose={() => setOpen(false)} />
      )}
    </>
  );
}
