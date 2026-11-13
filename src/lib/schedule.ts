import "server-only";
import { sql } from "./db";
import { timed } from "./perf";
import { accessTokenFor, getGoogleConnection } from "./googleSync";
import { wallToUtc } from "./availabilityPure";
import {
  candidateSlots,
  pickSpread,
  type BusyInterval,
  type ScheduleSlot,
  type SchedulingConstraints,
} from "./schedulePure";

/**
 * ── Scheduling server: roster + free/busy + suggestions ────────────────────
 * Availability comes from each member's OWN Google grant (google_connections,
 * calendar.readonly) via FreeBusy — start, end, busy/free, and nothing else.
 * No event titles, attendees, or locations ever leave Google. A calendar that
 * fails to load is reported unavailable and NEVER treated as empty: no slot
 * is proposed unless every required participant is known free.
 */

export interface ScheduleRosterEntry {
  /** The id used as a calendarParticipantId — a member email or calendar id. */
  email: string;
  name: string;
  hasCalendar: boolean;
  /** "member" = their own grant; "linked" = a calendar shared to a member. */
  kind: "member" | "linked";
}

/**
 * Selectable calendars: members with their own grant, plus linked calendars
 * (a colleague's calendar shared to a member's account).
 */
export async function scheduleRoster(): Promise<ScheduleRosterEntry[]> {
  const [members, linked] = await Promise.all([
    sql<{ email: string; name: string; has_cal: boolean }[]>`
      select u.email, u.name, (g.email is not null) as has_cal
        from app_users u
        left join google_connections g on g.email = u.email
       order by has_cal desc, u.name`,
    sql<{ calendar_id: string; label: string }[]>`
      select calendar_id, label from linked_calendars order by label`.catch(() => []),
  ]);
  const out: ScheduleRosterEntry[] = members.map((r) => ({
    email: r.email,
    name: r.name,
    hasCalendar: r.has_cal,
    kind: "member" as const,
  }));
  for (const l of linked) {
    const already = out.find((m) => m.email === l.calendar_id);
    if (already) {
      // A linked copy makes an unconnected member schedulable.
      if (!already.hasCalendar) already.hasCalendar = true;
      continue;
    }
    out.push({ email: l.calendar_id, name: l.label, hasCalendar: true, kind: "linked" });
  }
  return out;
}

export interface SuggestResult {
  ok: boolean;
  error?: string;
  slots?: ScheduleSlot[];
  /** How many conflict-free starts existed in the window, before picking. */
  availableCount?: number;
  /** Calendars that could not be read — their owners are NOT covered. */
  unavailable?: string[];
  checkedAt?: string;
}

async function freeBusyFor(
  email: string,
  timeMinISO: string,
  timeMaxISO: string
): Promise<BusyInterval[] | null> {
  // Own grant first; otherwise a linked calendar rides its via-member's
  // token, asking Google for that calendar id directly (free/busy only).
  let conn = await getGoogleConnection(email);
  let calendarId = "primary";
  if (!conn) {
    const linked = await sql<{ via_email: string }[]>`
      select via_email from linked_calendars where calendar_id = ${email.toLowerCase()}`.catch(() => []);
    if (!linked[0]) return null;
    conn = await getGoogleConnection(linked[0].via_email);
    calendarId = email.toLowerCase();
    if (!conn) return null;
  }
  try {
    const token = await accessTokenFor(conn);
    const res = await fetch("https://www.googleapis.com/calendar/v3/freeBusy", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ timeMin: timeMinISO, timeMax: timeMaxISO, items: [{ id: calendarId }] }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      calendars?: Record<string, { busy?: { start: string; end: string }[]; errors?: unknown[] }>;
    };
    const cal = data.calendars?.[calendarId];
    if (!cal || (Array.isArray(cal.errors) && cal.errors.length > 0)) return null;
    return cal.busy ?? [];
  } catch {
    return null; // reported unavailable — never "empty calendar"
  }
}

/**
 * Conflict-free suggestions for the constraint set. Excluded starts support
 * "generate different times"; the caller re-runs this before trusting any
 * slot that has aged.
 */
export async function scheduleSuggestions(
  constraints: SchedulingConstraints,
  exclude: string[] = []
): Promise<SuggestResult> {
  return timed("schedule.suggest", async () => {
    const [sy, sm, sd] = constraints.dateStart.split("-").map(Number);
    const [ey, em, ed] = constraints.dateEnd.split("-").map(Number);
    if (!sy || !ey) return { ok: false, error: "Bad date range." };
    const timeMin = wallToUtc(constraints.timezone, sy, sm, sd, 0).toISOString();
    const timeMax = wallToUtc(constraints.timezone, ey, em, ed, 24 * 60).toISOString();

    const emails = [...new Set(constraints.calendarParticipantIds.map((e) => e.toLowerCase()))];
    const results = await Promise.all(emails.map((e) => freeBusyFor(e, timeMin, timeMax)));

    const busyByParticipant: Record<string, BusyInterval[]> = {};
    const unavailable: string[] = [];
    emails.forEach((e, i) => {
      const r = results[i];
      if (r === null) unavailable.push(e);
      else busyByParticipant[e] = r;
    });
    if (unavailable.length > 0) {
      // A missing calendar means unknown availability — refuse to guess.
      return { ok: false, unavailable, error: "Availability unavailable for a selected calendar." };
    }

    const now = new Date().toISOString();
    const all = candidateSlots(busyByParticipant, constraints, now);
    const picked = pickSpread(all, constraints.suggestionCount, new Set(exclude));
    return {
      ok: true,
      slots: picked,
      availableCount: all.length,
      unavailable: [],
      checkedAt: now,
    };
  }, { participants: constraints.calendarParticipantIds.length });
}
