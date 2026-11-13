"use client";

import { useEffect, useMemo, useState } from "react";
import { Close } from "@carbon/icons-react";
import type { SectionInfo, StageKey } from "@/lib/types";
import { composeNotes, type FounderRow } from "@/lib/founders";
import { FileDrop, MAX_FILES, MAX_TOTAL_BYTES } from "./FileDrop";
import { FounderFields } from "./FounderFields";

/** Everything the dashboard needs to show the deal locally . */
export interface NewDealPayload {
  name: string;
  notes: string;
  sectionGid: string;
  stage: StageKey;
  /** School names — the server creates tags on save. */
  schools: string[];
  financingAmount: string;
  round: string;
  files: File[];
  /** The company name alone, for the founders' network records. */
  company: string;
  /** Founders — each also becomes a person in the Network tab. */
  founders: FounderRow[];
}

const ROUNDS = ["Angel", "Pre-Seed", "Seed", "Series A"];

/** Seed values for the form — e.g. extraction from an inbound pitch. */
export interface DealPrefill {
  company?: string;
  financing?: string;
  round?: string;
  notes?: string;
  founders?: FounderRow[];
}

export function CreateDealModal({
  sections,
  schoolNames,
  presetSectionGid,
  initial,
  title = "New deal",
  submitLabel = "Create deal",
  onClose,
  onCreate,
}: {
  sections: SectionInfo[];
  /** All known school names, for the founder-school autocomplete. */
  schoolNames: string[];
  presetSectionGid?: string;
  /** Pre-filled values (inbound extraction); user edits before creating. */
  initial?: DealPrefill;
  title?: string;
  submitLabel?: string;
  onClose: () => void;
  /** Called with the composed deal — the parent shows it locally and syncs. */
  /** May return a promise — the modal shows a pending state until it lands. */
  onCreate: (payload: NewDealPayload) => void | Promise<void>;
}) {
  const firstSection = sections[0]?.gid ?? "";
  const [company, setCompany] = useState(initial?.company ?? "");
  const [financing, setFinancing] = useState(initial?.financing ?? "");
  const [round, setRound] = useState(
    ROUNDS.find((r) => r.toLowerCase() === (initial?.round ?? "").toLowerCase()) ?? ""
  );
  const [notes, setNotes] = useState(initial?.notes ?? "");
  const [sectionGid, setSectionGid] = useState(
    presetSectionGid || firstSection
  );
  // Committed founders (the block) plus the in-progress entry form.
  const [founders, setFounders] = useState<FounderRow[]>(initial?.founders ?? []);
  const [draft, setDraft] = useState<FounderRow>({
    name: "",
    school: "",
    linkedin: "",
    email: "",
  });
  // Write-in school when the dropdown is set to "Other".
  const [draftOther, setDraftOther] = useState("");
  // True from Create-click until the handler settles: pending label on the
  // button, closes disabled, double-submit impossible.
  const [submitting, setSubmitting] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const [error, setError] = useState("");

  // Escape closes the popup.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Size the overlay to the visual viewport so the mobile sheet stays above
  // the keyboard.
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

  // Resolve the "Other — write in" choice to the typed school name.
  const draftSchool =
    draft.school === "__other__" ? draftOther.trim() : draft.school;

  // A founder typed into the entry form but not yet added still counts.
  const effectiveFounders = useMemo(
    () =>
      draft.name.trim()
        ? [...founders, { ...draft, school: draftSchool }]
        : founders,
    [founders, draft, draftSchool]
  );
  const founderNames = useMemo(
    () => effectiveFounders.map((f) => f.name.trim()).filter(Boolean),
    [effectiveFounders]
  );
  const taskName = useMemo(() => {
    const c = company.trim();
    if (!c) return "";
    return founderNames.length > 0 ? `${founderNames.join(", ")} // ${c}` : c;
  }, [company, founderNames]);

  const totalBytes = files.reduce((n, f) => n + f.size, 0);

  const addFounder = () => {
    if (!draft.name.trim()) return;
    setFounders([
      ...founders,
      { ...draft, name: draft.name.trim(), school: draftSchool },
    ]);
    setDraft({ name: "", school: "", linkedin: "", email: "" });
    setDraftOther("");
  };

  const submit = async () => {
    if (submitting) return;
    setError("");
    if (!company.trim()) {
      setError("Give the deal a name.");
      return;
    }
    if (files.length > 0 && totalBytes > MAX_TOTAL_BYTES) {
      setError("Attachments exceed the 4MB upload limit — remove some files.");
      return;
    }

    // Compose notes: freeform text plus a structured founders block.
    const financingLine =
      financing.trim() || round
        ? `Raising: ${financing.trim() || "TBD"}${round ? ` (${round})` : ""}`
        : "";
    const fullNotes = composeNotes(
      [financingLine, notes.trim()].filter(Boolean).join("\n\n"),
      effectiveFounders
    );

    // School tags ride the founders: every founder's school, deduped. The
    // separate checkbox picker is gone — founders are the source of truth.
    const schoolInputs = effectiveFounders.map((f) => f.school);
    const seen = new Map<string, string>();
    for (const s of schoolInputs) {
      const n = s.trim();
      if (n && !seen.has(n.toLowerCase())) seen.set(n.toLowerCase(), n);
    }
    const displaySchools = [...seen.values()];

    // Local-first: hand everything to the dashboard, which shows the deal
    // immediately and saves in the background. While the handler
    // runs (create + upload + finalize), the footer shows a live pending
    // state — the button must never feel dead.
    setSubmitting(true);
    try {
      await Promise.resolve(
        onCreate({
          name: taskName,
          notes: fullNotes,
          sectionGid,
          stage: sections.find((s) => s.gid === sectionGid)?.stage ?? "to-meet",
          schools: displaySchools,
          financingAmount: financing.trim(),
          round,
          files,
          company: company.trim(),
          founders: effectiveFounders
            .map((f) => ({
              name: f.name.trim(),
              school: f.school.trim(),
              linkedin: f.linkedin.trim(),
              email: f.email.trim().toLowerCase(),
            }))
            .filter((f) => f.name),
        })
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="anim-fade fixed inset-0 z-50 flex items-end justify-center bg-navy/50 p-0 sm:items-center sm:p-4"
      style={vv ? { top: vv.top, height: vv.height, bottom: "auto" } : undefined}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !submitting) onClose();
      }}
    >
      <div
        className="card anim-pop flex max-h-full w-full max-w-2xl flex-col overflow-hidden bg-bg sm:max-h-[90dvh]"
        onFocus={(e) => {
          const t = e.target as HTMLElement;
          if (t.matches("input, textarea, select")) {
            setTimeout(() => t.scrollIntoView({ block: "center", behavior: "smooth" }), 60);
          }
        }}
      >
        <div className="flex shrink-0 items-start justify-between gap-4 px-6 pb-4 pt-6">
          <h2 className="text-[20px] font-normal text-ink">{title}</h2>
          <button
            className="tap flex items-center justify-center text-sub hover:text-ink disabled:opacity-40"
            onClick={onClose}
            disabled={submitting}
            aria-label="Close"
          >
            <Close size={22} />
          </button>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto overscroll-contain px-6 pb-5">
          <div>
            <span className="mb-1 block text-[12px] font-semibold text-sub">
              Deal name
            </span>
            {/* Company takes half; financing and round split the other half. */}
            <div className="flex flex-col gap-2.5 sm:flex-row">
              <div className="min-w-0 w-full sm:w-1/2">
                <input
                  className="field"
                  autoFocus
                  placeholder="Company"
                  value={company}
                  onChange={(e) => setCompany(e.target.value)}
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
                    {ROUNDS.map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            </div>
            {founderNames.length > 0 && company.trim() && (
              <span className="mt-1 block text-[12px] text-faint">
                Saves as “{taskName}”
              </span>
            )}
          </div>

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

          <FounderFields
            founders={founders}
            draft={draft}
            draftOther={draftOther}
            schoolNames={schoolNames}
            onFounders={setFounders}
            onDraft={setDraft}
            onDraftOther={setDraftOther}
            onAdd={addFounder}
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

          {/* Attachments */}
          <div>
            <span className="mb-1 block text-[12px] font-semibold text-sub">
              Attachments{" "}
              <span className="font-normal text-faint">
                (decks, docs — up to {MAX_FILES} files, 4MB total)
              </span>
            </span>
            <FileDrop files={files} onChange={setFiles} />
          </div>

          {error && <div className="callout p-3 text-[13px]">{error}</div>}
        </div>

        {/* Sticky footer: always visible, never scrolls away. */}
        <div className="flex shrink-0 justify-end gap-2 border-t border-line-strong bg-bg px-6 py-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
          <button className="btn-secondary disabled:opacity-40" onClick={onClose} disabled={submitting}>
            Cancel
          </button>
          <button
            className="btn-primary disabled:cursor-default disabled:opacity-70"
            onClick={() => void submit()}
            disabled={submitting}
            aria-busy={submitting}
          >
            {submitting ? (
              <span className="inline-flex items-center gap-2">
                <span
                  className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/40 border-t-white"
                  aria-hidden
                />
                Creating…
              </span>
            ) : (
              submitLabel
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
