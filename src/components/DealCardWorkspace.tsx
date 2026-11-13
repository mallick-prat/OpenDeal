"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronLeft } from "@carbon/icons-react";
import {
  createDeal,
  finalizeCandidatePromotionAction,
  triageCandidateAction,
  type TriageOp,
} from "@/app/actions";
import type { CandidateCore, CandidateExtras } from "@/lib/candidatePayload";
import type { SectionInfo, StageKey } from "@/lib/types";
import { STAGE_BY_KEY } from "@/lib/stages";
import { composeNotes, type FounderRow } from "@/lib/founders";
import { isOpen } from "@/lib/candidatesPure";
import { etFullDate, etLongMonthDayYear, etWeekdayDay } from "@/lib/etDates";
import { FounderFields } from "./FounderFields";
import { AssignSelect } from "./AssignSelect";
import { EnrichButton } from "./EnrichButton";
import { EmailThread } from "./EmailThread";
import { CandidatePager, setTurnDirection } from "./CandidatePager";
import { Callout } from "./Callout";
import { useTriageSession } from "./TriageSessionContext";
import { isInternalEmail } from "@/config/crm.config";

const ROUNDS = ["Angel", "Pre-Seed", "Seed", "Series A"];

/**
 * ── Triage as a deal card ──────────────────────────────────────────────────
 * The inbox item IS the deal: the same fields the Edit card shows, pre-filled
 * from the pitch, editable in place. One click puts it on the board exactly
 * as laid out (no second form). The
 * email thread sits underneath as the evidence; everything the machine
 * inferred beyond the fields lives behind "More context".
 */
