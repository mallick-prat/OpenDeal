/**
 * Keyboard confirm for ignoring a whole Granola meeting note.
 * First Delete arms; second Delete confirms; Escape cancels.
 * Does not steal e / s / i — those stay on the existing handlers.
 */

export type NoteIgnorePhase = "idle" | "armed";

export type NoteIgnoreKeyResult = {
  phase: NoteIgnorePhase;
  action: "none" | "arm" | "confirm" | "cancel";
};

export function noteIgnoreKey(phase: NoteIgnorePhase, key: string): NoteIgnoreKeyResult {
  if (key === "Escape") {
    return phase === "armed"
      ? { phase: "idle", action: "cancel" }
      : { phase: "idle", action: "none" };
  }
  if (key === "Delete") {
    return phase === "armed"
      ? { phase: "idle", action: "confirm" }
      : { phase: "armed", action: "arm" };
  }
  return { phase, action: "none" };
}

/** True when a shortcut would steal keystrokes from a field the user is editing. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return Boolean(
    target.closest("input, textarea, select, [contenteditable]:not([contenteditable='false'])")
  );
}
