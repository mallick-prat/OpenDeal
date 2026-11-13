import Link from "next/link";
import { redirect } from "next/navigation";
import { currentAppUser } from "@/lib/users";
import { sql } from "@/lib/db";
import { timed } from "@/lib/perf";
import { AppNav } from "@/components/AppNav";
import { NoteSession } from "@/components/NoteSession";
import { loadNoteDetail, openNoteQueue } from "@/lib/noteDetail";
import { CandidateQueue, type CandidateCard } from "@/components/CandidateQueue";
import { listCandidateSummaries } from "@/lib/candidates";
import { missingSlots } from "@/lib/candidatesPure";
import { granolaInboxItems, granolaToCards } from "@/lib/meetingNotesView";
import { listSchoolNames } from "@/lib/candidates";
import { fetchSections } from "@/lib/sections";

// Sixtyfour enrichment actions post back to this route — give them headroom.
export const maxDuration = 120;

/**
 * One Granola note, triage view: summary first, the original note collapsed
 * below, and context-aware actions. Lives under /inbox — meetings are an
 * information source here, not a product surface.
 */
export default async function NoteTriagePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const member = await currentAppUser();
  if (!member) redirect("/login");
  if (member.role === "user") redirect("/");
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) redirect("/inbox");

  const [note, queue, sectionRows, schoolNames, rail, granola] = await timed("page.inbox_note", () =>
    Promise.all([
      loadNoteDetail(id),
      openNoteQueue(),
      fetchSections(),
      listSchoolNames().catch(() => []),
      listCandidateSummaries(member.email, 200).catch(() => []),
      granolaInboxItems().catch(() => []),
    ])
  );
  if (!note) redirect("/inbox?handled=1");

  const railItems: CandidateCard[] = rail.map((r) => {
    const parsedLite = {
      companyName: r.company_name,
      raiseAmount: r.raise_amount,
      round: r.round,
      founders: r.founders ? [{ fullName: r.founders }] : [],
    };
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
  const merged = [...railItems, ...granolaToCards(granola)].sort((a, b) =>
    (b.receivedAt ?? "").localeCompare(a.receivedAt ?? "")
  );

  return (
    <div className="flex min-h-[100dvh]">
      <AppNav user={{ name: member.name, email: member.email, image: member.image }} role={member.role} />
      <div className="min-w-0 flex-1">
        <main className="mx-auto w-full max-w-[1440px] px-4 pb-24 pt-8 sm:px-6 lg:grid lg:grid-cols-[380px_minmax(0,1fr)] lg:items-start lg:gap-8">
          <div className="hidden max-h-[calc(100dvh-6rem)] overflow-y-auto lg:block">
            <CandidateQueue items={merged} viewerEmail={member.email} />
          </div>
          <div className="min-w-0">
            <Link
              href="/inbox?source=granola&handled=1"
              className="text-[13px] font-medium text-primary hover:text-primary-pressed lg:hidden"
            >
              ← Inbox
            </Link>
            <NoteSession
              initial={note}
              queue={queue}
              sections={sectionRows}
              schoolNames={schoolNames}
            />
          </div>
        </main>
      </div>
    </div>
  );
}
