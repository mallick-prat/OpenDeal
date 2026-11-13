import "server-only";
import { sql } from "./db";
import { isOpen } from "./candidatesPure";
import { granolaInboxItems, granolaToCards } from "./meetingNotesView";
import type { ProposedUpdate } from "./meetingNoteUpdates";
import type { NoteDetail } from "@/components/NoteTriage";

/** One Granola note as the triage card reads it. Null when it doesn't exist. */
export async function loadNoteDetail(id: string): Promise<NoteDetail | null> {
  const rows = await sql<
    {
      id: string;
      title: string | null;
      starts_at: Date | null;
      participants: { name?: string | null; email?: string | null }[] | null;
      matched_deal_gid: string | null;
      deal_name: string | null;
      match_state: string;
      review_state: string;
      match_confidence: number | null;
      match_evidence: { kind?: string; value?: string; via?: string } | null;
      proposed_updates: ProposedUpdate[] | null;
      summary_md: string | null;
      notes_md: string | null;
      note_url: string | null;
    }[]
  >`
    select n.id, n.title, n.starts_at, n.participants, n.matched_deal_gid,
           d.name as deal_name, n.match_state, n.review_state,
           n.match_confidence, n.match_evidence, n.proposed_updates,
           n.summary_md, n.notes_md, n.note_url
      from meeting_notes n
      left join deals d on d.gid = n.matched_deal_gid
     where n.id = ${id}`;
  const r = rows[0];
  if (!r) return null;
  return {
    id: r.id,
    title: r.title,
    startsAt: r.starts_at ? new Date(r.starts_at).toISOString() : null,
    participants: (r.participants ?? []).map((p) => ({
      name: p.name ?? null,
      email: p.email ?? null,
    })),
    dealGid: r.matched_deal_gid,
    dealName: r.deal_name,
    matchState: r.match_state,
    reviewState: r.review_state,
    confidence: r.match_confidence === null ? null : Number(r.match_confidence),
    evidence: r.match_evidence ?? null,
    updates: r.proposed_updates ?? [],
    summary: r.summary_md,
    notes: r.notes_md,
    noteUrl: r.note_url,
  };
}

/** The open Granola notes in rail order: the triage session's deck. */
export async function openNoteQueue(): Promise<string[]> {
  const items = await granolaInboxItems().catch(() => []);
  return granolaToCards(items)
    .filter((c) => isOpen(c.status) && c.status !== "snoozed")
    .map((c) => c.id);
}
