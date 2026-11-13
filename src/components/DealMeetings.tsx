"use client";

import { GranolaMark } from "@/components/GranolaMark";
import { crm } from "@/config/crm.config";
import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, Launch, Subtract } from "@carbon/icons-react";
import {
  detachNoteFromDealAction,
  getDealMeetingsAction,
  unmatchMeetingAction,
} from "@/app/actions";
import type { DealMeeting, DealNote } from "@/lib/meetings";
import type { CalendarMatchEvidence } from "@/lib/calendarPure";
import { INTERNAL_DOMAINS } from "@/lib/companiesPure";
import { etTime, etWeekdayDay } from "@/lib/etDates";

/**
 * Calendar meetings the sync matched to this deal (calendarSync.ts). Read-only
 * except for the one correction that matters: a low-confidence match shows why
 * it matched and a one-click "Not this deal?" to detach it.
 */

/**
 * Summary first, full meeting notes behind one quiet toggle — the room's
 * context without scrolling the card into a wall of text.
 */
function NoteBody({ note }: { note: DealNote }) {
  const [showFull, setShowFull] = useState(false);
  return (
    <>
      {note.summary && !showFull && (
        <p className="mt-1 whitespace-pre-wrap text-[12px] leading-relaxed text-body">
          {note.summary}
        </p>
      )}
      {note.transcript && (
        <>
          <button
            type="button"
            className="mt-1 text-[11px] font-medium text-sub transition-colors hover:text-primary"
            aria-expanded={showFull}
            onClick={() => setShowFull((v) => !v)}
          >
            {showFull ? "Hide transcript context" : "View transcript context"}
          </button>
          {showFull && (
            <div className="mt-1 max-h-72 overflow-y-auto border-l-2 border-line pl-2.5">
              <p className="whitespace-pre-wrap text-[12px] leading-relaxed text-body">
                {note.transcript}
              </p>
            </div>
          )}
        </>
      )}
    </>
  );
}

function noteUrl(n: DealNote): string | null {
  return n.url;
}

/** "Mon, Jul 21 · 2:00 PM" in Eastern time. */
function fmtWhen(iso: string): string {
  return `${etWeekdayDay(iso)} · ${etTime(iso)}`;
}

/**
 * The − in a card's top-right corner. Never removes on the first click:
 * a small confirmation slides open right underneath, and only its Remove
 * commits. Escape or clicking anywhere else keeps the card.
 */
