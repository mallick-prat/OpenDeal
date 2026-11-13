"use client";

import { crm } from "@/config/crm.config";
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { Deal, PipelineData, StageKey } from "@/lib/types";
import { COMMON_SCHOOLS, NO_SCHOOL, STAGES } from "@/lib/stages";
import {
  createDeal,
  deleteDeal,
  moveDealStage,
  bulkMoveDealsAction,
  bulkDeleteDealsAction,
} from "@/app/actions";
import { formatDateTime, schoolStats } from "@/lib/aggregate";
import { Sidebar, type SessionUser, type View } from "./Sidebar";
import dynamic from "next/dynamic";
import { dealsForSchool } from "@/lib/aggregate";
import { LiveDeals } from "./RecentDeals";
import { OwnerFilter } from "./OwnerFilter";
import { DeepSearch } from "./DeepSearch";
import { useCockpit, InboxPanel, CalendarPanel, GranolaPanel, ChangesPanel } from "./HomeCockpit";
import { DealTable } from "./DealTable";
import { KanbanBoard } from "./KanbanBoard";
import type { NewDealPayload } from "./CreateDealModal";

/*
 * The school-detail charts and the modals load on demand; everything else
 * stays in the entry chunk. Analytics is its own page (/analytics).
 */
const SchoolDetail = dynamic(() => import("./SchoolDetail").then((m) => m.SchoolDetail), { ssr: false });
const EditDealModal = dynamic(() => import("./EditDealModal").then((m) => m.EditDealModal), { ssr: false });
const CreateDealModal = dynamic(() => import("./CreateDealModal").then((m) => m.CreateDealModal), { ssr: false });

function SectionHead({
  title,
  sub,
  live,
}: {
  title: string;
  sub?: string;
  live?: boolean;
}) {
  return (
    <div className="mb-4">
      <h2 className="flex items-center gap-2.5 text-[22px] font-normal text-ink">
        {live && (
          <span className="relative flex h-2.5 w-2.5" aria-hidden>
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
            <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-emerald-500" />
          </span>
        )}
        {title}
      </h2>
      {sub && <p className="mt-1 text-[13px] text-sub">{sub}</p>}
    </div>
  );
}

const VIEW_PATH: Record<View, string> = {
  home: "/",
  analytics: "/analytics",
  deals: "/deals",
};

function pathToView(path: string): View {
  if (path.startsWith("/deals")) return "deals";
  return "home";
}

