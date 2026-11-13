"use client";

import { crm } from "@/config/crm.config";
import { Callout } from "./Callout";
import { useEffect, useMemo, useRef, useState } from "react";
import { Close } from "@carbon/icons-react";
import type { Deal, DealDraft, SectionInfo } from "@/lib/types";
import { loadDealDraft, saveDeal } from "@/app/actions";
import {
  companyFromDealName,
  composeNotes,
  extractFounders,
  type FounderRow,
} from "@/lib/founders";
import { PassComposer } from "./PassComposer";
import { FounderFields } from "./FounderFields";
import { useFounderEmails, AddressPanel } from "./FounderEmails";
import { parseOther } from "./SchoolFields";
import { SchoolTags } from "./SchoolTags";
import { FileDrop, MAX_TOTAL_BYTES } from "./FileDrop";
import { DealAttachments } from "./DealAttachments";
import { DealMeetings } from "./DealMeetings";
import { DealEmails } from "./DealEmails";
import { OwnerPicker } from "./OwnerPicker";
import { DealComments } from "./DealComments";
import { DealActionsMenu } from "./DealActionsMenu";
import { etShortDate } from "@/lib/etDates";

const ROUNDS = crm.rounds;

/** A server action the current deployment no longer knows: this tab predates
 *  the latest release. Nothing is wrong with the deal; the page needs a reload. */
function staleDeploymentMessage(err: unknown): string | null {
  const msg = err instanceof Error ? err.message : String(err);
  return /was not found on the server|older or newer deployment|Failed to find Server Action/i.test(msg)
    ? "The app was updated since this page loaded. Reload the page, then save again."
    : null;
}

