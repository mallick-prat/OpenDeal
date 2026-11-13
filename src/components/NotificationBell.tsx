"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Notification, NotificationNew } from "@carbon/icons-react";
import {
  getNotifications,
  unreadNotificationsAction,
  markNotificationsReadAction,
} from "@/app/actions";
import { etShortDate } from "@/lib/etDates";

interface NotifItem {
  id: string;
  type: "mention" | "reply" | "comment";
  dealGid: string | null;
  dealName: string | null;
  actorName: string | null;
  actorImage: string | null;
  actorEmail: string | null;
  excerpt: string | null;
  read: boolean;
  createdAt: string;
}

const POLL_MS = 45_000;

function timeAgo(iso: string): string {
  const secs = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 45) return "now";
  if (secs < 3600) return `${Math.round(secs / 60)}m`;
  if (secs < 86400) return `${Math.round(secs / 3600)}h`;
  if (secs < 7 * 86400) return `${Math.round(secs / 86400)}d`;
  return etShortDate(iso);
}

function verb(t: NotifItem["type"]): string {
  return t === "mention" ? "mentioned you on" : t === "reply" ? "replied on" : "commented on";
}

function Face({ item }: { item: NotifItem }) {
  if (item.actorImage) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={item.actorImage}
        alt=""
        referrerPolicy="no-referrer"
        className="h-8 w-8 shrink-0 rounded-full border border-line object-cover"
      />
    );
  }
  const initials = (item.actorName || item.actorEmail || "?")
    .split(/[\s@.]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0]!.toUpperCase())
    .join("");
  return (
    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary text-[11px] font-semibold text-white">
      {initials}
    </span>
  );
}

/**
 * Bell + unread badge that opens a dropdown of recent comment activity.
 * Polls the unread count in the background; fetches the full list on open,
 * marks it read, and opening an item jumps to that deal.
 */
export function NotificationBell({
  onOpenDeal,
  className = "",
}: {
  onOpenDeal: (gid: string) => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [unread, setUnread] = useState(0);
  const [items, setItems] = useState<NotifItem[] | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  const refreshCount = useCallback(async () => {
    if (typeof document !== "undefined" && document.hidden) return;
    const res = await unreadNotificationsAction();
    if (res.ok && typeof res.unread === "number") setUnread(res.unread);
  }, []);

  // Background poll for the badge — an external-system subscription: setUnread
  // only ever fires from refreshCount's async continuation, not synchronously.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refreshCount();
    const id = setInterval(() => void refreshCount(), POLL_MS);
    const onVisible = () => {
      if (!document.hidden) void refreshCount();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refreshCount]);

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const toggle = async () => {
    const next = !open;
    setOpen(next);
    if (!next) return;
    const res = await getNotifications();
    if (res.ok) {
      setItems(res.items);
      // Everything shown is now seen — clear the badge and persist.
      if (res.unread > 0) {
        setUnread(0);
        await markNotificationsReadAction();
      }
    }
  };

  const openItem = (item: NotifItem) => {
    setOpen(false);
    if (item.dealGid) onOpenDeal(item.dealGid);
  };

  return (
    <div ref={ref} className={`relative shrink-0 ${className}`}>
      <button
        onClick={toggle}
        aria-label={unread > 0 ? `Notifications (${unread} unread)` : "Notifications"}
        aria-haspopup="menu"
        aria-expanded={open}
        className="relative flex items-center justify-center rounded-full p-2 text-body transition-colors hover:bg-bg-soft hover:text-primary"
      >
        {unread > 0 ? <NotificationNew size={20} /> : <Notification size={20} />}
        {unread > 0 && (
          <span className="absolute right-1 top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold leading-none text-white">
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-full z-40 mt-1 max-h-[70dvh] w-[min(22rem,calc(100vw-1.5rem))] overflow-hidden rounded-lg border border-line bg-bg shadow-lg">
          <div className="border-b border-line px-4 py-3 text-[13px] font-semibold text-ink">
            Notifications
          </div>
          <div className="max-h-[calc(70dvh-3rem)] overflow-y-auto">
            {items === null ? (
              <p className="px-4 py-6 text-center text-[13px] text-faint">Loading…</p>
            ) : items.length === 0 ? (
              <p className="px-4 py-6 text-center text-[13px] text-faint">
                Nothing yet. You&apos;ll hear about comments on your deals here.
              </p>
            ) : (
              <ul>
                {items.map((n) => (
                  <li key={n.id}>
                    <button
                      onClick={() => openItem(n)}
                      className={`flex w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-bg-soft ${
                        n.read ? "" : "bg-red-50/60"
                      }`}
                    >
                      <Face item={n} />
                      <span className="min-w-0 flex-1">
                        <span className="block text-[13px] leading-snug text-body">
                          <span className="font-semibold text-ink">{n.actorName ?? "Someone"}</span>{" "}
                          {verb(n.type)}{" "}
                          <span className="font-semibold text-ink">{n.dealName ?? "a deal"}</span>
                        </span>
                        {n.excerpt && (
                          <span className="mt-0.5 block truncate text-[12px] text-faint">
                            {n.excerpt}
                          </span>
                        )}
                        <span className="mt-0.5 block text-[11px] text-faint">
                          {timeAgo(n.createdAt)}
                        </span>
                      </span>
                      {!n.read && (
                        <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-primary" />
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
