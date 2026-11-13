"use client";

import { useEffect, useRef, useState } from "react";
import { Calendar, Close } from "@carbon/icons-react";
import { scheduleRosterAction, scheduleSuggestAction } from "@/app/actions";
import {
  defaultConstraints,
  formatSlotsForEmail,
  parseWhen,
  type ScheduleSlot,
  type SchedulingConstraints,
} from "@/lib/schedulePure";
import type { ScheduleRosterEntry } from "@/lib/schedule";
import { etLongMonthDay } from "@/lib/etDates";

/**
 * The composer's Schedule panel: describe constraints in plain language,
 * see EXACTLY how they resolved, edit them as ordinary controls, review
 * conflict-free times, and insert them as text at the cursor. Deterministic
 * parsing, live FreeBusy, no holds, no event creation — a utility, not an
 * assistant.
 */

const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function fmtRange(c: SchedulingConstraints): string {
  const f = (k: string) => {
    const [y, m, d] = k.split("-").map(Number);
    return etLongMonthDay(new Date(Date.UTC(y, m - 1, d, 12)));
  };
  return `${f(c.dateStart)} to ${f(c.dateEnd)}`;
}

function fmtClock(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  const ampm = h >= 12 ? "PM" : "AM";
  const hh = h % 12 === 0 ? 12 : h % 12;
  return `${hh}:${String(m).padStart(2, "0")} ${ampm}`;
}

