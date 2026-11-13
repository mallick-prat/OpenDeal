import { crm } from "@/config/crm.config";
import { parseFrom } from "./emailParse";
import { wallToUtc } from "./availabilityPure";

/**
 * ── Forwarded-thread reconstruction (pure) ───────────────────────────────────
 * A forwarded pitch usually carries the whole history with it: who introduced
 * whom, what the team already said, what the founder originally wrote. That
 * history is the point — "fwd this to the inbox and I get our whole
 * relationship back" — so this splits one flat body into its constituent
 * messages (zones), each with its own sender, recipients, date and text.
 *
 * Handles the three shapes that actually show up in our mail:
 *   1. Gmail    `---------- Forwarded message ---------` + From/Date/Subject/To
 *   2. Reply    `On <date>, <name> <addr> wrote:` followed by `>`-quoted text
 *   3. Outlook  `*From: *…` / `*Sent: *…` / `*To: *…` / `*Subject: *…`
 * plus Apple Mail's `Begin forwarded message:`.
 *
 * No I/O — unit-tested against fixtures modelled on real threads.
 */

export interface ThreadZone {
  /** 0 = the message as it reached us; higher = further back in the quote chain. */
  depth: number;
  from: { name: string; email: string };
  to: string[];
  cc: string[];
  /** The date exactly as written in the header (may be unparseable). */
  dateText: string;
  /** ISO timestamp when the date could be parsed, else null. */
  sentAt: string | null;
  subject: string;
  body: string;
}

const GMAIL_SEP = /^-{3,}\s*Forwarded message\s*-{3,}$/i;
const APPLE_SEP = /^Begin forwarded message:$/i;
/** "On Mon, May 18, 2026 at 4:18 PM Ben Ross <ben@harbor.club> wrote:" */
const ON_WROTE = /^On\s+(.{4,240}?)\s+wrote:\s*$/i;
/** Header lines survive an HTML→text pass as `*From: *`, so allow the stars. */
const HEADER = /^\*?\s*(From|To|Cc|Bcc|Date|Sent|Subject|Reply-To)\s*:\s*\*?\s*(.*)$/i;

/**
 * Strip EVERY level of `>` quoting. Depth is rebuilt from the headers we
 * recover, so nesting markers carry no information we need — and leaving the
 * inner ones in place hides the boundaries of doubly-quoted sub-threads.
 */
function unquote(lines: string[]): string[] {
  return lines.map((l) => l.replace(/^(?:\s*>)+\s?/, ""));
}

/** Gmail wraps long attributions; rejoin `On …` + `… wrote:` pairs. */
function rejoinAttributions(lines: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^On\s+/i.test(line.trim()) && !/wrote:\s*$/i.test(line.trim())) {
      // Look ahead up to two lines for the tail of the attribution.
      for (let j = 1; j <= 2 && i + j < lines.length; j++) {
        const joined = `${line.trim()} ${lines
          .slice(i + 1, i + 1 + j)
          .map((s) => s.trim())
          .join(" ")}`.replace(/\s+/g, " ");
        if (ON_WROTE.test(joined)) {
          out.push(joined);
          i += j;
          break;
        }
        if (j === 2 || i + j === lines.length - 1) out.push(line);
      }
      continue;
    }
    out.push(line);
  }
  return out;
}

/**
 * Mail written without an offset is Eastern wall-clock — the timezone every
 * other surface in the app displays in.
 */
const MAIL_TZ = crm.org.timezone;

/** Minutes from UTC for the zone abbreviations that turn up in our mail. */
const ZONE_OFFSETS: Record<string, number> = {
  Z: 0, UT: 0, UTC: 0, GMT: 0,
  EST: -300, EDT: -240,
  CST: -360, CDT: -300,
  MST: -420, MDT: -360,
  PST: -480, PDT: -420,
};

const MONTH_NAMES = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];

/** "May" / "Sept" / "september" → 1-12, or 0 when it isn't a month. */
function monthNumber(word: string): number {
  const w = word.toLowerCase().replace(/\.$/, "");
  const i = MONTH_NAMES.findIndex((m) => m.startsWith(w.slice(0, 3)) && w.length >= 3);
  return i < 0 ? 0 : i + 1;
}

/** "Mon, May 18, 2026 4:18 PM" — weekday and time optional. */
const WALL_CLOCK =
  /^(?:[A-Za-z]{3,9},?\s+)?([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp])\.?[Mm]\.?)?$/;

/** A trailing zone name, with or without parentheses: "(PDT)", "EST". */
const TRAILING_ZONE = /\s*\(?\b([A-Za-z]{1,4})\b\)?\.?$/;
/** A trailing numeric offset: "-0400", "+02:00". */
const TRAILING_OFFSET = /([+-])(\d{2}):?(\d{2})$/;

