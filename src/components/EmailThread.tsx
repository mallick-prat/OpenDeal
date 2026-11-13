"use client";

import { useMemo, useState } from "react";
import { parseEmailThread, type ThreadZone } from "@/lib/emailThread";
import { etDayFirstDateTime } from "@/lib/etDates";

/**
 * The forwarded thread, unrolled. A pitch that arrives as "Fwd: Fwd: FW:"
 * carries the whole relationship with it; this shows it as what it is — a
 * conversation, oldest first, with every sender and date intact — instead of
 * one undifferentiated wall of quoted text.
 */

/** "Mon, May 18, 2026 at 4:18 PM" → "18 May 2026, 4:18 PM". */
function formatWhen(zone: ThreadZone): string {
  if (!zone.sentAt) return zone.dateText;
  return etDayFirstDateTime(zone.sentAt);
}

function initials(name: string, email: string): string {
  const source = name.trim() || email;
  const parts = source.split(/[\s@.]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "?") + (parts[1]?.[0] ?? "")).toUpperCase();
}

/** Recipients are context, not headline — one tidy line, truncated. */
function addressLine(zone: ThreadZone): string {
  const strip = (a: string) => a.replace(/\s*<[^>]*>\s*/, "").trim() || a;
  const to = zone.to.map(strip).join(", ");
  const cc = zone.cc.map(strip).join(", ");
  return [to && `to ${to}`, cc && `cc ${cc}`].filter(Boolean).join(" · ");
}

function Message({ zone, isLatest }: { zone: ThreadZone; isLatest: boolean }) {
  const who = zone.from.name || zone.from.email || "Unknown sender";
  const when = formatWhen(zone);
  const addresses = addressLine(zone);
  return (
    <li className="relative pl-9">
      {/* Timeline node */}
      <span
        className={`absolute left-0 top-0.5 flex h-7 w-7 items-center justify-center rounded-full text-[10px] font-semibold ${
          isLatest ? "bg-primary text-white" : "bg-bg-soft text-sub"
        }`}
        aria-hidden
      >
        {initials(zone.from.name, zone.from.email)}
      </span>

      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className="text-[13px] font-semibold text-ink">{who}</span>
        {zone.from.email && zone.from.name && (
          <span className="text-[12px] text-faint">{zone.from.email}</span>
        )}
        {when && <span className="text-[12px] text-faint">· {when}</span>}
      </div>

      {addresses && (
        <div className="mt-0.5 truncate text-[12px] text-faint" title={addresses}>
          {addresses}
        </div>
      )}
      {zone.subject && (
        <div className="mt-0.5 text-[12px] italic text-sub">{zone.subject}</div>
      )}

      <pre className="mt-2 whitespace-pre-wrap font-sans text-[13px] leading-relaxed text-body">
        {zone.body}
      </pre>
    </li>
  );
}

export function EmailThread({ bodyText }: { bodyText: string }) {
  const zones = useMemo(() => parseEmailThread(bodyText), [bodyText]);
  const [expanded, setExpanded] = useState(false);

  if (zones.length === 0) return null;

  // A single message needs no timeline chrome — it's just an email.
  if (zones.length === 1) {
    return (
      <pre className="card-flat max-h-96 overflow-y-auto whitespace-pre-wrap p-4 font-sans text-[13px] leading-relaxed text-body">
        {zones[0].body}
      </pre>
    );
  }

  // Long chains collapse to the two most recent; the history is one click away.
  const COLLAPSE_AT = 4;
  const collapsed = !expanded && zones.length > COLLAPSE_AT;
  const hiddenCount = collapsed ? zones.length - 2 : 0;
  const shown = collapsed ? zones.slice(-2) : zones;

  return (
    <div className="card-flat p-4">
      <div className="mb-3 flex items-center justify-between">
        <span className="text-[12px] text-sub">
          {zones.length} messages
          {zones[0].sentAt && (
            <span className="text-faint">
              {" "}
              · {formatWhen(zones[0])} → {formatWhen(zones[zones.length - 1])}
            </span>
          )}
        </span>
        {zones.length > COLLAPSE_AT && (
          <button
            onClick={() => setExpanded((v) => !v)}
            className="text-[12px] font-medium text-primary transition-colors hover:text-primary-pressed"
          >
            {expanded ? "Collapse" : `Show all ${zones.length}`}
          </button>
        )}
      </div>

      {collapsed && (
        <button
          onClick={() => setExpanded(true)}
          className="mb-4 w-full rounded border border-dashed border-line py-2 text-[12px] text-sub transition-colors hover:border-primary hover:text-primary"
        >
          {hiddenCount} earlier {hiddenCount === 1 ? "message" : "messages"} hidden
        </button>
      )}

      <ol className="flex flex-col gap-6 border-l border-line pl-3">
        {shown.map((zone, i) => (
          <Message
            key={`${zone.sentAt ?? zone.dateText}-${i}`}
            zone={zone}
            isLatest={zone === zones[zones.length - 1]}
          />
        ))}
      </ol>
    </div>
  );
}
