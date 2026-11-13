"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Analytics,
  Email,
  Home,
  Settings,
  Table,
} from "@carbon/icons-react";
import { signOut } from "next-auth/react";
import { Logout } from "@carbon/icons-react";
import { Avatar, OrgLogo } from "./Sidebar";

/**
 * The left navigation rail for standalone pages (Inbox, Meetings, Settings).
 * Same visual language as the dashboard Sidebar — logo, 3px red active bar,
 * red-tinted active row — but href-based: these pages are real routes, so
 * navigation is a link, not a view swap. Desktop only; the standalone pages
 * keep their own compact mobile headers and back links.
 */
// Mirrors the dashboard sidebar exactly — same items, same order, same
// icons — so switching pages never reshuffles the rail.
const LINKS: { href: string; label: string; icon: React.ReactNode }[] = [
  { href: "/", label: "Home", icon: <Home size={20} /> },
  { href: "/deals", label: "Deals", icon: <Table size={20} /> },
  { href: "/analytics", label: "Analytics", icon: <Analytics size={20} /> },
  { href: "/inbox", label: "Inbox", icon: <Email size={20} /> },
];

export interface NavUser {
  name: string;
  email: string;
  image: string | null;
}

export function AppNav({ user, role }: { user?: NavUser; role?: string }) {
  const pathname = usePathname();
  // One nav, every page, per role: contributors browse their deals but don't triage.
  const links = role === "user" ? LINKS.filter((l) => l.href !== "/inbox") : LINKS;
  const isActive = (href: string) =>
    href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);
  return (
    <nav className="sticky top-0 hidden h-[100dvh] w-56 shrink-0 flex-col border-r border-line bg-bg lg:flex">
      <Link href="/" className="flex items-center px-5 py-5" aria-label="Home">
        <OrgLogo size={36} />
      </Link>
      <div className="flex min-w-0 flex-1 flex-col">
        {links.map((l) => {
          const active = isActive(l.href);
          return (
            <Link
              key={l.href}
              href={l.href}
              aria-current={active ? "page" : undefined}
              className={`relative flex items-center gap-3 px-5 py-3.5 text-[14px] transition-colors ${
                active
                  ? "bg-red-50 font-semibold text-primary-pressed"
                  : "text-body hover:bg-bg-soft hover:text-primary"
              }`}
            >
              <span
                className={`absolute left-0 top-0 h-full w-[3px] ${
                  active ? "bg-primary" : "bg-transparent"
                }`}
              />
              {l.icon}
              <span>{l.label}</span>
            </Link>
          );
        })}
      </div>
      <div className="border-t border-line px-5 pb-5 pt-4">
        {user && (
          <div className="mb-4 flex items-center gap-3">
            <Avatar user={user} />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[14px] font-semibold text-ink">{user.name}</div>
              <div className="truncate text-[12px] text-faint">{user.email}</div>
            </div>
          </div>
        )}
        <div className="flex items-center justify-between">
          <a
            href="/settings"
            className="flex items-center gap-2 text-[13px] font-medium text-primary transition-colors hover:text-primary-pressed"
          >
            <Settings size={16} />
            Settings
          </a>
          {user && (
            <button
              onClick={() => signOut({ callbackUrl: "/login" })}
              className="flex items-center gap-2 text-[13px] font-medium text-primary transition-colors hover:text-primary-pressed"
            >
              <Logout size={16} />
              Log out
            </button>
          )}
        </div>
      </div>
    </nav>
  );
}
