"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { triageCandidateAction } from "@/app/actions";
import { useTriageSession } from "./TriageSessionContext";

/** Top-right assignment: hand the candidate to a teammate without leaving. */
export function AssignSelect({
  candidateId,
  assignedTo,
  members,
  viewerEmail,
}: {
  candidateId: string;
  assignedTo: string | null;
  members: { email: string; name: string }[];
  viewerEmail: string;
}) {
  const router = useRouter();
  const session = useTriageSession();
  const [busy, setBusy] = useState(false);

  return (
    <label className="flex items-center gap-1.5 text-[13px] text-sub">
      Assign
      <select
        className="border border-line bg-bg px-2 py-1.5 text-[13px] text-ink outline-none focus:border-primary"
        value={assignedTo ?? ""}
        disabled={busy}
        aria-label="Assign to teammate"
        onChange={async (e) => {
          setBusy(true);
          await triageCandidateAction(candidateId, {
            kind: "assign",
            assignee: e.target.value || null,
          });
          setBusy(false);
          if (session) void session.refreshCurrent();
          else router.refresh();
        }}
      >
        <option value="">Nobody</option>
        {members.map((m) => (
          <option key={m.email} value={m.email}>
            {m.email.toLowerCase() === viewerEmail.toLowerCase() ? "Me" : m.name || m.email}
          </option>
        ))}
      </select>
    </label>
  );
}
