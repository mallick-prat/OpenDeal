"use client";

import { useEffect, useRef, useState } from "react";

/**
 * App-wide error boundary, self-healing edition: any uncaught render error
 * (a database blip on a page without its own guard, an action throwing
 * mid-render) lands here — logged to the System log, then quietly retried
 * on a backoff until the real screen takes back over. Nobody reads a dead
 * error page or reloads by hand.
 */
/** Errors that mean "this tab belongs to a replaced deployment". */
const STALE_BUILD =
  /Load failed|ChunkLoadError|Loading chunk|dynamically imported module|Importing a module script failed|error loading dynamically imported/i;

export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const [attempt, setAttempt] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // A deploy replaces the build this tab was loaded from; its lazy chunks
  // 404 forever after, so soft retries (reset/refresh) can NEVER heal it —
  // that was the every-2-seconds crash loop. One hard reload fetches fresh
  // HTML with live asset URLs. The sessionStorage latch keeps a genuine
  // outage that merely sounds like a chunk error from looping reloads.
  useEffect(() => {
    if (!STALE_BUILD.test(error.message)) return;
    const KEY = "xf-stale-build-reload";
    const last = Number(sessionStorage.getItem(KEY) ?? 0);
    if (Date.now() - last > 60_000) {
      sessionStorage.setItem(KEY, String(Date.now()));
      window.location.reload();
    }
  }, [error]);

  useEffect(() => {
    void fetch("/api/log", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: `page crashed: ${error.message}`.slice(0, 300),
        stack: error.digest ? `digest: ${error.digest}` : error.stack,
        url: window.location.pathname,
      }),
      keepalive: true,
    }).catch(() => {});
  }, [error]);

  useEffect(() => {
    // 2s, 4s, 8s, 15s, then every 20s — patient, not spammy.
    const delays = [2000, 4000, 8000, 15000];
    const delay = delays[attempt] ?? 20000;
    timer.current = setTimeout(() => {
      setAttempt((a) => a + 1);
      reset();
    }, delay);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [attempt, reset]);

  return (
    <main className="mx-auto flex min-h-[100dvh] w-full max-w-lg flex-col items-center justify-center gap-4 px-6 text-center">
      <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-primary" aria-hidden />
      <h1 className="text-[24px] font-light text-ink">Reconnecting…</h1>
      <p className="text-[14px] text-sub" role="status" aria-live="polite">
        The server hit a blip (it was logged). Retrying automatically — this
        screen replaces itself the moment it&rsquo;s back.
        {attempt > 0 && ` (attempt ${attempt + 1})`}
      </p>
      <button
        className="btn-secondary tap"
        onClick={() => {
          setAttempt((a) => a + 1);
          reset();
        }}
      >
        Try now
      </button>
    </main>
  );
}
