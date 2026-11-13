"use client";

import { crm } from "@/config/crm.config";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Checkmark, Close, Copy, Email, TrashCan, UserFollow, View } from "@carbon/icons-react";
import {
  addUser,
  createMagicLink,
  emailSignInLink,
  removeUser,
  setUserRole,
  getMemberStatsAction,
  startViewAsAction,
} from "@/app/actions";
import type { MemberStats } from "@/lib/memberStats";
import { fmtMinutes } from "@/lib/memberStatsPure";
import { etShortDate, etShortDateTime } from "@/lib/etDates";
import { Avatar } from "./Sidebar";

type Role = "super_admin" | "admin" | "user";

export interface MemberView {
  email: string;
  name: string;
  role: Role;
  image: string | null;
  owner_name: string | null;
  last_login_at: string | null;
}

const ROLE_LABEL: Record<Role, string> = {
  super_admin: "Owner",
  admin: "Partner",
  user: "Contributor",
};

const ROLE_BADGE: Record<Role, string> = {
  super_admin: "bg-primary text-white",
  admin: "bg-red-50 text-primary-pressed",
  user: "bg-bg-soft text-body",
};

function RoleBadge({ role }: { role: Role }) {
  return (
    <span
      className={`px-2 py-0.5 text-[11px] font-semibold ${ROLE_BADGE[role]}`}
    >
      {ROLE_LABEL[role]}
    </span>
  );
}