export function EditDealModal({
  deal,
  sections,
  topSchools,
  members = [],
  viewer,
  onClose,
  onSaved,
  onDelete,
}: {
  deal: Deal;
  sections: SectionInfo[];
  topSchools: string[];
  members?: { email: string; name: string; image: string | null }[];
  /** The signed-in member — author of new comments; role gates comment delete. */
  viewer: {
    email: string;
    name: string;
    image: string | null;
    role: "super_admin" | "admin" | "user";
  };
  onClose: () => void;
  onSaved: () => void;
  /** Two-step-confirmed delete; the parent removes it locally and syncs. */
  onDelete: (deal: Deal) => void;
}) {
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [draft, setDraft] = useState<DealDraft | null>(null);
  const [loadError, setLoadError] = useState("");
  const [name, setName] = useState("");
  const [notes, setNotes] = useState("");
  // Founders live as a text block in the notes; the card shows them as rows.
  const [founders, setFounders] = useState<FounderRow[]>([]);
  const [founderDraft, setFounderDraft] = useState<FounderRow>({
    name: "",
    school: "",
    linkedin: "",
    email: "",
  });
  const [founderOther, setFounderOther] = useState("");
  // Names already on the deal when it opened — only NEW ones join the network.
  const [initialFounderNames, setInitialFounderNames] = useState<Set<string>>(
    new Set()
  );
  const [sectionGid, setSectionGid] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [otherOn, setOtherOn] = useState(false);
  const [otherText, setOtherText] = useState("");
  const [financing, setFinancing] = useState("");
  const [round, setRound] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  // R-01: someone else wrote this deal while the modal was open. The form
  // keeps the member's typing; they choose Reload or Save anyway.
  const [conflict, setConflict] = useState(false);
  const [reloadNonce, setReloadNonce] = useState(0);

  const orderedTop = useMemo(() => topSchools.slice(0, 10), [topSchools]);

  const founderMail = useFounderEmails(deal.gid);
  const [mailMerged, setMailMerged] = useState(false);
  useEffect(() => {
    if (mailMerged || !draft || founderMail.people === null) return;
    setMailMerged(true);
    const rows = [...founders];
    const rowNames = new Set(rows.map((r) => r.name.trim().toLowerCase()));
    const allNames = [
      ...rowNames,
      ...founderMail.people.map((pp) => pp.name.trim().toLowerCase()),
    ];
    let changed = false;
    for (const person of founderMail.people) {
      const key = person.name.trim().toLowerCase();
      const primary = person.addresses.find((a) => a.primary)?.email ?? "";
      if (rowNames.has(key)) {
        const i = rows.findIndex((r) => r.name.trim().toLowerCase() === key);
        if (i >= 0 && !rows[i].email && primary) {
          rows[i] = { ...rows[i], email: primary };
          changed = true;
        }
        continue;
      }
      // Ghost fragments ("Pat" next to "Pat Rivera") stay hidden.
      const isFragment =
        !key.includes(" ") &&
        allNames.some((n) => n !== key && n.split(/\s+/)[0] === key);
      if (isFragment) continue;
      rows.push({ name: person.name.trim(), school: "", linkedin: "", email: primary });
      rowNames.add(key);
      changed = true;
    }
    if (changed) {
      setFounders(rows);
      // Names that already live as canonical links never re-insert into the
      // network on save.
      setInitialFounderNames(
        (cur) =>
          new Set([
            ...cur,
            ...founderMail.people!.map((pp) => pp.name.trim().toLowerCase()),
          ])
      );
    }
  }, [mailMerged, draft, founderMail.people, founders]);

  // Mobile keyboard handling: size the overlay to the VISUAL viewport so the
  // bottom sheet (and its sticky footer) always sits above the keyboard.
  const [vv, setVv] = useState<{ height: number; top: number } | null>(null);
  useEffect(() => {
    const v = typeof window !== "undefined" ? window.visualViewport : null;
    if (!v) return;
    const on = () => setVv({ height: v.height, top: v.offsetTop });
    on();
    v.addEventListener("resize", on);
    v.addEventListener("scroll", on);
    return () => {
      v.removeEventListener("resize", on);
      v.removeEventListener("scroll", on);
    };
  }, []);

  // Escape closes the popup — but through the dirty guard (kept in a ref so the
  // once-bound listener always calls the latest version).
  const attemptCloseRef = useRef<() => void>(() => {});
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") attemptCloseRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    let alive = true;
    loadDealDraft(deal.gid).catch((err) => ({
      ok: false as const,
      error: staleDeploymentMessage(err) ?? "Couldn't reach the server. Reload to try again.",
    })).then((res) => {
      if (!alive) return;
      if (res.ok) {
        setDraft(res.draft);
        setName(res.draft.name);
        const split = extractFounders(res.draft.notes);
        setNotes(split.rest);
        setFounders(split.founders);
        setInitialFounderNames(
          new Set(split.founders.map((f) => f.name.trim().toLowerCase()))
        );
        setSectionGid(res.draft.sectionGid);
        // Seed the school picker: top-10 as checkboxes, the rest into write-in.
        const names = res.draft.schools;
        const topSet = new Set(orderedTop);
        const others = names.filter((n) => !topSet.has(n));
        setSelected(new Set(names.filter((n) => topSet.has(n))));
        setOtherOn(others.length > 0);
        setOtherText(others.join(", "));
        setFinancing(res.draft.financing ?? "");
        setRound(res.draft.round ?? "");
      } else {
        setLoadError(res.error);
      }
    });
    return () => {
      alive = false;
    };
  }, [deal.gid, orderedTop, reloadNonce]);

  const toggle = (school: string) => {
    const next = new Set(selected);
    if (next.has(school)) next.delete(school);
    else next.add(school);
    setSelected(next);
  };

  // "From the pitch email · Jul 12" — the field's latest provenance claim.
  const sourceCaption = (field: string): string | null => {
    const c = draft?.sources?.[field];
    if (!c) return null;
    const when = etShortDate(c.at);
    const who = c.actor ? c.actor.split("@")[0] : null;
    switch (c.source) {
      case "email":
        return `From the pitch email · ${when}`;
      case "granola":
        return `From a Granola note · ${when}`;
      case "merge":
        return `Merged from another deal · ${when}`;
      case "calendar":
        return `From calendar · ${when}`;
      case "manual":
        return who ? `Edited by ${who} · ${when}` : `Edited by hand · ${when}`;
    }
  };

  const addFounder = () => {
    if (!founderDraft.name.trim()) return;
    const school =
      founderDraft.school === "__other__"
        ? founderOther.trim()
        : founderDraft.school;
    setFounders([
      ...founders,
      { ...founderDraft, name: founderDraft.name.trim(), school },
    ]);
    setFounderDraft({ name: "", school: "", linkedin: "", email: "" });
    setFounderOther("");
  };

  const submit = async (force = false) => {
    if (!draft) return;
    if (files.length > 0) {
      const total = files.reduce((n, f) => n + f.size, 0);
      if (total > MAX_TOTAL_BYTES) {
        setSaveError("Attachments exceed the 4MB upload limit.");
        return;
      }
    }
    setSaving(true);
    setSaveError("");
    setConflict(false);

    const finalNames = [...selected, ...(otherOn ? parseOther(otherText) : [])];

    // A founder typed into the entry form but not yet added still counts.
    const school =
      founderDraft.school === "__other__"
        ? founderOther.trim()
        : founderDraft.school;
    const finalFounders = founderDraft.name.trim()
      ? [...founders, { ...founderDraft, school }]
      : founders;

    let res: Awaited<ReturnType<typeof saveDeal>>;
    try {
      res = await saveDeal({
      gid: draft.gid,
      name,
      notes: composeNotes(notes, finalFounders),
      sectionGid: sectionGid !== draft.sectionGid ? sectionGid : "",
      schools: finalNames,
      financingAmount: financing,
      round,
      newFounders: finalFounders
        .map((f) => ({
          name: f.name.trim(),
          school: f.school.trim(),
          linkedin: f.linkedin.trim(),
        }))
        .filter(
          (f) => f.name && !initialFounderNames.has(f.name.toLowerCase())
        ),
      baselineHash: draft.baselineHash ?? null,
      force,
      });
    } catch (err) {
      // A thrown action (a tab older than the latest deploy, a dropped
      // connection) used to leave "Saving…" up forever. Say what happened.
      setSaving(false);
      setSaveError(staleDeploymentMessage(err) ?? "Couldn't reach the server. Try again.");
      return;
    }
    if (!res.ok) {
      setSaving(false);
      setConflict(!!res.conflict);
      setSaveError(res.error ?? "Something went wrong.");
      return;
    }
    if (files.length > 0) {
      const fd = new FormData();
      fd.append("taskGid", draft.gid);
      for (const f of files) fd.append("files", f, f.name);
      const up = await fetch("/api/attachments", { method: "POST", body: fd })
        .then((r) => r.json())
        .catch(() => ({ ok: false }));
      if (!up.ok) {
        setSaving(false);
        setSaveError(
          up.error ?? "Saved, but the attachments didn't upload — try again."
        );
        return;
      }
    }
    setSaving(false);
    onSaved();
  };

  // Have any of the STAGED fields changed since load? (Owners, decision, and
  // comments commit on their own, so they never count as unsaved here.)
  const isDirty = (): boolean => {
    if (!draft) return false;
    if (name !== draft.name) return true;
    if ((financing || "") !== (draft.financing ?? "")) return true;
    if ((round || "") !== (draft.round ?? "")) return true;
    if (sectionGid !== draft.sectionGid) return true;
    if (files.length > 0) return true;
    const finalNames = [...selected, ...(otherOn ? parseOther(otherText) : [])];
    const a = new Set(finalNames.map((s) => s.trim().toLowerCase()).filter(Boolean));
    const b = new Set(draft.schools.map((s) => s.trim().toLowerCase()).filter(Boolean));
    if (a.size !== b.size || [...a].some((s) => !b.has(s))) return true;
    const school =
      founderDraft.school === "__other__" ? founderOther.trim() : founderDraft.school;
    const finalFounders = founderDraft.name.trim()
      ? [...founders, { ...founderDraft, school }]
      : founders;
    return composeNotes(notes, finalFounders) !== draft.notes;
  };

  const attemptClose = () => {
    if (
      isDirty() &&
      typeof window !== "undefined" &&
      !window.confirm("Discard your unsaved changes?")
    ) {
      return;
    }
    onClose();
  };
  // Keep the ref the Escape listener calls pointed at the latest closure.
  useEffect(() => {
    attemptCloseRef.current = attemptClose;
  });

  return (
    <div
      className="anim-fade fixed inset-0 z-50 flex items-end justify-center bg-navy/50 p-0 sm:items-center sm:p-4"
      style={vv ? { top: vv.top, height: vv.height, bottom: "auto" } : undefined}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) attemptClose();
      }}
    >
      <div className="card anim-pop flex max-h-full w-full max-w-2xl flex-col overflow-hidden overscroll-contain bg-bg sm:max-h-[90dvh]">
        <div className="flex shrink-0 items-center justify-between gap-4 px-6 pb-3 pt-5">
          <div className="flex items-center gap-1">
            <DealActionsMenu deal={deal} onDelete={() => setConfirmingDelete(true)} />
            <h2 className="text-[20px] font-normal text-ink">Edit deal</h2>
          </div>
          <button
            className="tap flex items-center justify-center text-sub hover:text-ink"
            onClick={attemptClose}
            aria-label="Close"
          >
            <Close size={22} />
          </button>
        </div>

        {/* Scrollable body: everything above the pinned footer. On focus, lift
            the field into view so the on-screen keyboard never covers it. */}
        <div
          className="min-h-0 flex-1 overflow-y-auto px-6 pb-4"
          onFocus={(e) => {
            const t = e.target as HTMLElement;
            if (t.matches("input, textarea, select")) {
              setTimeout(() => t.scrollIntoView({ block: "center", behavior: "smooth" }), 60);
            }
          }}
        >
          {confirmingDelete && (
            <Callout tone="error" className="mb-3 flex flex-wrap items-center gap-2 p-3 text-[13px]">
              <span className="flex-1">Delete this deal?</span>
              <button
                className="font-semibold text-primary hover:text-primary-pressed"
                onClick={() => onDelete(deal)}
                disabled={saving}
              >
                Yes, delete
              </button>
              <button
                className="font-medium text-sub hover:text-ink"
                onClick={() => setConfirmingDelete(false)}
              >
                Keep
              </button>
            </Callout>
          )}
          {loadError && (
            <Callout tone="error" className="p-3 text-[13px]">
              Couldn&apos;t open this deal: {loadError}
            </Callout>
          )}

          {!draft && !loadError && (
            <p role="status" aria-live="polite" className="py-10 text-center text-[14px] text-sub">
              Opening…
            </p>
          )}

          {draft && (
            <div className="flex flex-col gap-4">
            <div>
              <span className="mb-1 block text-[12px] font-semibold text-sub">
                Deal name
              </span>
              <div className="flex flex-col gap-2.5 sm:flex-row">
                <div className="min-w-0 w-full sm:w-1/2">
                  <input
                    className="field"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                  />
                </div>
                <div className="flex min-w-0 w-full gap-2.5 sm:w-1/2">
                  <div className="min-w-0 w-full sm:w-1/2">
                    <input
                      className="field"
                      placeholder="$ Financing"
                      value={financing}
                      onChange={(e) => setFinancing(e.target.value)}
                    />
                  </div>
                  <div className="min-w-0 w-full sm:w-1/2">
                    <select
                      className="field"
                      aria-label="Round"
                      value={round}
                      onChange={(e) => setRound(e.target.value)}
                    >
                      <option value="">Round</option>
                      {/* Keep an existing value even if it isn't in the configured list. */}
                      {[...ROUNDS, ...(round && !ROUNDS.includes(round) ? [round] : [])].map((r) => (
                        <option key={r} value={r}>
                          {r}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              </div>
              {(() => {
                // A-01: one quiet line answering "where did this number come
                // from" — the latest provenance claim for financing (or round).
                const caption = financing
                  ? sourceCaption("financing")
                  : round
                    ? sourceCaption("round")
                    : null;
                return caption ? (
                  <p className="mt-1 text-[11px] text-sub">{caption}</p>
                ) : null;
              })()}
            </div>

            {/* Stage and Pass share the top row, control-height aligned.
                Passing happens HERE, note and all — no page hop; the open
                composer takes the full row. Ambiguous one-slash titles keep
                [Company] visible rather than guess. */}
            <div className="grid gap-2.5 sm:grid-cols-2">
              <label className="block">
                <span className="mb-1 block text-[12px] font-semibold text-sub">
                  Stage
                </span>
                <select
                  className="field"
                  value={sectionGid}
                  onChange={(e) => setSectionGid(e.target.value)}
                >
                  {sections.map((s) => (
                    <option key={s.gid} value={s.gid}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </label>
              <PassComposer
                gid={deal.gid}
                companyName={(() => {
                  const c = companyFromDealName(deal.name).trim();
                  return !c || / \/ /.test(c) ? null : c;
                })()}
                founders={founders.map((f) => ({ name: f.name, email: f.email }))}
                viewerName={viewer.name}
                viewerEmail={viewer.email}
              />
            </div>

            <OwnerPicker
              gid={deal.gid}
              initialOwners={deal.owners}
              members={members}
              onError={setSaveError}
            />

            <div>
              <FounderFields
                founders={founders}
                draft={founderDraft}
                draftOther={founderOther}
                schoolNames={orderedTop}
                onFounders={setFounders}
                onDraft={setFounderDraft}
                onDraftOther={setFounderOther}
                onAdd={addFounder}
                collapsedAdd
                rowExtra={(name) => {
                  const person = founderMail.byName(name);
                  return person ? (
                    <AddressPanel
                      person={person}
                      act={founderMail.act}
                      busy={founderMail.busy}
                    />
                  ) : null;
                }}
              />
              {founderMail.error && (
                <p className="mt-1 text-[12px] text-primary">{founderMail.error}</p>
              )}
            </div>

            <SchoolTags
              selected={selected}
              known={orderedTop}
              onToggle={toggle}
              extras={otherOn ? parseOther(otherText) : []}
              onExtras={(list) => {
                setOtherOn(list.length > 0);
                setOtherText(list.join(", "));
              }}
            />

            <label className="block">
              <span className="mb-1 block text-[12px] font-semibold text-sub">
                Notes
              </span>
              <textarea
                className="field min-h-36 py-2 leading-relaxed"
                style={{ height: "auto" }}
                rows={6}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
              />
            </label>

            <div>
              <span className="mb-1 block text-[12px] font-semibold text-sub">
                Attachments
              </span>
              {deal.attachmentCount > 0 && (
                <div className="mb-2.5">
                  <DealAttachments gid={deal.gid} />
                </div>
              )}
              <FileDrop files={files} onChange={setFiles} />
            </div>

            {/* Each renders its own bordered section — and nothing at all
                when the deal has no history of that kind. */}
            <DealEmails gid={deal.gid} />
            <DealMeetings gid={deal.gid} />

            <div className="border-t border-line pt-5">
              <DealComments gid={deal.gid} viewer={viewer} members={members} />
            </div>
            </div>
          )}
        </div>

        {/* Pinned action bar: a non-scrolling flex child, so it always sits
            flush at the bottom and nothing shows below or through it. */}
        {draft && (
          <div className="shrink-0 border-t border-line bg-bg px-6 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3">
            {saveError && (
              <Callout tone="error" className="mb-2 p-2.5 text-[12px]">
                {saveError}
                {conflict && (
                  <span className="ml-2 inline-flex gap-2">
                    <button
                      className="underline"
                      onClick={() => {
                        setConflict(false);
                        setSaveError("");
                        setMailMerged(false);
                        setReloadNonce((n) => n + 1);
                      }}
                    >
                      Reload
                    </button>
                    <button className="underline" onClick={() => void submit(true)}>
                      Save anyway
                    </button>
                  </span>
                )}
              </Callout>
            )}
            <div className="flex items-center justify-end gap-2">
              <button className="btn-secondary" onClick={attemptClose} disabled={saving}>
                Cancel
              </button>
              <button className="btn-primary" onClick={() => void submit()} disabled={saving}>
                {saving ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
