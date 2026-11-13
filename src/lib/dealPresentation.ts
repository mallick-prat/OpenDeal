/**
 * Pure presentation helpers for deal rows. Kept out of pipeline.ts (which is
 * server-only) so they're unit-testable — and so a single malformed row can
 * never crash the whole board render.
 */

const ELLIPSIS_AT = 180;

/** Collapse whitespace and clip the notes to a board-card excerpt. Null-safe. */
export function noteExcerpt(notes: string | null | undefined): string {
  const note = String(notes ?? "").replace(/\s+/g, " ").trim();
  return note.length > ELLIPSIS_AT ? `${note.slice(0, ELLIPSIS_AT - 3)}…` : note;
}