export function MembersAdmin({
  members,
  viewerEmail,
  viewerRole,
}: {
  members: MemberView[];
  viewerEmail: string;
  viewerRole: Role;
}) {
  const router = useRouter();
  const isSuper = viewerRole === "super_admin";
  const [flash, setFlash] = useState("");
  const [adding, setAdding] = useState(false);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState<Role>("admin");
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [sortK, setSortK] = useState<"name" | "role" | "login">("role");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [page, setPage] = useState(0);
  const [openMember, setOpenMember] = useState<MemberView | null>(null);

  const ROLE_RANKING: Record<Role, number> = { super_admin: 0, admin: 1, user: 2 };
  const sorted = useMemo(() => {
    const list = [...members];
    const sign = sortDir === "asc" ? 1 : -1;
    list.sort((a, b) => {
      let base: number;
      switch (sortK) {
        case "name":
          base = (a.name || a.email).localeCompare(b.name || b.email);
          break;
        case "login":
          // Most recent first is the natural read; never-signed-in sinks.
          base = (b.last_login_at ?? "").localeCompare(a.last_login_at ?? "");
          break;
        default:
          base =
            ROLE_RANKING[a.role] - ROLE_RANKING[b.role] ||
            (a.name || a.email).localeCompare(b.name || b.email);
      }
      return base * sign;
    });
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [members, sortK, sortDir]);
  const MEMBERS_PAGE = 10;
  const pageCount = Math.max(1, Math.ceil(sorted.length / MEMBERS_PAGE));
  const safePage = Math.min(page, pageCount - 1);
  const visible = sorted.slice(safePage * MEMBERS_PAGE, safePage * MEMBERS_PAGE + MEMBERS_PAGE);

  const sortBtn = (k: "name" | "role" | "login", label: string) => (
    <button
      className={`flex items-center gap-1 text-[11.5px] font-semibold uppercase tracking-wide ${
        sortK === k ? "text-ink" : "text-sub hover:text-ink"
      }`}
      onClick={() => {
        if (sortK === k) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
        else {
          setSortK(k);
          setSortDir("asc");
        }
        setPage(0);
      }}
      aria-label={`Sort by ${label}${sortK === k ? (sortDir === "asc" ? ", ascending" : ", descending") : ""}`}
    >
      {label}
      {sortK === k && <span aria-hidden>{sortDir === "asc" ? "↑" : "↓"}</span>}
    </button>
  );

  const say = (msg: string) => {
    setFlash(msg);
    setTimeout(() => setFlash(""), 8000);
  };

  const copyLink = async (target: string) => {
    // Magic link: one click signs them straight in (valid 7 days), so it's
    // minted server-side and should be shared like a key.
    const res = await createMagicLink(target);
    if (!res.ok || !res.url) {
      say(res.error ?? "Couldn't create the link.");
      return;
    }
    try {
      await navigator.clipboard.writeText(res.url);
      setCopied(target);
      setTimeout(() => setCopied((c) => (c === target ? null : c)), 2500);
    } catch {
      say(`Sign-in link for ${target}: ${res.url}`);
    }
  };

  const emailLink = async (target: string) => {
    say(`Sending a sign-in link to ${target}…`);
    const res = await emailSignInLink(target);
    if (res.ok) {
      say(`Sign-in link emailed to ${target}.`);
      return;
    }
    // Direct delivery is unavailable (Resend domain not verified yet), so
    // open a ready-to-send draft in your own mail app instead.
    const link = await createMagicLink(target);
    if (link.ok && link.url) {
      const subject = encodeURIComponent(`Your ${crm.org.name} sign-in link`);
      const body = encodeURIComponent(
        `You've been added to ${crm.org.name}.\n\nSign in here: ${link.url}\n\nThe link works for 7 days and signs you in as ${target}.`
      );
      window.location.href = `mailto:${target}?subject=${subject}&body=${body}`;
      say(
        `Direct sending isn't set up yet, so a ready-to-send draft opened in your mail app for ${target}.`
      );
    } else {
      say(res.error ?? "Couldn't send the link.");
    }
  };

  const submitAdd = async () => {
    setAdding(true);
    const res = await addUser({ email, name, role });
    setAdding(false);
    if (res.ok) {
      const addr = email.trim().toLowerCase();
      say(
        res.emailed
          ? `${addr} can now sign in — an invite email with the link is on its way.`
          : `${addr} can now sign in, but the invite email didn't send — share ${location.origin}/login with them directly.`
      );
      setEmail("");
      setName("");
      setRole("user");
      router.refresh();
    } else {
      say(res.error ?? "Couldn't add the member.");
    }
  };

  const changeRole = async (target: string, next: Role) => {
    const res = await setUserRole(target, next);
    if (res.ok) router.refresh();
    else say(res.error ?? "Couldn't change the role.");
  };

  const remove = async (target: string) => {
    setConfirmRemove(null);
    const res = await removeUser(target);
    if (res.ok) {
      say(`${target} was removed and can no longer sign in.`);
      router.refresh();
    } else {
      say(res.error ?? "Couldn't remove the member.");
    }
  };

  return (
    <div>
      {flash && <div className="callout mb-4 p-3 text-[13px]">{flash}</div>}

      <div className="flex items-center gap-6 border-b border-line pb-2">
        {sortBtn("role", "Role")}
        {sortBtn("name", "Name")}
        {sortBtn("login", "Last sign-in")}
        <span className="ml-auto text-[12px] tabular-nums text-faint">
          {members.length} member{members.length === 1 ? "" : "s"}
        </span>
      </div>
      <div className="flex flex-col divide-y divide-line">
        {visible.map((m) => (
          <div
            key={m.email}
            className="flex cursor-pointer flex-wrap items-center gap-x-2 gap-y-2 py-3 transition-colors hover:bg-bg-soft"
            onClick={() => setOpenMember(m)}
            title={`Open ${m.name || m.email}'s activity`}
          >
            <Avatar user={{ name: m.name, email: m.email, image: m.image }} />
            <div className="min-w-[180px] flex-1">
              <div className="flex items-center gap-2">
                <span className="truncate text-[14px] font-semibold text-ink">
                  {m.name || m.email}
                </span>
                {/* The select already names the role; badge only when there's no select. */}
                {(!isSuper || m.email === viewerEmail) && (
                  <RoleBadge role={m.role} />
                )}
                {m.email === viewerEmail && (
                  <span className="text-[11px] text-faint">you</span>
                )}
              </div>
              <div className="truncate text-[12px] text-faint">
                {m.email}
                {m.last_login_at
                  ? ` · signed in ${etShortDate(m.last_login_at)}`
                  : " · never signed in"}
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1" onClick={(e) => e.stopPropagation()}>
              <button
                className="flex h-9 w-9 items-center justify-center text-sub hover:text-primary"
                title={
                  copied === m.email
                    ? "Copied"
                    : `Copy ${m.email}'s sign-in link (valid 7 days)`
                }
                aria-label={`Copy sign-in link for ${m.email}`}
                onClick={() => copyLink(m.email)}
              >
                {copied === m.email ? (
                  <Checkmark size={16} className="text-primary" />
                ) : (
                  <Copy size={16} />
                )}
              </button>
              <button
                className="flex h-9 w-9 items-center justify-center text-sub hover:text-primary"
                title={`Email ${m.email} their sign-in link`}
                aria-label={`Email sign-in link to ${m.email}`}
                onClick={() => emailLink(m.email)}
              >
                <Email size={16} />
              </button>
              {isSuper &&
                (m.email !== viewerEmail ? (
                  <>
                    <select
                      className="field ml-1 !h-9 !w-36 !text-[13px]"
                      value={m.role}
                      onChange={(e) =>
                        changeRole(m.email, e.target.value as Role)
                      }
                      aria-label={`Role for ${m.email}`}
                    >
                      <option value="super_admin">Owner</option>
                      <option value="admin">Partner</option>
                      <option value="user">Contributor</option>
                    </select>
                    {confirmRemove === m.email ? (
                      <button
                        className="btn-primary !h-9 !px-2.5 !text-[12px]"
                        onClick={() => remove(m.email)}
                      >
                        Remove?
                      </button>
                    ) : (
                      <button
                        className="flex h-9 w-9 items-center justify-center text-sub hover:text-primary"
                        title={`Remove ${m.email}`}
                        aria-label={`Remove ${m.email}`}
                        onClick={() => {
                          setConfirmRemove(m.email);
                          setTimeout(
                            () =>
                              setConfirmRemove((c) =>
                                c === m.email ? null : c
                              ),
                            4000
                          );
                        }}
                      >
                        <TrashCan size={16} />
                      </button>
                    )}
                  </>
                ) : (
                  // Invisible stand-ins keep every row's icons in the same columns.
                  <>
                    <div className="invisible ml-1 h-9 w-36" aria-hidden />
                    <div className="invisible h-9 w-9" aria-hidden />
                  </>
                ))}
            </div>
          </div>
        ))}
      </div>

      {sorted.length > MEMBERS_PAGE && (
        <div className="mt-2 flex items-center justify-between border-t border-line pt-2.5 text-[13px] text-sub">
          <span className="tabular-nums">
            {safePage * MEMBERS_PAGE + 1}–{Math.min((safePage + 1) * MEMBERS_PAGE, sorted.length)} of {sorted.length}
          </span>
          <span className="flex items-center gap-2">
            <button className="tag" disabled={safePage === 0} onClick={() => setPage(safePage - 1)} aria-label="Previous page">
              ← Prev
            </button>
            <span className="tabular-nums">{safePage + 1} / {pageCount}</span>
            <button
              className="tag"
              disabled={safePage >= pageCount - 1}
              onClick={() => setPage(safePage + 1)}
              aria-label="Next page"
            >
              Next →
            </button>
          </span>
        </div>
      )}

      {openMember && (
        <MemberPanel
          member={openMember}
          isSuper={isSuper}
          self={openMember.email === viewerEmail}
          onClose={() => setOpenMember(null)}
        />
      )}

      {/* Add member */}
      <div className="mt-6 border-t border-line pt-5">
        <h3 className="flex items-center gap-2 text-[14px] font-semibold text-ink">
          <UserFollow size={18} />
          Add a member
        </h3>
        <div className="mt-3 flex flex-col gap-3 sm:flex-row">
          <input
            className="field flex-1"
            placeholder="email@example.com"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <input
            className="field flex-1"
            placeholder="Full name (optional)"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <select
            className="field sm:!w-44"
            value={role}
            onChange={(e) => setRole(e.target.value as Role)}
            aria-label="Role for the new member"
          >
            <option value="admin">Partner (all deals)</option>
            <option value="user">Contributor (own deals only)</option>
            {isSuper && <option value="super_admin">Owner</option>}
          </select>
        </div>
        <div className="mt-3 flex items-center gap-4">
          <button
            className="btn-primary"
            onClick={submitAdd}
            disabled={adding || !email.trim()}
          >
            {adding ? "Adding…" : "Add member"}
          </button>
        </div>
      </div>
    </div>
  );
}

export interface ActivityView {
  id: number;
  actor: string;
  action: string;
  target: string;
  detail: Record<string, unknown>;
  created_at: string;
}

const ACTION_LABEL: Record<string, string> = {
  signed_in: "signed in",
  created_deal: "created a deal",
  edited_deal: "edited a deal",
  moved_deal: "moved a deal",
  deleted_deal: "deleted a deal",
  added_user: "added a member",
  removed_user: "removed a member",
  changed_role: "changed a role",
  sent_sign_in_link: "emailed a sign-in link",
  created_sign_in_link: "created a sign-in link",
  added_owner: "added a deal owner",
  removed_owner: "removed a deal owner",
  collected_intel: "ran the intel agent",
  sent_digest: "sent a digest",
};

const LOG_PAGE_SIZE = 10;

export function ActivityLog({ rows }: { rows: ActivityView[] }) {
  const [page, setPage] = useState(0);
  const pages = Math.max(1, Math.ceil(rows.length / LOG_PAGE_SIZE));
  const start = page * LOG_PAGE_SIZE;
  return (
    <div>
      <div className="flex flex-col divide-y divide-line">
        {rows.length === 0 && (
          <p className="py-3 text-[13px] text-sub">Nothing logged yet.</p>
        )}
        {rows.slice(start, start + LOG_PAGE_SIZE).map((r) => {
          // Older rows may hold the detail as a JSON string rather than an object.
          let detailObj: Record<string, unknown> = {};
          if (typeof r.detail === "string") {
            try {
              detailObj = JSON.parse(r.detail);
            } catch {
              detailObj = {};
            }
          } else if (r.detail) {
            detailObj = r.detail;
          }
          const detail = Object.entries(detailObj)
            .map(([k, v]) => `${k}: ${String(v)}`)
            .join(", ");
          return (
            <div key={r.id} className="flex items-baseline gap-3 py-2.5">
              <span className="w-32 shrink-0 text-[12px] tabular-nums text-faint">
                {etShortDateTime(r.created_at)}
              </span>
              <span className="min-w-0 flex-1 text-[13px] text-body">
                <span className="font-semibold text-ink">
                  {r.actor.split("@")[0]}
                </span>{" "}
                {ACTION_LABEL[r.action] ?? r.action}
                {r.target && (
                  <span className="text-sub"> — {r.target}</span>
                )}
                {detail && (
                  <span className="text-faint"> ({detail})</span>
                )}
              </span>
            </div>
          );
        })}
      </div>
      {pages > 1 && (
        <div className="mt-4 flex items-center gap-4 border-t border-line pt-3">
          <button
            className="btn-secondary !h-8 !px-3 !text-[12px]"
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            disabled={page === 0}
          >
            ← Newer
          </button>
          <span className="text-[12px] text-faint">
            Page {page + 1} of {pages}
          </span>
          <button
            className="btn-secondary !h-8 !px-3 !text-[12px]"
            onClick={() => setPage((p) => Math.min(pages - 1, p + 1))}
            disabled={page >= pages - 1}
          >
            Older →
          </button>
        </div>
      )}
    </div>
  );
}

/* ── Member analytics drawer ─────────────────────────────────────────────── */

function StatTile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="border border-line p-3">
      <div className="text-[19px] font-light leading-none tabular-nums text-ink">{value}</div>
      <div className="mt-1 text-[10.5px] font-semibold uppercase tracking-wide text-sub">{label}</div>
      {sub && <div className="mt-0.5 text-[11px] text-faint">{sub}</div>}
    </div>
  );
}

