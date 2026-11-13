"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Self-healing loading state: when a server render couldn't reach the
 * database, this quietly re-renders on a backoff until it succeeds — the
 * user never has to reload by hand. Rendered IN PLACE of the dead screen;
 * the moment a retry works, the real page takes over.
 */
export function AutoRetry({
  title = "Waking the database…",
  detail = "Reconnecting…",
}: {
  title?: string;
  detail?: string;
}) {
  const router = useRouter();
  const [attempt, setAttempt] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    // 2s, 4s, 8s, 15s, then every 20s — patient, not spammy.
    const delays = [2000, 4000, 8000, 15000];
    const delay = delays[attempt] ?? 20000;
    timer.current = setTimeout(() => {
      router.refresh();
      setAttempt((a) => a + 1);
    }, delay);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [attempt, router]);

  return (
    <main className="mx-auto flex min-h-[100dvh] w-full max-w-lg flex-col items-center justify-center gap-4 px-6 text-center">
      <span
        className="inline-block h-2 w-2 animate-pulse rounded-full bg-primary"
        aria-hidden
      />
      <h1 className="text-[24px] font-light text-ink">{title}</h1>
      <p className="text-[14px] text-sub" role="status" aria-live="polite">
        {detail}
        {attempt > 0 && ` (attempt ${attempt + 1})`}
      </p>
    </main>
  );
}
