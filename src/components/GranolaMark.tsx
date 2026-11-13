import { Notebook } from "@carbon/icons-react";

/** Marks meeting notes that came from Granola (a generic notebook glyph). */
export function GranolaMark({ size = 16, className = "" }: { size?: number; className?: string }) {
  return (
    <Notebook
      size={size}
      aria-label="Granola note"
      className={`inline-block shrink-0 align-[-3px] ${className}`}
    />
  );
}
