import "server-only";
import { accessTokenFor, getGoogleConnection } from "./googleSync";
import { timed } from "./perf";
import {
  DEFAULT_SLOT_CONFIG,
  groupSlotsByDay,
  openSlots,
  type BusyInterval,
} from "./availabilityPure";

/**
 * ── Live availability for "suggest times" ───────────────────────────────────
 * Free slots come straight from Google FreeBusy at request time — the synced
 * calendar_events table would do, but a stale sync must never produce a
 * double-booked suggestion, so this reads the calendar live. Uses the same
 * per-member google_connections grant the calendar sync runs on
 * (calendar.readonly — reading is all this does).
 */

export interface AvailabilityResult {
  connected: boolean;
  tzLabel: string;
  slotMinutes: number;
  days: { dayKey: string; dayLabel: string; slots: { startISO: string; endISO: string; timeLabel: string }[] }[];
  generatedAt: string;
}

export async function getAvailability(
  email: string,
  opts: { slotMinutes?: number; businessDays?: number } = {}
): Promise<AvailabilityResult> {
  return timed("extension.availability", async () => {
    const slotMinutes = [15, 30, 45, 60].includes(opts.slotMinutes ?? 0) ? opts.slotMinutes! : 30;
    const businessDays = Math.min(10, Math.max(3, opts.businessDays ?? 7));
    const base: AvailabilityResult = {
      connected: false,
      tzLabel: "ET",
      slotMinutes,
      days: [],
      generatedAt: new Date().toISOString(),
    };
    const conn = await getGoogleConnection(email);
    if (!conn) return base;

    const token = await accessTokenFor(conn);
    const now = new Date();
    // Look far enough ahead to cover the weekday horizon plus weekends.
    const timeMax = new Date(now.getTime() + (businessDays + 6) * 24 * 3600000);
    const res = await fetch("https://www.googleapis.com/calendar/v3/freeBusy", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        timeMin: now.toISOString(),
        timeMax: timeMax.toISOString(),
        items: [{ id: "primary" }],
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`FreeBusy ${res.status}: ${(await res.text()).slice(0, 150)}`);
    const data = (await res.json()) as {
      calendars?: { primary?: { busy?: { start: string; end: string }[] } };
    };
    const busy: BusyInterval[] = data.calendars?.primary?.busy ?? [];

    const slots = openSlots(busy, now.toISOString(), {
      ...DEFAULT_SLOT_CONFIG,
      slotMinutes,
      businessDays,
    });
    return {
      ...base,
      connected: true,
      days: groupSlotsByDay(slots).map((g) => ({
        dayKey: g.dayKey,
        dayLabel: g.dayLabel,
        slots: g.slots.map((s) => ({ startISO: s.startISO, endISO: s.endISO, timeLabel: s.timeLabel })),
      })),
    };
  }, { email });
}
