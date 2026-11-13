"use client";

import { Callout } from "./Callout";
import { useCallback, useEffect, useRef, useState } from "react";
import { TrashCan } from "@carbon/icons-react";
import {
  getDealComments,
  addDealCommentAction,
  deleteDealCommentAction,
} from "@/app/actions";
import { OwnerAvatar } from "./OwnerPicker";
import type { ThreadComment } from "@/lib/commentsPure";
import {
  activeMentionQuery,
  matchMembers,
  splitMentions,
  type MentionMember,
} from "@/lib/mentions";
import { etShortDate } from "@/lib/etDates";

interface Viewer {
  email: string;
  name: string;
  image: string | null;
  role: "super_admin" | "admin" | "user";
}

/** Body with any @Name (of a member the comment mentioned) highlighted. */
function CommentBody({
  body,
  mentionedEmails,
  members,
}: {
  body: string;
  mentionedEmails: string[];
  members: MentionMember[];
}) {
  const names = mentionedEmails
    .map((e) => members.find((m) => m.email.toLowerCase() === e.toLowerCase())?.name)
    .filter((n): n is string => !!n);
  const parts = splitMentions(body, names);
  return (
    <p className="mt-0.5 whitespace-pre-wrap break-words text-[13px] leading-relaxed text-body">
      {parts.map((p, i) =>
        p.mention ? (
          <span key={i} className="font-semibold text-primary">
            {p.text}
          </span>
        ) : (
          <span key={i}>{p.text}</span>
        )
      )}
    </p>
  );
}

/** "just now" / "5m" / "3h" / "2d" / "Mar 4" for the comment timestamp. */
function timeAgo(iso: string): string {
  const then = new Date(iso).getTime();
  const secs = Math.max(0, (Date.now() - then) / 1000);
  if (secs < 45) return "just now";
  if (secs < 3600) return `${Math.round(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.round(secs / 3600)}h ago`;
  if (secs < 7 * 86400) return `${Math.round(secs / 86400)}d ago`;
  return etShortDate(iso);
}

function canDelete(authorEmail: string, viewer: Viewer): boolean {
  if (viewer.role === "admin" || viewer.role === "super_admin") return true;
  return authorEmail.toLowerCase() === viewer.email.toLowerCase();
}

