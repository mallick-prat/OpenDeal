"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Email, Renew } from "@carbon/icons-react";
import {
  pollInboundNowAction,
  disconnectInboundMailboxAction,
} from "@/app/actions";
import { etShortDateTime } from "@/lib/etDates";

/**
 * Settings card for the shared sourcing mailbox (NEXT_PUBLIC_INBOUND_MAILBOX). Admin-only
 * connect/disconnect; a poll runs every 15 min via cron, or on demand here.
 */
export function InboundMailbox({
  connected,
  live,
  address,
  isAdmin,
  lastPolledAt,
  connectedBy,
  stats,
}: {
  connected: boolean;
  live: boolean;
  address: string;
  isAdmin: boolean;
  lastPolledAt: string | null;
  connectedBy: string | null;
  stats: { fetched?: number; parsed?: number; skipped?: number } | null;
}) {
  const router = useRouter();
  const [flash, setFlash] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const result = new URLSearchParams(window.location.search).get("inbox");
    if (!result) return;
    const t = setTimeout(() => {
      setFlash(
        result === "connected"
          ? `Connected ${address}. The first poll runs within 15 minutes — or hit “Poll now”.`
          : result === "wrong-account"
            ? `That wasn't ${address}. Sign in with the sourcing mailbox account and try again.`
            : result === "forbidden"
              ? "Only admins can connect the mailbox."
              : "Mailbox connection didn't complete. Confirm the Gmail API and the readonly + modify scopes are enabled in the Google Cloud project."
      );
      window.history.replaceState(null, "", "/settings");
    }, 0);
    return () => clearTimeout(t);
  }, [address]);

  const poll = async () => {
    setBusy(true);
    setFlash("Polling the mailbox…");
    const res = await pollInboundNowAction();
    setBusy(false);
    setFlash(
      res.ok
        ? `Polled: ${res.fetched ?? 0} new, ${res.parsed ?? 0} parsed, ${res.skipped ?? 0} skipped.`
        : (res.error ?? "Poll didn't run.")
    );
    if (res.ok) router.refresh();
  };

  const disconnect = async () => {
    setBusy(true);
    const res = await disconnectInboundMailboxAction();
    setBusy(false);
    if (!res.ok) setFlash(res.error ?? "Couldn't disconnect.");
    else router.refresh();
  };

  return (
    <div>
      {flash && <div className="callout mb-4 p-3 text-[13px]">{flash}</div>}
      {connected ? (
        <div className="flex flex-wrap items-center gap-4">
          <div className="text-[13px] text-body">
            <span className="font-semibold text-ink">
              {live ? "Live" : "Connected"}
            </span>{" "}
            · {address}
            {live ? " · pitches ingest on arrival" : " · reconciles daily"}
            {connectedBy ? ` · by ${connectedBy}` : ""}
            {lastPolledAt &&
              ` · last polled ${etShortDateTime(lastPolledAt)}`}
            {stats && (stats.parsed ?? 0) + (stats.skipped ?? 0) > 0
              ? ` (${stats.parsed ?? 0} parsed, ${stats.skipped ?? 0} skipped)`
              : ""}
            .
          </div>
          {isAdmin && (
            <div className="flex items-center gap-2">
              <button
                className="btn-secondary flex items-center gap-2 !text-[13px]"
                onClick={poll}
                disabled={busy}
              >
                <Renew size={16} />
                {busy ? "Working…" : "Poll now"}
              </button>
              <button
                className="text-[13px] text-sub hover:text-primary"
                onClick={disconnect}
                disabled={busy}
              >
                Disconnect
              </button>
            </div>
          )}
        </div>
      ) : !address ? (
        <p className="text-[13px] text-sub">
          Optional. To turn on the inbound queue, set{" "}
          <code className="font-mono text-ink">NEXT_PUBLIC_INBOUND_MAILBOX</code>{" "}
          to a shared Gmail address (for example deals@yourfund.com), redeploy,
          and come back here to connect it. See docs/SETUP.md, optional steps.
        </p>
      ) : (
        <div className="flex flex-wrap items-center gap-4">
          <p className="text-[13px] text-sub">
            Connect <span className="font-medium text-ink">{address}</span> so
            pitches sent there are parsed into deal drafts in the Inbound queue.
            Gmail readonly + modify; the mailbox account must grant consent.
          </p>
          {isAdmin ? (
            <a
              href="/api/google/connect-inbox"
              className="btn-primary flex items-center gap-2"
            >
              <Email size={16} />
              Connect sourcing mailbox
            </a>
          ) : (
            <span className="text-[13px] text-sub">An admin can connect it.</span>
          )}
        </div>
      )}
    </div>
  );
}
