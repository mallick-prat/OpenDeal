"use client";

import { useEffect, useState } from "react";

/**
 * Ships uncaught browser errors (including hydration failures) to
 * /api/log so they appear in Settings → System log. Capped at 5 reports
 * per page load, deduped by message, so a render loop can't flood the log.
 */
export function ClientErrorReporter() {
  // A tab that outlived a deploy calls action ids the server no longer has.
  // Every action in it fails from then on, so say so once, with the fix.
  const [stale, setStale] = useState(false);
  useEffect(() => {
    const seen = new Set<string>();
    let budget = 5;

    const report = (message: string, stack?: string) => {
      if (budget <= 0 || seen.has(message)) return;
      seen.add(message);
      budget--;
      void fetch("/api/log", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message,
          stack,
          url: window.location.pathname,
        }),
        keepalive: true,
      }).catch(() => {});
    };

    const onError = (e: ErrorEvent) => {
      report(e.message || "unknown error", e.error?.stack);
    };
    const onRejection = (e: PromiseRejectionEvent) => {
      const r = e.reason;
      const text = r instanceof Error ? r.message : String(r);
      if (/was not found on the server|older or newer deployment|Failed to find Server Action/i.test(text)) {
        setStale(true);
      }
      report(
        r instanceof Error ? `unhandled: ${r.message}` : `unhandled: ${String(r)}`,
        r instanceof Error ? r.stack : undefined
      );
    };

    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);

  if (!stale) return null;
  return (
    <div
      role="alert"
      className="fixed inset-x-0 top-0 z-[100] flex items-center justify-center gap-3 border-b border-line-strong bg-bg px-4 py-2 text-[13px] text-ink shadow"
    >
      <span>The app was updated since this page loaded.</span>
      <button className="btn-primary !h-8 !px-3 !text-[12px]" onClick={() => window.location.reload()}>
        Reload
      </button>
    </div>
  );
}
