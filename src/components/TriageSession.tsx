"use client";

import { crm } from "@/config/crm.config";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  getCandidateCoresAction,
  getCandidateExtrasAction,
  getCandidatePayloadAction,
} from "@/app/actions";
import type {
  CandidateCore,
  CandidateExtras,
  CandidatePayload,
} from "@/lib/candidatePayload";
import type { SectionInfo } from "@/lib/types";
import { CandidateQueue, type CandidateCard } from "./CandidateQueue";
import { Callout } from "./Callout";
import { DealCardWorkspace } from "./DealCardWorkspace";
import {
  TriageSessionContext,
  type TriageSessionApi,
} from "./TriageSessionContext";

const DIR_KEY = "xf-page-turn";

/* ── Core cache persistence: a mid-session full-page refresh boots warm ──── */

const CORE_STORE_KEY = "xf-triage-cores-v1";
const CORE_STORE_MAX = 40;
/** A failed fetch gets ONE silent retry on a later turn, then stays quiet. */
const MAX_TRIES = 2;

function coreOfPayload(p: CandidatePayload): CandidateCore {
  const { candidate, parsed, deckLinks, attachments, missing, claims, isOpenStatus, proposedDeal, dealPrefill } = p;
  return { candidate, parsed, deckLinks, attachments, missing, claims, isOpenStatus, proposedDeal: proposedDeal ?? null, dealPrefill };
}

function extrasOfPayload(p: CandidatePayload): CandidateExtras {
  return { storedDocs: p.storedDocs, history: p.history, meetingContext: p.meetingContext };
}

/**
 * Best-effort restore of cores this tab persisted earlier. Only ids still in
 * the server-fresh queue come back (closed cards never resurrect), and each
 * entry gets a light shape check so corrupt storage can't crash a render.
 */
function restoreCores(initial: CandidatePayload): ReadonlyMap<string, CandidateCore> {
  const m = new Map<string, CandidateCore>();
  try {
    const raw =
      typeof window === "undefined" ? null : sessionStorage.getItem(CORE_STORE_KEY);
    if (raw) {
      const stored = JSON.parse(raw) as {
        v?: number;
        cores?: Record<string, CandidateCore>;
      };
      if (stored?.v === 1 && stored.cores) {
        for (const id of initial.queue) {
          const core = stored.cores[id];
          if (
            core &&
            core.candidate?.id === id &&
            core.claims &&
            core.dealPrefill &&
            Array.isArray(core.missing)
          ) {
            m.set(id, core);
          }
        }
      }
    }
  } catch {
    // No storage / bad JSON — start cold; the prefetch warms it right up.
  }
  m.set(initial.candidate.id, coreOfPayload(initial));
  return m;
}

function persistCores(m: ReadonlyMap<string, CandidateCore>): void {
  try {
    const entries = [...m.entries()].slice(-CORE_STORE_MAX);
    sessionStorage.setItem(
      CORE_STORE_KEY,
      JSON.stringify({ v: 1, cores: Object.fromEntries(entries) })
    );
  } catch {
    // Quota/private mode — the in-memory cache still covers this session.
  }
}

/**
 * ── The triage miniapp ──────────────────────────────────────────────────────
 * The queue loads once; ← → and every triage action swap candidates INSTANTLY
 * in client state — no route navigation. Payloads come in two stages:
 * CORE (the whole above-the-fold workspace) is aggressively prefetched in
 * batches so a turn always lands on a rendered page; EXTRAS (history + docs)
 * fade in underneath. If a turn ever outruns the cache we STAY on the current
 * card — interactive, with a thin progress bar — until core lands. No blank
 * page, ever. The URL follows along via history.replaceState so /inbox/<id>
 * stays deep-linkable.
 */
