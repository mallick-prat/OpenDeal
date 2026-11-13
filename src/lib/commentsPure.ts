/**
 * ── Deal comments: pure helpers ──────────────────────────────────────────────
 * Threading, delete permissions, and notification targeting — no I/O, so
 * they're unit-tested. The DB/email half lives in comments.ts.
 */

export interface FlatComment {
  id: string;
  deal_gid: string;
  parent_id: string | null;
  author_email: string;
  author_name: string;
  author_image: string | null;
  body: string;
  mentioned_emails: string[];
  created_at: string; // ISO
}

export interface ThreadComment extends FlatComment {
  replies: ThreadComment[];
}

/**
 * Nest a flat, chronologically-sorted list into one level of threads: top-level
 * comments (oldest first) each carrying their replies (oldest first). A reply
 * whose parent is missing (deleted) is promoted to top level so it never
 * vanishes silently.
 */
export function nestComments(flat: FlatComment[]): ThreadComment[] {
  const byId = new Map<string, ThreadComment>();
  for (const c of flat) byId.set(c.id, { ...c, replies: [] });

  const roots: ThreadComment[] = [];
  const sorted = [...byId.values()].sort((a, b) =>
    a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0
  );
  for (const c of sorted) {
    const parent = c.parent_id ? byId.get(c.parent_id) : null;
    if (parent) parent.replies.push(c);
    else roots.push(c);
  }
  return roots;
}

/** Total count including replies — for the section header. */
export function countComments(flat: FlatComment[]): number {
  return flat.length;
}

export type CommentActorRole = "super_admin" | "admin" | "user";

/** You may delete your own comment; admins may delete any. */
export function canDeleteComment(
  authorEmail: string,
  actor: { email: string; role: CommentActorRole }
): boolean {
  if (actor.role === "admin" || actor.role === "super_admin") return true;
  return authorEmail.toLowerCase() === actor.email.toLowerCase();
}

/**
 * Who to email about a new comment: the deal's owners plus (for a reply) the
 * parent comment's author, minus the person who wrote it, deduped and
 * lowercased. Never notifies the actor about their own comment.
 */
export function commentNotifyList(input: {
  ownerEmails: string[];
  parentAuthorEmail?: string | null;
  actorEmail: string;
}): string[] {
  const actor = input.actorEmail.toLowerCase();
  const set = new Set<string>();
  for (const e of input.ownerEmails) {
    const lower = (e ?? "").toLowerCase().trim();
    if (lower && lower !== actor) set.add(lower);
  }
  const parent = (input.parentAuthorEmail ?? "").toLowerCase().trim();
  if (parent && parent !== actor) set.add(parent);
  return [...set];
}

/** Trim + clamp a comment body; returns null if empty after trimming. */
export function normalizeCommentBody(raw: string): string | null {
  const body = raw.replace(/\r\n/g, "\n").trim();
  if (!body) return null;
  return body.slice(0, 5000);
}

/* ── Notifications ─────────────────────────────────────────────────────────── */

export type NotifType = "mention" | "reply" | "comment";
const NOTIF_RANK: Record<NotifType, number> = { mention: 3, reply: 2, comment: 1 };

/**
 * Who to notify about a new comment, and why. One row per person (the strongest
 * reason wins: an @mention outranks a reply outranks being an owner), never the
 * author, deduped + lowercased.
 */
export function notificationTargets(input: {
  ownerEmails: string[];
  parentAuthorEmail?: string | null;
  mentionEmails?: string[];
  actorEmail: string;
}): { email: string; type: NotifType }[] {
  const actor = input.actorEmail.toLowerCase().trim();
  const chosen = new Map<string, NotifType>();
  const add = (raw: string, type: NotifType) => {
    const email = (raw ?? "").toLowerCase().trim();
    if (!email || email === actor) return;
    const cur = chosen.get(email);
    if (!cur || NOTIF_RANK[type] > NOTIF_RANK[cur]) chosen.set(email, type);
  };
  for (const e of input.mentionEmails ?? []) add(e, "mention");
  if (input.parentAuthorEmail) add(input.parentAuthorEmail, "reply");
  for (const e of input.ownerEmails) add(e, "comment");
  return [...chosen.entries()].map(([email, type]) => ({ email, type }));
}
