"use client";

import { crm } from "@/config/crm.config";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Checkmark, Close } from "@carbon/icons-react";
import {
  confirmFounderSchoolAction,
  resolveFounderLinkedinAction,
} from "@/app/actions";
import { LinkedinConfirm } from "./LinkedinConfirm";
import { useTriageSession } from "./TriageSessionContext";

/**
 * The per-founder confirmation workflow, living where it belongs — on the
 * founder's row. Two lines, each one verdict:
 *  · LinkedIn: hunt candidates → Confirm / Not them, or paste a URL by hand.
 *  · School: suggested value → Confirm (rides onto the deal) / Not right.
 */
/** The [School] bracket, directly editable: click, type, Enter. */
export function FounderSchoolEdit({
  candidateId,
  name,
  school,
}: {
  candidateId: string;
  name: string;
  school: string | null;
}) {
  const router = useRouter();
  const session = useTriageSession();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(school ?? "");
  const [busy, setBusy] = useState(false);

  const save = async () => {
    const v = draft.trim();
    if (!v || busy) return;
    setBusy(true);
    const res = await confirmFounderSchoolAction(candidateId, name, v);
    setBusy(false);
    if (res.ok) {
      setEditing(false);
      if (session) void session.refreshCurrent();
      else router.refresh();
    }
  };

  if (editing) {
    return (
      <input
        className="field !h-7 w-28 !px-1.5 !text-[13px]"
        autoFocus
        placeholder={crm.tags.singular}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => (draft.trim() && draft.trim() !== school ? void save() : setEditing(false))}
        onKeyDown={(e) => {
          if (e.key === "Enter") void save();
          if (e.key === "Escape") setEditing(false);
        }}
      />
    );
  }
  return (
    <button
      className="text-[13px] font-medium text-primary underline decoration-dotted underline-offset-2 hover:text-primary-pressed"
      title={`Click to set the ${crm.tags.singular.toLowerCase()}`}
      onClick={() => {
        setDraft(school ?? "");
        setEditing(true);
      }}
    >
      [{busy ? "…" : school ?? `${crm.tags.singular.toLowerCase()}?`}]
    </button>
  );
}

export function FounderTriage({
  candidateId,
  name,
  huntOptions,
  needsLinkedin,
  hasLinkedin = false,
  linkedinUrl = null,
  suggestedSchool,
}: {
  candidateId: string;
  name: string;
  /** Machine hunt candidates ("url (78%)") — null when none. */
  huntOptions: string[] | null;
  /** True when the founder has no profile at all yet. */
  needsLinkedin: boolean;
  /** Founder already has a profile — the affordance becomes a quiet edit. */
  hasLinkedin?: boolean;
  /** The profile URL itself — shown as its own editable line. */
  linkedinUrl?: string | null;
  /** Machine-suggested school awaiting a human verdict — null when settled. */
  suggestedSchool: string | null;
}) {
  const router = useRouter();
  const session = useTriageSession();
  const [pasting, setPasting] = useState(false);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState("");

  const refresh = () => {
    if (session) void session.refreshCurrent();
    else router.refresh();
  };

  const pasteConfirm = async () => {
    if (!url.trim() || busy) return;
    setBusy("paste");
    const res = await resolveFounderLinkedinAction(candidateId, name, url.trim());
    setBusy(null);
    if (!res.ok) {
      setNote(res.error ?? "Didn't go through.");
      return;
    }
    setPasting(false);
    refresh();
  };

  const school = async (confirm: boolean) => {
    setBusy("school");
    const res = await confirmFounderSchoolAction(
      candidateId,
      name,
      confirm ? suggestedSchool : null
    );
    setBusy(null);
    if (!res.ok) {
      setNote(res.error ?? "Didn't go through.");
      return;
    }
    refresh();
  };

  const btn =
    "tap inline-flex items-center gap-0.5 border border-line px-1.5 py-0.5 text-[11px] font-medium hover:border-primary hover:text-primary";

  return (
    <span className="flex flex-col gap-1 text-[13px] text-sub">
      {huntOptions && huntOptions.length > 0 && (
        <span>
          LinkedIn?{" "}
          <LinkedinConfirm candidateId={candidateId} name={name} options={huntOptions} />
        </span>
      )}
      {(needsLinkedin || hasLinkedin) && (!huntOptions || huntOptions.length === 0) && (
        <span className="flex flex-wrap items-center gap-2">
          {pasting ? (
            <>
              <input
                className="field !h-8 w-72 max-w-full !px-2 !text-[13px]"
                autoFocus
                placeholder="https://linkedin.com/in/…"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void pasteConfirm();
                  if (e.key === "Escape") setPasting(false);
                }}
              />
              <button className={`${btn} text-body`} disabled={busy !== null} onClick={() => void pasteConfirm()}>
                <Checkmark size={12} /> {busy === "paste" ? "Linking…" : "Confirm"}
              </button>
            </>
          ) : linkedinUrl ? (
            <>
              LinkedIn:{" "}
              <a
                href={linkedinUrl}
                target="_blank"
                rel="noreferrer"
                className="text-primary hover:underline"
              >
                {linkedinUrl.replace(/^https?:\/\//, "")}
              </a>
              <button
                className="text-[12px] font-medium text-sub hover:text-primary"
                onClick={() => {
                  setUrl(linkedinUrl);
                  setPasting(true);
                }}
              >
                edit
              </button>
            </>
          ) : (
            <button
              className="text-[12px] font-medium text-primary hover:text-primary-pressed"
              onClick={() => setPasting(true)}
            >
              No profile yet — paste their LinkedIn
            </button>
          )}
        </span>
      )}
      {suggestedSchool && (
        <span className="flex flex-wrap items-center gap-2">
          {crm.tags.singular}: <span className="font-medium text-ink">{suggestedSchool}</span>
          <button className={`${btn} text-body`} disabled={busy !== null} onClick={() => void school(true)}>
            <Checkmark size={12} /> {busy === "school" ? "Saving…" : "Confirm"}
          </button>
          <button className={`${btn} text-sub`} disabled={busy !== null} onClick={() => void school(false)}>
            <Close size={12} /> Not right
          </button>
        </span>
      )}
      {note && <span className="text-[12px] text-faint">{note}</span>}
    </span>
  );
}
