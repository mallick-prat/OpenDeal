"use client";

import { GranolaMark } from "@/components/GranolaMark";
import { NoteMatchBar, type MatchProposal } from "./NoteMatchBar";

import { useCallback, useEffect, useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Add, Checkmark, ChevronDown, Search, Subtract } from "@carbon/icons-react";
import {
  applyGranolaUpdatesAction,
  commitNoteReviewAction,
  createDeal,
  enrichNoteCompanyAction,
  enrichNotePersonAction,
  extractNoteReviewAction,
  ignoreGranolaNoteAction,
  noteReviewBootstrapAction,
  passNoteAction,
  searchPeopleAction,
  type CommitStep,
  type NoteReviewCommit,
} from "@/app/actions";
import { GranolaReviewCard } from "./GranolaReview";
import { CreateDealModal, type NewDealPayload } from "./CreateDealModal";
import { summaryLine, type NoteExtraction } from "@/lib/meetingReviewPure";
import type { NoteMatches, NoteEnrichment } from "@/lib/meetingReview";
import type { SectionInfo } from "@/lib/types";
import type { ProposedUpdate } from "@/lib/meetingNoteUpdates";
import { isTypingTarget, noteIgnoreKey } from "@/lib/noteTriageKeys";
import { etWeekdayDate } from "@/lib/etDates";
import { crm, isInternalEmail } from "@/config/crm.config";

/**
 * Granola triage as a review-and-save workspace: extracted facts become
 * reviewable cards (company & deal, people, meeting), any combination saves
 * in one action, and Enrich fills gaps without ever overwriting an edit.
 */

export interface NoteDetail {
  id: string;
  title: string | null;
  startsAt: string | null;
  participants: { name: string | null; email: string | null }[];
  dealGid: string | null;
  dealName: string | null;
  matchState: string;
  reviewState: string;
  confidence: number | null;
  evidence: { kind?: string; value?: string; via?: string } | null;
  updates: ProposedUpdate[];
  summary: string | null;
  notes: string | null;
  noteUrl: string | null;
}

interface PersonCard {
  key: string;
  enabled: boolean;
  dismissed: boolean;
  mode: "create" | "update" | "attach";
  personId: string | null;
  state: "existing" | "possible" | "new" | "insufficient";
  existingLabel: string | null;
  candidates: { id: string; name: string; school: string | null; reason: string }[];
  fields: {
    name: string; email: string; school: string; gradYear: string;
    linkedinUrl: string; city: string; title: string; org: string;
  };
  /** What the system prefilled — anything differing at save was user-typed. */
  prefill: {
    name: string; email: string; school: string; gradYear: string;
    linkedinUrl: string; city: string; title: string; org: string;
  };
  role: string;
  founderOnDeal: boolean;
  open: boolean;
  enrich: "idle" | "running" | "done" | "error";
  enrichNote: string;
  searching: string;
  hits: { id: string; name: string; line: string }[];
}

interface CompanyCard {
  enabled: boolean;
  dismissed: boolean;
  mode: "create" | "attach";
  dealGid: string;
  dealLabel: string;
  deals: { gid: string; name: string; stage: string }[];
  name: string;
  round: string;
  amount: string;
  applyFinancing: boolean;
  evidence: string | null;
  open: boolean;
  enrich: "idle" | "running" | "done" | "error";
  enrichNote: string;
  searching: string;
  hits: { gid: string; name: string; stage: string }[];
}

function fmtWhen(iso: string | null): string {
  return iso ? etWeekdayDate(iso) : "date unknown";
}

function Chip({ text }: { text: string }) {
  return (
    <span className="shrink-0 rounded border border-line bg-bg-soft px-1.5 py-0.5 text-[10.5px] font-semibold text-sub">
      {text}
    </span>
  );
}

const CHIP: Record<PersonCard["state"], string> = {
  existing: "In CRM",
  possible: "Duplicate?",
  new: "New",
  insufficient: "Needs info",
};

function buildCompanyCard(
  x: NoteExtraction,
  m: NoteMatches,
  enrichData: NoteEnrichment,
  matched: boolean
): CompanyCard {
  const dealHits = m.company.deals.map((d) => ({ gid: d.gid, name: d.name, stage: d.stage }));
  const hasExisting = m.company.state === "existing" && dealHits.length > 0;
  return {
    enabled: !matched && (hasExisting || !!x.company),
    dismissed: false,
    mode: hasExisting ? "attach" : "create",
    dealGid: hasExisting ? dealHits[0].gid : "",
    dealLabel: hasExisting ? dealHits[0].name : "",
    deals: dealHits,
    name: x.company?.name ?? m.company.companyName ?? "",
    round: x.financing?.round ?? x.financing?.security ?? "",
    amount: x.financing?.amount ?? "",
    applyFinancing: !!x.financing && x.financing.status !== "historical",
    evidence: x.financing?.evidence ?? x.company?.evidence ?? null,
    open: false,
    enrich: enrichData?.company?.status === "done" ? "done" : "idle",
    enrichNote: "",
    searching: "",
    hits: [],
  };
}

function buildPersonCards(
  x: NoteExtraction,
  m: NoteMatches,
  enrichData: NoteEnrichment
): PersonCard[] {
  return x.people.map((p) => {
    const pm = m.people.find((v) => v.key === p.key);
    const state = pm?.state ?? "new";
    const en = enrichData?.people?.[p.key];
    const enF = en?.status === "done" ? en.fields ?? {} : {};
    const prefill = {
      name: p.name,
      email: p.email ?? enF.email ?? "",
      school: p.school ?? enF.school ?? "",
      gradYear: p.gradYear ?? enF.grad_year ?? "",
      linkedinUrl: p.linkedin ?? enF.linkedin ?? "",
      city: p.city ?? enF.location ?? "",
      title: p.title ?? enF.title ?? "",
      org: p.company ?? x.company?.name ?? enF.company ?? "",
    };
    return {
      key: p.key,
      enabled: state === "existing" || (state === "new" && !!p.email),
      dismissed: false,
      mode: state === "existing" ? ("attach" as const) : ("create" as const),
      personId: pm?.personId ?? null,
      state,
      existingLabel: pm?.label ?? null,
      candidates: (pm?.candidates ?? []).map((c) => ({
        id: c.id, name: c.name, school: c.school, reason: c.reason,
      })),
      fields: { ...prefill },
      prefill,
      role: p.role,
      founderOnDeal: p.role === "founder",
      open: false,
      enrich: en?.status === "done" ? ("done" as const) : ("idle" as const),
      enrichNote: "",
      searching: "",
      hits: [],
    };
  });
}

