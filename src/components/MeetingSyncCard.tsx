"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Renew } from "@carbon/icons-react";

/**
 * One button, both meeting pipes: runs the calendar sweep (events + matching
 * + reverse enrichment) and then the Granola sync (notes + matching + update
 * proposals), reporting each in plain words. The crons do this every quarter
 * hour on their own — the button is for "I just finished the meeting and
 * want it NOW".
 */
export function MeetingSyncCard({ isAdmin }: { isAdmin: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");

  const run = async () => {
    setBusy(true);
    setStatus("Syncing the calendar…");
    try {
      const cal = (await fetch("/api/cron/calendar-sync", { method: "POST" })
        .then((r) => r.json())
        .catch(() => null)) as {
        ok?: boolean;
        events?: number;
        matched?: number;
        error?: string;
      } | null;
      const calLine = cal?.ok
        ? `Calendar: ${cal.events ?? 0} events, ${cal.matched ?? 0} newly matched`
        : `Calendar failed${cal?.error ? ` — ${cal.error}` : ""}`;

      setStatus(`${calLine}. Syncing Granola…`);
      const gr = (await fetch("/api/cron/granola-sync?ui=1", { method: "POST" })
        .then((r) => r.json())
        .catch(() => null)) as {
        ok?: boolean;
        imported?: number;
        updated?: number;
        suggested?: number;
        error?: string;
      } | null;
      const grLine = gr?.ok
        ? `Granola: ${gr.imported ?? 0} new, ${gr.suggested ?? 0} suggested`
        : `Granola failed${gr?.error ? ` — ${gr.error}` : ""}`;

      setStatus(`${calLine} · ${grLine}.`);
      router.refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-[15px] font-semibold text-ink">Meeting sync</h3>
          <p className="mt-0.5 text-[13px] text-sub">
            Calendar and Granola refresh on the schedule in vercel.json (daily by
            default); run them now to pull a meeting that just ended.
          </p>
        </div>
        {isAdmin && (
          <button
            className="btn-primary inline-flex items-center gap-1.5"
            disabled={busy}
            onClick={() => void run()}
          >
            <Renew size={16} className={busy ? "animate-spin" : ""} />
            {busy ? "Syncing…" : "Sync now"}
          </button>
        )}
      </div>
      {status && <p className="mt-2 text-[13px] text-body">{status}</p>}
    </div>
  );
}
