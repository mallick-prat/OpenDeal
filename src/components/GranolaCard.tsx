"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Renew } from "@carbon/icons-react";
import { etShortDateTime } from "@/lib/etDates";

/**
 * Settings card for the Granola meeting-notes sync. The API key lives in env
 * (GRANOLA_API_KEY) — only its presence is reported here, never the value.
 * A cron pulls the last 30 days on schedule; admins can also sync on demand.
 */
export function GranolaCard({
  configured,
  isAdmin,
  lastSyncedAt,
  counts,
}: {
  configured: boolean;
  isAdmin: boolean;
  lastSyncedAt: string | null;
  counts: { total: number; suggested: number; unmatched: number; attached: number };
}) {
  const router = useRouter();
  const [flash, setFlash] = useState("");
  const [busy, setBusy] = useState(false);

  const syncNow = async () => {
    setBusy(true);
    setFlash("Syncing Granola notes…");
    try {
      const res = await fetch("/api/cron/granola-sync?ui=1", { method: "POST" });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        imported?: number;
        updated?: number;
        suggested?: number;
        errors?: number;
        error?: string;
      };
      if (data.ok) {
        setFlash(
          `Synced: ${data.imported ?? 0} new, ${data.updated ?? 0} refreshed, ${data.suggested ?? 0} suggested` +
            ((data.errors ?? 0) > 0 ? `, ${data.errors} skipped.` : ".")
        );
        router.refresh();
      } else {
        setFlash(data.error ?? "Sync didn't run.");
      }
    } catch {
      setFlash("Sync didn't run — network error.");
    }
    setBusy(false);
  };

  return (
    <div>
      {flash && <div className="callout mb-4 p-3 text-[13px]">{flash}</div>}
      {configured ? (
        <div className="flex flex-wrap items-center gap-4">
          <div className="text-[13px] text-body">
            <span className="font-semibold text-ink">Connected</span>
            {" · "}
            {counts.total} note{counts.total === 1 ? "" : "s"}
            {counts.suggested > 0 && ` · ${counts.suggested} suggested`}
            {counts.attached > 0 && ` · ${counts.attached} attached`}
            {lastSyncedAt &&
              ` · last synced ${etShortDateTime(lastSyncedAt)}`}
            .
          </div>
          {isAdmin && (
            <button
              className="btn-secondary flex items-center gap-2 !text-[13px]"
              onClick={syncNow}
              disabled={busy}
            >
              <Renew size={16} />
              {busy ? "Working…" : "Sync now"}
            </button>
          )}
        </div>
      ) : (
        <p className="text-[13px] text-sub">
          Set <span className="font-medium text-ink">GRANOLA_API_KEY</span>{" "}in
          Vercel env (an API key from Granola&apos;s integration settings,
          grn_…) and meeting notes sync automatically. Only the key&apos;s
          presence is shown here.
        </p>
      )}
    </div>
  );
}