export function TriageSession({
  initial,
  members,
  viewerEmail,
  sections,
  schoolNames,
  railItems,
}: {
  initial: CandidatePayload;
  members: { email: string; name: string }[];
  viewerEmail: string;
  sections: SectionInfo[];
  schoolNames: string[];
  /** Queue rows for the master list; present on desktop split view. */
  railItems?: CandidateCard[];
}) {
  const router = useRouter();
  const [queue, setQueue] = useState<string[]>(initial.queue);
  const [currentId, setCurrentId] = useState(initial.candidate.id);
  const [coreCache, setCoreCache] = useState<ReadonlyMap<string, CandidateCore>>(
    () => restoreCores(initial)
  );
  const [extrasCache, setExtrasCache] = useState<ReadonlyMap<string, CandidateExtras>>(
    () =>
      // A core-only boot seeds nothing: the warm-cache effect fetches this
      // card's extras immediately, same as any later card in the session.
      initial.extrasPending
        ? new Map()
        : new Map([[initial.candidate.id, extrasOfPayload(initial)]])
  );
  /** A turn waiting on its core: current card stays up, thin bar shows. */
  const [pendingTurn, setPendingTurn] = useState<{ id: string; dir: "next" | "prev" } | null>(null);
  const [turnError, setTurnError] = useState("");

  /** Core fetches in flight, keyed by id — dedupes AND lets a turn await one. */
  const inflightCores = useRef<Map<string, Promise<CandidateCore | null>>>(new Map());
  /** Extras fetches in flight. */
  const inflightExtras = useRef<Set<string>>(new Set());
  /** Failed tries per "core:<id>" / "extras:<id>" — capped at MAX_TRIES. */
  const attempts = useRef<Map<string, number>>(new Map());
  /** The latest pending turn — stale fetch resolutions check against it. */
  const pendingTurnRef = useRef<{ id: string; dir: "next" | "prev" } | null>(null);
  const refreshingRef = useRef(false);
  const bootedRef = useRef(false);
  const turnRef = useRef<HTMLDivElement>(null);

  // Entry animation: honour a page-turn direction left by the previous page
  // (same contract PageTurn used). Class goes on via the DOM, not state — the
  // server-rendered markup stays identical for hydration.
  useEffect(() => {
    try {
      const dir = sessionStorage.getItem(DIR_KEY) as "next" | "prev" | null;
      if (dir && turnRef.current) {
        sessionStorage.removeItem(DIR_KEY);
        turnRef.current.classList.add(dir === "next" ? "page-turn-next" : "page-turn-prev");
      }
    } catch {
      // No storage, no animation.
    }
  }, []);

  // Mirror the core cache into sessionStorage (best-effort, capped).
  useEffect(() => {
    persistCores(coreCache);
  }, [coreCache]);

  const putCore = useCallback((id: string, core: CandidateCore) => {
    setCoreCache((prev) => new Map(prev).set(id, core));
  }, []);
  const putExtras = useCallback((id: string, extras: CandidateExtras) => {
    setExtrasCache((prev) => new Map(prev).set(id, extras));
  }, []);

  /**
   * Warm cores for the given ids in ONE batched action call. Deduped against
   * the cache and in-flight fetches; failures bump the attempt counter and
   * get one silent retry when a later turn re-runs the prefetch effect.
   */
  const fetchCores = useCallback(
    (ids: string[], cached: ReadonlyMap<string, CandidateCore>) => {
      const need = [...new Set(ids)].filter(
        (id) =>
          !cached.has(id) &&
          !inflightCores.current.has(id) &&
          (attempts.current.get(`core:${id}`) ?? 0) < MAX_TRIES
      );
      if (need.length === 0) return;
      const batch = getCandidateCoresAction(need)
        .then((res) => (res.ok && res.cores ? res.cores : null))
        .catch(() => null);
      for (const id of need) {
        const one = batch.then((cores) => cores?.[id] ?? null);
        inflightCores.current.set(id, one);
        void one
          .then((core) => {
            if (core) {
              attempts.current.delete(`core:${id}`);
              putCore(id, core);
            } else {
              attempts.current.set(`core:${id}`, (attempts.current.get(`core:${id}`) ?? 0) + 1);
            }
          })
          .finally(() => inflightCores.current.delete(id));
      }
    },
    [putCore]
  );

  /** Warm extras (history + docs) for the given ids, one quiet call each. */
  const fetchExtras = useCallback(
    (ids: string[], cached: ReadonlyMap<string, CandidateExtras>) => {
      for (const id of new Set(ids)) {
        if (cached.has(id) || inflightExtras.current.has(id)) continue;
        if ((attempts.current.get(`extras:${id}`) ?? 0) >= MAX_TRIES) continue;
        inflightExtras.current.add(id);
        void getCandidateExtrasAction(id)
          .then((res) => {
            if (res.ok && res.extras) {
              attempts.current.delete(`extras:${id}`);
              putExtras(id, res.extras);
            } else {
              attempts.current.set(
                `extras:${id}`,
                (attempts.current.get(`extras:${id}`) ?? 0) + 1
              );
            }
          })
          .catch(() => {
            attempts.current.set(
              `extras:${id}`,
              (attempts.current.get(`extras:${id}`) ?? 0) + 1
            );
          })
          .finally(() => inflightExtras.current.delete(id));
      }
    },
    [putExtras]
  );

  // The warm cache: on boot, ONE batched call covers the first 8 queue slots;
  // after every turn, top up so current±4 cores stay cached and current±1 has
  // extras. Re-runs as the cache fills, no-oping once everything's warm.
  useEffect(() => {
    const idx = queue.indexOf(currentId);
    const coreTargets = [currentId];
    if (!bootedRef.current) {
      bootedRef.current = true;
      coreTargets.push(...queue.slice(0, 8));
    }
    const extrasTargets = [currentId];
    if (idx !== -1) {
      for (let off = -4; off <= 4; off++) {
        const t = queue[idx + off];
        if (t) coreTargets.push(t);
      }
      for (const off of [-1, 1]) {
        const t = queue[idx + off];
        if (t) extrasTargets.push(t);
      }
    }
    fetchCores(coreTargets, coreCache);
    fetchExtras(extrasTargets, extrasCache);
  }, [currentId, queue, coreCache, extrasCache, fetchCores, fetchExtras]);

  /** Restart the page-turn animation on the container (ref, never state). */
  const playTurn = (dir: "next" | "prev") => {
    const el = turnRef.current;
    if (!el) return;
    el.classList.remove("page-turn-next", "page-turn-prev");
    void el.offsetWidth; // reflow so the same animation can replay
    el.classList.add(dir === "next" ? "page-turn-next" : "page-turn-prev");
  };

  /** The committed swap: state + URL + title + animation. Instant. */
  const commitTurn = (id: string, dir: "next" | "prev", core?: CandidateCore) => {
    setCurrentId(id);
    window.history.replaceState(null, "", `/inbox/${id}`);
    const c = core ?? coreCache.get(id);
    if (c) {
      document.title = `${c.parsed?.companyName || c.candidate.subject || "Candidate"} — ${crm.org.name} Inbox`;
    }
    playTurn(dir);
  };

  /**
   * Turn the page. Core cached → instant swap (extras fade in when they
   * land). Core missing → STAY on the current card, fully interactive, with
   * the thin top progress bar until core arrives; a failure keeps the
   * current card up and surfaces the error instead.
   */
  const showCandidate = (id: string, dir: "next" | "prev") => {
    setTurnError("");
    if (coreCache.has(id)) {
      pendingTurnRef.current = null;
      setPendingTurn(null);
      commitTurn(id, dir);
      return;
    }
    const turn = { id, dir };
    pendingTurnRef.current = turn;
    setPendingTurn(turn);
    // A user-driven turn always deserves a fresh try, even after prefetch
    // burned its retries.
    attempts.current.delete(`core:${id}`);
    fetchCores([id], coreCache);
    const inflight =
      inflightCores.current.get(id) ?? Promise.resolve<CandidateCore | null>(null);
    void inflight.then((core) => {
      if (pendingTurnRef.current !== turn) return; // superseded by a later turn
      pendingTurnRef.current = null;
      setPendingTurn(null);
      if (core) commitTurn(id, dir, core);
      else setTurnError("Couldn't load that candidate. Try again.");
    });
  };

  const api: TriageSessionApi = {
    // Post-mutation reconcile: re-fetch this candidate's payload in place of
    // router.refresh — children applied their optimistic state already. One
    // round trip refreshes BOTH stages of the cache.
    refreshCurrent: async () => {
      const id = currentId;
      if (refreshingRef.current) return;
      refreshingRef.current = true;
      try {
        const res = await getCandidatePayloadAction(id);
        if (res.ok && res.payload) {
          const fresh = res.payload;
          putCore(id, coreOfPayload(fresh));
          putExtras(id, extrasOfPayload(fresh));
        }
      } finally {
        refreshingRef.current = false;
      }
    },
    // Terminal action (board/pass/ignore/attach): drop the candidate from the
    // local queue and turn to whatever slid into its place. The cache keeps
    // the closed card (never evict mid-session) so the page stays rendered
    // even if the next core is still landing.
    advance: (serverNextId) => {
      const idx = queue.indexOf(currentId);
      const rest = queue.filter((q) => q !== currentId);
      setQueue(rest);
      if (rest.length === 0) {
        router.push("/inbox?cleared=1");
        return;
      }
      const next =
        (idx >= 0 && idx < rest.length ? rest[idx] : null) ??
        (serverNextId && rest.includes(serverNextId) ? serverNextId : null) ??
        rest[0];
      showCandidate(next, "next");
    },
    goTo: (id, dir) => showCandidate(id, dir),
  };

  const core = coreCache.get(currentId);
  const extras = extrasCache.get(currentId) ?? null;
  const qIdx = queue.indexOf(currentId);
  // The wheel follows what the rail SHOWS — email candidates and granola
  // notes in one order. A note neighbor is a route (href), not a session id.
  const nav = railItems && railItems.length > 0 ? railItems : null;
  const navIdx = nav ? nav.findIndex((r) => r.id === currentId) : -1;
  const prevId = nav
    ? navIdx > 0
      ? (nav[navIdx - 1].href ?? nav[navIdx - 1].id)
      : null
    : qIdx > 0
      ? queue[qIdx - 1]
      : null;
  const nextId = nav
    ? navIdx >= 0 && navIdx < nav.length - 1
      ? (nav[navIdx + 1].href ?? nav[navIdx + 1].id)
      : null
    : qIdx >= 0 && qIdx < queue.length - 1
      ? queue[qIdx + 1]
      : null;

  return (
    <TriageSessionContext.Provider value={api}>
      {/* A turn waiting on its fetch: thin indeterminate bar, page stays live. */}
      {pendingTurn && (
        <div
          className="progress-rail fixed inset-x-0 top-0 z-50"
          role="progressbar"
          aria-label="Loading the next candidate"
        >
          <div className="progress-runner bg-primary" />
        </div>
      )}
      <main
        className={`mx-auto flex min-h-[100dvh] w-full flex-col px-6 pt-10 ${
          railItems ? "max-w-[1440px] lg:grid lg:grid-cols-[380px_minmax(0,1fr)] lg:items-start lg:gap-8" : "max-w-3xl pt-12"
        }`}
      >
        {railItems && (
          <aside className="hidden lg:block lg:sticky lg:top-0 lg:max-h-[100dvh] lg:overflow-y-auto lg:py-2">
            <h1 className="px-1 pb-2 text-[26px] font-light text-ink">Inbox</h1>
            <CandidateQueue
              items={railItems}
              viewerEmail={viewerEmail}
              selectedId={currentId}
              onSelect={(id) => {
                if (id === currentId) return;
                const target = queue.indexOf(id);
                api.goTo(id, target >= 0 && target < qIdx ? "prev" : "next");
              }}
            />
          </aside>
        )}
        <div ref={turnRef} className="flex min-h-full min-w-0 flex-1 flex-col">
          {turnError && (
            <Callout tone="error" className="mb-4 p-3 text-[13px]">
              {turnError}
            </Callout>
          )}
          {core && (
            <DealCardWorkspace
              key={core.candidate.id}
              core={core}
              extras={extras}
              members={members}
              viewerEmail={viewerEmail}
              sections={sections}
              schoolNames={schoolNames}
              queuePosition={qIdx + 1}
              queueTotal={queue.length}
              prevId={prevId}
              nextId={nextId}
            />
          )}
        </div>
      </main>
    </TriageSessionContext.Provider>
  );
}
