import { NextResponse } from "next/server";
import { mergeDeals } from "@/lib/dealMerge";
import { logError } from "@/lib/log";
import { isCronAuthorized } from "@/lib/cronAuth";

export const maxDuration = 60;

/**
 * Ops lever: merge two deals by gid, exactly as the in-app Merge button does
 * (survivor picked by stage/sync/age, children repointed, duplicate deleted).
 * Cron-secret gated; used for repair work when psql isn't reachable. The
 * merge itself refuses nonsense (same gid twice, missing rows) and logs to
 * app_events either way.
 */
export async function POST(req: Request) {
  if (!isCronAuthorized(req)) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }
  const body = (await req.json().catch(() => null)) as { a?: string; b?: string } | null;
  const a = body?.a?.trim() ?? "";
  const b = body?.b?.trim() ?? "";
  if (!a || !b || a.length > 60 || b.length > 60) {
    return NextResponse.json({ ok: false, error: "Pass gids a and b." }, { status: 400 });
  }
  try {
    const res = await mergeDeals(a, b, "ops:merge-deals");
    if ("error" in res) return NextResponse.json({ ok: false, ...res }, { status: 409 });
    return NextResponse.json({ ok: true, ...res });
  } catch (err) {
    logError("cron", "merge-deals failed", err, { a, b });
    return NextResponse.json({ ok: false, error: "Merge failed." }, { status: 500 });
  }
}
