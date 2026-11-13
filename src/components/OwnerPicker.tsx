"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Add, Close } from "@carbon/icons-react";
import { addDealOwner, removeDealOwner } from "@/app/actions";
import type { DealOwner } from "@/lib/types";

/** Small round avatar: photo when we have one, first initial otherwise. */
export function OwnerAvatar({
  owner,
  size = 28,
}: {
  owner: { name: string; email: string; image: string | null };
  size?: number;
}) {
  if (owner.image) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={owner.image}
        alt=""
        referrerPolicy="no-referrer"
        style={{ width: size, height: size }}
        className="shrink-0 rounded-full border border-line object-cover"
      />
    );
  }
  const initial = (owner.name || owner.email)[0]?.toUpperCase() ?? "?";
  return (
    <span
      style={{ width: size, height: size, fontSize: size * 0.42 }}
      className="flex shrink-0 items-center justify-center rounded-full bg-primary font-semibold text-white"
    >
      {initial}
    </span>
  );
}

/**
 * Owners row for a deal: avatar + name chips with remove, and a + circle
 * that opens a member search (top 5 matches). Changes save immediately.
 */
export function OwnerPicker({
  gid,
  initialOwners,
  members,
  onError,
}: {
  gid: string;
  initialOwners: DealOwner[];
  members: { email: string; name: string; image: string | null }[];
  onError: (msg: string) => void;
}) {
  const [owners, setOwners] = useState<DealOwner[]>(initialOwners);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const popRef = useRef<HTMLDivElement>(null);

  // Click-outside closes the picker.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (popRef.current && !popRef.current.contains(e.target as Node)) {
        setOpen(false);
        setQuery("");
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const candidates = useMemo(() => {
    const taken = new Set(owners.map((o) => o.email));
    const pool = members.filter((m) => !taken.has(m.email));
    const q = query.trim().toLowerCase();
    const matches = q
      ? pool.filter(
          (m) =>
            m.name.toLowerCase().includes(q) ||
            m.email.toLowerCase().includes(q)
        )
      : pool;
    return matches.slice(0, 5);
  }, [members, owners, query]);

  const add = (m: { email: string; name: string; image: string | null }) => {
    // Optimistic: chip appears now, rolls back if the save fails.
    setOwners((o) => [...o, m]);
    setOpen(false);
    setQuery("");
    void addDealOwner(gid, m.email).then((res) => {
      if (!res.ok) {
        setOwners((o) => o.filter((x) => x.email !== m.email));
        onError(res.error ?? "Couldn't add the owner.");
      }
    });
  };

  const remove = (email: string) => {
    const prev = owners;
    setOwners((o) => o.filter((x) => x.email !== email));
    void removeDealOwner(gid, email).then((res) => {
      if (!res.ok) {
        setOwners(prev);
        onError(res.error ?? "Couldn't remove the owner.");
      }
    });
  };

  return (
    <div>
      <span className="mb-1.5 block text-[12px] font-semibold text-sub">
        Owners
      </span>
      <div className="flex flex-wrap items-center gap-2">
        {owners.map((o) => (
          <span
            key={o.email}
            className="group flex items-center gap-1.5 border border-line bg-bg-soft py-1 pl-1 pr-2"
            title={o.email}
          >
            <OwnerAvatar owner={o} size={24} />
            <span className="text-[13px] text-ink">{o.name || o.email}</span>
            <button
              className="tap ml-0.5 flex items-center justify-center text-faint hover:text-primary"
              title={`Remove ${o.name || o.email} as owner`}
              aria-label={`Remove ${o.name || o.email} as owner`}
              onClick={() => remove(o.email)}
            >
              <Close size={14} />
            </button>
          </span>
        ))}

        <div className="relative" ref={popRef}>
          <button
            className="tap flex h-8 w-8 items-center justify-center rounded-full border border-dashed border-strong text-sub hover:border-primary hover:text-primary"
            title="Add an owner"
            aria-label="Add an owner"
            onClick={() => setOpen((v) => !v)}
          >
            <Add size={18} />
          </button>
          {open && (
            <div className="absolute left-0 top-10 z-10 w-64 border border-line bg-bg shadow-lg">
              <input
                autoFocus
                className="w-full border-b border-line bg-bg px-3 py-2 text-[13px] outline-none"
                placeholder="Search members…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    setOpen(false);
                    setQuery("");
                  }
                  if (e.key === "Enter" && candidates[0]) add(candidates[0]);
                }}
              />
              {candidates.length === 0 ? (
                <p className="px-3 py-2.5 text-[12px] text-faint">
                  {members.length === owners.length
                    ? "Everyone already owns this deal."
                    : "No members match."}
                </p>
              ) : (
                candidates.map((m) => (
                  <button
                    key={m.email}
                    className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-bg-soft"
                    onClick={() => add(m)}
                  >
                    <OwnerAvatar owner={m} size={24} />
                    <span className="min-w-0">
                      <span className="block truncate text-[13px] text-ink">
                        {m.name || m.email}
                      </span>
                      <span className="block truncate text-[11px] text-faint">
                        {m.email}
                      </span>
                    </span>
                  </button>
                ))
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
