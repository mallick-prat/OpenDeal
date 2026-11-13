"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Add, Analytics, Email, Home, Logout, Settings, Table } from "@carbon/icons-react";
import { signOut } from "next-auth/react";
import { NotificationBell } from "./NotificationBell";
import { crm } from "@/config/crm.config";
import { orgInitials } from "@/lib/brandPure";

export type View = "home" | "analytics" | "deals";

export interface SessionUser {
  name: string;
  email: string;
  image: string | null;
}

const TABS: { key: View; label: string; icon: React.ReactNode }[] = [
  { key: "home", label: "Home", icon: <Home size={20} /> },
  { key: "deals", label: "Deals", icon: <Table size={20} /> },
  { key: "analytics", label: "Analytics", icon: <Analytics size={20} /> },
];

/** The org mark: brand-color square with your initials (see crm.config.ts). */
export function OrgLogo({ size = 36 }: { size?: number }) {
  const initials = orgInitials(crm.org.name);
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      aria-label={crm.org.name}
      role="img"
    >
      <rect width="100" height="100" fill="var(--brand-red-500)" />
      <text
        x="50"
        y="52"
        fill="#ffffff"
        textAnchor="middle"
        dominantBaseline="central"
        fontFamily="'IBM Plex Sans', Arial, sans-serif"
        fontSize={initials.length > 1 ? 52 : 60}
        fontWeight="700"
        letterSpacing="-3"
      >
        {initials}
      </text>
    </svg>
  );
}

export function Avatar({ user }: { user: SessionUser }) {
  if (user.image) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={user.image}
        alt=""
        referrerPolicy="no-referrer"
        className="h-9 w-9 rounded-full border border-line object-cover"
      />
    );
  }
  const initials = (user.name || user.email || "X")
    .split(/[\s@.]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0]!.toUpperCase())
    .join("");
  return (
    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary text-[13px] font-semibold text-white">
      {initials}
    </span>
  );
}

/**
 * Mobile account menu: the avatar opens a small dropdown with Settings and
 * Log out — the top-bar layout has no desktop footer, so this is where those
 * live on phones (and it's the only Settings entry point on mobile).
 */
function AccountMenu({
  user,
  onView,
  view,
  overflowTabs,
  showInbox,
}: {
  user: SessionUser;
  onView: (v: View) => void;
  view: View;
  /** Views that didn't fit in the bottom bar; live here instead. */
  overflowTabs: { key: View; label: string; icon: React.ReactNode }[];
  showInbox: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);
  const item =
    "flex w-full items-center gap-3 px-4 py-3 text-left text-[15px] text-body active:bg-bg-soft hover:bg-bg-soft";
  return (
    <div ref={ref} className="relative shrink-0">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-label="Menu"
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex items-center rounded-full p-0.5"
      >
        <Avatar user={user} />
      </button>
      {open && (
        <div className="absolute right-0 top-full z-40 mt-1 w-60 overflow-hidden rounded-lg border border-line bg-bg shadow-lg">
          <div className="border-b border-line px-4 py-3">
            <div className="truncate text-[14px] font-semibold text-ink">{user.name}</div>
            <div className="truncate text-[12px] text-faint">{user.email}</div>
          </div>
          {overflowTabs.map((t) => (
            <button
              key={t.key}
              onClick={() => {
                onView(t.key);
                setOpen(false);
              }}
              className={`${item} ${view === t.key ? "text-primary" : ""}`}
            >
              {t.icon} {t.label}
            </button>
          ))}
          {showInbox && (
            <Link
              href="/inbox"
              className={`${item} border-t border-line`}
              onClick={() => setOpen(false)}
            >
              <Email size={18} /> Inbox
            </Link>
          )}
          <a
            href="/settings"
            className={`${item} border-t border-line`}
            onClick={() => setOpen(false)}
          >
            <Settings size={18} /> Settings
          </a>
          <button
            onClick={() => signOut({ callbackUrl: "/login" })}
            className={`${item} border-t border-line`}
          >
            <Logout size={18} /> Log out
          </button>
        </div>
      )}
    </div>
  );
}

