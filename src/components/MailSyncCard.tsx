"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Email, Renew } from "@carbon/icons-react";
import { etShortDate } from "@/lib/etDates";

/**
 * Settings card for the personal-inbox Gmail sync (PR-05). Read-only scope;
 * bodies stay restricted to the connecting member until a thread is attached
 * to a deal.
 */
export function MailSyncCard({
  connected,
  address,
  status,
  lastSyncedAt,
  messageCount,
  threadCount,
  canSend,
}: {
  connected: boolean;
  address: string;
  status: string;
  lastSyncedAt: string | null;
  messageCount: number;
  threadCount: number;
  /** False when the grant is read-only — pass notes can't send as you yet. */
  canSend: boolean;
}) {
  const router = useRouter();
  const [flash, setFlash] = useState("");
  const [busy, setBusy] = useState(false);

  // Surface the ?mail=connected/wrong-account/error bounce-back from OAuth.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const result = params.get("mail");
    if (!result) return;
    const t = setTimeout(() => {
      setFlash(
        result === "connected"
          ? "Connected. First sync running."
          : result === "wrong-account"
            ? "That Google account doesn't match your sign-in email. Connect the same account you use to sign in here."
            : "Inbox connection didn't complete. Try again."
      );
      window.history.replaceState(null, "", "/settings");
    }, 0);
    return () => clearTimeout(t);
  }, []);

  const sync = async () => {
    setBusy(true);
    setFlash("Syncing your inbox…");
    try {
      const res = await fetch("/api/google/connect-mail/sync", {
        method: "POST",
      });
      const data = (await res.json().catch(() => null)) as {
        ok?: boolean;
        counts?: { synced: number; excluded: number; errors: number };
        error?: string;
      } | null;
      if (res.ok && data?.ok && data.counts) {
        setFlash(
          `Synced ${data.counts.synced} new message${data.counts.synced === 1 ? "" : "s"}, ` +
            `${data.counts.excluded} filtered out` +
            (data.counts.errors ? `, ${data.counts.errors} failed` : "") +
            "."
        );
        router.refresh();
      } else {
        setFlash(data?.error ?? "Sync didn't run.");
      }
    } catch {
      setFlash("Sync didn't run — network error.");
    }
    setBusy(false);
  };

  return (
    <div>
      {flash && <div className="callout mb-4 p-3 text-[13px]">{flash}</div>}
      {connected ? (
        <div className="flex flex-wrap items-center gap-4">
          <div className="text-[13px] text-body">
            <span className="font-semibold text-ink">{address}</span>{" "}
            {status === "reauth_needed" ? (
              <>— access expired; reconnect to resume syncing.</>
            ) : (
              <>
                — {messageCount.toLocaleString()} message
                {messageCount === 1 ? "" : "s"} across{" "}
                {threadCount.toLocaleString()} thread
                {threadCount === 1 ? "" : "s"}
                {lastSyncedAt &&
                  ` · last synced ${etShortDate(lastSyncedAt)}`}
                {!canSend && " · sending not enabled yet"}.
              </>
            )}
          </div>
          {status === "reauth_needed" ? (
            <a
              href="/api/google/connect-mail"
              className="btn-primary flex items-center gap-2"
            >
              <Email size={16} />
              Reconnect
            </a>
          ) : (
            <span className="flex flex-wrap items-center gap-2">
              {!canSend && (
                // Read-only grant: one reconnect adds send, so pass notes
                // can go out as this member.
                <a
                  href="/api/google/connect-mail"
                  className="btn-primary flex items-center gap-2"
                >
                  <Email size={16} />
                  Reconnect to enable sending
                </a>
              )}
              <button
                className="btn-secondary flex items-center gap-2 !text-[13px]"
                onClick={sync}
                disabled={busy}
              >
                <Renew size={16} />
                {busy ? "Syncing…" : "Sync now"}
              </button>
            </span>
          )}
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-4">
          <p className="text-[13px] text-sub">
            Syncs your inbox so pitches you receive personally appear in the
            Inbox queue. Only you can see message bodies until you attach a
            thread to a deal. Newsletters, receipts, and calendar invites are
            filtered out before anything is stored.
          </p>
          <a
            href="/api/google/connect-mail"
            className="btn-primary flex items-center gap-2"
          >
            <Email size={16} />
            Connect your inbox
          </a>
        </div>
      )}
    </div>
  );
}
