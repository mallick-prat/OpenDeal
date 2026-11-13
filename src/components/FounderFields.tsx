"use client";

import { crm } from "@/config/crm.config";

import { useEffect, useRef, useState } from "react";
import { Add, Edit, LogoLinkedin, OverflowMenuHorizontal, TrashCan } from "@carbon/icons-react";
import type { FounderRow } from "@/lib/founders";

/** Make a possibly-bare LinkedIn value into an openable URL. */
function linkedinHref(raw: string): string {
  const u = raw.trim();
  return /^https?:\/\//i.test(u) ? u : `https://${u}`;
}

/** Per-founder "⋯" menu: Edit and Remove. */
function RowMenu({
  name,
  onEdit,
  onRemove,
}: {
  name: string;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);
  const item =
    "flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] text-body hover:bg-bg-soft";
  return (
    <div ref={ref} className="relative shrink-0">
      <button
        className="tap flex items-center justify-center p-1 text-sub transition-colors hover:text-primary"
        aria-label={`Edit ${name}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <OverflowMenuHorizontal size={16} />
      </button>
      {open && (
        <div className="absolute right-0 top-full z-20 mt-1 w-32 overflow-hidden rounded-lg border border-line bg-bg py-1 shadow-lg">
          <button
            className={item}
            onClick={() => {
              onEdit();
              setOpen(false);
            }}
          >
            <Edit size={14} /> Edit
          </button>
          <button
            className={item}
            onClick={() => {
              onRemove();
              setOpen(false);
            }}
          >
            <TrashCan size={14} /> Remove
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * The founder block shared by the create and edit deal cards: committed
 * founder rows plus the entry form (name + school dropdown + LinkedIn).
 * The parent owns all state so it can react to adds (e.g. auto-ticking
 * the school picker).
 */
export function FounderFields({
  founders,
  draft,
  draftOther,
  schoolNames,
  onFounders,
  onDraft,
  onDraftOther,
  onAdd,
  collapsedAdd = false,
  rowExtra,
}: {
  founders: FounderRow[];
  draft: FounderRow;
  draftOther: string;
  schoolNames: string[];
  onFounders: (rows: FounderRow[]) => void;
  onDraft: (d: FounderRow) => void;
  onDraftOther: (s: string) => void;
  onAdd: () => void;
  /** Hide the entry form behind "+ Add founder" (progressive disclosure). */
  collapsedAdd?: boolean;
  /** Per-founder extra block (the address strip); owns email UI when set. */
  rowExtra?: (name: string) => React.ReactNode;
}) {
  const [adding, setAdding] = useState(!collapsedAdd);
  // Which committed row is being edited in place, and its working copy.
  const [editIdx, setEditIdx] = useState<number | null>(null);
  const [editRow, setEditRow] = useState<FounderRow>({ name: "", school: "", linkedin: "", email: "" });

  const startEdit = (i: number) => {
    setEditIdx(i);
    setEditRow({ ...founders[i] });
  };
  const saveEdit = () => {
    if (editIdx === null || !editRow.name.trim()) return;
    onFounders(
      founders.map((f, j) =>
        j === editIdx
          ? {
              name: editRow.name.trim(),
              school: editRow.school.trim(),
              linkedin: editRow.linkedin.trim(),
              email: editRow.email.trim().toLowerCase(),
            }
          : f
      )
    );
    setEditIdx(null);
  };

  return (
    <div>
      <span className="mb-1 block text-[12px] font-semibold text-sub">
        Founders
      </span>

      {/* The block: committed founders */}
      {founders.length > 0 && (
        <div className="card-flat mb-3 flex flex-col">
          {founders.map((f, i) =>
            editIdx === i ? (
              <div
                key={`edit-${i}`}
                className="flex flex-col gap-2 border-b border-line px-3 py-2.5 last:border-0"
              >
                <div className="flex flex-col gap-2 sm:flex-row">
                  <input
                    className="field min-w-0 flex-[3]"
                    placeholder="Founder name"
                    autoFocus
                    value={editRow.name}
                    onChange={(e) => setEditRow({ ...editRow, name: e.target.value })}
                  />
                  <input
                    className="field min-w-0 flex-1"
                    placeholder={crm.tags.singular}
                    value={editRow.school}
                    onChange={(e) => setEditRow({ ...editRow, school: e.target.value })}
                  />
                </div>
                <input
                  className="field"
                  type="email"
                  inputMode="email"
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                  // The address every meeting and email on this deal is matched
                  // on — without it the history panel has nothing to search.
                  placeholder="Email"
                  value={editRow.email}
                  onChange={(e) => setEditRow({ ...editRow, email: e.target.value })}
                  onKeyDown={(e) => e.key === "Enter" && saveEdit()}
                />
                <input
                  className="field"
                  placeholder="LinkedIn profile URL"
                  value={editRow.linkedin}
                  onChange={(e) => setEditRow({ ...editRow, linkedin: e.target.value })}
                  onKeyDown={(e) => e.key === "Enter" && saveEdit()}
                />
                <div className="flex items-center gap-2">
                  <button
                    className="btn-primary !text-[13px]"
                    onClick={saveEdit}
                    disabled={!editRow.name.trim()}
                  >
                    Save
                  </button>
                  <button
                    className="text-[13px] font-medium text-sub hover:text-primary"
                    onClick={() => setEditIdx(null)}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <div
                key={`${f.name}-${i}`}
                className="border-b border-line px-3 py-2 last:border-0"
              >
              <div className="flex items-center justify-between gap-3">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  {f.linkedin ? (
                    <a
                      href={linkedinHref(f.linkedin)}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-[14px] font-medium text-ink hover:text-primary hover:underline"
                      title="Open LinkedIn profile"
                    >
                      {f.name}
                      <LogoLinkedin size={14} className="text-[#0a66c2]" />
                    </a>
                  ) : (
                    <span className="text-[14px] font-medium text-ink">{f.name}</span>
                  )}
                  {!rowExtra &&
                    (f.email ? (
                      <a
                        href={`mailto:${f.email}`}
                        className="truncate text-[12px] text-sub hover:text-primary hover:underline"
                        title={`${f.email} — meetings and email are matched on this`}
                      >
                        {f.email}
                      </a>
                    ) : (
                      // Say what's missing and why: without an address this
                      // founder's meeting history can't be looked up at all.
                      <button
                        onClick={() => startEdit(i)}
                        className="text-[12px] text-faint underline decoration-dotted underline-offset-2 hover:text-primary"
                        title="Add an email to find past meetings with this founder"
                      >
                        + email
                      </button>
                    ))}
                  {f.school && (
                    <span className="border border-line px-1.5 py-0.5 text-[11px] text-sub">
                      {f.school}
                    </span>
                  )}
                </div>
                <RowMenu
                  name={f.name}
                  onEdit={() => startEdit(i)}
                  onRemove={() => onFounders(founders.filter((_, j) => j !== i))}
                />
              </div>
              {rowExtra?.(f.name)}
              </div>
            )
          )}
        </div>
      )}

      {/* Entry form: name + school share a row (3:1), then + to add.
          When collapsedAdd, one text button reveals it on demand. */}
      {!adding ? (
        <button
          className="flex items-center gap-1.5 text-[13px] font-medium text-primary hover:text-primary-pressed"
          onClick={() => setAdding(true)}
        >
          <Add size={16} /> Add founder
        </button>
      ) : (
      <div className="card-flat flex flex-col gap-2.5 p-3">
        <div className="flex flex-col gap-2.5 sm:flex-row">
          <div className="min-w-0 flex-[3]">
            <input
              className="field"
              placeholder="Founder name"
              value={draft.name}
              onChange={(e) => onDraft({ ...draft, name: e.target.value })}
            />
          </div>
          <div className="min-w-0 flex-1">
            <select
              className="field"
              aria-label="Founder school"
              value={draft.school}
              onChange={(e) => onDraft({ ...draft, school: e.target.value })}
            >
              <option value="">{crm.tags.singular}</option>
              {schoolNames.slice(0, 10).map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
              <option value="__other__">Other — write in</option>
            </select>
          </div>
        </div>
        {draft.school === "__other__" && (
          <input
            className="field"
            autoFocus
            placeholder={`${crm.tags.singular} name`}
            value={draftOther}
            onChange={(e) => onDraftOther(e.target.value)}
          />
        )}
        <input
          className="field"
          placeholder="LinkedIn profile URL"
          value={draft.linkedin}
          onChange={(e) => onDraft({ ...draft, linkedin: e.target.value })}
          onKeyDown={(e) => e.key === "Enter" && onAdd()}
        />
        <button
          className="flex items-center gap-1.5 self-start text-[13px] font-medium text-primary hover:text-primary-pressed disabled:text-faint"
          onClick={onAdd}
          disabled={!draft.name.trim()}
        >
          <Add size={16} />
          Add founder
        </button>
      </div>
      )}
    </div>
  );
}
