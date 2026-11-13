import "server-only";
import { sql } from "./db";
import { withRetry } from "./retry";
import type { NotifType } from "./commentsPure";

/**
 * ── In-app notifications ─────────────────────────────────────────────────────
 * Comment activity (a comment on a deal you own, a reply to you, or an @mention)
 * drops a row here; the bell shows the unread count and the recent list. FK to
 * deals(gid) cascades so a deleted deal clears its notifications.
 */

let schemaReady = false;
export async function ensureNotificationsSchema(): Promise<void> {
  if (schemaReady) return;
  await sql`
    create table if not exists notifications (
      id uuid primary key default gen_random_uuid(),
      recipient_email text not null,
      type text not null,
      deal_gid text references deals(gid) on update cascade on delete cascade,
      deal_name text,
      actor_email text,
      actor_name text,
      actor_image text,
      comment_id uuid,
      excerpt text,
      read_at timestamptz,
      created_at timestamptz not null default now()
    )
  `;
  await sql`
    create index if not exists notifications_recipient_idx
      on notifications (recipient_email, created_at desc)
  `;
  schemaReady = true;
}

export interface NotificationRow {
  id: string;
  type: NotifType;
  deal_gid: string | null;
  deal_name: string | null;
  actor_email: string | null;
  actor_name: string | null;
  actor_image: string | null;
  excerpt: string | null;
  read_at: Date | null;
  created_at: Date;
}

export interface NewNotification {
  recipientEmail: string;
  type: NotifType;
  dealGid: string;
  dealName: string;
  actorEmail: string;
  actorName: string;
  actorImage: string | null;
  commentId: string;
  excerpt: string;
}

/** Bulk-insert notifications (one per recipient). Never throws to its caller. */
export async function createNotifications(items: NewNotification[]): Promise<void> {
  if (items.length === 0) return;
  await ensureNotificationsSchema();
  const rows = items.map((n) => ({
    recipient_email: n.recipientEmail.toLowerCase(),
    type: n.type,
    deal_gid: n.dealGid,
    deal_name: n.dealName.slice(0, 300),
    actor_email: n.actorEmail.toLowerCase(),
    actor_name: n.actorName.slice(0, 200),
    actor_image: n.actorImage,
    comment_id: n.commentId,
    excerpt: n.excerpt.replace(/\s+/g, " ").trim().slice(0, 200),
  }));
  await sql`insert into notifications ${sql(
    rows,
    "recipient_email",
    "type",
    "deal_gid",
    "deal_name",
    "actor_email",
    "actor_name",
    "actor_image",
    "comment_id",
    "excerpt"
  )}`;
}

export async function listNotifications(
  email: string,
  limit = 30
): Promise<NotificationRow[]> {
  await ensureNotificationsSchema();
  return withRetry(
    () => sql<NotificationRow[]>`
      select id, type, deal_gid, deal_name, actor_email, actor_name, actor_image,
             excerpt, read_at, created_at
      from notifications
      where recipient_email = ${email.toLowerCase()}
      order by created_at desc
      limit ${limit}
    `
  );
}

export async function unreadNotificationCount(email: string): Promise<number> {
  await ensureNotificationsSchema();
  const rows = await withRetry(
    () => sql<{ n: number }[]>`
      select count(*)::int as n from notifications
      where recipient_email = ${email.toLowerCase()} and read_at is null
    `
  );
  return rows[0]?.n ?? 0;
}

/** Mark some (or, with no ids, all) of a member's notifications read. */
export async function markNotificationsRead(
  email: string,
  ids?: string[]
): Promise<void> {
  await ensureNotificationsSchema();
  if (ids && ids.length === 0) return;
  if (ids) {
    await sql`
      update notifications set read_at = now()
      where recipient_email = ${email.toLowerCase()} and read_at is null
        and id = any(${ids})
    `;
  } else {
    await sql`
      update notifications set read_at = now()
      where recipient_email = ${email.toLowerCase()} and read_at is null
    `;
  }
}
