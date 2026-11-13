import "server-only";
import { sql } from "./db";
import { timed } from "./perf";
import { sessionize, weeklyActivity, type WeekBucket } from "./memberStatsPure";
import type { StageKey } from "./types";

/**
 * ── Per-member analytics for the Settings members panel ─────────────────────
 * Everything derives from tables the app already writes:
 *   app_users       identity, invite chain, last sign-in
 *   activity_log    every recorded action since 2026-07-09 (sessions,
 *                   last-active, sign-ins, moves, triage)
 *   deals           created_by = submissions
 *   deal_owners     tagged ownership
 *   deal_comments                                           contributions
 *
 * "Hands-on time" is an estimate from recorded actions (page views aren't
 * logged); the UI labels it as such.
 */

export interface MemberStats {
  email: string;
  name: string;
  role: string;
  image: string | null;
  invitedBy: string | null;
  joinedAt: string | null;
  lastLoginAt: string | null;
  lastActiveAt: string | null;
  signIns: number;
  sessions: number;
  handsOnMinutes: number;
  activeDays: number;
  logSince: string; // when activity coverage begins
  weekly: WeekBucket[];
  counts: {
    dealsSubmitted: number;
    dealsOwned: number;
    dealMoves: number;
    triaged: number;
    boarded: number;
    comments: number;
  };
  recentDeals: { gid: string; name: string; stage: StageKey; created: string }[];
}

const LOG_SINCE = "1970-01-01";

export async function loadMemberStats(email: string): Promise<MemberStats | null> {
  return timed("settings.memberStats", async () => {
    const addr = email.trim().toLowerCase();
    const [users, events, dealsCreated, recent] = await Promise.all([
      sql<{
        email: string; name: string; role: string; image: string | null;
        invited_by: string | null; created_at: string | null; last_login_at: string | null;
      }[]>`
        select email, name, role, image, invited_by,
               created_at::text as created_at, last_login_at::text as last_login_at
          from app_users where email = ${addr}`,
      sql<{ action: string; at: string }[]>`
        select action, to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') at
          from activity_log where actor = ${addr}
         order by created_at asc limit 20000`,
      sql<{ n: number }[]>`select count(*)::int n from deals where created_by = ${addr}`,
      sql<{ gid: string; name: string; stage: string; created: string }[]>`
        select gid, name, stage, to_char(created_on, 'YYYY-MM-DD') created
          from deals where created_by = ${addr}
         order by created_on desc, name limit 5`,
    ]);
    const u = users[0];
    if (!u) return null;

    const [owned, comments] = await Promise.all([
      sql<{ n: number }[]>`select count(*)::int n from deal_owners where email = ${addr}`,
      sql<{ n: number }[]>`select count(*)::int n from deal_comments where author_email = ${addr}`,
    ]);

    const times = events.map((e) => e.at);
    const sess = sessionize(times);
    const actionCount = (name: string) => events.filter((e) => e.action === name).length;

    return {
      email: u.email,
      name: u.name,
      role: u.role,
      image: u.image,
      invitedBy: u.invited_by,
      joinedAt: u.created_at,
      lastLoginAt: u.last_login_at,
      lastActiveAt: sess.lastActive,
      signIns: actionCount("signed_in"),
      sessions: sess.sessions,
      handsOnMinutes: sess.totalMinutes,
      activeDays: sess.activeDays,
      logSince: LOG_SINCE,
      weekly: weeklyActivity(times, new Date().toISOString(), 8),
      counts: {
        dealsSubmitted: dealsCreated[0]?.n ?? 0,
        dealsOwned: owned[0]?.n ?? 0,
        dealMoves: actionCount("moved_deal"),
        triaged: actionCount("triaged_candidate"),
        boarded: actionCount("boarded_candidate"),
        comments: comments[0]?.n ?? 0,
      },
      recentDeals: recent.map((r) => ({ ...r, stage: r.stage as StageKey })),
    };
  }, { member: email });
}
