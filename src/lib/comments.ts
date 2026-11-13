import "server-only";
import { after } from "next/server";
import { sql } from "./db";
import { appUrl, crm, emailFrom } from "@/config/crm.config";
import { logError, logEvent } from "./log";
import { logActivity } from "./users";
import {
  nestComments,
  canDeleteComment,
  notificationTargets,
  normalizeCommentBody,
  type FlatComment,
  type ThreadComment,
  type CommentActorRole,
} from "./commentsPure";
import { createNotifications } from "./notifications";

/**
 * ── Deal comments ────────────────────────────────────────────────────────────
 * Any member can comment on any deal; a new comment emails the deal's owners
 * (and, for a reply, the parent author) — never the person who wrote it. One
 * level of replies. Authors delete their own; admins delete any.
 */


let schemaReady = false;
export async function ensureCommentsSchema(): Promise<void> {
  if (schemaReady) return;
  // FK to deals(gid) with ON UPDATE CASCADE so comments follow a deal if its
  // gid ever changes, and ON DELETE CASCADE so every
  // deal-deletion path clears them for free.
  await sql`
    create table if not exists deal_comments (
      id uuid primary key default gen_random_uuid(),
      deal_gid text not null references deals(gid) on update cascade on delete cascade,
      parent_id uuid references deal_comments(id) on delete cascade,
      author_email text not null,
      author_name text not null,
      author_image text,
      body text not null,
      created_at timestamptz not null default now()
    )
  `;
  await sql`
    alter table deal_comments
      add column if not exists mentioned_emails text[] not null default '{}'
  `;
  await sql`
    create index if not exists deal_comments_deal_idx
      on deal_comments (deal_gid, created_at)
  `;
  schemaReady = true;
}

interface CommentRow {
  id: string;
  deal_gid: string;
  parent_id: string | null;
  author_email: string;
  author_name: string;
  author_image: string | null;
  body: string;
  mentioned_emails: string[];
  created_at: Date;
}

function toFlat(r: CommentRow): FlatComment {
  return {
    id: r.id,
    deal_gid: r.deal_gid,
    parent_id: r.parent_id,
    author_email: r.author_email,
    author_name: r.author_name,
    author_image: r.author_image,
    body: r.body,
    mentioned_emails: r.mentioned_emails ?? [],
    created_at: r.created_at.toISOString(),
  };
}

/** Threaded comments for a deal, with author name/image refreshed from app_users. */
export async function listDealComments(gid: string): Promise<ThreadComment[]> {
  await ensureCommentsSchema();
  const rows = await sql<CommentRow[]>`
    select c.id, c.deal_gid, c.parent_id, c.author_email,
           coalesce(u.name, c.author_name) as author_name,
           coalesce(u.image, c.author_image) as author_image,
           c.body, c.mentioned_emails, c.created_at
    from deal_comments c
    left join app_users u on lower(u.email) = lower(c.author_email)
    where c.deal_gid = ${gid}
    order by c.created_at asc
  `;
  return nestComments(rows.map(toFlat));
}

export interface CommentAuthor {
  email: string;
  name: string;
  image: string | null;
}

/** Add a comment (or a reply when parentId is set). Notifies in the background. */
export async function addDealComment(
  gid: string,
  author: CommentAuthor,
  rawBody: string,
  parentId?: string | null,
  mentions?: string[]
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  await ensureCommentsSchema();
  const body = normalizeCommentBody(rawBody);
  if (!body) return { ok: false, error: "Write something first." };

  const deal = await sql<{ name: string }[]>`select name from deals where gid = ${gid}`;
  if (deal.length === 0) return { ok: false, error: "That deal no longer exists." };

  // A reply must point at a real comment on THIS deal.
  let parentAuthorEmail: string | null = null;
  let parent: string | null = null;
  if (parentId) {
    const p = await sql<{ author_email: string }[]>`
      select author_email from deal_comments where id = ${parentId} and deal_gid = ${gid}
    `;
    if (p.length === 0) return { ok: false, error: "That comment is gone." };
    parent = parentId;
    parentAuthorEmail = p[0].author_email;
  }

  // Only mentions that are real members AND whose @Name still appears in the
  // body count — so an edited-away mention doesn't ping anyone.
  const mentionEmails = await resolveMentions(mentions ?? [], body);

  const inserted = await sql<{ id: string }[]>`
    insert into deal_comments
      (deal_gid, parent_id, author_email, author_name, author_image, body, mentioned_emails)
    values (${gid}, ${parent}, ${author.email.toLowerCase()}, ${author.name || author.email},
            ${author.image}, ${body}, ${mentionEmails})
    returning id
  `;
  const id = inserted[0].id;
  logEvent("info", "comments", "comment added", {
    gid,
    by: author.email,
    reply: !!parent,
    mentions: mentionEmails.length,
  });
  // Surface comments on the deal's activity timeline too.
  void logActivity(author.email, "commented", gid, {});

  after(async () => {
    try {
      await fanOutCommentActivity({
        gid,
        dealName: deal[0].name,
        author,
        body,
        parentAuthorEmail,
        mentionEmails,
        commentId: id,
      });
    } catch (err) {
      logError("comments", "notify failed", err, { gid });
    }
  });

  return { ok: true, id };
}

