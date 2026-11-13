"use client";

/**
 * Offline fallback — precached by the service worker and served when a
 * navigation fails with no network. Fully static, no auth or data, so the
 * cached copy is always this message (not a login redirect). Exempt from the
 * auth middleware for the same reason.
 */
export default function OfflinePage() {
  return (
    <main className="mx-auto flex min-h-[100dvh] w-full max-w-sm flex-col items-center justify-center gap-4 px-6 text-center">
      <span
        aria-hidden
        className="flex h-14 w-14 items-center justify-center bg-primary text-[26px] font-bold text-white"
      >
        Xf
      </span>
      <h1 className="text-[26px] font-light text-ink">You&apos;re offline</h1>
      <p className="text-[15px] leading-relaxed text-sub">
        The pipeline needs a connection to load live pipeline data. Reconnect
        and try again — nothing you were doing was lost.
      </p>
      {/* Full reload so the service worker re-runs its network-first fetch. */}
      <button
        type="button"
        onClick={() => window.location.assign("/")}
        className="btn-primary mt-2"
      >
        Try again
      </button>
    </main>
  );
}