function sane(d: Date): boolean {
  const y = d.getUTCFullYear();
  return Number.isFinite(d.getTime()) && y > 1990 && y < 2100;
}

/** -240 → "-04:00" — an offset `Date.parse` reads the same way everywhere. */
function offsetSuffix(offsetMin: number): string {
  const sign = offsetMin < 0 ? "-" : "+";
  const abs = Math.abs(offsetMin);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}

/** Re-read a UTC wall clock as Eastern (DST-correct via wallToUtc). */
function utcWallInMailTz(utc: Date): Date {
  const at = wallToUtc(
    MAIL_TZ,
    utc.getUTCFullYear(), utc.getUTCMonth() + 1, utc.getUTCDate(),
    utc.getUTCHours() * 60 + utc.getUTCMinutes()
  );
  return new Date(at.getTime() + utc.getUTCSeconds() * 1000);
}

/**
 * "Sun, Jul 26, 2026 at 12:12 PM" → ISO, best effort.
 *
 * Mail headers written by a human carry a wall-clock time and often no offset
 * at all. `Date.parse` resolves those against the *process* timezone, so the
 * same thread read on a laptop and on a UTC server produced timestamps hours
 * apart — thread ordering and "sent at" labels drifted with the reader. Absent
 * an explicit zone we anchor to Eastern, the timezone the rest of the app
 * displays in.
 */
export function parseEmailDate(raw: string): string | null {
  const text = raw.trim();
  if (!text) return null;
  const cleaned = text.replace(/\s+at\s+/i, " ").replace(/\s+/g, " ").trim();

  // An explicit zone (named or numeric) makes the string absolute; strip it
  // off the wall clock and remember the offset.
  let body = cleaned;
  let offsetMin: number | null = null;
  const named = TRAILING_ZONE.exec(body);
  if (named && Object.hasOwn(ZONE_OFFSETS, named[1].toUpperCase())) {
    offsetMin = ZONE_OFFSETS[named[1].toUpperCase()];
    body = body.slice(0, named.index).trim();
  } else {
    const numeric = TRAILING_OFFSET.exec(body);
    if (numeric) {
      const mag = Number(numeric[2]) * 60 + Number(numeric[3]);
      offsetMin = numeric[1] === "-" ? -mag : mag;
      body = body.slice(0, numeric.index).trim();
    }
  }

  const m = WALL_CLOCK.exec(body);
  const month = m ? monthNumber(m[1]) : 0;
  if (m && month) {
    const day = Number(m[2]);
    const year = Number(m[3]);
    const hour12 = m[4] ? Number(m[4]) % 12 : 0;
    const minutes =
      (m[7]?.toLowerCase() === "p" ? hour12 + 12 : hour12) * 60 + Number(m[5] ?? 0);
    const d =
      offsetMin === null
        ? wallToUtc(MAIL_TZ, year, month, day, minutes)
        : new Date(Date.UTC(year, month - 1, day, 0, minutes - offsetMin, Number(m[6] ?? 0)));
    if (sane(d)) return d.toISOString();
  }

  // Shapes we don't model (RFC 2822 day-first, ISO) fall through to the
  // platform parser — but never with a zoneless string, whose meaning would
  // depend on the process timezone. The recovered zone is re-attached, and a
  // string with no zone at all is parsed as UTC and then re-read as Eastern.
  const anchored = offsetMin === null ? `${body} +00:00` : `${body} ${offsetSuffix(offsetMin)}`;
  for (const candidate of [anchored, cleaned, text]) {
    const t = Date.parse(candidate);
    if (!Number.isFinite(t)) continue;
    const p = new Date(t);
    // Only the anchored form is trusted to be zone-correct; a bare ISO date is
    // UTC by spec, and anything else that only the platform parser understood
    // carried its own zone.
    const d = candidate === anchored && offsetMin === null ? utcWallInMailTz(p) : p;
    // Guard against Date.parse accepting nonsense like a bare number.
    if (sane(d)) return d.toISOString();
  }
  return null;
}

/** Split "a@x.com, Bob <b@y.com>" into display strings. */
function splitAddresses(raw: string): string[] {
  return raw
    .split(/,(?![^<]*>)/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 12);
}

interface Header {
  from?: string;
  to?: string;
  cc?: string;
  date?: string;
  subject?: string;
}

/**
 * Read a run of header lines from the top of a segment. Returns the parsed
 * headers and the index where the body starts.
 */