/** Keep only mentions that are members and still referenced by @name in the body. */
async function resolveMentions(mentions: string[], body: string): Promise<string[]> {
  const wanted = [...new Set(mentions.map((m) => m.toLowerCase().trim()).filter(Boolean))];
  if (wanted.length === 0) return [];
  const members = await sql<{ email: string; name: string }[]>`
    select email, name from app_users where lower(email) = any(${wanted})
  `;
  const lowerBody = body.toLowerCase();
  return members
    .filter((m) => m.name && lowerBody.includes(`@${m.name.toLowerCase()}`))
    .map((m) => m.email.toLowerCase());
}

/** Delete a comment (and its replies, via ON DELETE CASCADE). */
export async function deleteDealComment(
  id: string,
  actor: { email: string; role: CommentActorRole }
): Promise<{ ok: true } | { ok: false; error: string }> {
  await ensureCommentsSchema();
  const rows = await sql<{ author_email: string }[]>`
    select author_email from deal_comments where id = ${id}
  `;
  if (rows.length === 0) return { ok: true }; // already gone
  if (!canDeleteComment(rows[0].author_email, actor)) {
    return { ok: false, error: "You can only delete your own comments." };
  }
  await sql`delete from deal_comments where id = ${id}`;
  await sql`delete from notifications where comment_id = ${id}`.catch(() => {});
  logEvent("info", "comments", "comment deleted", { id, by: actor.email });
  return { ok: true };
}

async function fanOutCommentActivity(input: {
  gid: string;
  dealName: string;
  author: CommentAuthor;
  body: string;
  parentAuthorEmail: string | null;
  mentionEmails: string[];
  commentId: string;
}): Promise<void> {
  const owners = await sql<{ email: string }[]>`
    select email from deal_owners where deal_gid = ${input.gid}
  `;
  const targets = notificationTargets({
    ownerEmails: owners.map((o) => o.email),
    parentAuthorEmail: input.parentAuthorEmail,
    mentionEmails: input.mentionEmails,
    actorEmail: input.author.email,
  });
  if (targets.length === 0) return;

  // 1) In-app notifications for everyone who should hear about this.
  await createNotifications(
    targets.map((t) => ({
      recipientEmail: t.email,
      type: t.type,
      dealGid: input.gid,
      dealName: input.dealName,
      actorEmail: input.author.email,
      actorName: input.author.name,
      actorImage: input.author.image,
      commentId: input.commentId,
      excerpt: input.body,
    }))
  ).catch((err) => logError("comments", "notification insert failed", err, { gid: input.gid }));

  // 2) Email as well, so it reaches people who aren't in the app right now.
  const recipients = targets.map((t) => t.email);
  if (!process.env.RESEND_API_KEY) {
    logEvent("info", "comments", "email skipped (no RESEND_API_KEY)", { recipients: recipients.length });
    return;
  }

  const safe = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  // Deep-link straight to the deal (and the comment), not the whole board.
  const link = `${appUrl()}/deals/${encodeURIComponent(input.gid)}#comment-${input.commentId}`;
  const html = `
    <div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:520px;color:#1a1a1a">
      <p style="margin:0 0 12px;font-size:15px">
        <strong>${safe(input.author.name)}</strong> commented on
        <strong>${safe(input.dealName)}</strong>:
      </p>
      <blockquote style="margin:0 0 16px;padding:10px 14px;border-left:3px solid ${crm.brand.primary};background:#faf5f5;font-size:14px;white-space:pre-wrap">${safe(input.body)}</blockquote>
      <a href="${link}" style="display:inline-block;padding:9px 16px;background:${crm.brand.primary};color:#fff;text-decoration:none;border-radius:6px;font-size:14px;font-weight:600">View the deal</a>
    </div>`;

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: emailFrom(),
      to: recipients,
      subject: `New comment on ${input.dealName}`,
      html,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    throw new Error(`Resend ${res.status}: ${(await res.text()).slice(0, 150)}`);
  }
  logEvent("info", "comments", "comment notification sent", {
    gid: input.gid,
    recipients: recipients.length,
  });
}
