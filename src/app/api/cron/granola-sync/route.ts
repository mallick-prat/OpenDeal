import { NextResponse } from "next/server";
import { meetingNotesOverview, syncGranolaNotes } from "@/lib/meetingNotes";
import { currentAppUser } from "@/lib/users";
import { logError, logEvent } from "@/lib/log";
import { record } from "@/lib/perf";
import { isCronAuthorized } from "@/lib/cronAuth";

export const maxDuration = 300;

/**
 * Granola meeting-notes sync. GET is the scheduled entry point (CRON_SECRET,
 * exactly like daily-sync); ?status returns config + counts without syncing.
 * POST is the settings-page "Sync now" — cron secret OR a signed-in admin
 * (dual-mode, like /api/intel/collect).
 */

function cronAuthorized(req: Request): boolean {
  return isCronAuthorized(req);
}

async function runSync(trigger: string) {
  const t0 = Date.now();
  const result = await syncGranolaNotes({ lookbackDays: 30 });
  // Freshly matched notes get their update proposals in the same pass.
  try {
    const { proposePendingUpdates } = await import("@/lib/meetingNoteUpdates");
    await proposePendingUpdates();
  } catch (err) {
    logError("granola", "propose pass failed", err);
  }
  logEvent("info", "granola", "sync done", {
    trigger,
    configured: result.configured,
    imported: result.imported,
    updated: result.updated,
    suggested: result.suggested,
    errors: result.errors,
  }, Date.now() - t0);
  record("cron.granola_sync", Date.now() - t0, { trigger, imported: result.imported });
  return result;
}

export async function GET(req: Request) {
  if (!cronAuthorized(req)) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }
  if (new URL(req.url).searchParams.has("status")) {
    return NextResponse.json({ ok: true, ...(await meetingNotesOverview()) });
  }
  try {
    const r = await runSync("cron");
    return NextResponse.json({
      ok: r.ok,
      imported: r.imported,
      updated: r.updated,
      suggested: r.suggested,
      errors: r.errors,
      configured: r.configured,
    });
  } catch (err) {
    logError("granola", "sync failed", err);
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "sync failed" },
      { status: 500 }
    );
  }
}

export async function POST(req: Request) {
  const cronOk = cronAuthorized(req);
  const member = cronOk ? null : await currentAppUser();
  const isAdmin =
    member?.role === "admin" || member?.role === "super_admin";
  if (!cronOk && !isAdmin) {
    return NextResponse.json(
      { ok: false, error: member ? "Admins only." : "Not signed in." },
      { status: member ? 403 : 401 }
    );
  }
  try {
    const r = await runSync(member?.email ?? "cron");
    return NextResponse.json({
      ok: r.ok,
      imported: r.imported,
      updated: r.updated,
      suggested: r.suggested,
      errors: r.errors,
      configured: r.configured,
    });
  } catch (err) {
    logError("granola", "manual sync failed", err);
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "sync failed" },
      { status: 500 }
    );
  }
}
