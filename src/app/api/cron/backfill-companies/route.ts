import { NextResponse } from "next/server";
import { backfillCompaniesBatch } from "@/lib/companies";
import { getBackfill, markBackfill } from "@/lib/backfills";
import { requireRole } from "@/lib/users";
import { logEvent } from "@/lib/log";
import { isCronAuthorized } from "@/lib/cronAuth";

export const maxDuration = 300;

const NAME = "companies";

/** Cron secret (curl-able in incidents) or a signed-in admin. */
async function authorized(req: Request): Promise<boolean> {
  if (isCronAuthorized(req)) return true;
  return (await requireRole("admin")) !== null;
}

/** GET ?status — progress only. GET (default) — run batches inside a time budget. */
export async function GET(req: Request) {
  if (!(await authorized(req))) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }
  const url = new URL(req.url);

  if (url.searchParams.has("status")) {
    return NextResponse.json({ ok: true, backfill: await getBackfill(NAME) });
  }
  if (url.searchParams.has("pause")) {
    await markBackfill(NAME, { status: "paused" });
    return NextResponse.json({ ok: true, paused: true });
  }

  const existing = await getBackfill(NAME);
  if (existing?.status === "paused" && !url.searchParams.has("resume")) {
    return NextResponse.json({ ok: true, backfill: existing, note: "paused — pass ?resume" });
  }

  // Time-budgeted batch loop: stop with ~40s headroom for the response.
  const deadline = Date.now() + (maxDuration - 40) * 1000;
  let done = existing?.done ?? 0;
  let totalCreated = 0;
  try {
    await markBackfill(NAME, { status: "running", done });
    for (;;) {
      const batch = await backfillCompaniesBatch(100);
      done += batch.linked;
      totalCreated += batch.created;
      await markBackfill(NAME, { status: "running", done, total: done + batch.remaining });
      if (batch.remaining === 0) {
        await markBackfill(NAME, { status: "complete", done, total: done });
        logEvent("info", "backfill", "companies backfill complete", { done, created: totalCreated });
        // Companies done → shadow historical inbound emails with candidates too.
        const { backfillCandidatesBatch } = await import("@/lib/candidates");
        let candidates = 0;
        for (;;) {
          const cb = await backfillCandidatesBatch(200);
          candidates += cb.processed;
          if (cb.remaining === 0 || cb.processed === 0 || Date.now() > deadline) break;
        }
        return NextResponse.json({
          ok: true,
          complete: true,
          done,
          created: totalCreated,
          candidatesBackfilled: candidates,
        });
      }
      if (batch.processed === 0 || (batch.linked === 0 && batch.created === 0)) {
        // Rows remain but none are linkable — e.g. "Founder //" deals with no
        // company named. Honest absence: we never invent a company. Done.
        await markBackfill(NAME, { status: "complete", done, total: done });
        return NextResponse.json({
          ok: true,
          complete: true,
          done,
          unlinkable: batch.remaining,
        });
      }
      if (Date.now() > deadline) {
        return NextResponse.json({
          ok: true,
          complete: false,
          done,
          remaining: batch.remaining,
          note: "time budget reached — invoke again to continue",
        });
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await markBackfill(NAME, { status: "failed", done, last_error: message });
    return NextResponse.json({ ok: false, error: message, done }, { status: 500 });
  }
}
