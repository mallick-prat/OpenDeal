import { decisionMeta } from "@/lib/decisionsPure";

/**
 * Small colored pill for a deal's current decision. Text + color (never color
 * alone) so it reads on the board, in the table, and in the deal header.
 */
export function DecisionChip({
  decision,
  size = "sm",
}: {
  decision: string | null | undefined;
  size?: "sm" | "md";
}) {
  const meta = decision ? decisionMeta(decision) : null;
  if (!meta) return null;
  const pad = size === "md" ? "px-2 py-0.5 text-[12px]" : "px-1.5 py-0.5 text-[10px]";
  return (
    <span
      className={`inline-flex items-center gap-1 rounded font-semibold text-white ${pad}`}
      style={{ backgroundColor: meta.color }}
      title={meta.hint}
    >
      {meta.label}
    </span>
  );
}
