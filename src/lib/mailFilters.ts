/**
 * ── Personal-inbox pre-filters (pure) ────────────────────────────────────────
 * Deterministic exclusion rules (PRD §9.1) applied BEFORE a personal-inbox
 * message body is ever fetched: mailing lists, bulk sends, automated senders,
 * calendar traffic, and receipts never enter the store. No I/O — kept pure so
 * it's unit-testable, mirroring src/lib/emailParse.ts.
 */

export interface MailFilterInput {
  /** Raw header name → value; lookup here is case-insensitive. */
  headers: Record<string, string>;
  from: string;
  subject: string;
}

export interface MailFilterResult {
  exclude: boolean;
  reason: string | null;
}

const AUTOMATED_FROM = /no-?reply|notifications@|mailer-daemon/i;
const RECEIPT_FROM = /(?:receipts?|billing|invoices?)@/i;
const RECEIPT_SUBJECT =
  /\b(?:your receipt|receipt for|receipt from|your invoice|invoice for|invoice from|invoice #|invoice \d)/i;
const CALENDAR_SUBJECT =
  /^\s*(?:invitation|updated invitation|accepted|declined|tentative(?:ly accepted)?|cance(?:l+ed)? event)\s*:/i;

const keep: MailFilterResult = { exclude: false, reason: null };
const drop = (reason: string): MailFilterResult => ({ exclude: true, reason });

/**
 * Should this message be kept out of the personal-inbox store entirely?
 * First matching rule wins; a plain human email matches none of them.
 */
export function shouldExcludeMessage(input: MailFilterInput): MailFilterResult {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(input.headers ?? {})) {
    headers[name.toLowerCase()] = String(value ?? "");
  }
  const from = String(input.from ?? "");
  const subject = String(input.subject ?? "");

  // Mailing lists announce themselves via RFC 2919/2369 headers.
  if ("list-id" in headers || "list-unsubscribe" in headers) {
    return drop("mailing list");
  }

  const precedence = (headers["precedence"] ?? "").trim().toLowerCase();
  if (precedence === "bulk" || precedence === "list") return drop("bulk");

  if (AUTOMATED_FROM.test(from)) return drop("automated");

  // Calendar invites: a text/calendar MIME hint or Google/Outlook's stock
  // "Invitation:/Accepted:/Declined:" subject prefixes.
  if (
    /text\/calendar/i.test(headers["content-type"] ?? "") ||
    CALENDAR_SUBJECT.test(subject)
  ) {
    return drop("calendar");
  }

  if (RECEIPT_FROM.test(from) || RECEIPT_SUBJECT.test(subject)) {
    return drop("receipt");
  }

  return keep;
}

/**
 * Deterministic pre-gate BEFORE any AI spend: does this personal-inbox
 * message plausibly concern dealflow? Deliberately tight — the classifier
 * cleans up false positives; false negatives just stay ordinary mail.
 */
const DEAL_SIGNALS = [
  "fundrais",
  "raising",
  "our raise",
  "pre-seed",
  "preseed",
  "seed round",
  "seed stage",
  "series a",
  "series b",
  "pitch deck",
  "our deck",
  "deck attached",
  "deck link",
  "docsend",
  "term sheet",
  "cap table",
  "safe note",
  "valuation",
  "angel round",
  "investment opportunity",
  "investing in",
  "lead investor",
  "venture round",
];

export function looksDealRelated(
  subject: string,
  body: string,
  opts: { hasAttachment?: boolean; hasDeckLink?: boolean } = {}
): boolean {
  if (opts.hasDeckLink) return true;
  const text = `${subject}\n${body}`.toLowerCase();
  if (DEAL_SIGNALS.some((s) => text.includes(s))) return true;
  // A PDF attachment alone is a weaker signal — require any raise-ish word.
  if (opts.hasAttachment && /\b(raise|round|pitch|deck|invest)/.test(text)) return true;
  return false;
}
