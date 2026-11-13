import { NextResponse } from "next/server";
import { syncAllCalendars } from "@/lib/calendarSync";
import { currentAppUser } from "@/lib/users";
import { logError, logEvent } from "@/lib/log";
import { record } from "@/lib/perf";
import { isCronAuthorized } from "@/lib/cronAuth";

export const maxDuration = 300;

/**
 * Google Calendar sync (PR-10). GET is the scheduled entry point, gated by
 * CRON_SECRET exactly like granola-sync/daily-sync. Sweeps every legacy
 * google_connections grant, upserts calendar_events, and matches external
 * meetings to deals.
 */

function cronAuthorized(req: Request): boolean {
  return isCronAuthorized(req);
}

async function runSweep(trigger: string) {
  const t0 = Date.now();
    const counts = await syncAllCalendars();
    // Every fresh sync feeds reverse enrichment: new invites get matched to
    // deals, founder-shaped attendees get linked, interactions get stamped.
    const { reverseEnrichSweep } = await import("@/lib/calendarEnrich");
    const enriched = await reverseEnrichSweep().catch((err) => {
      logError("calendar", "reverse enrich sweep failed", err);
      return null;
    });
  logEvent(
    "info",
    "calendar",
    "cron sweep done",
    { trigger, ...counts, enriched: JSON.stringify(enriched ?? {}) },
    Date.now() - t0
  );
  record("cron.calendar_sync", Date.now() - t0, { trigger, errors: counts.errors });
  return { ok: counts.errors === 0, ...counts, enriched };
}

export async function GET(req: Request) {
  if (!cronAuthorized(req)) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }
  try {
    return NextResponse.json(await runSweep("cron"));
  } catch (err) {
    logError("calendar", "cron sweep failed", err);
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "sync failed" },
      { status: 500 }
    );
  }
}

/** Settings "Sync now": cron secret OR a signed-in admin (dual-mode). */
export async function POST(req: Request) {
  const cronOk = cronAuthorized(req);
  const member = cronOk ? null : await currentAppUser();
  const isAdmin = member?.role === "admin" || member?.role === "super_admin";
  if (!cronOk && !isAdmin) {
    return NextResponse.json(
      { ok: false, error: member ? "Admins only." : "Not signed in." },
      { status: member ? 403 : 401 }
    );
  }
  try {
    return NextResponse.json(await runSweep(member?.email ?? "cron"));
  } catch (err) {
    logError("calendar", "manual sweep failed", err);
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "sync failed" },
      { status: 500 }
    );
  }
}
