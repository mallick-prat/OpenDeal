/**
 * Deal names are stored as "Founders // Company". Split them for display on
 * cards, the share preview, and the public page. Pure, so it's unit-tested.
 */
export function splitDealName(name: string): { founder: string; company: string } {
  const raw = String(name ?? "");
  const i = raw.indexOf("//");
  if (i < 0) return { founder: "", company: raw.trim() || "Untitled deal" };
  return {
    founder: raw.slice(0, i).trim(),
    company: raw.slice(i + 2).trim() || "Untitled deal",
  };
}
