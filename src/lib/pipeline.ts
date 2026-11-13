import "server-only";
import type { Deal, DealOwner, PipelineData } from "./types";
import type { StageKey } from "./types";
import { sql, isoDate, type DealRow } from "./db";
import { withRetry } from "./retry";
import { fetchSections } from "./sections";
import { crm } from "@/config/crm.config";
import { noteExcerpt } from "./dealPresentation";
import { currentDecisionKeys } from "./decisions";
import { upcomingMeetingStarts } from "./meetings";
import { logEvent, timed } from "./log";

/**
 * Map a DB row to a Deal. Every field is null-safe: a single row with an
 * unexpected NULL (e.g. notes cleared mid-sync) must NEVER crash the whole
 * board render — that turned one bad row into "couldn't load the pipeline".
 */
function rowToDeal(r: DealRow, owners: DealOwner[]): Deal {
  return {
    gid: r.gid,
    name: r.name ?? "",
    note: noteExcerpt(r.notes),
    stage: (r.stage ?? "to-meet") as StageKey,
    schools: r.schools ?? [],
    owner: r.owner ?? "Unassigned",
    created: isoDate(r.created_on),
    modified: isoDate(r.modified_on),
    url: r.url ?? "",
    financing: r.financing_amount ?? null,
    round: r.round ?? null,
    attachmentCount: r.attachment_count ?? 0,
    offered: r.offered ?? false,
    createdBy: r.created_by ?? null,
    owners,
    visibility: r.visibility ?? "team",
  };
}

/**
 * The app's read path: the database is the source of truth. Stages come
 * from src/config/crm.config.ts.
 */
export async function fetchPipeline(): Promise<PipelineData> {
  // Each query gets its OWN retry wrapper: withRetry's deadline can then
  // cancel the underlying postgres.js query (a blanket Promise.all wrapper
  // has nothing to cancel, so an abandoned attempt lived on as a zombie
  // holding a pool connection).
  const [rows, ownerRows, sections, decisionByGid, meetingByGid] = await timed("pipeline", "fetchPipeline", () =>
    Promise.all([
      // Explicit columns with notes trimmed in SQL: the board only shows a
      // 180-char excerpt, and full notes total ~2MB across the table.
      withRetry(() => sql<DealRow[]>`
        select gid, coalesce(name, '') as name,
               coalesce(left(notes, 200), '') as notes,
               coalesce(stage, 'to-meet') as stage, section_gid,
               schools, coalesce(owner, 'Unassigned') as owner,
               created_on, modified_on, coalesce(url, '') as url,
               financing_amount, round, attachment_count, offered, created_by, visibility
        from deals order by created_on desc
      `),
      withRetry(() => sql<{ deal_gid: string; email: string; name: string; image: string | null }[]>`
        select o.deal_gid, u.email, u.name, u.image
        from deal_owners o
        join app_users u on u.email = o.email
        order by o.added_at
      `),
      fetchSections(),
      // These two ran AFTER the batch, adding two serial roundtrips to every
      // render of every tab. They depend on nothing above — parallelize.
      currentDecisionKeys(),
      upcomingMeetingStarts(),
    ])
  );

  const ownersByGid = new Map<string, DealOwner[]>();
  if (Array.isArray(ownerRows)) {
    for (const o of ownerRows) {
      const list = ownersByGid.get(o.deal_gid) ?? [];
      list.push({ email: o.email, name: o.name, image: o.image });
      ownersByGid.set(o.deal_gid, list);
    }
  }

  // rowToDeal is null-safe, but a genuinely corrupt row still shouldn't take
  // down the entire board: skip it (logged) so the other deals render.
  const deals: Deal[] = [];
  if (Array.isArray(rows)) {
    for (const r of rows) {
      try {
        deals.push(rowToDeal(r, ownersByGid.get(r.gid) ?? []));
      } catch (err) {
        logEvent("error", "pipeline", "skipped unrenderable deal row", {
          gid: r?.gid ?? "unknown",
          error: err instanceof Error ? err.message.slice(0, 120) : String(err),
        });
      }
    }
  }

  // Paint the team's current verdict on each deal (never blocks the board:
  // currentDecisionKeys swallows a missing table into an empty map).
  if (decisionByGid.size > 0) {
    for (const d of deals) d.decision = decisionByGid.get(d.gid) ?? null;
  }

  // Paint the next upcoming matched calendar meeting on each deal (never
  // blocks the board: upcomingMeetingStarts swallows a missing table into an
  // empty map).
  if (meetingByGid.size > 0) {
    for (const d of deals) d.nextMeetingAt = meetingByGid.get(d.gid) ?? null;
  }

  return {
    deals,
    fetchedAt: new Date().toISOString(),
    projectName: crm.pipelineName,
    sections,
  };
}