function readHeaders(lines: string[]): { header: Header; bodyStart: number } {
  const header: Header = {};
  let i = 0;
  let seen = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      // A blank line ends the block only once we've actually read headers.
      if (seen > 0) {
        i++;
        break;
      }
      i++;
      continue;
    }
    const m = line.match(HEADER);
    if (!m) break;
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    if (key === "from") header.from = value;
    else if (key === "to") header.to = value;
    else if (key === "cc") header.cc = value;
    else if (key === "date" || key === "sent") header.date = value;
    else if (key === "subject") header.subject = value;
    seen++;
    i++;
  }
  return { header, bodyStart: seen > 0 ? i : 0 };
}

function zoneFrom(header: Header, body: string, depth: number): ThreadZone {
  const dateText = header.date ?? "";
  return {
    depth,
    from: parseFrom(header.from ?? ""),
    to: splitAddresses(header.to ?? ""),
    cc: splitAddresses(header.cc ?? ""),
    dateText,
    sentAt: dateText ? parseEmailDate(dateText) : null,
    subject: (header.subject ?? "").trim(),
    body: body.replace(/\n{3,}/g, "\n\n").trim(),
  };
}

/**
 * Split one email body into its thread zones, OLDEST FIRST.
 *
 * Quoted chains are written newest-first, so document order is reversed on the
 * way out; when every zone carries a parseable date those win instead, which
 * fixes the occasional out-of-order forward.
 */
export function parseEmailThread(
  text: string,
  top?: { from?: string; subject?: string; date?: string }
): ThreadZone[] {
  if (!text.trim()) return [];
  const lines = rejoinAttributions(unquote(text.split(/\r?\n/)));

  // Find every boundary: separators, attributions, and bare header blocks.
  const marks: { at: number; skip: number; attribution?: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (GMAIL_SEP.test(t) || APPLE_SEP.test(t)) {
      marks.push({ at: i, skip: 1 });
      continue;
    }
    const on = t.match(ON_WROTE);
    if (on) {
      marks.push({ at: i, skip: 1, attribution: on[1] });
      continue;
    }
    // A `From:` line that begins a real header block (Date/Sent/To/Subject
    // within the next few lines) starts a zone even without a separator.
    const h = t.match(HEADER);
    if (h && h[1].toLowerCase() === "from") {
      const near = lines
        .slice(i + 1, i + 5)
        .some((l) => /^\*?\s*(Date|Sent|To|Subject)\s*:/i.test(l.trim()));
      // Don't double-count the header block that follows a separator.
      const justAfterSep = marks.length > 0 && i - marks[marks.length - 1].at <= 2;
      if (near && !justAfterSep) marks.push({ at: i, skip: 0 });
    }
  }

  const zones: ThreadZone[] = [];
  const bounds = [...marks.map((m) => m.at), lines.length];

  // Everything before the first boundary is the message as we received it.
  const headText = lines.slice(0, bounds[0]).join("\n").trim();
  if (headText || marks.length === 0) {
    zones.push(
      zoneFrom(
        { from: top?.from, subject: top?.subject, date: top?.date },
        headText,
        0
      )
    );
  }

  marks.forEach((mark, idx) => {
    const segment = lines.slice(mark.at + mark.skip, bounds[idx + 1]);
    const { header, bodyStart } = readHeaders(segment);
    if (mark.attribution && !header.from) {
      // "On <date>, <name> <addr> wrote:" — pull the address out of the tail.
      const addr = mark.attribution.match(/<([^>]+@[^>]+)>\s*$/);
      const name = mark.attribution
        .replace(/<[^>]*>\s*$/, "")
        .replace(/^.*?\d{4}(?:\s+at\s+\S+\s*(?:AM|PM)?)?[,\s]*/i, "")
        .trim();
      header.from = addr ? `${name} <${addr[1]}>` : name;
      const dateHalf = mark.attribution.match(
        /^(.*?\d{4}(?:\s+at\s+[\d:]+\s*(?:AM|PM)?)?)/i
      );
      if (dateHalf && !header.date) header.date = dateHalf[1].replace(/,\s*$/, "").trim();
    }
    zones.push(zoneFrom(header, segment.slice(bodyStart).join("\n"), zones.length));
  });

  // A zone with no text of its own is just routing — the "I forwarded this"
  // wrapper. Keep the conversation, drop the envelope (unless it's all we have).
  const withBody = zones.filter((z) => z.body.trim());
  const meaningful = withBody.length > 0 ? withBody : zones.slice(0, 1);
  const ordered = meaningful.slice().reverse();
  const allDated = ordered.length > 1 && ordered.every((z) => z.sentAt);
  if (allDated) {
    ordered.sort((a, b) => Date.parse(a.sentAt!) - Date.parse(b.sentAt!));
  }
  return ordered.map((z, i) => ({ ...z, depth: i }));
}
