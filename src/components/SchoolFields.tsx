"use client";

import { crm } from "@/config/crm.config";

/** Split a comma / newline separated write-in string into clean school names. */
export function parseOther(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Turn a list of school names into existing tag gids plus brand-new names,
 * matching against the known name→gid map case-insensitively.
 */
export function resolveSchools(
  names: string[],
  schoolTagGids: Record<string, string>
): { gids: string[]; newNames: string[] } {
  const byLower = new Map(
    Object.entries(schoolTagGids).map(([k, v]) => [k.toLowerCase(), v])
  );
  const gids = new Set<string>();
  const newNames: string[] = [];
  for (const raw of names) {
    const n = raw.trim();
    if (!n) continue;
    const gid = byLower.get(n.toLowerCase());
    if (gid) gids.add(gid);
    else if (!newNames.some((x) => x.toLowerCase() === n.toLowerCase()))
      newNames.push(n);
  }
  return { gids: [...gids], newNames };
}

export function SchoolFields({
  topSchools,
  selected,
  onToggle,
  otherOn,
  onOtherToggle,
  otherText,
  onOtherChange,
}: {
  topSchools: string[];
  selected: Set<string>;
  onToggle: (name: string) => void;
  otherOn: boolean;
  onOtherToggle: () => void;
  otherText: string;
  onOtherChange: (text: string) => void;
}) {
  return (
    <div>
      <span className="mb-1 block text-[12px] font-semibold text-sub">
        {crm.tags.plural}
      </span>
      <div className="card-flat grid grid-cols-2 gap-x-3 gap-y-1.5 p-3 sm:grid-cols-3">
        {topSchools.map((school) => (
          <label
            key={school}
            className="flex cursor-pointer items-center gap-2 text-[13px] text-body"
          >
            <input
              type="checkbox"
              className="accent-[var(--brand-red-500)]"
              checked={selected.has(school)}
              onChange={() => onToggle(school)}
            />
            <span className="truncate">{school}</span>
          </label>
        ))}
        <label className="flex cursor-pointer items-center gap-2 text-[13px] text-body">
          <input
            type="checkbox"
            className="accent-[var(--brand-red-500)]"
            checked={otherOn}
            onChange={onOtherToggle}
          />
          <span className="truncate">Other</span>
        </label>
      </div>
      {otherOn && (
        <input
          className="field mt-2"
          autoFocus
          value={otherText}
          onChange={(e) => onOtherChange(e.target.value)}
        />
      )}
    </div>
  );
}
