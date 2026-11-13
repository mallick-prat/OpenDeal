import Link from "next/link";
import { ChevronLeft } from "@carbon/icons-react";
import { AppNav } from "@/components/AppNav";
import { redirect } from "next/navigation";
import { currentAppUser } from "@/lib/users";
import { listCandidateSummaries, openCandidateQueue } from "@/lib/candidates";
import { getInboundMailbox, inboundAddress } from "@/lib/inboundMailbox";
import { missingSlots, isOpen, type ParsedSummary } from "@/lib/candidatesPure";
import { CandidateQueue, type CandidateCard } from "@/components/CandidateQueue";
import { InboxPulse } from "@/components/InboxPulse";

export const maxDuration = 60;

/** The Review Queue: every inbound pitch, addressable and triageable. */
export default async function InboxPage({
  searchParams,
}: {
  searchParams: Promise<{ cleared?: string; handled?: string; source?: string }>;
}) {
  const member = await currentAppUser();
  if (!member) redirect("/login");
  // Triage is the investment team's desk; contributors work from the board.
  if (member.role === "user") redirect("/");

  const [rows, mailbox, queue, granola, { cleared, handled, source }] = await Promise.all([
    listCandidateSummaries(member.email, 200),
    getInboundMailbox(),
    openCandidateQueue(member.email),
    import("@/lib/meetingNotesView").then((m) => m.granolaInboxItems()).catch(() => []),
    searchParams,
  ]);

  // Desktop is a master-detail view that lives at /inbox/<id>; with anything
  // open, land there directly with the first pitch selected. A source filter
  // (the old /meetings deep link) shows the filtered list instead.
  if (queue.length > 0 && cleared !== "1" && handled !== "1" && !source) {
    redirect(`/inbox/${queue[0]}`);
  }

  const items: CandidateCard[] = rows.map((r) => {
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
      founders: r.founders || null,
      fromName: r.from_name,
      fromEmail: r.from_email,
      subject: r.subject,
      round: r.round,
      raiseAmount: r.raise_amount,
      deckCount: r.deck_count,
      attachmentCount: r.attachment_count,
      missing: missingSlots(parsedLite, r.deck_count + r.attachment_count > 0),
      promotedDealGid: r.promoted_deal_gid,
      source: "email" as const,
    };
  });

  // Granola notes ride the same queue: one triage surface, source labeled.
  const { granolaToCards } = await import("@/lib/meetingNotesView");
  const noteItems: CandidateCard[] = granolaToCards(granola);

  const merged = [...items, ...noteItems].sort((a, b) =>
    (b.receivedAt ?? "").localeCompare(a.receivedAt ?? "")
  );
  const visibleItems = source === "granola" ? merged.filter((i) => i.source === "granola") : merged;

  const openCount = visibleItems.filter((i) => isOpen(i.status) && i.status !== "snoozed").length;

  return (
    <div className="flex min-h-[100dvh]">
    <AppNav user={{ name: member.name, email: member.email, image: member.image }} role={member.role} />
    <main className="mx-auto w-full max-w-4xl px-6 py-16">
      {/* New pitches appear without a reload — the page watches the queue. */}
      <InboxPulse />
      <Link
        href="/"
        className="mb-6 inline-flex items-center gap-1 text-[14px] font-medium text-primary hover:text-primary-pressed"
      >
        <ChevronLeft size={16} aria-hidden /> Back to the dashboard
      </Link>
      <h1 className="text-[34px] font-light text-ink">Inbox</h1>
      {handled === "1" && (
        <p className="mt-3 text-[13px] text-sub" role="status">
          That one was already handled.
        </p>
      )}

      {cleared === "1" && queue.length === 0 && (
        <p className="mt-3 text-[13px] text-sub" role="status">
          No open pitches.
        </p>
      )}

      <section className="mt-6">
        <CandidateQueue items={visibleItems} viewerEmail={member.email} />
      </section>
      {mailbox === null && (
        <p className="mt-6 text-[12px] text-faint">
          {inboundAddress()
            ? `Pitches arrive via ${inboundAddress()}. That mailbox is not connected; an admin can connect it in Settings.`
            : "No inbound mailbox is set up yet. It is optional: an admin can add one in Settings."}
        </p>
      )}
    </main>
    </div>
  );
}
