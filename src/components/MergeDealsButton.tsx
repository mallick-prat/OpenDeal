"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ArrowsHorizontal } from "@carbon/icons-react";
import { mergeDealsAction } from "@/app/actions";

/**
 * "These look like the same company" — shown when the seen-before panel
 * lists two deals for one candidate. One click + one confirm merges them;
 * the server keeps the record that has come furthest and folds the other in
 * (fields fill blanks, notes append, every meeting/email/founder repoints).
 */
export function MergeDealsButton({
  gidA,
  gidB,
  nameA,
  nameB,
}: {
  gidA: string;
  gidB: string;
  nameA: string;
  nameB: string;
}) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [pending, start] = useTransition();
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState("");

  const short = (n: string) => n.split("//").pop()?.trim() ?? n;

  if (done) {
    return (
      <p className="mt-1.5 text-[12.5px] text-body">
        Merged — <span className="font-medium">{done}</span> now carries the
        whole history.
      </p>
    );
  }

  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1.5">
      {!confirming ? (
        <button
          className="inline-flex items-center gap-1.5 border border-primary px-2.5 py-1 text-[12px] font-medium text-primary transition-colors hover:bg-primary hover:text-white"
          onClick={() => setConfirming(true)}
        >
          <ArrowsHorizontal size={13} />
          These are the same company — merge them
        </button>
      ) : (
        <>
          <span className="text-[12.5px] text-body">
            Merge <span className="font-medium">{short(nameB)}</span> into{" "}
            <span className="font-medium">{short(nameA)}</span>? The deeper
            record survives; nothing in the history is lost.
          </span>
          <button
            disabled={pending}
            className="border border-primary bg-primary px-2.5 py-1 text-[12px] font-medium text-white hover:bg-primary-pressed disabled:opacity-50"
            onClick={() =>
              start(async () => {
                setError("");
                const res = await mergeDealsAction(gidA, gidB);
                if (res.ok && res.keptName) {
                  setDone(short(res.keptName));
                  router.refresh();
                } else {
                  setError((!res.ok ? res.error : null) ?? "Didn't go through.");
                }
              })
            }
          >
            {pending ? "Merging…" : "Yes, merge"}
          </button>
          <button
            className="text-[12px] font-medium text-sub hover:text-ink"
            onClick={() => setConfirming(false)}
          >
            Keep separate
          </button>
        </>
      )}
      {error && <span className="text-[12px] text-primary">{error}</span>}
    </div>
  );
}