export function SchedulePanel({
  viewerEmail,
  onInsert,
  onClose,
}: {
  viewerEmail: string;
  /** Receives the finished text block for cursor insertion. */
  onInsert: (text: string) => void;
  onClose: () => void;
}) {
  const nowISO = useRef(new Date().toISOString()).current;
  const [roster, setRoster] = useState<ScheduleRosterEntry[]>([]);
  const [c, setC] = useState<SchedulingConstraints>(() => defaultConstraints(nowISO, viewerEmail));
  const [when, setWhen] = useState("");
  const [parseNote, setParseNote] = useState("");
  const [more, setMore] = useState(false);
  const [slots, setSlots] = useState<ScheduleSlot[] | null>(null);
  const [checkedAt, setCheckedAt] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [unavailable, setUnavailable] = useState<string[]>([]);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void scheduleRosterAction().then((r) => {
      if (r.ok && r.roster) setRoster(r.roster);
    });
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const nameOf = (id: string) =>
    roster.find((r) => r.email === id)?.name ?? (id === viewerEmail ? "You" : id);

  const applyParse = () => {
    const outcome = parseWhen(when, nowISO, roster.filter((r) => r.hasCalendar));
    const merged: SchedulingConstraints = { ...c, ...outcome.constraints };
    if (outcome.constraints.calendarParticipantIds) {
      // "with Sam" adds Sam — the viewer's calendar stays.
      merged.calendarParticipantIds = [
        ...new Set([viewerEmail, ...outcome.constraints.calendarParticipantIds]),
      ];
    }
    setC(merged);
    setSlots(null);
    const notes: string[] = [];
    if (outcome.clarify) notes.push(outcome.clarify);
    if (outcome.unresolved.length > 0) notes.push(`Didn't understand ${outcome.unresolved.join(", ")}.`);
    setParseNote(notes.join(" "));
  };

  const fetchSlots = async (exclude: string[] = []) => {
    setBusy(true);
    setError("");
    setUnavailable([]);
    const res = await scheduleSuggestAction(
      {
        durationMinutes: c.durationMinutes,
        dateStart: c.dateStart,
        dateEnd: c.dateEnd,
        allowedWeekdays: c.allowedWeekdays,
        dailyStartTime: c.dailyStartTime,
        dailyEndTime: c.dailyEndTime,
        suggestionCount: c.suggestionCount,
        minimumNoticeMinutes: c.minimumNoticeMinutes,
        calendarParticipantIds: c.calendarParticipantIds,
      },
      exclude
    );
    setBusy(false);
    if (!res.ok) {
      setUnavailable(res.unavailable ?? []);
      setError(res.error ?? "Couldn't check availability.");
      return;
    }
    setSlots(res.slots ?? []);
    setCheckedAt(res.checkedAt ?? null);
  };

  const toggleParticipant = (email: string) => {
    setSlots(null);
    setC((prev) => ({
      ...prev,
      calendarParticipantIds: prev.calendarParticipantIds.includes(email)
        ? prev.calendarParticipantIds.filter((e) => e !== email)
        : [...prev.calendarParticipantIds, email],
    }));
  };

  const staleMinutes = checkedAt
    ? Math.round((Date.now() - new Date(checkedAt).getTime()) / 60000)
    : null;

  const selectable = roster.filter((r) => r.hasCalendar);
  const unavailableRoster = roster.filter((r) => !r.hasCalendar);

  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-label="Schedule times"
      className="absolute bottom-full left-0 right-0 z-40 mb-2 border border-line-strong bg-bg p-3 shadow-lg sm:right-auto sm:w-[480px]"
    >
      <div className="flex items-center justify-between gap-2 border-b border-line pb-2">
        <span className="flex items-center gap-1.5 text-[13px] font-semibold text-ink">
          <Calendar size={15} aria-hidden /> Schedule
        </span>
        <button className="tap-sm p-1 text-sub hover:text-ink" aria-label="Close scheduling" onClick={onClose}>
          <Close size={18} />
        </button>
      </div>

      {/* Calendars */}
      <div className="mt-2.5">
        <span className="text-[11.5px] font-semibold uppercase tracking-wide text-sub">
          Calendar participants
        </span>
        <div className="mt-1 flex flex-wrap gap-1.5">
          {selectable.map((r) => {
            const on = c.calendarParticipantIds.includes(r.email);
            return (
              <button
                key={r.email}
                className={`tag ${on ? "!border-primary !text-primary" : ""}`}
                aria-pressed={on}
                title={r.kind === "linked" ? "Shared calendar (free/busy via your account)" : "Connected calendar"}
                onClick={() => toggleParticipant(r.email)}
              >
                {r.email === viewerEmail ? "You" : r.name}
              </button>
            );
          })}
          {unavailableRoster.map((r) => (
            <span key={r.email} className="tag !text-faint" title="No calendar connected — ask them to connect Google in Settings">
              {r.name} · unavailable
            </span>
          ))}
        </div>
      </div>

      {/* Duration + When */}
      <div className="mt-2.5 flex flex-wrap items-end gap-2">
        <label className="block">
          <span className="mb-0.5 block text-[11.5px] font-semibold uppercase tracking-wide text-sub">
            Length
          </span>
          <select
            className="field !h-9 !w-28 !text-[13px]"
            value={c.durationMinutes}
            onChange={(e) => {
              setC({ ...c, durationMinutes: Number(e.target.value) });
              setSlots(null);
            }}
          >
            {[15, 20, 30, 45, 60, 90].map((d) => (
              <option key={d} value={d}>
                {d} minutes
              </option>
            ))}
          </select>
        </label>
        <label className="block min-w-0 flex-1">
          <span className="mb-0.5 block text-[11.5px] font-semibold uppercase tracking-wide text-sub">
            When
          </span>
          <input
            className="field !h-9 !text-[13px]"
            placeholder='e.g. "next week in the afternoon" — Enter applies'
            value={when}
            onChange={(e) => setWhen(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                applyParse();
              }
            }}
            onBlur={() => when.trim() && applyParse()}
          />
        </label>
      </div>
      {parseNote && <p className="mt-1 text-[12px] text-primary-pressed">{parseNote}</p>}

      {/* The interpretation, visible and editable — never a hidden guess. */}
      <p className="mt-2 text-[12.5px] text-body">
        {fmtRange(c)} · {fmtClock(c.dailyStartTime)}–{fmtClock(c.dailyEndTime)} ET ·{" "}
        {c.allowedWeekdays.length === 5 && c.allowedWeekdays.every((d) => d <= 5)
          ? "Weekdays"
          : c.allowedWeekdays.map((d) => DAY_LABELS[d - 1]).join(", ")}{" "}
        · {c.suggestionCount} option{c.suggestionCount === 1 ? "" : "s"}{" "}
        <button className="ml-1 text-[12px] font-medium text-primary hover:underline" onClick={() => setMore((v) => !v)}>
          {more ? "Fewer options" : "More options"}
        </button>
      </p>

      {more && (
        <div className="mt-2 grid grid-cols-2 gap-2 border border-line bg-bg-soft p-2.5 sm:grid-cols-3">
          <label className="block">
            <span className="mb-0.5 block text-[11px] font-semibold uppercase text-sub">From</span>
            <input type="date" className="field !h-8 !text-[12.5px]" value={c.dateStart}
              onChange={(e) => { setC({ ...c, dateStart: e.target.value }); setSlots(null); }} />
          </label>
          <label className="block">
            <span className="mb-0.5 block text-[11px] font-semibold uppercase text-sub">To</span>
            <input type="date" className="field !h-8 !text-[12.5px]" value={c.dateEnd}
              onChange={(e) => { setC({ ...c, dateEnd: e.target.value }); setSlots(null); }} />
          </label>
          <label className="block">
            <span className="mb-0.5 block text-[11px] font-semibold uppercase text-sub">Options</span>
            <select className="field !h-8 !text-[12.5px]" value={c.suggestionCount}
              onChange={(e) => { setC({ ...c, suggestionCount: Number(e.target.value) }); setSlots(null); }}>
              {[1, 2, 3, 4, 5, 6, 7, 8].map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
          <label className="block">
            <span className="mb-0.5 block text-[11px] font-semibold uppercase text-sub">Day start</span>
            <input type="time" className="field !h-8 !text-[12.5px]" value={c.dailyStartTime}
              onChange={(e) => { setC({ ...c, dailyStartTime: e.target.value }); setSlots(null); }} />
          </label>
          <label className="block">
            <span className="mb-0.5 block text-[11px] font-semibold uppercase text-sub">Day end</span>
            <input type="time" className="field !h-8 !text-[12.5px]" value={c.dailyEndTime}
              onChange={(e) => { setC({ ...c, dailyEndTime: e.target.value }); setSlots(null); }} />
          </label>
          <fieldset className="col-span-2 sm:col-span-3">
            <legend className="mb-0.5 text-[11px] font-semibold uppercase text-sub">Days</legend>
            <div className="flex flex-wrap gap-1">
              {DAY_LABELS.map((label, i) => {
                const day = i + 1;
                const on = c.allowedWeekdays.includes(day);
                return (
                  <button key={day} className={`tag !px-2 !py-0.5 !text-[11.5px] ${on ? "!border-primary !text-primary" : ""}`}
                    aria-pressed={on}
                    onClick={() => {
                      const next = on ? c.allowedWeekdays.filter((d) => d !== day) : [...c.allowedWeekdays, day].sort();
                      if (next.length > 0) { setC({ ...c, allowedWeekdays: next }); setSlots(null); }
                    }}>
                    {label}
                  </button>
                );
              })}
            </div>
          </fieldset>
        </div>
      )}

      {/* Times */}
      <div className="mt-2.5">
        {slots === null ? (
          <button className="btn-primary tap !text-[13px]" disabled={busy || c.calendarParticipantIds.length === 0} onClick={() => void fetchSlots()}>
            {busy ? "Checking calendars…" : "Find times"}
          </button>
        ) : slots.length === 0 ? (
          <div className="border border-line bg-bg-soft p-2.5 text-[12.5px] text-body">
            No common availability in this range.
            <span className="mt-1 block text-faint">
              Try a wider date range, longer days, fewer calendars, or a shorter meeting — nothing was changed automatically.
            </span>
          </div>
        ) : (
          <>
            <ul className="flex flex-col divide-y divide-line border border-line" aria-label="Suggested times">
              {slots.map((s) => (
                <li key={s.startISO} className="flex items-center gap-2 px-2.5 py-1.5">
                  <span className="min-w-0 flex-1 text-[13px] text-ink">
                    {s.dayLabel} · <span className="font-semibold">{s.timeLabel}</span>
                    <span className="text-faint"> ET</span>
                  </span>
                  <button className="tap-sm text-[12px] font-medium text-sub hover:text-primary"
                    aria-label={`Remove ${s.dayLabel} ${s.timeLabel}`}
                    onClick={() => setSlots(slots.filter((x) => x.startISO !== s.startISO))}>
                    Remove
                  </button>
                </li>
              ))}
            </ul>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-faint">
              {staleMinutes !== null && (
                <span>
                  Availability checked {staleMinutes < 1 ? "just now" : `${staleMinutes} minute${staleMinutes === 1 ? "" : "s"} ago`}.
                </span>
              )}
              <button className="font-medium text-sub hover:text-primary" disabled={busy}
                onClick={() => void fetchSlots(slots.map((s) => s.startISO))}>
                Generate different times
              </button>
              <button className="font-medium text-sub hover:text-primary" disabled={busy}
                onClick={() => void fetchSlots()}>
                Refresh
              </button>
            </div>
          </>
        )}
        {error && (
          <p className="mt-1.5 text-[12.5px] text-primary-pressed">
            {unavailable.length > 0
              ? `Availability unavailable for ${unavailable.map(nameOf).join(", ")} — remove that calendar or reconnect it in Settings.`
              : error}
          </p>
        )}
      </div>

      <div className="mt-3 flex items-center justify-end gap-2 border-t border-line pt-2.5">
        <button className="tap-sm text-[13px] font-medium text-sub hover:text-primary" onClick={onClose}>
          Cancel
        </button>
        <button className="btn-primary tap !text-[13px]" disabled={!slots || slots.length === 0}
          onClick={() => {
            if (slots && slots.length > 0) {
              onInsert(formatSlotsForEmail(slots));
              onClose();
            }
          }}>
          Insert times
        </button>
      </div>
    </div>
  );
}
