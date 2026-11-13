"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";

/**
 * Keeps the inbox live: polls the queue's fingerprint and refreshes the page
 * the moment it changes, so a forwarded pitch appears on screen without
 * anyone reloading. Polling pauses while the tab is hidden — background tabs
 * shouldn't drain batteries or hammer the pool — and resumes with an
 * immediate check on return, which is exactly when someone flips back to see
 * whether their forward landed.
 */
const POLL_MS = 20_000;

export function InboxPulse() {
  const router = useRouter();
  const last = useRef<string | null>(null);

  useEffect(() => {
    let stopped = false;

    const check = async () => {
      if (stopped || document.hidden) return;
      try {
        const res = await fetch("/api/inbox/pulse", { cache: "no-store" });
        if (!res.ok) return;
        const { stamp } = (await res.json()) as { stamp?: string };
        if (!stamp) return;
        if (last.current !== null && stamp !== last.current) router.refresh();
        last.current = stamp;
      } catch {
        // A missed pulse is fine; the next tick retries.
      }
    };

    const timer = setInterval(() => void check(), POLL_MS);
    const onVisible = () => {
      if (!document.hidden) void check();
    };
    document.addEventListener("visibilitychange", onVisible);
    void check();

    return () => {
      stopped = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [router]);

  return null;
}
