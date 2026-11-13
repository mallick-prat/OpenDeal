import { NextResponse } from "next/server";
import { currentAppUser } from "@/lib/users";
import { listCandidateSummaries } from "@/lib/candidates";
import { meetingsForTriage } from "@/lib/calendarEnrich";
import { notesForReview } from "@/lib/meetingNotesView";
import { isOpen } from "@/lib/candidatesPure";
import { sql } from "@/lib/db";
import { logError } from "@/lib/log";
import { record } from "@/lib/perf";
import { STAGE_BY_KEY } from "@/lib/stages";
import type { StageKey } from "@/lib/types";

const stageLabel = (key: string) =>
  STAGE_BY_KEY[key as StageKey]?.label ?? (key || "a new stage");

// A stalled pool retries for ~22s; the platform default (15s) would 504
// first. Explicit ceiling so retries get to finish.
export const maxDuration = 30;

/**
 * The Home cockpit's data: the open inbox queue and the personal meeting
 * strip, in one round trip. Fetched lazily when the Home tab renders — the
 * dashboard's main payload stays untouched, and tabs that never show Home
 * never pay for this.
 */
export async function GET() {
  const member = await currentAppUser();
  if (!member) return NextResponse.json({ ok: false }, { status: 401 });
  const t0 = performance.now();
  try {
    // 200, not 60: the list mixes all statuses newest-first, and an actively
    // triaged inbox needs that much headroom to actually surface 40 open rows.
    // Summaries, not full rows — this route renders six scalar fields.
    const [rows, meetings, granola, changes] = await Promise.all([
      listCandidateSummaries(member.email, 200),
      meetingsForTriage(member.email, 14, 14).catch(() => []),
      notesForReview(6).catch(() => []),
      recentChanges().catch(() => []),
    ]);

    const queue = rows
      .filter((r) => isOpen(r.status) && r.status !== "snoozed")
      .slice(0, 40)
      .map((r) => ({
        id: r.id,
        company: r.company_name,
        subject: r.subject,
        fromName: r.from_name,
        status: r.status,
        confidence: r.confidence === null ? null : Number(r.confidence),
        receivedAt: r.received_at ? new Date(r.received_at).toISOString() : null,
      }));

    const ms = performance.now() - t0;
    record("api.cockpit", ms, { queue: queue.length, meetings: meetings.length });
    const res = NextResponse.json({
      ok: true,
      granola: granola.map((g) => ({
        id: g.id,
        title: g.title,
        dealGid: g.dealGid,
        dealName: g.dealName,
        count: g.updates.length,
        state: g.state,
      })),
      changes,
      queue,
      meetings: meetings
        .map((m) => ({
        id: m.id,
        title: m.title,
        startsAt: m.startsAt,
        upcoming: m.upcoming,
        companies: m.companies
          .filter((c) => !m.dismissed.includes(c.domain))
          .map((c) => ({
            domain: c.domain,
            investor: c.investor,
            dealGid: c.dealGid,
            dealName: c.dealName,
            candidateId: c.candidateId ?? null,
          })),
        }))
        // Home previews DEAL meetings; loose social invites stay on /meetings.
        .filter((m) => m.companies.length > 0)
        .slice(0, 30),
    });
    res.headers.set("Server-Timing", `app;dur=${Math.round(ms)}`);
    return res;
  } catch (err) {
    logError("pipeline", "home cockpit failed", err);
    return NextResponse.json({ ok: false }, { status: 500 });
  }
}

/**
 * The last few system-visible changes as linkable sentences. Deal names come
 * from the live row when the gid still resolves, else from the logged detail
 * (deal ids can change on merge, so the log's gid can go
 * stale); the link re-resolves by name in that case.
 */
async function recentChanges(): Promise<
  { dealGid: string | null; dealName: string | null; rest: string; at: string }[]
> {
  const rows = await sql<
    { actor: string; action: string; target: string; detail: Record<string, unknown>; created_at: Date }[]
  >`
    select actor, action, target, coalesce(detail, '{}'::jsonb) as detail, created_at
      from activity_log
     where action in ('boarded_candidate', 'granola_applied', 'granola_attached', 'moved_deal', 'set_decision', 'created_deal')
     order by created_at desc
     limit 10
  `;
  const gids = [...new Set(rows.map((r) => r.target).filter(Boolean))];
  const loggedNames = [
    ...new Set(rows.map((r) => String(r.detail.name ?? "")).filter(Boolean)),
  ];
  const found =
    gids.length > 0 || loggedNames.length > 0
      ? await sql<{ gid: string; name: string }[]>`
          select gid, name from deals
           where gid = any(${gids}) or name = any(${loggedNames})`
      : [];
  const byGid = new Map(found.map((d) => [d.gid, d]));
  const byName = new Map(found.map((d) => [d.name, d]));
  const who = (email: string) => email.split("@")[0];

  return rows.map((r) => {
    const deal =
      byGid.get(r.target) ??
      (r.detail.name ? byName.get(String(r.detail.name)) : undefined) ??
      null;
    const fullName = deal?.name ?? (r.detail.name ? String(r.detail.name) : null);
    const dealName = fullName ? (fullName.split("//").pop()?.trim() ?? fullName) : null;
    const rest =
      r.action === "boarded_candidate"
        ? `added to the pipeline by ${who(r.actor)}`
        : r.action === "granola_applied"
          ? `updated from Granola (${Number(r.detail.applied ?? 0) || "some"} change${Number(r.detail.applied) === 1 ? "" : "s"})`
          : r.action === "granola_attached"
            ? `got its Granola note attached by ${who(r.actor)}`
            : r.action === "moved_deal"
              ? `moved to ${stageLabel(String(r.detail.to ?? ""))} by ${who(r.actor)}`
              : r.action === "set_decision"
                ? `decision set to ${String(r.detail.decision ?? "…")} by ${who(r.actor)}`
                : `created by ${who(r.actor)}`;
    return {
      dealGid: deal?.gid ?? null,
      dealName,
      rest,
      at: r.created_at.toISOString(),
    };
  });
}
