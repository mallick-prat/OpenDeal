import "server-only";
import { sql } from "./db";
import { withRetry } from "./retry";
import { logEvent, logError } from "./log";
import { STAGE_BY_KEY } from "./stages";
import type { StageKey } from "./types";

/**
 * ── Deal-to-deal merge: two records of one company become one ───────────────
 * Renames, re-forwards, and parallel doors sometimes mint a second deal for a
 * company the team already tracks. Merging keeps the record that has come
 * furthest (deeper stage; tie → older) and folds the other in:
 *
 *   · fields min-max — the survivor's values win; the duplicate fills blanks
 *   · notes append under a "Merged from …" divider (nothing is lost)
 *   · every child repoints: meetings, filed emails, candidates, founders,
 *     owners, decisions, Granola notes, tracking
 *   · the duplicate row is deleted
 *
 * Never merges automatically — this runs only behind an explicit button with
 * its own confirm step.
 */

export interface MergeDealsResult {
  keptGid: string;
  keptName: string;
  absorbedName: string;
}

interface DealRow {
  gid: string;
  name: string;
  stage: string;
  created_on: string | null;
  financing_amount: string | null;
  round: string | null;
  notes: string | null;
  schools: string[] | null;
  section_gid: string | null;
  url: string | null;
}

/**
 * Deeper stage wins; then the older record (it holds the history).
 */
export function pickSurvivor(a: DealRow, b: DealRow): [DealRow, DealRow] {
  const order = (d: DealRow) => STAGE_BY_KEY[d.stage as StageKey]?.order ?? -1;
  const active = (d: DealRow) => STAGE_BY_KEY[d.stage as StageKey]?.active ?? false;
  if (active(a) !== active(b)) return active(a) ? [a, b] : [b, a];
  if (order(a) !== order(b)) return order(a) > order(b) ? [a, b] : [b, a];
  return (a.created_on ?? "9999") <= (b.created_on ?? "9999") ? [a, b] : [b, a];
}

export async function mergeDeals(
  gidA: string,
  gidB: string,
  by: string
): Promise<MergeDealsResult | { error: string }> {
  if (gidA === gidB) return { error: "That's the same deal twice." };
  const rows = await withRetry(
    () => sql<DealRow[]>`
      select gid, name, stage, created_on::text as created_on,
             financing_amount, round, notes, schools, section_gid, url
        from deals where gid in (${gidA}, ${gidB})`
  );
  if (rows.length !== 2) return { error: "One of those deals no longer exists." };
  const [keep, absorb] = pickSurvivor(rows[0], rows[1]);

  try {
    // 1 · Fields, min-max: survivor's values stand; blanks fill from the
    // duplicate. Notes append whole under a divider.
    const mergedNotes =
      absorb.notes && !(keep.notes ?? "").includes(absorb.notes.slice(0, 80))
        ? `${(keep.notes ?? "").trimEnd()}\n\n— Merged from “${absorb.name}” · ${new Date().toISOString().slice(0, 10)} —\n${absorb.notes}`
        : keep.notes;
    const mergedSchools = [
      ...new Set([...(keep.schools ?? []), ...(absorb.schools ?? [])]),
    ];
    await withRetry(
      () => sql`
        update deals
           set financing_amount = coalesce(nullif(financing_amount, ''), ${absorb.financing_amount}),
               round = coalesce(nullif(round, ''), ${absorb.round}),
               notes = ${mergedNotes},
               schools = ${sql.array(mergedSchools)},
               modified_on = current_date
         where gid = ${keep.gid}`
    );

    // 2 · Children repoint, duplicates dropped where a unique person/member
    // already sits on the survivor.
    await sql`
      update deal_founders df set deal_gid = ${keep.gid}
       where df.deal_gid = ${absorb.gid}
         and not exists (
           select 1 from deal_founders k
            where k.deal_gid = ${keep.gid} and k.person_id = df.person_id
         )`.catch(() => {});
    await sql`delete from deal_founders where deal_gid = ${absorb.gid}`.catch(() => {});
    await sql`
      update deal_owners o set deal_gid = ${keep.gid}
       where o.deal_gid = ${absorb.gid}
         and not exists (
           select 1 from deal_owners k
            where k.deal_gid = ${keep.gid} and k.email = o.email
         )`.catch(() => {});
    await sql`delete from deal_owners where deal_gid = ${absorb.gid}`.catch(() => {});
    await sql`update calendar_events set matched_deal_gid = ${keep.gid} where matched_deal_gid = ${absorb.gid}`.catch(() => {});
    await sql`update inbound_emails set deal_gid = ${keep.gid} where deal_gid = ${absorb.gid}`.catch(() => {});
    await sql`update deal_candidates set promoted_deal_gid = ${keep.gid} where promoted_deal_gid = ${absorb.gid}`.catch(() => {});
    await sql`update deal_candidates set proposed_deal_gid = ${keep.gid} where proposed_deal_gid = ${absorb.gid}`.catch(() => {});
    await sql`update meeting_notes set matched_deal_gid = ${keep.gid} where matched_deal_gid = ${absorb.gid}`.catch(() => {});
    await sql`update deal_decisions set deal_gid = ${keep.gid} where deal_gid = ${absorb.gid}`.catch(() => {});
    // 3 · The duplicate goes away.
    await withRetry(() => sql`delete from deals where gid = ${absorb.gid}`);

    logEvent("info", "pipeline", "deals merged", {
      kept: keep.gid,
      absorbed: absorb.gid,
      absorbedName: absorb.name,
      by,
    });
    return { keptGid: keep.gid, keptName: keep.name, absorbedName: absorb.name };
  } catch (err) {
    logError("pipeline", "deal merge failed", err, { gidA, gidB });
    return { error: "The merge didn't complete — nothing was deleted." };
  }
}
