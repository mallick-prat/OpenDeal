"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { CalendarHeatMap, Renew } from "@carbon/icons-react";
import { syncGoogleNow } from "@/app/actions";
import { etShortDate } from "@/lib/etDates";

/**
 * Settings card for the Gmail/Calendar connection that powers each deal's
 * calendar and email context. Metadata only, per user.
 */
export function GoogleConnect({
  connected,
  lastSyncedAt,
  calendarCount,
  gmailCount,
}: {
  connected: boolean;
  lastSyncedAt: string | null;
  calendarCount: number;
  gmailCount: number;
}) {
  const router = useRouter();
  const [flash, setFlash] = useState("");
  const [busy, setBusy] = useState(false);

  // Surface the ?google=connected/failed bounce-back from the OAuth flow.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const result = params.get("google");
    if (!result) return;
    const t = setTimeout(() => {
      setFlash(
        result === "connected"
          ? "Connected. First sync running."
          : "Google connection didn't complete. Try again, and make sure the Gmail and Calendar APIs are enabled in the Google Cloud project."
      );
      window.history.replaceState(null, "", "/settings");
    }, 0);
    return () => clearTimeout(t);
  }, []);

  const sync = async () => {
    setBusy(true);
    setFlash("Syncing calendar and email metadata…");
    const res = await syncGoogleNow();
    setBusy(false);
    setFlash(
      res.ok
        ? `Synced: ${res.calendar} calendar events, ${res.gmail} emails indexed.`
        : (res.error ?? "Sync didn't run.")
    );
    if (res.ok) router.refresh();
  };

  return (
    <div>
      {flash && <div className="callout mb-4 p-3 text-[13px]">{flash}</div>}
      {connected ? (
        <div className="flex flex-wrap items-center gap-4">
          <div className="text-[13px] text-body">
            <span className="font-semibold text-ink">Connected.</span>{" "}
            {calendarCount.toLocaleString()} calendar events and{" "}
            {gmailCount.toLocaleString()} emails indexed
            {lastSyncedAt &&
              ` · last synced ${etShortDate(lastSyncedAt)}`}
            .
          </div>
          <button
            className="btn-secondary flex items-center gap-2 !text-[13px]"
            onClick={sync}
            disabled={busy}
          >
            <Renew size={16} />
            {busy ? "Syncing…" : "Sync now"}
          </button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-4">
          <p className="text-[13px] text-sub">
            Connect Google to show meetings and email history on each deal and to
            match meeting notes to deals. Calendar events and email headers
            only, never message bodies.
          </p>
          <a href="/api/google/connect" className="btn-primary flex items-center gap-2">
            <CalendarHeatMap size={16} />
            Connect Google
          </a>
        </div>
      )}
    </div>
  );
}