/** Fold a fresh extraction into cards without losing a single user decision. */
function mergeCompany(old: CompanyCard | null, next: CompanyCard): CompanyCard {
  if (!old) return next;
  return {
    ...next,
    enabled: old.enabled || next.enabled,
    dismissed: old.dismissed,
    mode: old.dealGid ? old.mode : next.mode,
    dealGid: old.dealGid || next.dealGid,
    dealLabel: old.dealLabel || next.dealLabel,
    deals: next.deals.length >= old.deals.length ? next.deals : old.deals,
    name: old.name || next.name,
    round: old.round || next.round,
    amount: old.amount || next.amount,
    open: old.open,
    searching: old.searching,
    hits: old.hits,
  };
}

function mergePeople(old: PersonCard[], next: PersonCard[]): PersonCard[] {
  const merged = next.map((np) => {
    const prev = old.find((o) => o.key === np.key);
    if (!prev) return np;
    const fields = { ...np.fields };
    (Object.keys(fields) as (keyof PersonCard["fields"])[]).forEach((k) => {
      if (prev.fields[k]) fields[k] = prev.fields[k];
    });
    return {
      ...np,
      enabled: prev.enabled || np.enabled,
      dismissed: prev.dismissed,
      personId: prev.personId ?? np.personId,
      mode: prev.personId ? prev.mode : np.mode,
      state: prev.personId ? prev.state : np.state,
      existingLabel: prev.existingLabel ?? np.existingLabel,
      fields,
      prefill: np.prefill,
      founderOnDeal: prev.founderOnDeal || np.founderOnDeal,
      open: prev.open,
    };
  });
  const extraOld = old.filter((o) => !next.some((np) => np.key === o.key));
  return [...merged, ...extraOld];
}

/** + approves a suggestion into the save; − waves it away entirely. */
function ApproveIgnore({ on, approve, ignore }: { on: boolean; approve: () => void; ignore: () => void }) {
  return (
    <span className="flex shrink-0 items-center gap-1">
      <button
        type="button"
        aria-label="Approve this suggestion"
        title="Approve"
        aria-pressed={on}
        className={`flex h-6 w-6 items-center justify-center border ${
          on
            ? "border-primary bg-red-50 text-primary"
            : "border-line text-sub hover:border-primary hover:text-primary"
        }`}
        onClick={approve}
      >
        <Add size={14} aria-hidden />
      </button>
      <button
        type="button"
        aria-label="Ignore this suggestion"
        title="Ignore"
        className="flex h-6 w-6 items-center justify-center border border-line text-sub hover:border-primary hover:text-primary"
        onClick={ignore}
      >
        <Subtract size={14} aria-hidden />
      </button>
    </span>
  );
}

/** What the triage session gives a card: neighbours, place, and a way out. */
export interface NoteSessionApi {
  prevId: string | null;
  nextId: string | null;
  position: string | null;
  turn: (dir: "next" | "prev") => void;
  /** A verdict landed: drop this note and show the next, no navigation. */
  done: (kind: "ignore" | "pass" | "add") => void;
}

