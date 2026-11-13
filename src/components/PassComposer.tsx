"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Callout } from "./Callout";
import { crm } from "@/config/crm.config";
import { SchedulePanel } from "./SchedulePanel";
import { draftPassEmailAction, sendPassEmailAction } from "@/app/actions";
import {
  defaultPassBody,
  defaultPassSubject,
  parseCcList,
  passDraftProblem,
  unresolvedPlaceholders,
} from "@/lib/passEmailPure";

/** The shared deal inbox, cc'd on every pass so the team sees it land. Empty
 *  when no inbound mailbox is configured (then nobody is cc'd by default). */
const TEAM_CC = crm.inbound.address;

/**
 * Gmail-style address chips: Enter, comma, blur, or a paste turns text into
 * removable pills; Backspace on an empty input pops the last one. The
 * committed chips live in the parent's comma-joined string; the in-progress
 * text stays here and is reported up so Send never loses a half-typed
 * address.
 */
function EmailChips({
  value,
  onChange,
  onPending,
  placeholder,
  listId,
}: {
  value: string;
  onChange: (next: string) => void;
  onPending: (text: string) => void;
  placeholder?: string;
  listId?: string;
}) {
  const [draft, setDraftState] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const chips = useMemo(() => parseCcList(value).emails, [value]);
  const setDraft = (t: string) => {
    setDraftState(t);
    onPending(t);
  };

  const commit = (extra = "") => {
    const text = `${draft} ${extra}`.trim();
    if (!text) return;
    // Spaces separate pasted address lists just like commas do.
    const parsed = parseCcList(text.replace(/\s+/g, ","));
    const next = [...chips];
    for (const e of parsed.emails) if (!next.includes(e)) next.push(e);
    onChange(next.join(", "));
    setDraft(parsed.invalid.join(" "));
  };

  const removeAt = (i: number) => {
    onChange(chips.filter((_, j) => j !== i).join(", "));
    inputRef.current?.focus();
  };

  return (
    <span
      className="field flex !h-auto min-h-9 cursor-text flex-wrap items-center gap-1 !py-1"
      onClick={() => inputRef.current?.focus()}
    >
      {chips.map((e, i) => (
        <span
          key={e}
          className="inline-flex max-w-full items-center gap-1 rounded-full border border-line bg-bg-soft py-0.5 pl-0.5 pr-1 text-[12.5px] text-body"
        >
          <span
            className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary text-[11px] font-semibold text-white"
            aria-hidden
          >
            {e[0]?.toUpperCase()}
          </span>
          <span className="truncate">{e}</span>
          <button
            type="button"
            className="shrink-0 px-0.5 text-sub hover:text-primary"
            aria-label={`Remove ${e}`}
            onClick={(ev) => {
              ev.stopPropagation();
              removeAt(i);
            }}
          >
            ×
          </button>
        </span>
      ))}
      <input
        ref={inputRef}
        className="min-w-[12ch] flex-1 border-0 bg-transparent text-[13px] outline-none"
        type="text"
        inputMode="email"
        autoComplete="off"
        list={listId}
        placeholder={chips.length === 0 ? placeholder : undefined}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === "," || e.key === ";") {
            e.preventDefault();
            commit();
          } else if (e.key === "Backspace" && draft === "" && chips.length > 0) {
            e.preventDefault();
            removeAt(chips.length - 1);
          }
        }}
        onPaste={(e) => {
          const text = e.clipboardData.getData("text");
          if (text.includes("@")) {
            e.preventDefault();
            commit(text);
          }
        }}
        onBlur={() => commit()}
      />
    </span>
  );
}

/**
 * The pass note, written and sent without leaving the deal card. Fast path:
 * the default note appears instantly with name and company filled when they
 * are reliable. The AI button rewrites it from the full deal context; every
 * word stays editable, drafts survive a refresh, and nothing ever sends on
 * its own.
 */

type DraftStatus = "default" | "ai" | "edited";

interface StoredDraft {
  to: string;
  cc?: string;
  subject: string;
  body: string;
  status: DraftStatus;
  open: boolean;
}

