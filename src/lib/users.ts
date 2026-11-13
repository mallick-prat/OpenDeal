import "server-only";
import { cache } from "react";
import { cookies } from "next/headers";
import { auth } from "@/auth";
import { sql } from "./db";
import { withRetry, withDeadline } from "./retry";

/**
 * ── Roles & permissions ──────────────────────────────────────────────────────
 *
 * super_admin ("Owner") — everything: manage users (add/remove/change roles), see the
 *               activity log, every deal. Cannot delete themselves, and
 *               the last super admin can never be removed or demoted.
 * admin ("Partner") — every deal and the inbox; can add users (as 'user' or 'admin', never
 *               'super_admin') and view the member list. No removals, no role
 *               changes, no activity log.
 * user ("Contributor") — sees only their own deals, no inbox triage: rows whose owner matches their
 *               owner_name, plus anything they created in the app. Deals they
 *               create are stamped with their name so they stay visible.
 *
 * `app_users` is the sign-in allowlist — removing someone blocks their next
 * sign-in AND (because every page/action re-reads this table) cuts off any
 * session that's still alive.
 * ────────────────────────────────────────────────────────────────────────────
 */

export type Role = "super_admin" | "admin" | "user";

export interface AppUser {
  email: string;
  name: string;
  role: Role;
  image: string | null;
  owner_name: string | null;
  invited_by: string | null;
  created_at: Date;
  last_login_at: Date | null;
}

export const ROLE_RANK: Record<Role, number> = {
  user: 0,
  admin: 1,
  super_admin: 2,
};

export async function getAppUser(email?: string | null): Promise<AppUser | null> {
  if (!email) return null;
  const rows = await withRetry(
    () => sql<AppUser[]>`
      select email, name, role, image, owner_name, invited_by, created_at, last_login_at
      from app_users where email = ${email.toLowerCase()}
    `
  );
  return rows[0] ?? null;
}

/**
 * The session user's app_users row, or null when signed out OR when their
 * access was removed after sign-in (stale session).
 */
/** View-as: the authoritative cookie (httpOnly) and the display marker. */
export const VIEW_AS_COOKIE = "od_viewas";
export const VIEW_AS_MARKER = "od_viewas_name";

/**
 * The signed-in human, ignoring any view-as cookie.
 *
 * Deduped per request: "who is calling" cannot change inside one request, and
 * every page, layout, generateMetadata and server action asked independently —
 * an `auth()` decode plus an `app_users` roundtrip each time.
 */
export const realAppUser = cache(async function realAppUser(): Promise<AppUser | null> {
  const session = await auth();
  return getAppUser(session?.user?.email);
});

/**
 * The acting user. A super admin carrying the view-as cookie acts AS that
 * member — reads and writes both — which is the whole point of "view as".
 * The privilege check runs on every request: the cookie is inert unless the
 * REAL session is a super admin, so it can't outlive a role change.
 */
export const currentAppUser = cache(async function currentAppUser(): Promise<AppUser | null> {
  const real = await realAppUser();
  if (!real || real.role !== "super_admin") return real;
  try {
    const jar = await cookies();
    const target = jar.get(VIEW_AS_COOKIE)?.value?.toLowerCase();
    if (!target || target === real.email) return real;
    const t = await getAppUser(target);
    return t ?? real;
  } catch {
    // No request scope (cron, background) — no cookie to honor.
    return real;
  }
});

/** Gate for server actions: current user at or above `min`, else null. */
export async function requireRole(min: Role): Promise<AppUser | null> {
  const user = await currentAppUser();
  if (!user || ROLE_RANK[user.role] < ROLE_RANK[min]) return null;
  return user;
}

export async function listAppUsers(): Promise<AppUser[]> {
  return withRetry(
    () => sql<AppUser[]>`
      select email, name, role, image, owner_name, invited_by, created_at, last_login_at
      from app_users
      order by case role when 'super_admin' then 0 when 'admin' then 1 else 2 end, name, email
    `
  );
}

/**
 * Append to the audit trail. Never throws — an audit failure must not break
 * the action being audited.
 */
export async function logActivity(
  actor: string,
  action: string,
  target = "",
  detail: Record<string, string | number | boolean | null> = {}
): Promise<void> {
  try {
    await withDeadline(
      sql`
        insert into activity_log (actor, action, target, detail)
        values (${actor}, ${action}, ${target}, ${sql.json(detail)})
      `,
      4_000
    );
  } catch {
    // swallow — a stuck audit write must not zombie a pooled connection
  }
}

export interface ActivityRow {
  id: number;
  actor: string;
  action: string;
  target: string;
  detail: Record<string, unknown>;
  created_at: Date;
}

export async function recentActivity(limit = 200): Promise<ActivityRow[]> {
  return sql<ActivityRow[]>`
    select id::int, actor, action, target, detail, created_at
    from activity_log
    order by created_at desc
    limit ${limit}
  `;
}

/** Record a successful sign-in: refresh profile fields + audit it. */
export async function touchLogin(
  email: string,
  name?: string | null,
  image?: string | null
): Promise<void> {
  try {
    await sql`
      update app_users set
        last_login_at = now(),
        name = case when ${name ?? ""} <> '' then ${name ?? ""} else name end,
        image = coalesce(${image ?? null}, image)
      where email = ${email.toLowerCase()}
    `;
    await logActivity(email.toLowerCase(), "signed_in");
  } catch {
    // non-fatal
  }
}