export function DealComments({
  gid,
  viewer,
  members = [],
}: {
  gid: string;
  viewer: Viewer;
  members?: MentionMember[];
}) {
  const [comments, setComments] = useState<ThreadComment[] | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    const res = await getDealComments(gid);
    if (res.ok) setComments(res.comments);
    else setError(res.error);
  }, [gid]);

  // Initial fetch on open (and when switching to another deal). The guard drops
  // a late response after the deal changed or the modal closed.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await getDealComments(gid);
      if (cancelled) return;
      if (res.ok) setComments(res.comments);
      else setError(res.error);
    })();
    return () => {
      cancelled = true;
    };
  }, [gid]);

  // Arriving from a notification deep-link (…/deals/<gid>#comment-<id>): once
  // the thread is loaded, bring that comment into view and flash it.
  const scrolledHashRef = useRef("");
  useEffect(() => {
    if (!comments) return;
    const hash = window.location.hash;
    if (!hash.startsWith("#comment-") || scrolledHashRef.current === hash) return;
    const el = document.getElementById(hash.slice(1));
    if (!el) return;
    scrolledHashRef.current = hash;
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    el.classList.add("comment-flash");
    const t = setTimeout(() => el.classList.remove("comment-flash"), 2200);
    return () => clearTimeout(t);
  }, [comments]);

  const total = comments
    ? comments.reduce((n, c) => n + 1 + c.replies.length, 0)
    : 0;

  return (
    <div>
      <span className="mb-2 block text-[12px] font-semibold text-sub">
        Comments{comments ? ` (${total})` : ""}
      </span>

      {error && <Callout tone="error" className="mb-3 p-3 text-[13px]">{error}</Callout>}

      {comments === null ? (
        <p role="status" aria-live="polite" className="py-2 text-[13px] text-faint">
          Loading comments…
        </p>
      ) : comments.length === 0 ? (
        <p className="py-1 text-[13px] text-faint">
          No comments yet. Start the conversation.
        </p>
      ) : (
        <ul className="flex flex-col gap-4">
          {comments.map((c) => (
            <li key={c.id}>
              <CommentItem
                comment={c}
                viewer={viewer}
                gid={gid}
                members={members}
                onChanged={load}
                onError={setError}
              />
              {c.replies.length > 0 && (
                <ul className="mt-3 flex flex-col gap-3 border-l border-line pl-4 sm:ml-4">
                  {c.replies.map((r) => (
                    <li key={r.id}>
                      <CommentItem
                        comment={r}
                        viewer={viewer}
                        gid={gid}
                        members={members}
                        isReply
                        onChanged={load}
                        onError={setError}
                      />
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}

      <div className="mt-4">
        <Composer
          gid={gid}
          viewer={viewer}
          members={members}
          onPosted={load}
          onError={setError}
          placeholder="Add a comment…"
        />
      </div>
    </div>
  );
}

function CommentItem({
  comment,
  viewer,
  gid,
  members,
  isReply = false,
  onChanged,
  onError,
}: {
  comment: ThreadComment;
  viewer: Viewer;
  gid: string;
  members: MentionMember[];
  isReply?: boolean;
  onChanged: () => void | Promise<void>;
  onError: (e: string) => void;
}) {
  const [replying, setReplying] = useState(false);
  const [busy, setBusy] = useState(false);
  const size = isReply ? 26 : 32;

  const remove = async () => {
    setBusy(true);
    const res = await deleteDealCommentAction(comment.id);
    setBusy(false);
    if (!res.ok) onError(res.error ?? "Couldn't delete.");
    else onChanged();
  };

  return (
    <div id={`comment-${comment.id}`} className="flex scroll-mt-24 gap-3">
      <OwnerAvatar
        owner={{ name: comment.author_name, email: comment.author_email, image: comment.author_image }}
        size={size}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="truncate text-[13px] font-semibold text-ink">
            {comment.author_name}
          </span>
          <span className="shrink-0 text-[11px] text-faint">
            {timeAgo(comment.created_at)}
          </span>
          {canDelete(comment.author_email, viewer) && (
            <button
              className="tap ml-auto flex shrink-0 items-center justify-center p-0.5 text-faint transition-colors hover:text-primary disabled:opacity-50"
              title="Delete comment"
              aria-label="Delete comment"
              onClick={remove}
              disabled={busy}
            >
              <TrashCan size={14} />
            </button>
          )}
        </div>
        <CommentBody
          body={comment.body}
          mentionedEmails={comment.mentioned_emails}
          members={members}
        />
        {!isReply && (
          <button
            className="mt-1 text-[12px] font-medium text-sub transition-colors hover:text-primary"
            onClick={() => setReplying((v) => !v)}
          >
            {replying ? "Cancel" : "Reply"}
          </button>
        )}
        {replying && (
          <div className="mt-2">
            <Composer
              gid={gid}
              viewer={viewer}
              members={members}
              parentId={comment.id}
              autoFocus
              compact
              placeholder={`Reply to ${comment.author_name.split(" ")[0]}…`}
              onPosted={async () => {
                setReplying(false);
                await onChanged();
              }}
              onError={onError}
            />
          </div>
        )}
      </div>
    </div>
  );
}

function Composer({
  gid,
  viewer,
  members,
  parentId,
  placeholder,
  autoFocus = false,
  compact = false,
  onPosted,
  onError,
}: {
  gid: string;
  viewer: Viewer;
  members: MentionMember[];
  parentId?: string;
  placeholder: string;
  autoFocus?: boolean;
  compact?: boolean;
  onPosted: () => void | Promise<void>;
  onError: (e: string) => void;
}) {
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  // Members the writer has picked from the @-menu; the server re-checks each
  // still appears as @Name before notifying, so removing text un-mentions them.
  const [picked, setPicked] = useState<Map<string, string>>(new Map());
  const [menu, setMenu] = useState<{ matches: MentionMember[]; active: number } | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);

  const refreshMenu = (value: string, caret: number) => {
    const q = activeMentionQuery(value, caret);
    if (q === null || members.length === 0) {
      setMenu(null);
      return;
    }
    const matches = matchMembers(members, q);
    setMenu(matches.length ? { matches, active: 0 } : null);
  };

  const onChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setBody(e.target.value);
    refreshMenu(e.target.value, e.target.selectionStart ?? e.target.value.length);
  };

  // Replace the in-progress @query with @Full Name and record the pick.
  const choose = (m: MentionMember) => {
    const el = ref.current;
    const caret = el?.selectionStart ?? body.length;
    const before = body.slice(0, caret);
    const at = before.lastIndexOf("@");
    if (at < 0) return;
    const insert = `@${m.name} `;
    const next = body.slice(0, at) + insert + body.slice(caret);
    setBody(next);
    setPicked((p) => new Map(p).set(m.email.toLowerCase(), m.name));
    setMenu(null);
    requestAnimationFrame(() => {
      const pos = at + insert.length;
      el?.focus();
      el?.setSelectionRange(pos, pos);
    });
  };

  const submit = async () => {
    const text = body.trim();
    if (!text || busy) return;
    const mentions = [...picked.keys()];
    setBusy(true);
    const res = await addDealCommentAction(gid, text, parentId ?? null, mentions);
    setBusy(false);
    if (!res.ok) {
      onError(res.error ?? "Couldn't post the comment.");
      return;
    }
    setBody("");
    setPicked(new Map());
    setMenu(null);
    await onPosted();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (menu) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setMenu((s) => (s ? { ...s, active: (s.active + 1) % s.matches.length } : s));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setMenu((s) => (s ? { ...s, active: (s.active - 1 + s.matches.length) % s.matches.length } : s));
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        choose(menu.matches[menu.active]);
        return;
      }
      if (e.key === "Escape") {
        setMenu(null);
        return;
      }
    }
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      void submit();
    }
  };

  return (
    <div className="flex items-start gap-3">
      {!compact && <OwnerAvatar owner={viewer} size={32} />}
      <div className="relative flex min-w-0 flex-1 items-end gap-2">
        <div className="relative min-w-0 flex-1">
          <textarea
            ref={ref}
            className="field w-full resize-y py-2 leading-relaxed"
            rows={compact ? 2 : 3}
            placeholder={placeholder}
            value={body}
            onChange={onChange}
            onKeyDown={onKeyDown}
            onBlur={() => setTimeout(() => setMenu(null), 120)}
          />
          {menu && (
            <ul className="absolute bottom-full left-0 z-40 mb-1 max-h-56 w-64 overflow-y-auto rounded-lg border border-line bg-bg py-1 shadow-lg">
              {menu.matches.map((m, i) => (
                <li key={m.email}>
                  <button
                    type="button"
                    // onMouseDown (not click) so it fires before textarea blur.
                    onMouseDown={(e) => {
                      e.preventDefault();
                      choose(m);
                    }}
                    className={`flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] ${
                      i === menu.active ? "bg-bg-soft" : ""
                    }`}
                  >
                    <OwnerAvatar owner={m} size={22} />
                    <span className="truncate text-ink">{m.name}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <button
          className="btn-primary shrink-0 !text-[13px]"
          onClick={submit}
          disabled={busy || !body.trim()}
          title="⌘↵ to send · @ to mention"
        >
          {busy ? "Posting…" : parentId ? "Reply" : "Comment"}
        </button>
      </div>
    </div>
  );
}
