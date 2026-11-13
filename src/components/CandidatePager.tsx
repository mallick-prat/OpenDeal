"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { ChevronLeft, ChevronRight } from "@carbon/icons-react";
import { useTriageSession } from "./TriageSessionContext";

const DIR_KEY = "xf-page-turn";

/** Remember which way we're turning so the next page slides in from there. */
export function setTurnDirection(dir: "next" | "prev") {
  try {
    sessionStorage.setItem(DIR_KEY, dir);
  } catch {
    // Private-mode storage failures just skip the animation.
  }
}

/** ← / → through the open queue, with arrow-key support. */
export function CandidatePager({
  prevId,
  nextId,
}: {
  prevId: string | null;
  nextId: string | null;
}) {
  const router = useRouter();
  const session = useTriageSession();

  const go = (dir: "next" | "prev") => {
    const target = dir === "next" ? nextId : prevId;
    if (!target) return;
    // A rooted target (a granola note's page) is a navigation, not a swap.
    if (target.startsWith("/")) {
      setTurnDirection(dir);
      router.push(target);
      return;
    }
    // In the triage session the turn is an instant client-state swap.
    if (session) {
      session.goTo(target, dir);
      return;
    }
    setTurnDirection(dir);
    router.push(`/inbox/${target}`);
  };

  // Prefetch both neighbours so the turn is already rendered when clicked.
  // (The triage session prefetches payloads itself — no route prefetch.)
  useEffect(() => {
    if (session) return;
    if (nextId) router.prefetch(nextId.startsWith("/") ? nextId : `/inbox/${nextId}`);
    if (prevId) router.prefetch(prevId.startsWith("/") ? prevId : `/inbox/${prevId}`);
  }, [router, prevId, nextId, session]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      // closest, not matches: keydowns inside a contenteditable (Scratchpad,
      // rich fields) target child nodes, and arrows there must edit, not page.
      if (t.closest("input, textarea, select, [contenteditable]") || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "ArrowRight") go("next");
      else if (e.key === "ArrowLeft") go("prev");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prevId, nextId, session]);

  return (
    <span className="flex items-center gap-1">
      <button
        className="tap flex h-8 w-8 items-center justify-center border border-line text-sub transition-colors hover:border-primary hover:text-primary disabled:opacity-30"
        disabled={!prevId}
        aria-label="Previous candidate"
        title="Previous (←)"
        onClick={() => go("prev")}
      >
        <ChevronLeft size={16} />
      </button>
      <button
        className="tap flex h-8 w-8 items-center justify-center border border-line text-sub transition-colors hover:border-primary hover:text-primary disabled:opacity-30"
        disabled={!nextId}
        aria-label="Next candidate"
        title="Next (→)"
        onClick={() => go("next")}
      >
        <ChevronRight size={16} />
      </button>
    </span>
  );
}
