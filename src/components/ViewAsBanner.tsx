"use client";

import { useEffect, useState } from "react";
import { stopViewAsAction } from "@/app/actions";

/**
 * The "viewing as" ribbon. Renders only when the non-httpOnly marker cookie
 * is present (set alongside the authoritative httpOnly cookie), so pages pay
 * nothing when nobody is impersonating. The marker is display-only — the
 * server re-checks the real session's privilege on every request.
 */
export function ViewAsBanner() {
  const [name, setName] = useState<string | null>(null);
  useEffect(() => {
    const m = document.cookie.match(/(?:^|;\s*)od_viewas_name=([^;]+)/);
    setName(m ? decodeURIComponent(m[1]) : null);
  }, []);
  if (!name) return null;
  return (
    <div className="fixed inset-x-0 bottom-0 z-[90] flex items-center justify-center gap-3 bg-primary px-4 py-2 text-[13px] font-medium text-white">
      <span>
        Viewing as <strong>{name}</strong> — the app behaves exactly as it does for them, and actions run as them.
      </span>
      <button
        className="border border-white/70 px-2.5 py-0.5 text-[12.5px] font-semibold hover:bg-white hover:text-primary"
        onClick={() => {
          void stopViewAsAction().then(() => {
            window.location.href = "/";
          });
        }}
      >
        Exit
      </button>
    </div>
  );
}
