import type { StageKey } from "./types";
import { crm } from "@/config/crm.config";

export interface StageMeta {
  key: StageKey;
  label: string;
  short: string;
  color: string;
  /** Stages that count as live pipeline (not yet decided, not misc). */
  active: boolean;
  /** Display order in funnel / legends. */
  order: number;
}

/** The funnel, straight from src/config/crm.config.ts (order = array order). */
export const STAGES: StageMeta[] = crm.stages.map((s, order) => ({
  ...s,
  order,
}));

export const STAGE_BY_KEY: Record<StageKey, StageMeta> = Object.fromEntries(
  STAGES.map((s) => [s.key, s])
) as Record<StageKey, StageMeta>;

/**
 * Tags are stored as `schools` in the database and code (the original use
 * case was university-network investing). The user-facing label comes from
 * crm.tags, so this is "Sector" or "Source" or whatever you set.
 */
export const COMMON_SCHOOLS: readonly string[] = crm.tags.quickFilters;

export const NO_SCHOOL = "Untagged";

const GRAY = "#4B5563";

/** Chip color for a tag; anything unlisted falls back to gray. */
export function schoolColor(name: string): string {
  const colors: Record<string, string> = crm.tags.colors;
  return colors[name.trim().toLowerCase()] ?? GRAY;
}

/** Every tag is a valid tag. (Kept as a seam: if you sync tags from another
 *  system that also carries non-category labels, filter them here.) */
export function isSchoolTag(_tag: string): boolean {
  return true;
}