function RemoveControl({
  label,
  confirmText,
  busy,
  onConfirm,
}: {
  label: string;
  confirmText: string;
  busy: boolean;
  onConfirm: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <div ref={ref} className="relative shrink-0">
      <button
        type="button"
        aria-label={label}
        title={label}
        aria-expanded={open}
        aria-haspopup="dialog"
        disabled={busy}
        className="flex h-5 w-5 items-center justify-center rounded text-faint transition-colors hover:bg-bg-soft hover:text-primary disabled:opacity-50"
        onClick={() => setOpen((v) => !v)}
      >
        <Subtract size={14} aria-hidden />
      </button>
      {open && (
        <div
          role="dialog"
          aria-label={confirmText}
          className="absolute right-0 top-full z-30 mt-1 w-max max-w-[240px] rounded-lg border border-line bg-bg px-2.5 py-2 shadow-lg"
        >
          <p className="text-[11.5px] text-body">{confirmText}</p>
          <div className="mt-1.5 flex items-center justify-end gap-3">
            <button
              type="button"
              className="text-[11.5px] font-medium text-sub transition-colors hover:text-ink"
              onClick={() => setOpen(false)}
            >
              Keep
            </button>
            <button
              type="button"
              className="text-[11.5px] font-semibold text-primary transition-colors hover:underline"
              onClick={() => {
                setOpen(false);
                onConfirm();
              }}
            >
              Remove
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Not cancelled and starts in the future (evaluated at render time). */
function isUpcoming(m: DealMeeting): boolean {
  return m.status !== "cancelled" && new Date(m.startsAt).getTime() > Date.now();
}

function isInternal(email: string): boolean {
  return INTERNAL_DOMAINS.has(email.slice(email.lastIndexOf("@") + 1));
}

function externalAttendees(m: DealMeeting): string[] {
  return m.attendees.map((a) => a.email).filter((e) => !isInternal(e));
}

/** "45 min" / "1.5 h" when both ends are known. */
function durationText(startsAt: string, endsAt: string | null): string | null {
  if (!endsAt) return null;
  const mins = Math.round((Date.parse(endsAt) - Date.parse(startsAt)) / 60_000);
  if (mins <= 0 || mins > 12 * 60) return null;
  return mins < 60 ? `${mins} min` : `${(mins / 60).toFixed(mins % 60 === 0 ? 0 : 1)} h`;
}

/** Why the matcher put this meeting on the deal, in plain words. */
function evidenceText(evidence: CalendarMatchEvidence[]): string {
  const first = evidence[0];
  if (!first) return "Matched automatically";
  if (first.kind === "attendee_email") return `Matched by attendee ${first.value}`;
  return `Matched by “${first.value}” in the title`;
}

export function DealMeetings({ gid }: { gid: string }) {
  const [items, setItems] = useState<DealMeeting[] | null>(null);
  const [looseNotes, setLooseNotes] = useState<DealNote[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  // One meeting unfolds at a time: attendees, duration, match evidence.
  const [openId, setOpenId] = useState<string | null>(null);
  const [sectionOpen, setSectionOpen] = useState(true);

  const load = useCallback(async () => {
    const res = await getDealMeetingsAction(gid);
    if (res.ok) {
      setItems(res.items);
      setLooseNotes(res.looseNotes ?? []);
    } else setError(res.error);
  }, [gid]);

  // Initial fetch on open (and when switching to another deal). The guard drops
  // a late response after the deal changed or the modal closed.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await getDealMeetingsAction(gid);
      if (cancelled) return;
      if (res.ok) {
        setItems(res.items);
        setLooseNotes(res.looseNotes ?? []);
      } else setError(res.error);
    })();
    return () => {
      cancelled = true;
    };
  }, [gid]);

  const unmatch = async (m: DealMeeting) => {
    setBusy(m.id);
    // Optimistic: drop it now. The paired Granola note rides along so it
    // doesn't resurface as a loose card after the meeting detaches.
    setItems((cur) => (cur ? cur.filter((x) => x.id !== m.id) : cur));
    const res = await unmatchMeetingAction(m.id, gid, m.granola?.id);
    setBusy(null);
    if (!res.ok) {
      setError(res.error ?? "Couldn't unmatch the meeting.");
      await load(); // put it back if the detach failed
    }
  };

  const removeNote = async (n: DealNote) => {
    setBusy(n.id);
    setLooseNotes((cur) => cur.filter((x) => x.id !== n.id));
    const res = await detachNoteFromDealAction(n.id, gid);
    setBusy(null);
    if (!res.ok) {
      setError(res.error ?? "Couldn't remove the note.");
      await load();
    }
  };

  // No matched meetings → no section at all (no empty-state noise in the modal).
  if (items !== null && items.length === 0 && looseNotes.length === 0 && !error) return null;

  return (
    <div className="border-t border-line pt-5">
      <button
        type="button"
        className="mb-2 flex w-full items-center gap-1.5 text-left"
        aria-expanded={sectionOpen}
        onClick={() => setSectionOpen((v) => !v)}
      >
        <ChevronDown
          size={14}
          className={`text-sub transition-transform ${sectionOpen ? "rotate-180" : ""}`}
          aria-hidden
        />
        <span className="text-[12px] font-semibold text-sub">
          Meetings{items ? ` (${items.length + looseNotes.length})` : ""}
        </span>
      </button>

      {items === null && !error && (
        <p role="status" aria-live="polite" className="py-1 text-[13px] text-faint">
          Loading meetings…
        </p>
      )}
      {error && <p className="py-1 text-[12px] text-primary">{error}</p>}

      {sectionOpen && items !== null && items.length > 0 && (
        <ul className="flex flex-col gap-2">
          {items.map((m) => {
            const cancelled = m.status === "cancelled";
            const upcoming = isUpcoming(m);
            const external = externalAttendees(m);
            const lowConfidence = (m.confidence ?? 0) < 0.9;
            const open = openId === m.id;
            const externalPeople = m.attendees.filter((a) => !isInternal(a.email));
            const internalPeople = m.attendees.filter((a) => isInternal(a.email));
            const duration = durationText(m.startsAt, m.endsAt);
            return (
              <li key={m.id} className="rounded-lg border border-line">
                <div className="flex w-full items-center gap-2 p-2.5">
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                    aria-expanded={open}
                    onClick={() => setOpenId(open ? null : m.id)}
                  >
                  <ChevronDown
                    size={14}
                    className={`shrink-0 text-sub transition-transform ${open ? "rotate-180" : ""}`}
                    aria-hidden
                  />
                  <span className="min-w-0 flex-1">
                    <span
                      className={`block truncate text-[13px] font-medium ${
                        cancelled ? "text-faint line-through" : "text-ink"
                      }`}
                      title={m.title || undefined}
                    >
                      {m.granola && <GranolaMark size={14} />}{m.granola ? " " : ""}
                      {m.title || "(untitled meeting)"}
                    </span>
                    <span className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11px] text-faint">
                      <span>{fmtWhen(m.startsAt)}</span>
                      {external.length > 0 && (
                        <span>
                          · {external.length} external attendee{external.length === 1 ? "" : "s"}
                        </span>
                      )}
                      {cancelled && <span>· Cancelled</span>}
                    </span>
                  </span>
                  </button>
                  {upcoming && (
                    <span className="shrink-0 rounded border border-line bg-bg-soft px-1.5 py-0.5 text-[10px] font-semibold text-sub">
                      Upcoming
                    </span>
                  )}
                  {upcoming && m.conferenceUrl && (
                    <a
                      href={m.conferenceUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="flex shrink-0 items-center gap-1 text-[11px] font-medium text-primary"
                      title="Open the video call"
                    >
                      <Launch size={11} /> Join
                    </a>
                  )}
                  <RemoveControl
                    label="Remove from this deal"
                    confirmText="Remove this meeting from the deal?"
                    busy={busy === m.id}
                    onConfirm={() => unmatch(m)}
                  />
                </div>

                {open && (
                  <div className="border-t border-line bg-bg-soft px-3 py-2.5">
                    <p className="text-[11px] text-faint">
                      {fmtWhen(m.startsAt)}
                      {duration && ` · ${duration}`}
                    </p>
                    {externalPeople.length > 0 && (
                      <div className="mt-1.5">
                        <p className="text-[11px] font-semibold uppercase tracking-wide text-sub">
                          On the invite
                        </p>
                        <ul className="mt-1 flex flex-col gap-0.5">
                          {externalPeople.map((a) => (
                            <li key={a.email} className="text-[12.5px] text-body">
                              {a.name ? (
                                <>
                                  {a.name}{" "}
                                  <a
                                    href={`mailto:${a.email}`}
                                    className="text-sub hover:text-primary hover:underline"
                                  >
                                    {a.email}
                                  </a>
                                </>
                              ) : (
                                <a
                                  href={`mailto:${a.email}`}
                                  className="text-body hover:text-primary hover:underline"
                                >
                                  {a.email}
                                </a>
                              )}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {internalPeople.length > 0 && (
                      <p className="mt-1.5 text-[11.5px] text-faint">
                        From {crm.org.name}:{" "}
                        {internalPeople
                          .map((a) => a.name ?? a.email.split("@")[0])
                          .join(", ")}
                      </p>
                    )}
                    {m.granola && (
                      <div className="mt-2 border-t border-line pt-2">
                        <p className="flex items-center gap-1.5 text-[12px] font-medium text-ink">
                          <GranolaMark size={15} />
                          {noteUrl(m.granola) ? (
                            <a
                              href={noteUrl(m.granola)!}
                              target="_blank"
                              rel="noreferrer"
                              className="hover:text-primary hover:underline"
                            >
                              {m.granola.title || "Granola note"}
                            </a>
                          ) : (
                            m.granola.title || "Meeting note"
                          )}
                        </p>
                        <NoteBody note={m.granola} />
                      </div>
                    )}
                    <div className="mt-2 flex flex-wrap items-center gap-x-2 text-[11px] text-faint">
                      <span>{evidenceText(m.evidence)}</span>
                      <button
                        type="button"
                        className="font-medium text-sub transition-colors hover:text-primary disabled:opacity-50"
                        onClick={() => unmatch(m)}
                        disabled={busy === m.id}
                      >
                        Not this deal?
                      </button>
                    </div>
                  </div>
                )}
                {!open && lowConfidence && (
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-line px-2.5 py-1.5 text-[11px] text-faint">
                    <span>{evidenceText(m.evidence)}</span>
                    <button
                      type="button"
                      className="font-medium text-sub transition-colors hover:text-primary disabled:opacity-50"
                      onClick={() => unmatch(m)}
                      disabled={busy === m.id}
                    >
                      Not this deal?
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {sectionOpen && looseNotes.length > 0 && (
        <ul className="mt-2 flex flex-col gap-2">
          {looseNotes.map((n) => (
            <li key={n.id} className="rounded-lg border border-line bg-bg-soft p-2.5">
              <div className="flex items-start justify-between gap-2">
                <p className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5 text-[12.5px] font-medium text-ink">
                  <GranolaMark size={15} />
                  {noteUrl(n) ? (
                    <a
                      href={noteUrl(n)!}
                      target="_blank"
                      rel="noreferrer"
                      className="hover:text-primary hover:underline"
                    >
                      {n.title || "Granola note"}
                    </a>
                  ) : (
                    n.title || "Meeting note"
                  )}
                  {n.startsAt && (
                    <span className="font-normal text-faint">· {fmtWhen(n.startsAt)}</span>
                  )}
                </p>
                <RemoveControl
                  label="Remove from this deal"
                  confirmText="Remove this note from the deal?"
                  busy={busy === n.id}
                  onConfirm={() => removeNote(n)}
                />
              </div>
              <NoteBody note={n} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
