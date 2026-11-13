/**
 * A message surface that screen readers announce. `tone="error"` is an
 * assertive alert (interrupts); the default status tone is polite (waits for a
 * pause). Use it for every flash / error / inline notice so nothing is silent
 * to assistive tech. Styling comes from the shared `.callout` class.
 */
export function Callout({
  tone = "status",
  className = "",
  children,
}: {
  tone?: "status" | "error";
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      aria-live={tone === "error" ? "assertive" : "polite"}
      className={`callout ${className}`}
    >
      {children}
    </div>
  );
}
