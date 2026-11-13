"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * Registers the service worker and surfaces the safe update pattern: when a new
 * version has installed and is waiting, show a "Reload" prompt rather than
 * reloading during active work. Also shows a small offline hint. Production
 * only — a SW in dev fights the Next dev server's HMR.
 */
/**
 * Watch a registration for a newly installed worker. Both listeners detach
 * through the caller's AbortSignal, and isDisposed guards late events.
 */
function watchForWaitingWorker(
  reg: ServiceWorkerRegistration,
  signal: AbortSignal,
  isDisposed: () => boolean,
  onWaiting: (w: ServiceWorker) => void
) {
  const onUpdateFound = () => {
    const installing = reg.installing;
    if (!installing) return;
    const onStateChange = () => {
      if (isDisposed()) return;
      if (installing.state === "installed" && navigator.serviceWorker.controller) {
        onWaiting(installing);
      }
    };
    installing.addEventListener("statechange", onStateChange, { signal });
  };
  reg.addEventListener("updatefound", onUpdateFound, { signal });
}

export function ServiceWorkerManager() {
  const [waiting, setWaiting] = useState<ServiceWorker | null>(null);
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!("serviceWorker" in navigator)) return;

    // The AbortController owns the registration's nested listeners (see
    // watchForWaitingWorker); the three top-level listeners detach
    // explicitly below. The disposed guard keeps late statechange events
    // from setting state after teardown.
    const ac = new AbortController();
    let disposed = false;

    const syncOnline = () => setOffline(!navigator.onLine);
    syncOnline();
    window.addEventListener("online", syncOnline);
    window.addEventListener("offline", syncOnline);

    let reloaded = false;
    const onControllerChange = () => {
      if (reloaded) return;
      reloaded = true;
      window.location.reload();
    };
    if (process.env.NODE_ENV === "production") {
      navigator.serviceWorker.addEventListener("controllerchange", onControllerChange);
      navigator.serviceWorker
        .register("/sw.js")
        .then((reg) => {
          if (disposed) return;
          if (reg.waiting) setWaiting(reg.waiting);
          watchForWaitingWorker(reg, ac.signal, () => disposed, setWaiting);
        })
        .catch(() => {});
    }

    return () => {
      disposed = true;
      window.removeEventListener("online", syncOnline);
      window.removeEventListener("offline", syncOnline);
      navigator.serviceWorker.removeEventListener("controllerchange", onControllerChange);
      ac.abort();
    };
  }, []);

  const applyUpdate = useCallback(() => {
    waiting?.postMessage("SKIP_WAITING");
  }, [waiting]);

  if (!waiting && !offline) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-50 flex justify-center px-3 pb-[calc(5rem+env(safe-area-inset-bottom))] md:pb-4">
      {waiting ? (
        <div className="pointer-events-auto flex items-center gap-3 rounded-full bg-navy px-4 py-2.5 text-[13px] text-white shadow-lg">
          <span>A new version is available.</span>
          <button
            onClick={applyUpdate}
            className="rounded-full bg-white/15 px-3 py-1 font-semibold active:bg-white/25"
          >
            Reload
          </button>
        </div>
      ) : (
        <div className="pointer-events-auto rounded-full bg-navy/90 px-4 py-2 text-[13px] text-white shadow-lg">
          You&apos;re offline
        </div>
      )}
    </div>
  );
}