export function DealCardWorkspace({
  core,
  extras,
  members,
  viewerEmail,
  sections,
  schoolNames,
  queuePosition,
  queueTotal,
  prevId,
  nextId,
}: {
  core: CandidateCore;
  extras: CandidateExtras | null;
  members: { email: string; name: string }[];
  viewerEmail: string;
  sections: SectionInfo[];
  schoolNames: string[];
  queuePosition: number;
  queueTotal: number;
  prevId: string | null;
  nextId: string | null;
}) {
  const { candidate: c, claims, missing, deckLinks, attachments, isOpenStatus, dealPrefill, proposedDeal } = core;
  const router = useRouter();
  const session = useTriageSession();
  const open = isOpenStatus && isOpen(c.status);

  /* ── The card's fields, seeded from the pitch ─────────────────────────── */
  const [company, setCompany] = useState(dealPrefill.company || "");
  const [financing, setFinancing] = useState(dealPrefill.financing || "");
  const [round, setRound] = useState(
    ROUNDS.find((r) => r.toLowerCase() === (dealPrefill.round || "").trim().toLowerCase()) ?? ""
  );
  const [sectionGid, setSectionGid] = useState(
    sections.find((s) => s.stage === "to-meet")?.gid ?? sections[0]?.gid ?? ""
  );
  const [founders, setFounders] = useState<FounderRow[]>(dealPrefill.founders ?? []);
  const [draft, setDraft] = useState<FounderRow>({ name: "", school: "", linkedin: "", email: "" });
  const [draftOther, setDraftOther] = useState("");
  const [notes, setNotes] = useState(dealPrefill.notes || "");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [passing, setPassing] = useState(false);
  const [passReason, setPassReason] = useState("");

  const draftSchool = draft.school === "__other__" ? draftOther.trim() : draft.school;
  // A founder typed into the entry row but not yet added still counts.
  const effectiveFounders = useMemo(
    () => (draft.name.trim() ? [...founders, { ...draft, school: draftSchool }] : founders),
    [founders, draft, draftSchool]
  );
  const founderNames = effectiveFounders.map((f) => f.name.trim()).filter(Boolean);
  const taskName = useMemo(() => {
    const co = company.trim();
    if (!co) return "";
    return founderNames.length > 0 ? `${founderNames.join(", ")} // ${co}` : co;
  }, [company, founderNames]);

  const addFounder = () => {
    if (!draft.name.trim()) return;
    setFounders([...founders, { ...draft, name: draft.name.trim(), school: draftSchool }]);
    setDraft({ name: "", school: "", linkedin: "", email: "" });
    setDraftOther("");
  };

  /* ── Verdicts: every terminal action turns the page ───────────────────── */
  const advance = (next: string | null | undefined) => {
    if (session) {
      session.advance(next ?? null);
      return;
    }
    setTurnDirection("next");
    router.push(next ? `/inbox/${next}` : "/inbox?cleared=1");
  };

  const triage = async (label: string, op: TriageOp, advanceAfter = true) => {
    // Not-a-deal deletes the row: turn the page first so nothing re-renders
    // against a vanished id. Optimistic by design.
    if (session && op.kind === "ignore") {
      session.advance(null);
      void triageCandidateAction(c.id, op);
      return;
    }
    setBusy(label);
    setError("");
    const res = await triageCandidateAction(c.id, op);
    setBusy(null);
    if (!res.ok) {
      setError(res.error ?? "That did not go through. Try again.");
      return;
    }
    if (advanceAfter) advance(res.nextId);
    else if (session) void session.refreshCurrent();
    else router.refresh();
  };

  /** Board exactly what the card shows: a real deal. */
  const board = async () => {
    if (busy) return;
    if (!company.trim()) {
      setError("Name the company.");
      return;
    }
    setBusy("board");
    setError("");
    const rows = effectiveFounders
      .map((f) => ({
        name: f.name.trim(),
        school: f.school.trim(),
        linkedin: f.linkedin.trim(),
        email: f.email.trim().toLowerCase(),
      }))
      .filter((f) => f.name);
    const financingLine =
      financing.trim() || round
        ? `Raising: ${financing.trim() || "TBD"}${round ? ` (${round})` : ""}`
        : "";
    const fullNotes = composeNotes([financingLine, notes.trim()].filter(Boolean).join("\n\n"), rows);
    const schools = [...new Map(rows.map((f) => [f.school.toLowerCase(), f.school])).values()].filter(Boolean);
    const created = await createDeal({
      name: taskName,
      notes: fullNotes,
      sectionGid,
      schools,
      financingAmount: financing.trim(),
      round,
      company: company.trim(),
      founders: rows,
    });
    if (!created.ok || !created.gid) {
      setBusy(null);
      setError(created.error ?? "Couldn't create the deal.");
      return;
    }
    const fin = await finalizeCandidatePromotionAction(c.id, created.gid);
    setBusy(null);
    advance(fin.ok ? fin.nextId : null);
  };

  // Keys: b add to board · p pass · i not a deal · j/k turn · e email. Quiet while typing.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest("input, textarea, select, [contenteditable]") || e.metaKey || e.ctrlKey || e.altKey) return;
      if (busy || passing) return;
      if (e.key === "b" || e.key === "a") void board();
      else if (e.key === "p") setPassing(true);
      else if (e.key === "i" || e.key === "d") void triage("ignore", { kind: "ignore" });
      else if (e.key === "j" && nextId) {
        if (nextId.startsWith("/")) router.push(nextId);
        else session?.goTo(nextId, "next");
      } else if (e.key === "k" && prevId) {
        if (prevId.startsWith("/")) router.push(prevId);
        else session?.goTo(prevId, "prev");
      } else if (e.key === "e") {
        document.getElementById("email-section")?.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, busy, passing, c.id, prevId, nextId, company, financing, round, sectionGid, founders, draft, notes]);

  /* ── Context pieces ───────────────────────────────────────────────────── */
  const history = extras?.history ?? null;
  const meetCtx = extras?.meetingContext ?? null;
  const storedDocs = extras?.storedDocs ?? [];
  const fromTeam = isInternalEmail(c.from_email);
  const intelLines = Array.isArray(claims["webIntel"]?.current?.value)
    ? (claims["webIntel"]!.current!.value as string[])
    : [];
  // Deals this email is probably about: the server's proposal first, then
  // what team history matched. One line each, one click to file.
  const related = [
    ...(proposedDeal ? [{ gid: proposedDeal.gid, name: proposedDeal.name, stage: proposedDeal.stage }] : []),
    ...(history?.deals ?? [])
      .filter((d) => d.gid !== proposedDeal?.gid)
      .map((d) => ({ gid: d.gid, name: d.name, stage: d.stage })),
  ].slice(0, 3);
  const bundled = new Set(storedDocs.map((d) => d.checksum)).size;
  const hasFiles = storedDocs.length > 0 || deckLinks.length > 0 || attachments.length > 0;
  const label = "mb-1 block text-[12px] font-semibold text-sub";
  const stageLabel = (stage: string) => STAGE_BY_KEY[stage as StageKey]?.label ?? stage;

  return (
    <>
      <div className="mb-4 flex items-baseline justify-between gap-4">
        <Link
          href="/inbox"
          className="inline-flex items-center gap-1 text-[14px] font-medium text-primary hover:text-primary-pressed lg:hidden"
        >
          <ChevronLeft size={16} aria-hidden /> Back to inbox
        </Link>
        {c.promoted_deal_gid && (
          <Link
            href={`/deals/${c.promoted_deal_gid}`}
            className="text-[14px] font-medium text-primary hover:text-primary-pressed"
          >
            Open the deal →
          </Link>
        )}
      </div>

      {/* Header: who sent it, when, and the two controls that aren't fields. */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
        <div className="min-w-0">
          <h1 className="break-words text-[24px] font-light leading-tight text-ink sm:text-[28px]">
            {taskName || c.subject || "(no subject)"}
          </h1>
          <p className="mt-1 text-[13.5px] text-sub">
            {fromTeam ? "Forwarded by " : "From "}
            {c.from_name || c.from_email || "unknown sender"}
            {!fromTeam && c.from_email && c.from_name ? ` <${c.from_email}>` : ""}
            {c.received_at && ` · ${etLongMonthDayYear(c.received_at)}`}
          </p>
        </div>
        {open && (
          <div className="flex shrink-0 flex-wrap items-center gap-3 sm:mt-1 sm:justify-end">
            <AssignSelect
              candidateId={c.id}
              assignedTo={c.assigned_to}
              members={members}
              viewerEmail={viewerEmail}
            />
            <EnrichButton id={c.id} />
          </div>
        )}
      </div>

      {/* About a deal we already hold: file it there in one click. */}
      {open && related.length > 0 && (
        <div className="mt-4 border-l-2 border-l-primary pl-3 text-[13.5px]" aria-label="Related deals">
          {related.map((d) => (
            <div key={d.gid} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 py-1">
              <span className="min-w-0 flex-1">
                <span className="font-semibold text-ink">Already on the board:</span>{" "}
                <Link href={`/deals/${d.gid}`} className="font-medium text-ink hover:underline">
                  {d.name}
                </Link>
                <span className="text-sub"> · {stageLabel(d.stage)}</span>
              </span>
              <button
                className="tap inline-block shrink-0 border border-primary bg-primary px-2.5 py-1 text-[12px] font-medium text-white transition-colors hover:bg-primary-pressed disabled:opacity-50"
                disabled={busy !== null}
                onClick={() => void triage("attach", { kind: "attach", dealGid: d.gid })}
              >
                {busy === "attach" ? "Filing…" : "File to this deal"}
              </button>
            </div>
          ))}
        </div>
      )}

      {/* The card: the Edit deal fields, in the Edit deal order. */}
      <div className="card anim-fade-up mt-5 flex flex-col gap-4 p-5">
        <div className="grid gap-2.5 sm:grid-cols-[minmax(0,1fr)_140px_150px]">
          <label className="block">
            <span className={label}>Company</span>
            <input
              className="field"
              value={company}
              disabled={!open}
              onChange={(e) => setCompany(e.target.value)}
            />
          </label>
          <label className="block">
            <span className={label}>Raising</span>
            <input
              className="field"
              placeholder="$"
              value={financing}
              disabled={!open}
              onChange={(e) => setFinancing(e.target.value)}
            />
          </label>
          <label className="block">
            <span className={label}>Round</span>
            <select className="field" value={round} disabled={!open} onChange={(e) => setRound(e.target.value)}>
              <option value="">Round</option>
              {ROUNDS.map((r) => (
                <option key={r} value={r}>{r}</option>
              ))}
            </select>
          </label>
        </div>

        <label className="block sm:w-1/2">
          <span className={label}>Stage</span>
          <select className="field" value={sectionGid} disabled={!open} onChange={(e) => setSectionGid(e.target.value)}>
            {sections.map((s) => (
              <option key={s.gid} value={s.gid}>{s.name}</option>
            ))}
          </select>
        </label>

        <FounderFields
          founders={founders}
          draft={draft}
          draftOther={draftOther}
          schoolNames={schoolNames}
          onFounders={setFounders}
          onDraft={setDraft}
          onDraftOther={setDraftOther}
          onAdd={addFounder}
          collapsedAdd
        />

        <label className="block">
          <span className={label}>Notes</span>
          <textarea
            className="field min-h-36 py-2 leading-relaxed"
            style={{ height: "auto" }}
            rows={6}
            value={notes}
            disabled={!open}
            onChange={(e) => setNotes(e.target.value)}
          />
        </label>

        {hasFiles && (
          <div>
            <div className="mb-1 flex items-baseline justify-between gap-3">
              <span className={label}>Files</span>
              {bundled > 1 && (
                <a
                  href={`/api/candidates/${c.id}/materials`}
                  target="_blank"
                  rel="noreferrer"
                  className="text-[12px] font-medium text-primary hover:underline"
                >
                  Download all ({bundled})
                </a>
              )}
            </div>
            <ul className="flex flex-col gap-1 text-[14px]">
              {storedDocs.map((d) => (
                <li key={d.id}>
                  <a href={`/api/documents/${d.id}`} target="_blank" rel="noreferrer" className="font-medium text-primary hover:underline">
                    {d.filename}
                  </a>{" "}
                  <span className="text-faint">{Math.round(d.bytes / 1024).toLocaleString()} KB</span>
                </li>
              ))}
              {deckLinks.map((d) => (
                <li key={d.url}>
                  <a href={d.url} target="_blank" rel="noreferrer" className="font-medium text-primary hover:underline">
                    {(() => {
                      try {
                        return new URL(d.url).hostname.replace(/^www\./, "");
                      } catch {
                        return d.kind;
                      }
                    })()}
                  </a>{" "}
                  <span className="text-[12px] text-faint">{d.kind}</span>
                </li>
              ))}
              {attachments
                .filter((a) => !storedDocs.some((d) => d.filename === a.filename))
                .map((a) => (
                  <li key={a.filename} className="text-sub">
                    {a.filename} <span className="text-faint">in the email</span>
                  </li>
                ))}
              {!extras && storedDocs.length === 0 && deckLinks.length === 0 && (
                <li className="text-faint">Loading…</li>
              )}
            </ul>
          </div>
        )}

        {(missing.length > 0 || intelLines.length > 0 || meetCtx || (c.classification && c.confidence !== null && Number(c.confidence) < 0.7)) && (
          <details className="text-[13px]">
            <summary className="cursor-pointer text-[12px] font-semibold text-sub">More context</summary>
            <div className="mt-2 flex flex-col gap-1.5 text-body">
              {missing.length > 0 && <p className="text-faint">{missing.join(" · ")}</p>}
              {c.classification && c.confidence !== null && Number(c.confidence) < 0.7 && (
                <p className="text-faint">
                  Low confidence read ({c.classification}){c.classifier_reason && `: ${c.classifier_reason}`}
                </p>
              )}
              {meetCtx && (meetCtx.priorMeetings > 0 || meetCtx.upcoming.length > 0) && (
                <p>
                  <span className="font-semibold text-ink">Calendar</span>
                  {meetCtx.priorMeetings > 0 &&
                    ` · Met ${meetCtx.priorMeetings === 1 ? "once" : `${meetCtx.priorMeetings} times`}${
                      meetCtx.lastMetAt ? `, last on ${etFullDate(meetCtx.lastMetAt)}` : ""
                    }`}
                  {meetCtx.upcoming.map((u) => (
                    <span key={u.id}> · Upcoming: {u.title}, {etWeekdayDay(u.startsAt)}</span>
                  ))}
                </p>
              )}
              {intelLines.map((l) => (
                <p key={l}>{l}</p>
              ))}
            </div>
          </details>
        )}
      </div>

      {/* The evidence: the email, in full, right under the card. */}
      {c.body_text && (
        <section className="anim-fade-up mb-8 mt-6" id="email-section" style={{ animationDelay: "40ms" }}>
          <h2 className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-sub">Email</h2>
          <div className="max-w-[760px]">
            <EmailThread bodyText={c.body_text} />
          </div>
        </section>
      )}

      {/* Verdicts, pinned. */}
      <div className="sticky bottom-0 mt-auto border-t border-line-strong bg-bg px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-6">
        {error && (
          <Callout tone="error" className="mb-3 p-3 text-[13px]">{error}</Callout>
        )}
        <div className="flex flex-wrap items-center gap-2">
          {open && (
            <>
              <button className="btn-primary tap flex-1 sm:flex-none" disabled={busy !== null} onClick={() => void board()}>
                {busy === "board" ? "Adding…" : "Add to board"}
              </button>
              {passing ? (
                <span className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
                  <input
                    className="field !h-10 w-full !text-[13px] sm:w-72"
                    autoFocus
                    placeholder="Why? (optional)"
                    value={passReason}
                    onChange={(e) => setPassReason(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void triage("pass", { kind: "pass", reason: passReason });
                      if (e.key === "Escape") setPassing(false);
                    }}
                  />
                  <button className="btn-secondary tap" disabled={busy !== null} onClick={() => void triage("pass", { kind: "pass", reason: passReason })}>
                    {busy === "pass" ? "Passing…" : "Pass"}
                  </button>
                  <button className="tap-sm text-[13px] font-medium text-sub hover:text-primary" onClick={() => setPassing(false)}>
                    Cancel
                  </button>
                </span>
              ) : (
                <button className="btn-secondary tap flex-1 sm:flex-none" disabled={busy !== null} onClick={() => setPassing(true)}>
                  Pass
                </button>
              )}
              <button
                className="tap-sm text-[13px] font-medium text-sub hover:text-primary"
                disabled={busy !== null}
                title="Not a deal. Removes it from the inbox."
                onClick={() => void triage("ignore", { kind: "ignore" })}
              >
                Not a deal
              </button>
              <span className="ml-auto flex items-center gap-3">
                {queueTotal > 0 && (
                  <span className="whitespace-nowrap text-[12px] text-faint" aria-live="polite">
                    {queuePosition > 0 ? `${queuePosition} of ${queueTotal}` : `${queueTotal} open`}
                  </span>
                )}
                <CandidatePager prevId={prevId} nextId={nextId} />
              </span>
            </>
          )}
          {!open && (c.status === "passed" || c.status === "ignored") && (
            <button className="btn-secondary tap" disabled={busy !== null} onClick={() => void triage("reopen", { kind: "reopen" }, false)}>
              {busy === "reopen" ? "Reopening…" : "Reopen"}
            </button>
          )}
          {!open && c.promoted_deal_gid && (
            <p className="text-[14px] text-sub">On the board.</p>
          )}
          {!open && (
            <span className="ml-auto">
              <CandidatePager prevId={prevId} nextId={nextId} />
            </span>
          )}
        </div>
        {open && (
          <p className="mt-2 hidden text-[11px] text-faint sm:block">
            Keys: <span className="font-medium">b</span> add to board · <span className="font-medium">p</span> pass ·{" "}
            <span className="font-medium">i</span> not a deal
          </p>
        )}
      </div>
    </>
  );
}
