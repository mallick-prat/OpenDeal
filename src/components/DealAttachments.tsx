"use client";

import { useCallback, useEffect, useState } from "react";
import { Document, Launch, TrashCan } from "@carbon/icons-react";
import {
  getDealAttachments,
  removeDealAttachmentAction,
  type DealAttachmentView,
} from "@/app/actions";

/**
 * Existing attachments on a deal: open each in a new tab, preview images
 * inline, and remove. Replaces the old "(N already on the deal)" count so the
 * deck is actually reachable for evaluation / meeting prep.
 */
export function DealAttachments({ gid }: { gid: string }) {
  const [items, setItems] = useState<DealAttachmentView[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await getDealAttachments(gid);
    if (res.ok) setItems(res.items);
    else setError(res.error);
  }, [gid]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await getDealAttachments(gid);
      if (cancelled) return;
      if (res.ok) setItems(res.items);
      else setError(res.error);
    })();
    return () => {
      cancelled = true;
    };
  }, [gid]);

  const remove = async (a: DealAttachmentView) => {
    if (typeof window !== "undefined" && !window.confirm(`Remove “${a.name}”?`)) return;
    setBusy(a.gid);
    // Optimistic: drop it now.
    setItems((cur) => (cur ? cur.filter((x) => x.gid !== a.gid) : cur));
    const res = await removeDealAttachmentAction(gid, a.gid);
    setBusy(null);
    if (!res.ok) {
      setError(res.error ?? "Couldn't remove it.");
      await load(); // put it back if the delete failed
    }
  };

  if (items === null && !error) {
    return (
      <p role="status" aria-live="polite" className="text-[12px] text-faint">
        Loading attachments…
      </p>
    );
  }
  if (error) {
    return <p className="text-[12px] text-primary">{error}</p>;
  }
  if (!items || items.length === 0) {
    return <p className="text-[12px] text-faint">No files attached yet.</p>;
  }

  return (
    <ul className="flex flex-col gap-2">
      {items.map((a) => (
        <li
          key={a.gid}
          className="flex items-center gap-3 rounded-lg border border-line p-2"
        >
          <a
            href={a.url ?? "#"}
            target="_blank"
            rel="noreferrer"
            className="flex min-w-0 flex-1 items-center gap-3"
            title={`Open ${a.name}`}
          >
            {a.isImage && a.downloadUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={a.downloadUrl}
                alt=""
                className="h-10 w-10 shrink-0 rounded border border-line object-cover"
              />
            ) : (
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded border border-line bg-bg-soft text-sub">
                <Document size={18} />
              </span>
            )}
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-medium text-ink">
                {a.name}
              </span>
              <span className="flex items-center gap-1 text-[11px] text-primary">
                <Launch size={11} /> Open
              </span>
            </span>
          </a>
          <button
            className="tap flex shrink-0 items-center justify-center p-1.5 text-sub transition-colors hover:text-primary disabled:opacity-50"
            aria-label={`Remove ${a.name}`}
            title="Remove attachment"
            onClick={() => remove(a)}
            disabled={busy === a.gid}
          >
            <TrashCan size={16} />
          </button>
        </li>
      ))}
    </ul>
  );
}
