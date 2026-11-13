"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { triageCandidateAction } from "@/app/actions";
import { useTriageSession } from "./TriageSessionContext";

/**
 * "Attach to this deal" — the reopen-not-duplicate move, rendered inside the
 * team-history panel. On success the triage session flows to the next
 * candidate, same as every other terminal action.
 */
export function AttachToDealButton({
  candidateId,
  dealGid,
}: {
  candidateId: string;
  dealGid: string;
}) {
  const router = useRouter();
  const session = useTriageSession();
  const [busy, setBusy] = useState(false);

  return (
    <button
      className="tap inline-block shrink-0 border border-primary bg-primary px-2.5 py-1 text-[12px] font-medium text-white transition-colors hover:bg-primary-pressed disabled:opacity-50"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        const res = await triageCandidateAction(candidateId, {
          kind: "attach",
          dealGid,
        });
        setBusy(false);
        if (res.ok) {
          if (session) session.advance(res.nextId ?? null);
          else if (res.nextId) router.push(`/inbox/${res.nextId}`);
          else router.push("/inbox?cleared=1");
        }
      }}
    >
      {busy ? "Merging…" : "Merge into this deal"}
    </button>
  );
}
