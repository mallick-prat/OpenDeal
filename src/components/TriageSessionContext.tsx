"use client";

import { createContext, useContext } from "react";

/**
 * ── The triage session's client-side API ────────────────────────────────────
 * When the candidate detail renders inside <TriageSession>, children swap
 * data in client state instead of navigating: refreshCurrent() re-fetches the
 * current candidate's payload (replacing router.refresh), advance() drops the
 * candidate from the queue and turns the page, goTo() is a plain page turn.
 *
 * Children treat the context as OPTIONAL and fall back to router navigation /
 * router.refresh when it's absent — so they stay reusable outside the session.
 */
export interface TriageSessionApi {
  /** Re-fetch the current candidate's payload (post-mutation reconcile). */
  refreshCurrent: () => Promise<void>;
  /** Terminal action: drop the current candidate and turn to the next. */
  advance: (nextId: string | null) => void;
  /** Plain page turn to a neighbouring candidate in the queue. */
  goTo: (id: string, dir: "next" | "prev") => void;
}

export const TriageSessionContext = createContext<TriageSessionApi | null>(null);

/** The session API, or null when rendering outside a triage session. */
export function useTriageSession(): TriageSessionApi | null {
  return useContext(TriageSessionContext);
}