/** The gid in a /deals/<gid> deep-link path, or null for any other path. */
function dealGidFromPath(path: string): string | null {
  const m = path.match(/^\/deals\/([^/?#]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

export function Dashboard({
  data,
  initialView = "home",
  initialDealGid,
  user,
  role = "admin",
  members = [],
}: {
  data: PipelineData;
  initialView?: View;
  /** From the /deals/[gid] route: open this deal as an overlay on load. */
  initialDealGid?: string;
  user: SessionUser;
  role?: "super_admin" | "admin" | "user";
  members?: { email: string; name: string; image: string | null }[];
}) {
  const router = useRouter();
  const [view, setViewState] = useState<View>(initialView);
  // Home's inbox + calendar panels, fetched once when Home first shows.
  const cockpit = useCockpit(view === "home");

  // Refs the history listeners read so they don't capture stale state: the
  // current deal list (to resolve a /deals/<gid> path back to a deal) and
  // whether *we* pushed the open-deal entry (so closing can just go Back).
  const allDealsRef = useRef<Deal[]>([]);
  const pushedDealRef = useRef(false);

  // The deal shown in the overlay (null = closed). Declared up here so the
  // history listeners and open/close helpers below can all reach it. A
  // /deals/<gid> deep-link opens that deal straight away, from server data.
  const [editing, setEditing] = useState<Deal | null>(
    () => (initialDealGid ? data.deals.find((d) => d.gid === initialDealGid) ?? null : null)
  );

  // Open a deal as an overlay AND give it a URL (/deals/<gid>) so it's
  // shareable, bookmarkable, and reachable from a notification.
  const openDeal = (deal: Deal) => {
    setEditing(deal);
    if (typeof window === "undefined") return;
    const target = `/deals/${encodeURIComponent(deal.gid)}`;
    if (window.location.pathname !== target) {
      window.history.pushState(null, "", target);
      pushedDealRef.current = true;
    }
  };

  // Close the overlay. If we pushed the deal entry, go Back so the deal URL
  // leaves history cleanly (Back won't reopen it); otherwise (opened via a
  // fresh deep-link load) fall back to the plain Deals URL.
  const closeDeal = () => {
    if (typeof window !== "undefined" && pushedDealRef.current) {
      pushedDealRef.current = false;
      window.history.back(); // popstate clears `editing` and restores the tab
      return;
    }
    setEditing(null);
    if (typeof window !== "undefined" && dealGidFromPath(window.location.pathname)) {
      window.history.pushState(null, "", "/deals");
      setViewState("deals");
    }
  };

  // Switch tab and reflect it in the URL without a full navigation (keeps
  // filters, kanban placement, etc. intact). Back/forward stay in sync below.
  // Analytics is a real page now (server-side aggregation), so it navigates.
  const setView = (v: View) => {
    if (v === "analytics") {
      router.push("/analytics");
      return;
    }
    setViewState(v);
    if (typeof window !== "undefined" && window.location.pathname !== VIEW_PATH[v]) {
      window.history.pushState(null, "", VIEW_PATH[v]);
    }
  };

  // Back/forward: keep the tab AND the open deal in sync with the URL, so a
  // /deals/<gid> entry reopens that deal and leaving it closes the overlay.
  useEffect(() => {
    const onPop = () => {
      const path = window.location.pathname;
      setViewState(pathToView(path));
      const gid = dealGidFromPath(path);
      pushedDealRef.current = false;
      setEditing(gid ? allDealsRef.current.find((d) => d.gid === gid) ?? null : null);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const [school, setSchool] = useState<string | null>(null);
  const [stage, setStage] = useState<StageKey | null>(null);
  const [query, setQuery] = useState("");
  // Filtering 2k deals + re-rendering the board is deprioritized behind
  // keeping the search input responsive.
  const deferredQuery = useDeferredValue(query);

  // "/" anywhere jumps to THE deal search (names instantly, bodies and
  // meaning via the dropdown). Panel inputs elsewhere only filter their own
  // list and say so — one search, many filters.
  const searchInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const onSlash = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.tagName === "SELECT" ||
          t.isContentEditable)
      )
        return;
      e.preventDefault();
      setView("deals");
      requestAnimationFrame(() => searchInputRef.current?.focus());
    };
    window.addEventListener("keydown", onSlash);
    return () => window.removeEventListener("keydown", onSlash);
    // setView is stable in practice (state setter + history); re-binding per
    // render would double-fire on fast keypresses.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [dealView, setDealView] = useState<"table" | "board">("board");
  // Empty set = everyone; multi-select narrows to any of the picked owners.
  const [ownerSel, setOwnerSel] = useState<Set<string>>(new Set());
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  // When non-null the create modal is open; string preselects a stage's section.
  const [creating, setCreating] = useState<null | { sectionGid?: string }>(null);
  // Optimistic stage moves from board drag & drop, keyed by deal gid.
  const [stageOverrides, setStageOverrides] = useState<
    Record<string, StageKey>
  >({});
  const [movingGids, setMovingGids] = useState<Set<string>>(new Set());

  // Fresh server data supersedes local optimistic moves.
  const [seenFetchedAt, setSeenFetchedAt] = useState(data.fetchedAt);
  if (seenFetchedAt !== data.fetchedAt) {
    setSeenFetchedAt(data.fetchedAt);
    setStageOverrides({});
  }

  // Deals created locally, shown immediately while they save.
  // Once the server data contains the real task, the local copy is deduped out.
  const [localDeals, setLocalDeals] = useState<Deal[]>([]);
  // Optimistically-deleted deals, hidden while the delete lands.
  const [deletedGids, setDeletedGids] = useState<Set<string>>(new Set());

  // Once the server data includes an optimistic deal, drop our local copy —
  // keeping
  // stale local entries around would produce duplicates.
  const serverGidSet = useMemo(
    () => new Set(data.deals.map((d) => d.gid)),
    [data.deals]
  );
  const landed = localDeals.some((d) => serverGidSet.has(d.gid));
  if (landed) {
    setLocalDeals((l) => l.filter((d) => !serverGidSet.has(d.gid)));
  }

  const allDeals = useMemo(() => {
    const serverGids = new Set(data.deals.map((d) => d.gid));
    const extras = localDeals.filter((d) => !serverGids.has(d.gid));
    let base = extras.length > 0 ? [...extras, ...data.deals] : data.deals;
    if (deletedGids.size > 0)
      base = base.filter((d) => !deletedGids.has(d.gid));
    return Object.keys(stageOverrides).length === 0
      ? base
      : base.map((d) =>
          stageOverrides[d.gid] ? { ...d, stage: stageOverrides[d.gid] } : d
        );
  }, [data.deals, localDeals, deletedGids, stageOverrides]);

  // Let the history listeners see the latest deal list without re-subscribing.
  useEffect(() => {
    allDealsRef.current = allDeals;
  }, [allDeals]);

  // New cards ride at the top of their kanban column until the next sync.
  const pinnedGids = useMemo(
    () => localDeals.map((d) => d.gid),
    [localDeals]
  );

  /** Optimistic delete: hide now, remove in the background. */
  const handleDelete = (deal: Deal) => {
    closeDeal();
    setDeletedGids((s) => new Set(s).add(deal.gid));
    setLocalDeals((l) => l.filter((d) => d.gid !== deal.gid));
    void (async () => {
      const res = await deleteDeal(deal.gid);
      if (!res.ok) throw new Error(res.error ?? "unknown error");
      router.refresh();
    })().catch((err) => {
      // Roll the card back and say so plainly.
      setDeletedGids((s) => {
        const next = new Set(s);
        next.delete(deal.gid);
        return next;
      });
      setSavedFlash(
        `Couldn't delete “${deal.name}”: ${err instanceof Error ? err.message : String(err)}`
      );
      setTimeout(() => setSavedFlash(""), 10000);
    });
  };
  const [savedFlash, setSavedFlash] = useState("");
  const allStats = useMemo(() => schoolStats(allDeals), [allDeals]);

  const bySchool = useMemo(
    () => (school ? dealsForSchool(allDeals, school) : allDeals),
    [allDeals, school]
  );

  // A deal belongs to everyone on it: the owner string AND the
  // app's multi-owner chips. Alicia's nine chip-owned deals count as hers
  // even when the assignee field says someone else.
  const ownerNamesOf = (d: Deal): string[] => {
    const names = new Set<string>();
    if (d.owner) names.add(d.owner);
    for (const o of d.owners) if (o.name) names.add(o.name);
    return [...names];
  };
  const { owners, ownerCounts } = useMemo(() => {
    const counts = new Map<string, number>();
    for (const d of allDeals) {
      for (const n of ownerNamesOf(d)) counts.set(n, (counts.get(n) ?? 0) + 1);
    }
    const byDeals = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([name]) => name);
    // The whole roster belongs in the picker — contributors and new members who
    // don't own a deal yet list after the active owners, alphabetically.
    const known = new Set(byDeals);
    const rest = members
      .map((m) => m.name)
      .filter((n) => n && !known.has(n))
      .sort((a, b) => a.localeCompare(b));
    return { owners: [...byDeals, ...rest], ownerCounts: counts };
     
  }, [allDeals, members]);

  const inRange = (d: Deal) =>
    (!fromDate || d.created >= fromDate) && (!toDate || d.created <= toDate);

  const filtered = useMemo(() => {
    const q = deferredQuery.trim().toLowerCase();
    return bySchool.filter(
      (d) =>
        (!stage || d.stage === stage) &&
        (ownerSel.size === 0 || ownerNamesOf(d).some((n) => ownerSel.has(n))) &&
        inRange(d) &&
        (!q ||
          d.name.toLowerCase().includes(q) ||
          d.note.toLowerCase().includes(q) ||
          d.owner.toLowerCase().includes(q))
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bySchool, stage, ownerSel, deferredQuery, fromDate, toDate]);

  // The board's columns ARE the stages; the stage filter narrows to one column.
  const boardDeals = useMemo(() => {
    const q = deferredQuery.trim().toLowerCase();
    return bySchool.filter(
      (d) =>
        (ownerSel.size === 0 || ownerNamesOf(d).some((n) => ownerSel.has(n))) &&
        inRange(d) &&
        (!q ||
          d.name.toLowerCase().includes(q) ||
          d.note.toLowerCase().includes(q) ||
          d.owner.toLowerCase().includes(q))
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bySchool, ownerSel, deferredQuery, fromDate, toDate]);

  /** Local-first create: show the deal now, save in the background. */
  const handleCreate = (payload: NewDealPayload) => {
    const tmpGid = `tmp${Date.now()}`;
    const today = new Date().toISOString().slice(0, 10);
    const note = payload.notes.replace(/\s+/g, " ").trim();
    const localDeal: Deal = {
      gid: tmpGid,
      name: payload.name,
      note: note.length > 180 ? `${note.slice(0, 177)}…` : note,
      stage: payload.stage,
      schools: payload.schools,
      owner: user.name,
      created: today,
      modified: today,
      url: "",
      financing: payload.financingAmount || null,
      round: payload.round || null,
      attachmentCount: payload.files.length,
      offered: false,
      createdBy: user.email || null,
      owners: [{ email: user.email, name: user.name, image: user.image }],
      visibility: "team",
    };
    setLocalDeals((l) => [localDeal, ...l]);
    setMovingGids((m) => new Set(m).add(tmpGid));
    setCreating(null);

    void (async () => {
      const res = await createDeal({
        name: payload.name,
        notes: payload.notes,
        sectionGid: payload.sectionGid,
        schools: payload.schools,
        financingAmount: payload.financingAmount,
        round: payload.round,
        company: payload.company,
        founders: payload.founders,
      });
      setMovingGids((m) => {
        const next = new Set(m);
        next.delete(tmpGid);
        return next;
      });
      if (!res.ok || !res.gid) {
        // Roll back the local copy and say so plainly.
        setLocalDeals((l) => l.filter((d) => d.gid !== tmpGid));
        setSavedFlash(
          `Couldn't save “${payload.name}”: ${res.error ?? "unknown error"}`
        );
        setTimeout(() => setSavedFlash(""), 8000);
        return;
      }
      const realGid = res.gid;
      setLocalDeals((l) =>
        l.map((d) => (d.gid === tmpGid ? { ...d, gid: realGid } : d))
      );
      if (payload.files.length > 0) {
        const fd = new FormData();
        fd.append("taskGid", realGid);
        for (const f of payload.files) fd.append("files", f, f.name);
        const up = await fetch("/api/attachments", { method: "POST", body: fd })
          .then((r) => r.json())
          .catch(() => ({ ok: false }));
        if (!up.ok) {
          setSavedFlash(
            `“${payload.name}” is saved, but its attachments didn't upload — add them from the deal card.`
          );
          setTimeout(() => setSavedFlash(""), 8000);
        }
      }
      router.refresh();
    })();
  };

  const handleMove = async (gid: string, stageKey: StageKey) => {
    const deal = allDeals.find((d) => d.gid === gid);
    const section = data.sections.find((s) => s.stage === stageKey);
    if (!deal || !section || deal.stage === stageKey) return;
    setStageOverrides((o) => ({ ...o, [gid]: stageKey }));
    setMovingGids((m) => new Set(m).add(gid));
    const res = await moveDealStage(gid, section.gid);
    setMovingGids((m) => {
      const next = new Set(m);
      next.delete(gid);
      return next;
    });
    if (res.ok) {
      // No banner on success — the card lands in its new column silently.
      router.refresh();
    } else {
      setStageOverrides((o) => {
        const next = { ...o };
        delete next[gid];
        return next;
      });
      setSavedFlash(`Couldn't move “${deal.name}”: ${res.error}`);
      setTimeout(() => setSavedFlash(""), 6000);
    }
  };

  // Bulk actions from the Kanban multi-select. Optimistic for the WHOLE
  // selection at once (instant feedback), but a SINGLE batched server call —
  // one transaction — so a big selection can't exhaust
  // the DB pool the way N separate calls would.
  const handleBulkMove = async (gids: string[], stageKey: StageKey) => {
    const section = data.sections.find((s) => s.stage === stageKey);
    if (!section) return;
    const targets = gids.filter((g) => {
      const d = allDeals.find((x) => x.gid === g);
      return d && d.stage !== stageKey;
    });
    if (targets.length === 0) return;
    setStageOverrides((o) => {
      const n = { ...o };
      for (const g of targets) n[g] = stageKey;
      return n;
    });
    setMovingGids((m) => {
      const n = new Set(m);
      for (const g of targets) n.add(g);
      return n;
    });
    const res = await bulkMoveDealsAction(targets, section.gid);
    setMovingGids((m) => {
      const n = new Set(m);
      for (const g of targets) n.delete(g);
      return n;
    });
    if (res.ok) {
      router.refresh();
    } else {
      setStageOverrides((o) => {
        const n = { ...o };
        for (const g of targets) delete n[g];
        return n;
      });
      setSavedFlash(`Couldn't move the deals: ${res.error}`);
      setTimeout(() => setSavedFlash(""), 6000);
    }
  };

  const handleBulkDelete = async (gids: string[]) => {
    const known = new Set(allDeals.map((d) => d.gid));
    const targets = gids.filter((g) => known.has(g));
    if (targets.length === 0) return;
    const set = new Set(targets);
    setDeletedGids((s) => {
      const n = new Set(s);
      for (const g of targets) n.add(g);
      return n;
    });
    setLocalDeals((l) => l.filter((d) => !set.has(d.gid)));
    const res = await bulkDeleteDealsAction(targets);
    if (res.ok) {
      router.refresh();
    } else {
      setDeletedGids((s) => {
        const n = new Set(s);
        for (const g of targets) n.delete(g);
        return n;
      });
      setSavedFlash(`Couldn't delete the deals: ${res.error}`);
      setTimeout(() => setSavedFlash(""), 8000);
    }
  };


  // Quick-filter dropdown: the pinned common schools, plus whatever else is selected.
  const dropdownSchools = useMemo(() => {
    const known = new Set(allStats.map((s) => s.school));
    const list = COMMON_SCHOOLS.filter((s) => known.has(s));
    if (school && !list.includes(school)) list.push(school);
    return list;
  }, [allStats, school]);

  // Every school (by volume) for the Deals filter row, mirroring All owners.
  const allSchoolNames = useMemo(
    () => allStats.map((s) => s.school),
    [allStats]
  );

  // Top 10 schools by volume — the checkbox set in the create/edit forms.
  const topSchools = useMemo(
    () =>
      allStats
        .filter((s) => s.school !== NO_SCHOOL)
        .slice(0, 10)
        .map((s) => s.school),
    [allStats]
  );

  const onSaved = () => {
    closeDeal();
    setSavedFlash("Saved. Refreshing the dashboard…");
    router.refresh();
    setTimeout(() => setSavedFlash(""), 6000);
  };

  const schoolDropdown = (
    <label className="flex items-center gap-2">
      <span className="whitespace-nowrap text-[13px] font-medium text-sub">
        {crm.tags.singular}
      </span>
      <select
        className="field min-w-44"
        value={school ?? ""}
        onChange={(e) => setSchool(e.target.value || null)}
      >
        <option value="">All {crm.tags.plural.toLowerCase()}</option>
        {dropdownSchools.map((s) => (
          <option key={s} value={s}>
            {s}
          </option>
        ))}
      </select>
    </label>
  );

  /** Jump from a home-page row into the CRM board, focused on its column. */
  const openInCrm = (deal: Deal) => {
    setStage(deal.stage);
    setDealView("board");
    setView("deals");
  };

  const heroTitle =
    view === "home"
      ? school
        ? `${school} deals`
        : "Dashboard"
      : crm.pipelineName;

  return (
    <div className="flex min-h-[100dvh] flex-col bg-bg md:flex-row">
      <Sidebar
        view={view}
        onView={setView}
        onNewDeal={() => {
          setView("deals");
          setCreating({});
        }}
        onOpenDeal={(gid) => {
          const deal = allDeals.find((d) => d.gid === gid);
          if (deal) openDeal(deal);
        }}
        user={user}

        showInbox={role !== "user"}
      />

      <div className="min-w-0 flex-1">
        <main className="mx-auto w-full max-w-[1500px] px-4 pb-[calc(5rem+env(safe-area-inset-bottom))] sm:px-8 md:pb-24">
          {/* Hero */}
          <section className="mt-8 flex flex-wrap items-end justify-between gap-4">
            <div>
              <p className="eyebrow">
                Refreshed {formatDateTime(data.fetchedAt)}
              </p>
              <h1 className="mt-1 max-w-3xl text-[38px] font-light leading-[1.2] text-ink sm:text-[46px]">
                {heroTitle}
              </h1>
            </div>
            {/* On the Deals tab the tag picker lives in the Filters row. */}
            {view !== "deals" && schoolDropdown}
          </section>

          <div key={view} className="anim-fade-up">
          {/* ===== HOME ===== */}
          {view === "home" && (
            <>
              {/* The cockpit: one frame, two even halves. On xl+ the frame
                  has a fixed height and every panel scrolls inside itself —
                  content never decides the layout. */}
              <section className="card mt-6 p-3">
                <div className="grid items-stretch gap-3 xl:h-[46rem] xl:grid-cols-2">
                  <div className="card-flat flex min-h-0 min-w-0 flex-col p-4">
                    <SectionHead title={role === "user" ? "Your deals" : "Live deals"} live={role !== "user"} />
                    <div className="min-h-0 flex-1">
                      <LiveDeals
                        deals={bySchool}
                        onEdit={openDeal}
                        onOpenCrm={openInCrm}
                        onMove={handleMove}
                        stageKeys={[...new Set(data.sections.map((s) => s.stage))]}
                        mineFor={role === "user" ? { email: user.email, name: user.name } : undefined}
                      />
                    </div>
                  </div>
                  <div className="flex min-h-0 min-w-0 flex-col gap-3">
                    <CalendarPanel data={cockpit} />
                    <InboxPanel data={cockpit} />
                    {role !== "user" && <GranolaPanel data={cockpit} />}
                    <ChangesPanel data={cockpit} />
                  </div>
                </div>
              </section>
              {school && (
                <SchoolDetail
                  school={school}
                  deals={bySchool}
                  onClose={() => setSchool(null)}
                  onViewDeals={() => setView("deals")}
                />
              )}
            </>
          )}

          {/* ===== PIPELINE ===== */}
          {view === "deals" && allDeals.length === 0 && (
            <section className="mt-10">
              <div className="card mx-auto max-w-xl p-8 text-center sm:p-10">
                <h2 className="text-[22px] font-normal text-ink">
                  Your pipeline is empty
                </h2>
                <p className="mx-auto mt-2 max-w-md text-[14px] leading-relaxed text-sub">
                  This is where every founder the team is tracking lives — from
                  first meeting to term sheet. Add your first deal to get started,
                  or forward a pitch to the deal inbox and it&rsquo;ll land here
                  automatically.
                </p>
                <button
                  className="btn-primary mt-6 h-11 justify-center px-6"
                  onClick={() => setCreating({})}
                >
                  + Add your first deal
                </button>
              </div>
            </section>
          )}

          {view === "deals" && allDeals.length > 0 && (
            <>
              <section className="mt-6">
                <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
                  {/* View toggle: CRM board first (default), then database */}
                  <div className="flex" role="group" aria-label="View mode">
                    <button
                      className={`tag ${dealView === "board" ? "active" : ""}`}
                      onClick={() => setDealView("board")}
                    >
                      CRM
                    </button>
                    <button
                      className={`tag -ml-px ${dealView === "table" ? "active" : ""}`}
                      onClick={() => setDealView("table")}
                    >
                      Database
                    </button>
                  </div>
                  <div className="relative max-w-xl flex-1">
                    <input
                      ref={searchInputRef}
                      className="field"
                      placeholder="Search founders, companies, notes, owners…"
                      aria-keyshortcuts="/"
                      title="Press / from anywhere to search"
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                    />
                    <DeepSearch
                      query={deferredQuery}
                      onOpen={(gid) => {
                        const d = allDealsRef.current.find((x) => x.gid === gid);
                        if (d) openDeal(d);
                        else router.push(`/deals/${gid}`);
                      }}
                    />
                  </div>
                </div>
                {/* Filters: wrap on mobile, single scrolling line on desktop */}
                <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-line pt-3 md:flex-nowrap md:overflow-x-auto">
                  <span className="shrink-0 text-[12px] font-semibold uppercase tracking-wide text-sub">
                    Filters
                  </span>
                  <select
                    className="field min-w-0 flex-1 basis-32 !max-w-[11rem] md:!max-w-none md:!flex-none md:!basis-auto md:!w-36"
                    aria-label="Filter by stage"
                    value={stage ?? ""}
                    onChange={(e) =>
                      setStage((e.target.value || null) as StageKey | null)
                    }
                  >
                    <option value="">All stages</option>
                    {STAGES.map((s) => (
                      <option key={s.key} value={s.key}>
                        {s.label}
                      </option>
                    ))}
                  </select>
                  <OwnerFilter
                    owners={owners}
                    counts={ownerCounts}
                    members={members}
                    selected={ownerSel}
                    onChange={setOwnerSel}
                  />
                  <select
                    className="field min-w-0 flex-1 basis-32 !max-w-[11rem] md:!max-w-none md:!flex-none md:!basis-auto md:!w-36"
                    aria-label={`Filter by ${crm.tags.singular.toLowerCase()}`}
                    value={school ?? ""}
                    onChange={(e) => setSchool(e.target.value || null)}
                  >
                    <option value="">All {crm.tags.plural.toLowerCase()}</option>
                    {allSchoolNames.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                  {/* Date-added range */}
                  <input
                    type="date"
                    className="field min-w-0 flex-1 basis-32 !max-w-[11rem] md:!max-w-none md:!flex-none md:!basis-auto md:!w-36"
                    aria-label="Added on or after"
                    value={fromDate}
                    max={toDate || undefined}
                    onChange={(e) => setFromDate(e.target.value)}
                  />
                  <span className="shrink-0 text-[13px] text-sub">to</span>
                  <input
                    type="date"
                    className="field min-w-0 flex-1 basis-32 !max-w-[11rem] md:!max-w-none md:!flex-none md:!basis-auto md:!w-36"
                    aria-label="Added on or before"
                    value={toDate}
                    min={fromDate || undefined}
                    onChange={(e) => setToDate(e.target.value)}
                  />
                  {(stage || ownerSel.size > 0 || school || fromDate || toDate) && (
                    <button
                      className="tag shrink-0"
                      onClick={() => {
                        setStage(null);
                        setOwnerSel(new Set());
                        setSchool(null);
                        setFromDate("");
                        setToDate("");
                      }}
                    >
                      Clear filters
                    </button>
                  )}
                  <button
                    className="btn-primary shrink-0 whitespace-nowrap"
                    onClick={() => setCreating({})}
                  >
                    + New deal
                  </button>
                </div>
              </section>
              <section className="mt-4">
                {dealView === "table" ? (
                  <DealTable deals={filtered} onEdit={openDeal} />
                ) : (
                  <KanbanBoard
                    deals={boardDeals}
                    searchKey={deferredQuery.trim().toLowerCase()}
                    onOpen={openDeal}
                    onMove={handleMove}
                    onBulkMove={handleBulkMove}
                    onBulkDelete={handleBulkDelete}
                    onNewInStage={(stageKey) => {
                      const section = data.sections.find(
                        (s) => s.stage === stageKey
                      );
                      setCreating({ sectionGid: section?.gid });
                    }}
                    stageFilter={stage}
                    movingGids={movingGids}
                    pinnedGids={pinnedGids}
                    searchActive={Boolean(
                      query.trim() || ownerSel.size > 0 || school || fromDate || toDate
                    )}
                    onClearSearch={() => {
                      setQuery("");
                      setOwnerSel(new Set());
                      setSchool(null);
                      setFromDate("");
                      setToDate("");
                    }}
                  />
                )}
              </section>
            </>
          )}

          </div>
        </main>

      </div>

      {editing && (
        <EditDealModal
          deal={editing}
          sections={data.sections}
          topSchools={topSchools}
          members={members}
          viewer={{ email: user.email, name: user.name, image: user.image, role }}
          onClose={closeDeal}
          onSaved={onSaved}
          onDelete={handleDelete}
        />
      )}

      {creating && (
        <CreateDealModal
          sections={data.sections}
          schoolNames={allSchoolNames.filter((s) => s !== NO_SCHOOL)}
          presetSectionGid={creating.sectionGid}
          onClose={() => setCreating(null)}
          onCreate={handleCreate}
        />
      )}

      {/* Floating toast: overlays instead of inserting into the flow, so a
          flash never shifts the page. */}
      {savedFlash && (
        <div
          role="status"
          aria-live="polite"
          className="toast-in fixed inset-x-0 bottom-[calc(4.5rem+env(safe-area-inset-bottom))] z-[70] flex justify-center px-4 md:bottom-6"
        >
          <div className="max-w-md rounded-xl border border-line bg-navy px-4 py-2.5 text-[13px] font-medium text-white shadow-lg">
            {savedFlash}
          </div>
        </div>
      )}
    </div>
  );
}