function fmtDay(iso: string | null): string {
  if (!iso) return "Never";
  return etShortDate(iso);
}

function MemberPanel({
  member,
  isSuper,
  self,
  onClose,
}: {
  member: MemberView;
  isSuper: boolean;
  self: boolean;
  onClose: () => void;
}) {
  const [stats, setStats] = useState<MemberStats | null>(null);
  const [failed, setFailed] = useState("");
  const [viewAsArmed, setViewAsArmed] = useState(false);
  const [viewAsBusy, setViewAsBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    setStats(null);
    setFailed("");
    void getMemberStatsAction(member.email).then((r) => {
      if (!alive) return;
      if (r.ok && r.stats) setStats(r.stats);
      else setFailed(r.error ?? "Couldn't load activity.");
    });
    return () => {
      alive = false;
    };
  }, [member.email]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const viewAs = async () => {
    if (viewAsBusy) return;
    setViewAsBusy(true);
    const r = await startViewAsAction(member.email);
    setViewAsBusy(false);
    if (r.ok) window.location.href = "/";
    else {
      setViewAsArmed(false);
      setFailed(r.error ?? "Couldn't start view-as.");
    }
  };

  const maxWeek = Math.max(1, ...(stats?.weekly.map((w) => w.count) ?? [1]));
  const c = stats?.counts;
  const contributions: [string, number][] = c
    ? [
        ["Deals submitted", c.dealsSubmitted],
        ["Deals owned", c.dealsOwned],
        ["Stage moves", c.dealMoves],
        ["Inbox triaged", c.triaged],
        ["Candidates boarded", c.boarded],
        ["Comments", c.comments],
      ]
    : [];

  return (
    <div
      className="fixed inset-0 z-[70] flex justify-end bg-navy/40"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-label={`Activity for ${member.name || member.email}`}
        className="flex h-full w-full max-w-lg flex-col border-l border-line bg-bg shadow-xl"
      >
        <div className="flex items-start gap-3 border-b border-line px-5 py-4">
          <Avatar user={{ name: member.name, email: member.email, image: member.image }} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="truncate text-[16px] font-semibold text-ink">{member.name || member.email}</span>
              <RoleBadge role={member.role} />
              {self && <span className="text-[11px] text-faint">you</span>}
            </div>
            <div className="truncate text-[12.5px] text-faint">{member.email}</div>
          </div>
          {isSuper && !self && (
            viewAsArmed ? (
              <span className="flex items-center gap-1.5">
                <button className="btn-primary !h-8 !px-2.5 !text-[12px]" onClick={() => void viewAs()} disabled={viewAsBusy}>
                  {viewAsBusy ? "Switching…" : "Confirm"}
                </button>
                <button className="tap-sm text-[12px] font-medium text-sub" onClick={() => setViewAsArmed(false)}>
                  Cancel
                </button>
              </span>
            ) : (
              <button
                className="flex h-8 items-center gap-1.5 border border-line px-2.5 text-[12.5px] font-medium text-body hover:border-primary/50 hover:text-primary"
                title="See the app exactly as they do (actions run as them; 1-hour limit)"
                onClick={() => setViewAsArmed(true)}
              >
                <View size={15} aria-hidden /> View as
              </button>
            )
          )}
          <button className="tap p-1.5 text-sub hover:text-ink" aria-label="Close" onClick={onClose}>
            <Close size={22} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {failed && <div className="callout mb-3 p-3 text-[13px]">{failed}</div>}
          {!stats && !failed && (
            <div className="flex flex-col gap-2">
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="h-14 animate-pulse bg-bg-soft" />
              ))}
            </div>
          )}
          {stats && (
            <>
              <div className="grid grid-cols-3 gap-2">
                <StatTile label="Last sign-in" value={fmtDay(stats.lastLoginAt)} />
                <StatTile label="Last active" value={fmtDay(stats.lastActiveAt)} />
                <StatTile label="Hands-on time" value={fmtMinutes(stats.handsOnMinutes)} />
                <StatTile label="Sessions" value={String(stats.sessions)} />
                <StatTile label="Active days" value={String(stats.activeDays)} />
                <StatTile label="Sign-ins" value={String(stats.signIns)} />
              </div>

              <h3 className="mt-5 text-[12px] font-semibold uppercase tracking-wide text-sub">
                Actions per week
              </h3>
              <div className="mt-2 flex h-16 items-end gap-1">
                {stats.weekly.map((w) => (
                  <div key={w.label} className="flex flex-1 flex-col items-center gap-1" title={`Week of ${w.label}: ${w.count} actions`}>
                    <div
                      className="w-full bg-primary/80"
                      style={{ height: `${Math.max(w.count > 0 ? 6 : 2, (w.count / maxWeek) * 52)}px`, background: w.count === 0 ? "#e7e4df" : undefined }}
                    />
                  </div>
                ))}
              </div>
              <div className="mt-1 flex justify-between text-[10.5px] text-faint">
                <span>{stats.weekly[0]?.label}</span>
                <span>{stats.weekly[stats.weekly.length - 1]?.label}</span>
              </div>

              <h3 className="mt-5 text-[12px] font-semibold uppercase tracking-wide text-sub">Contributions</h3>
              <div className="mt-1.5 grid grid-cols-2 gap-x-6">
                {contributions.map(([label, n]) => (
                  <div key={label} className="flex items-baseline justify-between border-b border-line py-1.5">
                    <span className="text-[12.5px] text-body">{label}</span>
                    <span className="text-[13px] font-semibold tabular-nums text-ink">{n.toLocaleString()}</span>
                  </div>
                ))}
              </div>

              {stats.recentDeals.length > 0 && (
                <>
                  <h3 className="mt-5 text-[12px] font-semibold uppercase tracking-wide text-sub">
                    Latest submissions
                  </h3>
                  <ul className="mt-1 flex flex-col">
                    {stats.recentDeals.map((d) => (
                      <li key={d.gid}>
                        <a
                          href={`/deals/${d.gid}`}
                          className="flex items-center justify-between gap-3 border-b border-line py-2 hover:bg-bg-soft"
                        >
                          <span className="min-w-0 truncate text-[13px] font-medium text-ink">{d.name}</span>
                          <span className="shrink-0 text-[11.5px] text-faint">{d.created}</span>
                        </a>
                      </li>
                    ))}
                  </ul>
                </>
              )}

              <p className="mt-5 text-[11.5px] leading-relaxed text-faint">
                Joined {fmtDay(stats.joinedAt)}
                {stats.invitedBy ? `, invited by ${stats.invitedBy}` : ""}. Hands-on time is an
                estimate: recorded actions grouped into sessions with a 30-minute idle cutoff,
                each counting its span plus five minutes. Activity is recorded since Jul 9, 2026;
                reading without acting isn&rsquo;t logged.
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