export function PassComposer({
  gid,
  companyName,
  founders,
  viewerName,
  viewerEmail = "",
}: {
  gid: string;
  /** Company side of the deal title; null when it can't be trusted. */
  companyName: string | null;
  founders: { name: string; email: string }[];
  viewerName: string;
  /** Powers the Schedule panel's default calendar; empty hides the button. */
  viewerEmail?: string;
}) {
  const router = useRouter();
  const storageKey = `passdraft:${gid}`;

  const firstFounder = founders.find((f) => f.name.trim());
  const founderFirstName = firstFounder
    ? firstFounder.name.trim().split(/\s+/)[0]
    : null;
  const senderFirst = (viewerName || crm.org.name).trim().split(/\s+/)[0];
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const scheduleTriggerRef = useRef<HTMLButtonElement>(null);

  // Insert a text block at the caret without touching the rest of the draft.
  const insertAtCursor = (text: string) => {
    const el = bodyRef.current;
    const start = el?.selectionStart ?? body.length;
    const end = el?.selectionEnd ?? start;
    setBody(body.slice(0, start) + text + body.slice(end));
    setStatus("edited");
    requestAnimationFrame(() => {
      el?.focus();
      const pos = start + text.length;
      el?.setSelectionRange(pos, pos);
    });
  };

  const defaults = useMemo(
    () => ({
      to: founders.find((f) => f.email.trim())?.email.trim().toLowerCase() ?? "",
      subject: defaultPassSubject(companyName),
      body: defaultPassBody({
        founderName: founderFirstName,
        companyName,
        senderFirstName: senderFirst,
      }),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [gid]
  );

  const [open, setOpen] = useState(false);
  const [to, setTo] = useState(defaults.to);
  // deals@ rides along by default so the whole team sees the send land in
  // the shared inbox; it's an ordinary editable field, remove it freely.
  const [cc, setCc] = useState(TEAM_CC);
  // Half-typed chip text, per field — Send folds it in rather than lose it.
  const toPendingRef = useRef("");
  const ccPendingRef = useRef("");
  const [subject, setSubject] = useState(defaults.subject);
  const [body, setBody] = useState(defaults.body);
  const [status, setStatus] = useState<DraftStatus>("default");
  const [busy, setBusy] = useState<"draft" | "improve" | "send" | null>(null);
  const [error, setError] = useState("");
  const [sent, setSent] = useState<null | { to: string; subject: string; body: string }>(null);
  const [showSent, setShowSent] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [undo, setUndo] = useState<null | { subject: string; body: string; status: DraftStatus }>(null);
  // Set only right after an AI draft that had too little context to be
  // more than a best-effort guess; cleared on any further edit or redraft.
  const [thinContext, setThinContext] = useState<string[] | null>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  // What the machine last wrote — divergence from this means "Edited".
  const machineBody = useRef(defaults.body);

  // A draft survives closing the card and accidental refreshes.
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(storageKey);
      if (!raw) return;
      const saved = JSON.parse(raw) as StoredDraft;
      if (typeof saved.body === "string" && saved.body.trim()) {
        setTo(saved.to ?? defaults.to);
        setCc(saved.cc ?? TEAM_CC);
        setSubject(saved.subject ?? defaults.subject);
        setBody(saved.body);
        setStatus(saved.status ?? "edited");
        if (saved.open) setOpen(true);
      }
    } catch {
      // a corrupt draft is not worth an error
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (sent) return;
    try {
      sessionStorage.setItem(
        storageKey,
        JSON.stringify({ to, cc, subject, body, status, open } satisfies StoredDraft)
      );
    } catch {
      // storage full or blocked; typing still works
    }
  }, [to, cc, subject, body, status, open, sent, storageKey]);

  const meaningfulEdits =
    body.trim() !== defaults.body.trim() || subject.trim() !== defaults.subject.trim();

  const applyDraft = (next: { subject: string; body: string }, as: DraftStatus) => {
    setUndo({ subject, body, status });
    setSubject(next.subject);
    setBody(next.body);
    machineBody.current = next.body;
    setStatus(as);
  };

  const runDraft = async (mode: "replace" | "improve") => {
    setChoosing(false);
    setBusy(mode === "improve" ? "improve" : "draft");
    setError("");
    const res = await draftPassEmailAction(gid, {
      mode,
      currentDraft: mode === "improve" ? body : null,
    });
    setBusy(null);
    if (!res.ok || !res.subject || !res.body) {
      setError(res.error ?? "Drafting didn't go through.");
      return;
    }
    // The draft is still the best honest attempt even when context is
    // thin — surface what's missing rather than let it read as confident.
    setThinContext(
      res.needsMoreContext ? (res.missingContext ?? []) : null
    );
    applyDraft({ subject: res.subject, body: res.body }, "ai");
  };

  const onAiClick = () => {
    if (busy) return;
    // Never silently overwrite someone's own words.
    if (status === "edited" && meaningfulEdits) setChoosing(true);
    else void runDraft("replace");
  };

  const resetToDefault = () => {
    setUndo({ subject, body, status });
    setTo(defaults.to || to);
    setCc(TEAM_CC);
    setSubject(defaults.subject);
    setBody(defaults.body);
    machineBody.current = defaults.body;
    setStatus("default");
    setError("");
    setThinContext(null);
  };

  const close = (force = false) => {
    if (!force && meaningfulEdits && !sent) {
      setConfirmDiscard(true);
      return;
    }
    setConfirmDiscard(false);
    setOpen(false);
    if (force) {
      try {
        sessionStorage.removeItem(storageKey);
      } catch {
        // fine
      }
      setTo(defaults.to);
      setCc(TEAM_CC);
      setSubject(defaults.subject);
      setBody(defaults.body);
      machineBody.current = defaults.body;
      setStatus("default");
      setError("");
      setThinContext(null);
    }
  };

  const send = async () => {
    // Fold in any half-typed chip text so a typed-but-not-Entered address
    // still counts (or still blocks, when it's broken).
    const effTo = [to, toPendingRef.current].filter((s) => s.trim()).join(", ");
    const effCc = [cc, ccPendingRef.current].filter((s) => s.trim()).join(", ");
    const problem = passDraftProblem({ to: effTo, subject, body });
    if (problem) {
      setError(problem);
      if (unresolvedPlaceholders(`${subject}\n${body}`).length > 0) {
        bodyRef.current?.focus();
      }
      return;
    }
    const ccCheck = parseCcList(effCc);
    if (ccCheck.invalid.length > 0) {
      setError(`CC has an invalid address: ${ccCheck.invalid[0]}`);
      return;
    }
    setBusy("send");
    setError("");
    const res = await sendPassEmailAction(gid, { to: effTo, cc: effCc, subject, body });
    setBusy(null);
    if (!res.ok) {
      setError(res.error ?? "The send didn't go through.");
      return;
    }
    setSent({ to: [to, toPendingRef.current].filter((s) => s.trim()).join(", "), subject, body });
    try {
      sessionStorage.removeItem(storageKey);
    } catch {
      // fine
    }
    router.refresh();
  };

  const placeholdersLeft = unresolvedPlaceholders(`${subject}\n${body}`);
  const statusLabel = status === "default" ? "Default" : status === "ai" ? "AI draft" : "Edited";

  if (sent) {
    return (
      <section className="rounded-lg border border-line p-3 sm:col-span-2">
        <p className="text-[14px] font-medium text-ink">Pass sent to {sent.to}.</p>
        <p className="mt-1 text-[13px] text-sub">
          It&apos;s recorded in this deal&apos;s email history, the decision is set to pass, and the
          stage moved with it.
        </p>
        <button
          className="tap-sm mt-2 text-[13px] font-medium text-primary hover:text-primary-pressed"
          onClick={() => setShowSent((v) => !v)}
        >
          {showSent ? "Hide the message" : "View the exact message"}
        </button>
        {showSent && (
          <div className="mt-2 border border-line bg-bg-soft p-3">
            <p className="text-[13px] font-medium text-ink">{sent.subject}</p>
            <p className="mt-2 whitespace-pre-wrap text-[13px] leading-relaxed text-body">
              {sent.body}
            </p>
          </div>
        )}
      </section>
    );
  }

  if (!open) {
    // Sits beside the Stage select in the card's top grid: same control
    // height, aligned to the field row, one word.
    return (
      <div className="flex sm:items-end">
        <button
          className="btn-secondary tap !h-12 w-full"
          onClick={() => setOpen(true)}
        >
          Pass
        </button>
      </div>
    );
  }

  return (
    <section className="rounded-lg border border-line sm:col-span-2">
      <div className="flex items-center justify-between gap-3 border-b border-line px-3 py-2">
        <span className="text-[13px] font-semibold text-ink">Pass note</span>
        <span className="text-[11px] uppercase tracking-wide text-faint">{statusLabel}</span>
      </div>

      <div className="flex flex-col gap-2.5 p-3">
        <label className="block">
          <span className="mb-1 block text-[12px] font-semibold text-sub">To</span>
          <EmailChips
            value={to}
            onChange={setTo}
            onPending={(t) => {
              toPendingRef.current = t;
            }}
            placeholder="founder@company.com"
            listId={`pass-recipients-${gid}`}
          />
          <datalist id={`pass-recipients-${gid}`}>
            {founders
              .filter((f) => f.email.trim())
              .map((f) => (
                <option key={f.email} value={f.email.trim().toLowerCase()}>
                  {f.name}
                </option>
              ))}
          </datalist>
        </label>
        <label className="block">
          <span className="mb-1 block text-[12px] font-semibold text-sub">Cc</span>
          <EmailChips
            value={cc}
            onChange={setCc}
            onPending={(t) => {
              ccPendingRef.current = t;
            }}
            placeholder="add addresses"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-[12px] font-semibold text-sub">Subject</span>
          <input
            className="field !h-9 !text-[13px]"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-[12px] font-semibold text-sub">Email</span>
          <textarea
            ref={bodyRef}
            className={`field min-h-[16rem] py-2 !text-[13px] leading-relaxed sm:min-h-[13rem] ${
              error && placeholdersLeft.length > 0 ? "!border-primary" : ""
            }`}
            style={{ height: "auto" }}
            rows={12}
            value={body}
            onChange={(e) => {
              setBody(e.target.value);
              const edited = e.target.value !== machineBody.current;
              if (edited) setThinContext(null);
              setStatus(
                e.target.value.trim() === defaults.body.trim()
                  ? "default"
                  : e.target.value === machineBody.current
                    ? status
                    : "edited"
              );
            }}
          />
        </label>

        {placeholdersLeft.length > 0 && (
          <p className="m-0 text-[12px] text-faint">
            Still to fill in: {placeholdersLeft.join(" and ")}
          </p>
        )}
        {thinContext && (
          <Callout tone="status" className="p-2.5 text-[12px]">
            This deal doesn&apos;t have much recorded yet, so the draft is a best
            guess rather than a grounded one.
            {thinContext.length > 0 && ` Missing: ${thinContext.join(", ")}.`} Worth
            a read before sending, or add a decision and rationale on the deal
            first.
          </Callout>
        )}
        {error && (
          <Callout tone="error" className="p-2.5 text-[12px]">
            {error}
          </Callout>
        )}
        {undo && (
          <button
            className="tap-sm self-start text-[12px] font-medium text-sub hover:text-primary"
            onClick={() => {
              setSubject(undo.subject);
              setBody(undo.body);
              machineBody.current = undo.body;
              setStatus(undo.status);
              setUndo(null);
            }}
          >
            Undo the last rewrite
          </button>
        )}
      </div>

      {/* The choice when AI would touch words a human wrote. */}
      {choosing && (
        <div className="flex flex-wrap items-center gap-2 border-t border-line bg-bg-soft px-3 py-2.5">
          <span className="text-[12px] text-sub">You&apos;ve edited this draft.</span>
          <button className="btn-secondary !py-1 text-[12px]" onClick={() => void runDraft("improve")}>
            Improve current draft
          </button>
          <button className="btn-secondary !py-1 text-[12px]" onClick={() => void runDraft("replace")}>
            Replace draft
          </button>
          <button
            className="tap-sm text-[12px] font-medium text-sub hover:text-primary"
            onClick={() => setChoosing(false)}
          >
            Cancel
          </button>
        </div>
      )}

      {confirmDiscard && (
        <div className="flex flex-wrap items-center gap-2 border-t border-line bg-bg-soft px-3 py-2.5">
          <span className="text-[12px] text-sub">Discard this draft?</span>
          <button className="btn-secondary !py-1 text-[12px]" onClick={() => close(true)}>
            Discard
          </button>
          <button
            className="tap-sm text-[12px] font-medium text-sub hover:text-primary"
            onClick={() => setConfirmDiscard(false)}
          >
            Keep writing
          </button>
        </div>
      )}

      {/* Sticky on phones so Send never hides behind the keyboard scroll. */}
      <div className="relative sticky bottom-0 flex flex-wrap items-center gap-2 border-t border-line bg-bg px-3 py-2.5">
        {scheduleOpen && viewerEmail && (
          <SchedulePanel
            viewerEmail={viewerEmail}
            onInsert={insertAtCursor}
            onClose={() => {
              setScheduleOpen(false);
              scheduleTriggerRef.current?.focus();
            }}
          />
        )}
        <button
          className="btn-secondary tap flex-1 sm:flex-none"
          disabled={busy !== null}
          onClick={onAiClick}
          aria-busy={busy === "draft" || busy === "improve"}
        >
          {busy === "draft" || busy === "improve" ? (
            <span className="inline-flex items-center gap-2">
              <span
                className="h-3 w-3 animate-spin rounded-full border-2 border-line border-t-primary"
                aria-hidden
              />
              {busy === "improve" ? "Improving…" : "Writing…"}
            </span>
          ) : (
            "Write thoughtful pass"
          )}
        </button>
        <button
          className="tap-sm text-[13px] font-medium text-sub hover:text-primary"
          disabled={busy !== null}
          onClick={resetToDefault}
        >
          Reset to default
        </button>
        {viewerEmail && (
          <button
            ref={scheduleTriggerRef}
            className="tap-sm text-[13px] font-medium text-sub hover:text-primary"
            aria-expanded={scheduleOpen}
            aria-haspopup="dialog"
            onClick={() => setScheduleOpen((v) => !v)}
          >
            Schedule
          </button>
        )}
        <span className="ml-auto flex items-center gap-2">
          <button
            className="tap-sm text-[13px] font-medium text-sub hover:text-primary"
            disabled={busy === "send"}
            onClick={() => close()}
          >
            Cancel
          </button>
          <button
            className="btn-primary tap"
            disabled={busy !== null}
            onClick={() => void send()}
          >
            {busy === "send" ? "Sending…" : "Send pass"}
          </button>
        </span>
      </div>
    </section>
  );
}
