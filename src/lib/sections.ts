import type { SectionInfo } from "./types";
import { STAGES } from "./stages";

/**
 * Board columns for the stage picker and the board itself. Stages live in
 * src/config/crm.config.ts, so there's no external system to ask; the
 * section id is simply the stage key. Kept async so call sites that were
 * written against a remote source (and `.catch()` it) need no changes.
 */
export async function fetchSections(): Promise<SectionInfo[]> {
  return STAGES.map((s) => ({ gid: s.key, name: s.label, stage: s.key }));
}