export function NoteTriage({
  note,
  sections,
  schoolNames,
  prevHref,
  nextHref,
  position: positionProp,
  session,
}: {
  note: NoteDetail;
  sections: SectionInfo[];
  schoolNames: string[];
  prevHref?: string | null;
  nextHref?: string | null;
  position?: string | null;
  session?: NoteSessionApi;
}) {
  const position = session?.position ?? positionProp ?? null;
  const [passing, setPassing] = useState(false);
  const [passReason, setPassReason] = useState("");
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState("");
  const [done, setDone] = useState("");
  const [extraction, setExtraction] = useState<NoteExtraction | null>(null);
  const [company, setCompany] = useState<CompanyCard | null>(null);
  const [people, setPeople] = useState<PersonCard[]>([]);
  const [results, setResults] = useState<CommitStep[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [enriching, setEnriching] = useState(false);
  const [enrichLine, setEnrichLine] = useState("");
  const [confirmIgnore, setConfirmIgnore] = useState(false);

  const matched = note.matchState === "confirmed" || note.matchState === "attached";
  const companyFromDeal = note.dealName
    ? (note.dealName.split("//").pop()?.trim() ?? note.dealName)
    : null;

  /* ── Bootstrap: free — seeds or the cached extraction, never the model ──── */
  const [extracted, setExtracted] = useState(false);
  useEffect(() => {
    let alive = true;
    void noteReviewBootstrapAction(note.id).then((r) => {
      if (!alive || !r.ok || !r.extraction || !r.matches) {
        if (alive && !r.ok) setError(r.error ?? "Couldn't read the note.");
        return;
      }
      setExtraction(r.extraction);
      setExtracted(r.extracted === true);
      setCompany(buildCompanyCard(r.extraction, r.matches, r.enrich ?? {}, matched));
      setPeople(buildPersonCards(r.extraction, r.matches, r.enrich ?? {}));
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [note.id]);

  /* ── Enrich: company + every person, in parallel, fill-empty-only ───────── */
  const fillEmpty = useCallback((cur: PersonCard["fields"], f: Record<string, string | null>) => {
    return {
      ...cur,
      email: cur.email || f.email || "",
      school: cur.school || f.school || "",
      gradYear: cur.gradYear || f.grad_year || "",
      linkedinUrl: cur.linkedinUrl || f.linkedin || "",
      city: cur.city || f.location || "",
      title: cur.title || f.title || "",
      org: cur.org || f.company || "",
    };
  }, []);

  const runEnrich = () => {
    if (enriching || !extraction) return;
    setEnriching(true);
    void (async () => {
      // Step 1, first click only: the single model pass over the note.
      let x = extraction;
      let currentCompany = company;
      let currentPeople = people;
      if (!extracted) {
        setEnrichLine("Reading the note…");
        const r = await extractNoteReviewAction(note.id);
        if (!r.ok || !r.extraction || !r.matches) {
          setEnrichLine(r.error ?? "Extraction failed.");
          setEnriching(false);
          return;
        }
        x = r.extraction;
        setExtraction(x);
        setExtracted(true);
        currentCompany = mergeCompany(company, buildCompanyCard(x, r.matches, {}, matched));
        currentPeople = mergePeople(people, buildPersonCards(x, r.matches, {}));
        setCompany(currentCompany);
        setPeople(currentPeople);
      }

      // Step 2: Sixtyfour per entity, dismissed cards spared.
      const jobs: Promise<void>[] = [];
      if (x.company?.name && currentCompany && !currentCompany.dismissed) {
        setCompany((c) => (c ? { ...c, enrich: "running" } : c));
        jobs.push(
          enrichNoteCompanyAction(note.id).then((r) => {
            setCompany((c) => {
              if (!c) return c;
              const f = r.slot?.fields ?? {};
              return {
                ...c,
                enrich: r.ok ? "done" : "error",
                enrichNote: r.ok
                  ? [f.description, f.location, f.last_round].filter(Boolean).join(" · ")
                  : (r.error ?? "failed"),
              };
            });
          })
        );
      }
      for (const p of currentPeople) {
        if (p.dismissed) continue;
        // Already complete — nothing to look up, nothing to spend.
        if (p.fields.linkedinUrl && p.fields.school && p.fields.city && p.fields.title) {
          setPeople((cur) => cur.map((q) => (q.key === p.key ? { ...q, enrich: "done" } : q)));
          continue;
        }
        setPeople((cur) => cur.map((q) => (q.key === p.key ? { ...q, enrich: "running" } : q)));
        jobs.push(
          enrichNotePersonAction(note.id, p.key).then((r) => {
            setPeople((cur) =>
              cur.map((q) =>
                q.key === p.key
                  ? {
                      ...q,
                      enrich: r.ok ? "done" : "error",
                      enrichNote: r.ok ? "" : (r.error ?? "failed"),
                      fields: r.ok && r.slot?.fields ? fillEmpty(q.fields, r.slot.fields) : q.fields,
                      prefill: r.ok && r.slot?.fields ? fillEmpty(q.prefill, r.slot.fields) : q.prefill,
                    }
                  : q
              )
            );
          })
        );
      }
      const n = jobs.length;
      setEnrichLine(n === 0 ? "" : `Enriching ${n} record${n === 1 ? "" : "s"}…`);
      await Promise.allSettled(jobs);
      setEnriching(false);
      setEnrichLine("Enrichment finished.");
      setTimeout(() => setEnrichLine(""), 4000);
    })();
  };

  /* ── Save ────────────────────────────────────────────────────────────────── */
  const updateCount =
    (company?.enabled && !company.dismissed ? 1 : 0) +
    people.filter((p) => p.enabled && !p.dismissed).length +
    1; // the meeting record itself

  /** The company card as the server wants it — shared by Add and Pass. */
  const companyPayload = (): NoteReviewCommit["company"] =>
    company?.enabled && !company.dismissed && !matched
      ? company.mode === "attach"
        ? {
            mode: "attach",
            dealGid: company.dealGid,
            round: company.round,
            financingAmount: company.amount,
            applyFinancingToExisting: company.applyFinancing,
          }
        : {
            mode: "create",
            name: company.name,
            round: company.round,
            financingAmount: company.amount,
            description: extraction?.company?.description ?? "",
          }
      : { mode: "none" };

  const peoplePayload = (): NoteReviewCommit["people"] =>
    people
      .filter((p) => p.enabled && !p.dismissed)
      .map((p) => ({
        key: p.key,
        mode: p.mode,
        personId: p.personId ?? undefined,
        edited: (Object.keys(p.fields) as (keyof typeof p.fields)[]).filter(
          (k) => p.fields[k].trim() !== p.prefill[k].trim()
        ),
        name: p.fields.name,
        email: p.fields.email,
        school: p.fields.school,
        gradYear: p.fields.gradYear,
        linkedinUrl: p.fields.linkedinUrl,
        city: p.fields.city,
        title: p.fields.title,
        org: p.fields.org,
        founderOnDeal: p.founderOnDeal,
      }));

  /** Mint the deal under this name, people riding along — one click. */
  const createNamed = (name: string) =>
    start(async () => {
      setError("");
      setResults(null);
      const payload: NoteReviewCommit = {
        company: {
          mode: "create",
          name: name.trim(),
          round: company?.round ?? "",
          financingAmount: company?.amount ?? "",
          description: extraction?.company?.description ?? "",
        },
        people: peoplePayload(),
      };
      const res = await commitNoteReviewAction(note.id, payload);
      setResults(res.results);
      if (res.ok) {
        if (session) {
          session.done("add");
          return;
        }
        setDone("Saved.");
        router.refresh();
      } else {
        setError(res.error ?? "Some steps need attention.");
      }
    });

  // What the note itself proposes: join the deal it already names, or mint
  // one from the company and founders it found. Shown on the match bar.
  const proposal: MatchProposal | null =
    !matched && company && !company.dismissed
      ? company.mode === "attach" && company.dealGid
        ? { kind: "attach", dealGid: company.dealGid, label: company.dealLabel, detail: "same company" }
        : company.name.trim()
          ? {
              kind: "create",
              name: company.name.trim(),
              detail:
                [
                  people.filter((p) => p.founderOnDeal && p.fields.name.trim()).map((p) => p.fields.name.trim()).join(", "),
                  company.amount,
                  company.round,
                ]
                  .filter(Boolean)
                  .join(" · ") || null,
            }
          : null
      : null;

  const save = () =>
    start(async () => {
      setError("");
      setResults(null);
      const payload: NoteReviewCommit = {
        company: companyPayload(),
        people: people
          .filter((p) => p.enabled && !p.dismissed)
          .map((p) => ({
            key: p.key,
            mode: p.mode,
            personId: p.personId ?? undefined,
            edited: (Object.keys(p.fields) as (keyof typeof p.fields)[]).filter(
              (k) => p.fields[k].trim() !== p.prefill[k].trim()
            ),
            name: p.fields.name,
            email: p.fields.email,
            school: p.fields.school,
            gradYear: p.fields.gradYear,
            linkedinUrl: p.fields.linkedinUrl,
            city: p.fields.city,
            title: p.fields.title,
            org: p.fields.org,
            founderOnDeal: p.founderOnDeal,
          })),
      };
      const res = await commitNoteReviewAction(note.id, payload);
      setResults(res.results);
      if (res.ok) {
        if (session) {
          session.done("add");
          return;
        }
        setDone("Saved.");
        router.refresh();
        if (nextHref) setTimeout(() => router.push(nextHref), 1200);
      } else {
        setError(res.error ?? "Some steps need attention.");
      }
    });

  // Ignore and Pass are optimistic inside the session: the next note shows
  // now, the verdict lands behind it (same contract as the email inbox).
  const ignore = () => {
    setConfirmIgnore(false);
    setError("");
    if (session) {
      session.done("ignore");
      void ignoreGranolaNoteAction(note.id);
      return;
    }
    start(async () => {
      const res = await ignoreGranolaNoteAction(note.id);
      if (!res.ok) setError(res.error ?? "That didn't go through.");
      else {
        setDone("Ignored.");
        router.refresh();
        if (nextHref) setTimeout(() => router.push(nextHref), 800);
      }
    });
  };

  const pass = () => {
    setError("");
    const c = companyPayload();
    const payload = {
      reason: passReason,
      company:
        c.mode === "attach" && c.dealGid
          ? { mode: "attach" as const, dealGid: c.dealGid }
          : c.mode === "create" && (c.name ?? "").trim()
            ? {
                mode: "create" as const,
                name: (c.name ?? "").trim(),
                round: c.round ?? undefined,
                financingAmount: c.financingAmount ?? undefined,
                description: c.description ?? undefined,
              }
            : { mode: "none" as const },
    };
    setPassing(false);
    if (session) {
      session.done("pass");
      void passNoteAction(note.id, payload);
      return;
    }
    start(async () => {
      const res = await passNoteAction(note.id, payload);
      if (!res.ok) setError(res.error ?? "That didn't go through.");
      else {
        setDone("Passed.");
        router.refresh();
        if (nextHref) setTimeout(() => router.push(nextHref), 800);
      }
    });
  };

  /* ── Keys: e enrich · s save · i ignore · del ignore · ←/→ move ─────────── */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      const step = noteIgnoreKey(confirmIgnore ? "armed" : "idle", e.key);
      if (step.action !== "none") {
        e.preventDefault();
        if (step.action === "cancel") setConfirmIgnore(false);
        else if (!pending && !done) {
          if (step.action === "arm") setConfirmIgnore(true);
          else if (step.action === "confirm") {
            setConfirmIgnore(false);
            document.getElementById("note-ignore")?.click();
          }
        }
        return;
      }
      if (pending || done) return;
      if (e.key === "ArrowRight") {
        if (session) session.turn("next");
        else if (nextHref) router.push(nextHref);
      } else if (e.key === "ArrowLeft") {
        if (session) session.turn("prev");
        else if (prevHref) router.push(prevHref);
      } else if (e.key === "s" || e.key === "a") document.getElementById("note-save")?.click();
      else if (e.key === "e") document.getElementById("note-enrich")?.click();
      else if (e.key === "i") document.getElementById("note-ignore")?.click();
      else if (e.key === "p") setPassing(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [confirmIgnore, done, pending, prevHref, nextHref, router, session]);

  /* ── Deal search inside the company card ────────────────────────────────── */
  useEffect(() => {
    const q = company?.searching.trim() ?? "";
    if (q.length < 3 || !company) return;
    const ctrl = new AbortController();
    const timer = setTimeout(() => {
      void fetch(`/api/deals/search?q=${encodeURIComponent(q)}`, { signal: ctrl.signal })
        .then((r) => (r.ok ? r.json() : null))
        .then((j: { results?: { gid: string; name: string; stage: string }[] } | null) => {
          if (!j?.results) return;
          // Only the response for what's in the box right now may render —
          // a slow answer for an earlier prefix must never clobber it.
          setCompany((c) =>
            c && c.searching.trim() === q ? { ...c, hits: j.results!.slice(0, 6) } : c
          );
        })
        .catch(() => {});
    }, 300);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [company?.searching]);

  const externals = note.participants.filter(
    (p) => p.email && !isInternalEmail(p.email)
  );
  const internals = note.participants.filter((p) => !p.email || isInternalEmail(p.email));
  const statusLine = useMemo(() => (extraction ? summaryLine(extraction) : null), [extraction]);

  const createFromModal = async (payload: NewDealPayload) => {
    const res = await createDeal({
      name: payload.name,
      notes: payload.notes,
      sectionGid: payload.sectionGid,
      schools: payload.schools,
      financingAmount: payload.financingAmount || undefined,
      round: payload.round || undefined,
      company: payload.company || undefined,
      founders: payload.founders.map((f) => ({ name: f.name, school: f.school, linkedin: f.linkedin })),
    });
    if (!res.ok || !res.gid) {
      setError(res.error ?? "Couldn't create the deal.");
      return;
    }
    setCreating(false);
    setCompany((c) =>
      c ? { ...c, enabled: true, mode: "attach", dealGid: res.gid!, dealLabel: payload.name, open: false } : c
    );
  };

  const searchPeople = (key: string, q: string) => {
    setPeople((cur) => cur.map((p) => (p.key === key ? { ...p, searching: q } : p)));
    if (q.trim().length < 2) return;
    setTimeout(() => {
      void searchPeopleAction(q).then((r) => {
        if (r.ok && r.people) {
          // Stale guard: apply only if the box still says what we searched.
          setPeople((cur) =>
            cur.map((p) =>
              p.key === key && p.searching === q ? { ...p, hits: r.people!.slice(0, 5) } : p
            )
          );
        }
      });
    }, 300);
  };

  return (
    <div className="mt-3 pb-20">
      {/* ── Header ───────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-2">
        <GranolaMark size={18} className="" />
        <h1 className="min-w-0 flex-1 truncate text-[22px] font-light text-ink">
          {note.title ?? "Untitled meeting"}
        </h1>
        {note.noteUrl && (
          <a
            href={note.noteUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="shrink-0 text-[12.5px] font-medium text-primary hover:underline"
          >
            Open in Granola →
          </a>
        )}
      </div>
      <p className="mt-1 text-[13px] text-sub">
        {fmtWhen(note.startsAt)}
        {externals.length > 0 && (
          <>
            {" · with "}
            <span className="font-medium text-body">
              {externals.map((p) => p.name || p.email).join(", ")}
            </span>
          </>
        )}
        {internals.length > 0 && (
          <span className="text-faint">
            {" · "}
            {internals.map((p) => (p.name || p.email || "").split(" ")[0]).filter(Boolean).join(", ")} inside
          </span>
        )}
      </p>

      {done && (
        <div className="callout mt-4 flex items-center gap-2 p-3 text-[13.5px]">
          <Checkmark size={16} className="text-primary" /> {done}{" "}
          <Link href="/inbox?source=granola&handled=1" className="font-medium text-primary hover:underline">
            Back to Inbox
          </Link>
        </div>
      )}
      {error && <div className="callout mt-4 p-3 text-[13.5px]">{error}</div>}
      {results && (
        <ul className="card mt-4 flex flex-col gap-1 p-3">
          {results.map((r, i) => (
            <li key={i} className="flex items-center gap-2 text-[13px]">
              <span className={r.ok ? "text-primary" : "text-sub"} aria-hidden>
                {r.ok ? "✓" : "✗"}
              </span>
              <span className={r.ok ? "text-body" : "font-medium text-ink"}>
                {r.href ? (
                  <Link href={r.href} className="hover:text-primary hover:underline">
                    {r.label}
                  </Link>
                ) : (
                  r.label
                )}
                {r.error && <span className="text-sub"> — {r.error}</span>}
              </span>
            </li>
          ))}
        </ul>
      )}

      {/* ── Status + Enrich ──────────────────────────────────────────────── */}
      <div className="mt-5 flex flex-wrap items-center gap-3">
        <p className="min-w-0 flex-1 text-[13.5px] font-medium text-ink">
          {statusLine ?? "Loading…"}
        </p>
        <button
          id="note-enrich"
          disabled={enriching || !extraction}
          className="border border-primary px-3 py-1.5 text-[12.5px] font-medium text-primary hover:bg-red-50 disabled:opacity-40"
          onClick={runEnrich}
        >
          {enriching ? "Enriching…" : "Enrich"}
        </button>
      </div>
      <p role="status" aria-live="polite" className="min-h-[18px] text-[12px] text-faint">
        {enrichLine}
      </p>

      <NoteMatchBar
        noteId={note.id}
        matchState={note.matchState}
        dealGid={note.dealGid}
        dealName={note.dealName}
        evidence={note.evidence}
        confidence={note.confidence}
        proposal={proposal}
        onCreate={createNamed}
        creating={pending}
      />

      {/* ── Company & deal ───────────────────────────────────────────────── */}
      {matched && note.dealGid ? (
        <section className="card mt-2 p-4">
          <p className="text-[13px] text-body">
            <Link href={`/deals/${note.dealGid}`} className="font-semibold text-primary hover:underline">
              {companyFromDeal}
            </Link>
            {note.confidence !== null && (
              <span className="text-faint"> · confidence {Math.round(note.confidence * 100)}%</span>
            )}
          </p>
          <div className="mt-3">
            {note.updates.length > 0 || note.reviewState === "applied" ? (
              <GranolaReviewCard
                noteId={note.id}
                title={note.title}
                dealGid={note.dealGid}
                dealName={note.dealName}
                updates={note.updates}
                state={note.reviewState === "applied" ? "applied" : "ready"}
              />
            ) : (
              <p className="text-[13px] text-sub">Attached — nothing new to apply.</p>
            )}
          </div>
        </section>
      ) : (
        company &&
        !company.dismissed && (
          <section className="card mt-2 p-4">
            <div className="flex flex-wrap items-center gap-2.5">
              <input
                id="company-enabled"
                type="checkbox"
                className="h-4 w-4 accent-[var(--brand-red-500)]"
                checked={company.enabled}
                onChange={(e) => setCompany({ ...company, enabled: e.target.checked })}
              />
              <label htmlFor="company-enabled" className="text-[13.5px] font-semibold text-ink">
                {company.mode === "attach" && company.dealLabel
                  ? `Attach to ${company.dealLabel.split("//").pop()?.trim() ?? company.dealLabel}`
                  : `Create deal${company.name ? `: ${company.name}` : ""}`}
              </label>
              {company.mode === "attach" ? <Chip text="In CRM" /> : <Chip text="New" />}
              {company.enrich === "running" && <Chip text="Enriching…" />}
              <span className="ml-auto flex items-center gap-2">
                <ApproveIgnore
                  on={company.enabled}
                  approve={() => setCompany({ ...company, enabled: true })}
                  ignore={() => setCompany({ ...company, dismissed: true, enabled: false })}
                />
                <button
                  className="flex items-center gap-1 text-[12px] font-medium text-sub hover:text-primary"
                  aria-expanded={company.open}
                  onClick={() => setCompany({ ...company, open: !company.open })}
                >
                  Details
                  <ChevronDown size={13} className={company.open ? "rotate-180" : ""} aria-hidden />
                </button>
              </span>
            </div>
            {(company.amount || company.round) && (
              <p className="mt-1.5 text-[12.5px] text-body">
                {[company.amount, company.round].filter(Boolean).join(" · ")}
                {extraction?.financing?.targetClose && ` · closes ${extraction.financing.targetClose}`}
                {extraction?.financing?.status && (
                  <span className="text-faint"> · {extraction.financing.status}</span>
                )}
              </p>
            )}
            {company.evidence && (
              <p className="mt-1 border-l-2 border-line pl-2 text-[12px] italic text-faint">
                “{company.evidence}”
              </p>
            )}
            {company.enrichNote && (
              <p className="mt-1.5 text-[12.5px] text-sub">{company.enrichNote}</p>
            )}

            {company.open && (
              <div className="mt-3 border-t border-line pt-3">
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    className={`border px-2.5 py-1 text-[12.5px] font-medium ${company.mode === "attach" ? "border-primary text-primary" : "border-line text-sub"}`}
                    onClick={() => setCompany({ ...company, mode: "attach" })}
                  >
                    Existing deal
                  </button>
                  <button
                    className={`border px-2.5 py-1 text-[12.5px] font-medium ${company.mode === "create" ? "border-primary text-primary" : "border-line text-sub"}`}
                    onClick={() => setCompany({ ...company, mode: "create" })}
                  >
                    New deal
                  </button>
                  {company.mode === "create" && (
                    <button
                      className="text-[12px] font-medium text-sub underline hover:text-primary"
                      onClick={() => setCreating(true)}
                    >
                      Full form
                    </button>
                  )}
                </div>
                {company.mode === "attach" ? (
                  <div className="mt-2.5">
                    {company.deals.map((d) => (
                      <label key={d.gid} className="flex items-center gap-2 py-1 text-[13px] text-body">
                        <input
                          type="radio"
                          name="company-deal"
                          className="accent-[var(--brand-red-500)]"
                          checked={company.dealGid === d.gid}
                          onChange={() =>
                            setCompany({ ...company, dealGid: d.gid, dealLabel: d.name, enabled: true })
                          }
                        />
                        <span className="min-w-0 flex-1 truncate">{d.name}</span>
                        <span className="text-[11.5px] text-faint">{d.stage}</span>
                      </label>
                    ))}
                    <div className="relative mt-1.5 max-w-[320px]">
                      <Search size={13} className="absolute left-2 top-1/2 -translate-y-1/2 text-faint" aria-hidden />
                      <input
                        className="field !h-8 w-full !pl-7 !text-[12.5px]"
                        placeholder="Search deals"
                        aria-label="Search deals"
                        value={company.searching}
                        onChange={(e) => setCompany({ ...company, searching: e.target.value })}
                      />
                    </div>
                    {company.searching.trim().length > 1 && company.hits.length > 0 && (
                      <div className="mt-1 flex max-w-[420px] flex-col divide-y divide-line border border-line">
                        {company.hits.map((d) => (
                          <button
                            key={d.gid}
                            className="flex items-center gap-2 px-2.5 py-1.5 text-left text-[12.5px] text-body hover:bg-bg-soft"
                            onClick={() =>
                              setCompany({
                                ...company,
                                dealGid: d.gid,
                                dealLabel: d.name,
                                deals: company.deals.some((x) => x.gid === d.gid)
                                  ? company.deals
                                  : [...company.deals, d],
                                enabled: true,
                                searching: "",
                                hits: [],
                              })
                            }
                          >
                            <span className="min-w-0 flex-1 truncate">{d.name}</span>
                            <span className="text-[11px] text-faint">{d.stage}</span>
                          </button>
                        ))}
                      </div>
                    )}
                    <label className="mt-2 flex items-center gap-2 text-[12.5px] text-body">
                      <input
                        type="checkbox"
                        className="accent-[var(--brand-red-500)]"
                        checked={company.applyFinancing}
                        onChange={(e) => setCompany({ ...company, applyFinancing: e.target.checked })}
                      />
                      Update the deal&apos;s financing to {company.amount || "—"}
                      {company.round ? ` (${company.round})` : ""}
                    </label>
                  </div>
                ) : (
                  <div className="mt-2.5 grid max-w-[520px] grid-cols-1 gap-1.5 sm:grid-cols-3">
                    <input
                      className="field !h-9 !text-[13px] sm:col-span-3"
                      placeholder="Deal name"
                      aria-label="Deal name"
                      value={company.name}
                      onChange={(e) => setCompany({ ...company, name: e.target.value })}
                    />
                    <input
                      className="field !h-9 !text-[13px]"
                      placeholder="Amount (e.g. $3M–$5M)"
                      aria-label="Financing amount"
                      value={company.amount}
                      onChange={(e) => setCompany({ ...company, amount: e.target.value })}
                    />
                    <input
                      className="field !h-9 !text-[13px]"
                      placeholder="Round (e.g. SAFE)"
                      aria-label="Round"
                      value={company.round}
                      onChange={(e) => setCompany({ ...company, round: e.target.value })}
                    />
                  </div>
                )}
              </div>
            )}
          </section>
        )
      )}

      {/* ── People ───────────────────────────────────────────────────────── */}
      {people.some((p) => !p.dismissed) && (
        <section className="mt-3 flex flex-col gap-2">
          {people.filter((p) => !p.dismissed).map((p) => (
            <div key={p.key} className="card p-4">
              <div className="flex flex-wrap items-center gap-2.5">
                <input
                  id={`person-${p.key}`}
                  type="checkbox"
                  className="h-4 w-4 accent-[var(--brand-red-500)]"
                  checked={p.enabled}
                  disabled={p.state === "possible" && !p.personId && p.mode !== "create"}
                  onChange={(e) =>
                    setPeople((cur) =>
                      cur.map((q) => (q.key === p.key ? { ...q, enabled: e.target.checked } : q))
                    )
                  }
                />
                <label htmlFor={`person-${p.key}`} className="text-[13.5px] font-semibold text-ink">
                  {p.state === "existing"
                    ? `Link ${p.fields.name} to this meeting`
                    : p.mode === "update"
                      ? `Update ${p.fields.name}`
                      : `Add ${p.fields.name || "person"}`}
                </label>
                <Chip text={CHIP[p.state]} />
                {p.role !== "unknown" && <Chip text={p.role} />}
                {p.enrich === "running" && <Chip text="Enriching…" />}
                <span className="ml-auto flex items-center gap-2">
                  <ApproveIgnore
                    on={p.enabled}
                    approve={() =>
                      setPeople((cur) =>
                        cur.map((q) => (q.key === p.key ? { ...q, enabled: true } : q))
                      )
                    }
                    ignore={() =>
                      setPeople((cur) =>
                        cur.map((q) =>
                          q.key === p.key ? { ...q, dismissed: true, enabled: false } : q
                        )
                      )
                    }
                  />
                  <button
                    className="flex items-center gap-1 text-[12px] font-medium text-sub hover:text-primary"
                    aria-expanded={p.open}
                    onClick={() =>
                      setPeople((cur) => cur.map((q) => (q.key === p.key ? { ...q, open: !q.open } : q)))
                    }
                  >
                    Details
                    <ChevronDown size={13} className={p.open ? "rotate-180" : ""} aria-hidden />
                  </button>
                </span>
              </div>
              <p className="mt-1 text-[12.5px] text-sub">
                {[p.fields.email, p.fields.title, p.fields.org, p.existingLabel]
                  .filter(Boolean)
                  .join(" · ") || "no contact details yet"}
                {p.enrichNote && <span className="text-faint"> · {p.enrichNote}</span>}
              </p>

              {p.state === "possible" && !p.personId && (
                <div className="callout-parchment mt-2 flex flex-wrap items-center gap-2 p-2 text-[12.5px]">
                  {p.candidates.map((c) => (
                    <button
                      key={c.id}
                      className="border border-line bg-bg px-2 py-1 font-medium text-body hover:border-primary hover:text-primary"
                      onClick={() =>
                        setPeople((cur) =>
                          cur.map((q) =>
                            q.key === p.key
                              ? { ...q, mode: "update", personId: c.id, enabled: true, state: "possible" }
                              : q
                          )
                        )
                      }
                    >
                      Update {c.name}
                      {c.school ? ` (${c.school})` : ""} — {c.reason}
                    </button>
                  ))}
                  <button
                    className="border border-line bg-bg px-2 py-1 font-medium text-body hover:border-primary hover:text-primary"
                    onClick={() =>
                      setPeople((cur) =>
                        cur.map((q) =>
                          q.key === p.key ? { ...q, mode: "create", personId: null, enabled: true } : q
                        )
                      )
                    }
                  >
                    Create new
                  </button>
                </div>
              )}

              {p.open && (
                <div className="mt-3 border-t border-line pt-3">
                  <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                    {(
                      [
                        ["name", "Name"],
                        ["email", "Email"],
                        ["school", crm.tags.singular],
                        ["gradYear", "Class year"],
                        ["linkedinUrl", "LinkedIn URL"],
                        ["city", "City"],
                        ["title", "Title"],
                        ["org", "Company"],
                      ] as const
                    ).map(([field, label]) => (
                      <input
                        key={field}
                        className="field !h-9 !text-[13px]"
                        placeholder={label}
                        aria-label={`${label} for ${p.fields.name || "person"}`}
                        value={p.fields[field]}
                        onChange={(e) =>
                          setPeople((cur) =>
                            cur.map((q) =>
                              q.key === p.key
                                ? { ...q, fields: { ...q.fields, [field]: e.target.value } }
                                : q
                            )
                          )
                        }
                      />
                    ))}
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-4">
                    {((company?.enabled && !company.dismissed) || (matched && !!note.dealGid)) && (
                      <label className="flex items-center gap-2 text-[12.5px] text-body">
                        <input
                          type="checkbox"
                          className="accent-[var(--brand-red-500)]"
                          checked={p.founderOnDeal}
                          onChange={(e) =>
                            setPeople((cur) =>
                              cur.map((q) =>
                                q.key === p.key ? { ...q, founderOnDeal: e.target.checked } : q
                              )
                            )
                          }
                        />
                        Founder on the deal
                      </label>
                    )}
                  </div>
                  <div className="relative mt-2 max-w-[300px]">
                    <Search size={13} className="absolute left-2 top-1/2 -translate-y-1/2 text-faint" aria-hidden />
                    <input
                      className="field !h-8 w-full !pl-7 !text-[12.5px]"
                      placeholder="Attach to a tracked person instead"
                      aria-label={`Search tracked people for ${p.fields.name || "person"}`}
                      value={p.searching}
                      onChange={(e) => searchPeople(p.key, e.target.value)}
                    />
                  </div>
                  {p.searching.trim().length > 1 && p.hits.length > 0 && (
                    <div className="mt-1 flex max-w-[420px] flex-col divide-y divide-line border border-line">
                      {p.hits.map((h) => (
                        <button
                          key={h.id}
                          className="px-2.5 py-1.5 text-left text-[12.5px] text-body hover:bg-bg-soft"
                          onClick={() =>
                            setPeople((cur) =>
                              cur.map((q) =>
                                q.key === p.key
                                  ? {
                                      ...q,
                                      mode: "attach",
                                      personId: h.id,
                                      state: "existing",
                                      existingLabel: h.line,
                                      enabled: true,
                                      searching: "",
                                      hits: [],
                                    }
                                  : q
                              )
                            )
                          }
                        >
                          {h.name}
                          {h.line && <span className="text-faint"> — {h.line}</span>}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </section>
      )}

      {/* ── The note itself ──────────────────────────────────────────────── */}
      {note.summary && (
        <section className="card mt-5 p-4">
          <h2 className="text-[13.5px] font-semibold text-ink">From the meeting</h2>
          <div className="mt-2 max-h-80 overflow-y-auto whitespace-pre-wrap text-[13.5px] leading-relaxed text-body">
            {note.summary}
          </div>
        </section>
      )}
      {note.notes && note.notes !== note.summary && (
        <section className="card mt-3 p-4">
          <h2 className="text-[13.5px] font-semibold text-ink">Original notes</h2>
          <div className="mt-2 max-h-[32rem] overflow-y-auto whitespace-pre-wrap text-[13px] leading-relaxed text-sub">
            {note.notes}
          </div>
        </section>
      )}

      {/* ── Verdicts, pinned: one click each, the next note follows at once ── */}
      <div className="sticky bottom-0 mt-6 flex flex-wrap items-center gap-2 border-t border-line bg-bg py-3">
        {matched && note.dealGid && note.updates.length > 0 && note.reviewState !== "applied" && (
          <button
            disabled={pending}
            className="btn-primary tap !text-[13.5px]"
            onClick={() =>
              start(async () => {
                const res = await applyGranolaUpdatesAction(note.id, "all");
                if (!res.ok) setError(res.error ?? "That didn't go through.");
                else if (session) session.done("add");
                else {
                  setDone("Updates applied.");
                  router.refresh();
                }
              })
            }
          >
            Apply all updates
          </button>
        )}
        <button
          id="note-save"
          disabled={pending || !extraction}
          className="btn-primary tap !text-[13.5px]"
          onClick={save}
        >
          {pending
            ? "Adding…"
            : company && company.enabled && !company.dismissed && !matched
              ? "Add to pipeline"
              : matched && !(note.updates.length > 0 && note.reviewState !== "applied")
                ? "Done"
                : `Save ${updateCount} update${updateCount === 1 ? "" : "s"}`}
        </button>
        {passing ? (
          <span className="flex flex-wrap items-center gap-2">
            <input
              className="field !h-9 w-64 !text-[13px]"
              autoFocus
              placeholder="Why? (optional)"
              aria-label="Pass reason"
              value={passReason}
              onChange={(e) => setPassReason(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") pass();
                if (e.key === "Escape") setPassing(false);
              }}
            />
            <button className="btn-secondary tap !text-[13.5px]" disabled={pending} onClick={pass}>
              Pass
            </button>
            <button className="tap-sm text-[13px] font-medium text-sub hover:text-primary" onClick={() => setPassing(false)}>
              Cancel
            </button>
          </span>
        ) : (
          <button
            id="note-pass"
            disabled={pending}
            className="btn-secondary tap !text-[13.5px]"
            title="Files the deal under To Pass with your reason"
            onClick={() => setPassing(true)}
          >
            Pass
          </button>
        )}
        <button
          id="note-ignore"
          disabled={pending}
          aria-keyshortcuts="Delete"
          aria-describedby="note-ignore-hint"
          className={
            confirmIgnore
              ? "tap-sm text-[13.5px] font-medium text-primary"
              : "tap-sm text-[13.5px] font-medium text-sub hover:text-primary"
          }
          onClick={ignore}
        >
          Ignore
        </button>
        <span id="note-ignore-hint" role="status" aria-live="polite" className="hidden text-[12px] text-faint sm:inline">
          {confirmIgnore ? (
            <>
              Press <b>Delete</b> again to ignore, <b>Esc</b> to cancel
            </>
          ) : (
            <>
              <b>a</b> add · <b>p</b> pass · <b>i</b> or <b>del</b> ignore · <b>e</b> enrich · ← →
            </>
          )}
        </span>
        <span className="ml-auto flex items-center gap-2">
          {position && <span className="text-[12px] tabular-nums text-faint">{position}</span>}
          <button
            className="tap flex h-9 w-9 items-center justify-center border border-line text-sub hover:border-primary hover:text-primary disabled:opacity-30"
            aria-label="Previous item (Left arrow)"
            disabled={session ? !session.prevId : !prevHref}
            onClick={() => (session ? session.turn("prev") : prevHref && router.push(prevHref))}
          >
            ‹
          </button>
          <button
            className="tap flex h-9 w-9 items-center justify-center border border-line text-sub hover:border-primary hover:text-primary disabled:opacity-30"
            aria-label="Next item (Right arrow)"
            disabled={session ? !session.nextId : !nextHref}
            onClick={() => (session ? session.turn("next") : nextHref && router.push(nextHref))}
          >
            ›
          </button>
        </span>
      </div>

      {creating && (
        <CreateDealModal
          sections={sections}
          schoolNames={schoolNames}
          initial={{
            company: company?.name ?? "",
            financing: company?.amount ?? "",
            round: company?.round ?? "",
            notes: [
              `Met ${fmtWhen(note.startsAt)} (Granola note).`,
              (note.summary ?? note.notes ?? "").replace(/\s+/g, " ").trim().slice(0, 800),
              note.noteUrl ?? "",
            ]
              .filter(Boolean)
              .join("\n\n"),
            founders: people
              .filter((p) => p.founderOnDeal && p.fields.name)
              .map((p) => ({
                name: p.fields.name,
                email: p.fields.email,
                school: p.fields.school,
                linkedin: p.fields.linkedinUrl,
              })),
          }}
          title="Create deal from this meeting"
          onClose={() => setCreating(false)}
          onCreate={createFromModal}
        />
      )}
    </div>
  );
}