export function Sidebar({
  view,
  onView,
  onNewDeal,
  onOpenDeal,
  user,
  showInbox = true,
}: {
  view: View;
  onView: (v: View) => void;
  /** Mobile top-bar "New deal" action; opens the create-deal modal. */
  onNewDeal?: () => void;
  /** Open a deal by gid — used when a notification is clicked. */
  onOpenDeal?: (gid: string) => void;
  user: SessionUser;
  /** Contributors work from the board, not the triage inbox. */
  showInbox?: boolean;
}) {
  const tabs = TABS;
  // Bottom bar shows 4 views around the centre "+"; the rest (and Inbound,
  // Settings, Log out) live in the profile menu.
  const primaryTabs = tabs.slice(0, 4);
  const overflowTabs = tabs.slice(4);
  const bottomTab = (t: (typeof TABS)[number]) => {
    const active = view === t.key;
    return (
      <button
        key={t.key}
        onClick={() => onView(t.key)}
        aria-current={active ? "page" : undefined}
        className={`flex flex-1 flex-col items-center justify-center gap-0.5 py-2 text-[10px] font-medium transition-colors ${
          active ? "text-primary" : "text-sub active:text-ink"
        }`}
      >
        {t.icon}
        <span>{t.label}</span>
      </button>
    );
  };
  return (
    <>
      {/* Top bar on mobile · left rail on desktop */}
      <nav className="sticky top-0 z-30 flex w-full shrink-0 flex-row items-center border-b border-line bg-bg pt-[env(safe-area-inset-top)] md:h-[100dvh] md:w-56 md:flex-col md:items-stretch md:border-b-0 md:border-r md:pt-0">
        <div className="hidden items-center px-5 py-5 md:flex">
          <OrgLogo size={36} />
        </div>
        <span className="flex shrink-0 items-center pl-4 md:hidden">
          <OrgLogo size={26} />
        </span>

        {/* Vertical tab strip — desktop only; on mobile these live in the bottom nav */}
        <div className="hidden min-w-0 flex-1 flex-col md:flex">
          {tabs.map((t) => (
            <button
              key={t.key}
              onClick={() => onView(t.key)}
              className={`relative flex items-center gap-3 px-5 py-3.5 text-[14px] transition-colors ${
                view === t.key
                  ? "bg-red-50 font-semibold text-primary-pressed"
                  : "text-body hover:bg-bg-soft hover:text-primary"
              }`}
            >
              <span
                className={`absolute left-0 top-0 h-full w-[3px] ${
                  view === t.key ? "bg-primary" : "bg-transparent"
                }`}
              />
              {t.icon}
              <span>{t.label}</span>
            </button>
          ))}
          {showInbox && (
            <Link
              href="/inbox"
              className="flex items-center gap-3 px-5 py-3.5 text-[14px] text-body transition-colors hover:bg-bg-soft hover:text-primary"
            >
              <Email size={20} />
              <span>Inbox</span>
            </Link>
          )}
        </div>

        {/* Mobile top-bar: notifications + profile menu (rest is bottom nav). */}
        <div className="ml-auto flex shrink-0 items-center gap-1 py-2 pr-2 md:hidden">
          {onOpenDeal && <NotificationBell onOpenDeal={onOpenDeal} />}
          <AccountMenu
            user={user}
            onView={onView}
            view={view}
            overflowTabs={overflowTabs}
            showInbox={showInbox}
          />
        </div>

        {/* Footer: profile, settings | log out — desktop only */}
        <div className="hidden border-t border-line px-5 pb-5 pt-4 md:block">
          <div className="flex items-center gap-3">
            <Avatar user={user} />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[14px] font-semibold text-ink">
                {user.name}
              </div>
              <div className="truncate text-[12px] text-faint">{user.email}</div>
            </div>
            {onOpenDeal && <NotificationBell onOpenDeal={onOpenDeal} />}
          </div>
          <div className="mt-4 flex items-center justify-between">
            <a
              href="/settings"
              className="flex items-center gap-2 text-[13px] font-medium text-primary transition-colors hover:text-primary-pressed"
            >
              <Settings size={16} />
              Settings
            </a>
            <button
              onClick={() => signOut({ callbackUrl: "/login" })}
              className="flex items-center gap-2 text-[13px] font-medium text-primary transition-colors hover:text-primary-pressed"
            >
              <Logout size={16} />
              Log out
            </button>
          </div>
        </div>
      </nav>

      {/* Bottom navigation — mobile only: 2 tabs · centre "+" · 2 tabs. */}
      <nav className="fixed inset-x-0 bottom-0 z-30 flex items-stretch border-t border-line bg-bg pb-[env(safe-area-inset-bottom)] shadow-[0_-1px_3px_rgba(0,0,0,0.05)] md:hidden">
        {primaryTabs.slice(0, 2).map(bottomTab)}
        {/* Centre New-deal: red brand square */}
        <div className="flex flex-1 items-center justify-center">
          <button
            onClick={onNewDeal}
            aria-label="New deal"
            className="-mt-4 flex h-14 w-14 items-center justify-center bg-primary text-white shadow-md active:bg-primary-pressed"
          >
            <Add size={28} />
          </button>
        </div>
        {primaryTabs.slice(2, 4).map(bottomTab)}
      </nav>
    </>
  );
}
