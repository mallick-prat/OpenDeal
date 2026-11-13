import { crm } from "@/config/crm.config";
import { cache } from "react";
import { notFound, redirect } from "next/navigation";
import type { Metadata } from "next";
import { currentAppUser, listAppUsers } from "@/lib/users";
import { listCandidateSummaries, listSchoolNames } from "@/lib/candidates";
import { missingSlots, type ParsedSummary } from "@/lib/candidatesPure";
import type { CandidateCard } from "@/components/CandidateQueue";
import { fetchSections } from "@/lib/sections";
import { buildCandidatePayload } from "@/lib/candidatePayload";
import { timed } from "@/lib/perf";
import { AppNav } from "@/components/AppNav";
import { TriageSession } from "@/components/TriageSession";

export const maxDuration = 120;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// generateMetadata and the page render in the SAME request — without cache()
// every DB read here ran twice per view.
const cachedUser = cache(() => currentAppUser());
// Core-only boot: the slow extras (team history, stored docs, calendar
// context) never block first paint — the client fades them in, the same
// path every later card in the session already takes.
const cachedPayload = cache((id: string, email: string) =>
  timed("page.inbox_payload", () => buildCandidatePayload(id, email, { extras: false }))
);

interface Props {
  params: Promise<{ id: string }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  if (!UUID.test(id)) return { title: `Candidate — ${crm.org.name}` };
  const member = await cachedUser().catch(() => null);
  if (!member) return { title: `Candidate — ${crm.org.name}` };
  const payload = await cachedPayload(id, member.email).catch(() => null);
  const name =
    payload?.parsed?.companyName || payload?.candidate.subject || "Candidate";
  return { title: `${name} — ${crm.org.name} Inbox` };
}

/**
 * Stable, deep-linkable entry into the triage session. The server assembles
 * the first payload + queue; from there <TriageSession> swaps candidates in
 * client state (history.replaceState keeps this URL honest).
 */
export default async function CandidatePage({ params }: Props) {
  const member = await cachedUser();
  if (!member) redirect("/login");
  // Triage is the investment team's desk; contributors work from the board.
  if (member.role === "user") redirect("/");

  const { id } = await params;
  // A malformed id is a genuine 404 — nothing in the app ever links to one.
  if (!UUID.test(id)) notFound();

  // A MISSING candidate is not. Clearing the queue quickly navigates to the
  // next id while the previous decision is still landing, so the target can
  // already be triaged (or filtered out of this viewer's set) by the time the
  // page renders. That's the normal end of triage, not an error — send the
  // reviewer back to the queue instead of a dead end.
  //
  // A THROW is different: that's the database being unreachable, and it must
  // propagate to the error boundary so it can retry, rather than be mistaken
  // for "already handled" and silently redirect.
  const payload = await cachedPayload(id, member.email);
  if (!payload) redirect("/inbox?handled=1");

  const [users, sections, schoolNames, rows] = await timed("page.inbox_rail", () =>
    Promise.all([
      listAppUsers(),
      fetchSections().catch(() => []),
      listSchoolNames(),
      listCandidateSummaries(member.email, 200).catch(() => []),
    ])
  );

  const railItems: CandidateCard[] = rows.map((r) => {
    // missingSlots reads the same fields the summary row carries — rebuild
    // the minimal ParsedSummary shape instead of shipping the whole blob.
    const parsedLite = {
      companyName: r.company_name,
      raiseAmount: r.raise_amount,
      round: r.round,
      founders: (r.founders ?? "")
        .split(", ")
        .filter(Boolean)
        .map((fullName) => ({ fullName })),
    } as ParsedSummary;
    return {
      id: r.id,
      status: r.status,
      assignedTo: r.assigned_to,
      classification: r.classification,
      confidence: r.confidence === null ? null : Number(r.confidence),
      receivedAt: r.received_at ? new Date(r.received_at).toISOString() : null,
      snoozedUntil: r.snoozed_until ? new Date(r.snoozed_until).toISOString() : null,
      companyName: r.company_name,
      oneLiner: r.one_liner,
      fromName: r.from_name,
      fromEmail: r.from_email,
      subject: r.subject,
      round: r.round,
      raiseAmount: r.raise_amount,
      deckCount: r.deck_count,
      attachmentCount: r.attachment_count,
      missing: missingSlots(parsedLite, r.deck_count + r.attachment_count > 0),
      promotedDealGid: r.promoted_deal_gid,
      founders: r.founders || null,
      source: "email" as const,
    };
  });

  // The main inbox and the split view share ONE queue: Granola rows ride
  // the same rail here, navigating to their own triage page.
  const { granolaInboxItems, granolaToCards } = await import("@/lib/meetingNotesView");
  const granolaCards = granolaToCards(await granolaInboxItems().catch(() => []));
  const mergedRail = [...railItems, ...granolaCards].sort((a, b) =>
    (b.receivedAt ?? "").localeCompare(a.receivedAt ?? "")
  );

  return (
    <div className="flex min-h-[100dvh]">
      <AppNav user={{ name: member.name, email: member.email, image: member.image }} role={member.role} />
      <div className="min-w-0 flex-1">
        <TriageSession
          initial={payload}
          railItems={mergedRail}
          members={users.map((u) => ({ email: u.email, name: u.name }))}
          viewerEmail={member.email}
          sections={sections}
          schoolNames={schoolNames}
        />
      </div>
    </div>
  );
}
