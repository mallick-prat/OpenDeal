/**
 * ── Pass email, pure ────────────────────────────────────────────────────────
 * The default note, placeholder handling, validation, and the safety scrub —
 * everything the composer and the server share, with no IO so it all tests.
 * House rule carried into copy and code alike: no em dashes anywhere.
 *
 * Also the deterministic half of context assembly: which recorded decision
 * is the CURRENT pass reason versus background noise, how deep the
 * relationship was (which sets the note's length), and whether there is
 * enough real signal to write an honest note at all. The prompt does the
 * writing; these functions decide what it's allowed to treat as true.
 */
import { INTERNAL_DOMAIN_SET } from "@/config/crm.config";


export interface PassDraft {
  to: string;
  subject: string;
  body: string;
}

/** The standing default note. Placeholders stay VISIBLE when uncertain. */
export function defaultPassBody(input: {
  founderName: string | null;
  companyName: string | null;
  senderFirstName: string;
}): string {
  const name = input.founderName?.trim() || "[Name]";
  const company = input.companyName?.trim() || "[Company]";
  return `Hi ${name},

Thank you again for sharing the materials and taking the time to walk us through what you're building at ${company}.

We came away impressed by the ambition of the vision and the strength of the team you're assembling. After discussing it internally, we do not believe we currently have the bandwidth to contribute as meaningfully as we would want to at this stage.

We would genuinely like to stay close as the company develops, with the hope of revisiting a potential partnership in a future financing. We're grateful that you considered us and wish you and the team continued momentum.

Rooting for you,
${input.senderFirstName}`;
}

export function defaultPassSubject(companyName: string | null): string {
  return `Following up on ${companyName?.trim() || "[Company]"}`;
}

/** Unresolved template placeholders that must block sending. */
export function unresolvedPlaceholders(text: string): string[] {
  const hits = text.match(/\[(?:Name|Company)\]/g) ?? [];
  return [...new Set(hits)];
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Parse a free-typed address field (To or Cc): comma or semicolon separated,
 * trimmed, lowered, deduped. Every address stays user-changeable; this only
 * sorts the well-formed from the broken so the composer can name the broken.
 */
export function parseCcList(raw: string): { emails: string[]; invalid: string[] } {
  const emails: string[] = [];
  const invalid: string[] = [];
  for (const piece of raw.split(/[,;]+/)) {
    const e = piece.trim().toLowerCase();
    if (!e) continue;
    if (!EMAIL_RE.test(e)) invalid.push(piece.trim());
    else if (!emails.includes(e)) emails.push(e);
  }
  return { emails, invalid };
}

/** First blocking problem with a draft, or null when it can send. The To
 * field is a chip list under the hood: comma separated, up to five people. */
export function passDraftProblem(draft: PassDraft): string | null {
  const to = parseCcList(draft.to);
  if (to.invalid.length > 0) {
    return `"${to.invalid[0]}" doesn't look like an email address.`;
  }
  if (to.emails.length === 0) return "Add a recipient.";
  if (to.emails.length > 5) return "That's more than 5 recipients.";
  if (!draft.subject.trim()) return "Add a subject.";
  if (!draft.body.trim()) return "The email is empty.";
  const left = unresolvedPlaceholders(`${draft.subject}\n${draft.body}`);
  if (left.length > 0) {
    return `Fill in ${left.join(" and ")} before sending.`;
  }
  return null;
}

/**
 * Single adverbs the prompt already forbids, kept here as a mechanical
 * backstop. Verified against a real model run: the prompt's own banned-word
 * instruction (plus its silent self-check step) still let "genuinely"
 * through once — a prompt is a strong preference, not a guarantee, so the
 * house-style words get the same deterministic treatment as the em dash.
 * Multi-word banned PHRASES stay prompt-only; splicing them out risks
 * leaving a grammatically broken sentence behind, unlike a lone adverb.
 *
 * The match reaches one character past the word on purpose: `replace()`
 * can only substitute the text it matched, so re-capitalizing the word
 * AFTER a removed sentence-starter ("Truly, we..." -> "We...") means
 * pulling that character into the match itself rather than trying to
 * mutate text outside it.
 */
const BANNED_WORDS = /\b(?:genuinely|truly|incredibly|impressive(?:ly)?|excited|excitedly)\b,?\s*(\S)?/gi;

function stripBannedWords(text: string): string {
  return text.replace(BANNED_WORDS, (match, nextChar: string | undefined, offset: number, whole: string) => {
    if (!nextChar) return "";
    const before = whole.slice(0, offset);
    const sentenceStart = before === "" || /[.!?\n]\s*$/.test(before);
    return sentenceStart ? nextChar.toUpperCase() : nextChar;
  });
}

/**
 * Safety scrub on model output before anyone sees it: no em or en dashes
 * (house rule), no internal addresses leaking into founder mail, no
 * stage-direction brackets beyond the two known placeholders, no banned
 * house-style words, tidy spacing.
 */
/** Does this line mention an address at one of OUR domains (see crm.config)? */
function namesInternalAddress(line: string): boolean {
  for (const m of line.matchAll(/[\w.+-]+@([\w-]+(?:\.[\w-]+)+)/g)) {
    if (INTERNAL_DOMAIN_SET.has(m[1].toLowerCase())) return true;
  }
  return false;
}

export function scrubPassDraft(text: string): string {
  return stripBannedWords(
    text
      .replace(/\s*[—–]\s*/g, ", ")
      // A line naming an internal address is internal commentary by
      // definition; the founder never needs it.
      .split("\n")
      .filter((line) => !namesInternalAddress(line))
      .join("\n")
      .replace(/\[(?!Name\]|Company\])[^\]\n]{1,60}\]/g, "")
  )
    .replace(/[ \t]+\n/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/* ── Decision selection ───────────────────────────────────────────────────── */

export interface RawDecision {
  decision: string;
  rationale: string | null;
  createdAt: string;
}

export interface SelectedDecisions {
  /** The most recent 'pass' decision — the explicit reason to write from.
   *  Null when no one has recorded one yet (thin-context territory). */
  current: RawDecision | null;
  /** Earlier decisions of ANY kind, newest first, capped at 2. Background
   *  only — an earlier "diligence: excited about the wedge" must never
   *  read as the team's current view once a pass is on record. */
  superseded: RawDecision[];
}

/**
 * `sendPassEmail` logs its own send as a 'pass' decision with a fixed
 * bookkeeping string, purely so the deal card shows a decision was made.
 * That string is not a reason a human wrote; treating it as one would feed
 * the model "Pass note sent to founder@co.com" as if it were evidence.
 */
function isAutoLoggedSendRecord(rationale: string | null): boolean {
  return !!rationale && /^pass note sent to /i.test(rationale.trim());
}

function hasRealRationale(d: RawDecision): boolean {
  return !!d.rationale?.trim() && !isAutoLoggedSendRecord(d.rationale);
}

/**
 * Split a deal's decision history into "the current pass reason" and
 * "everything else". Source-priority rule: the most recent pass decision
 * that actually carries a human-written reason is authoritative; nothing
 * else may be treated as such, no matter how much more detailed or
 * enthusiastic it reads. A pass logged only by the send flow's own
 * bookkeeping (no real rationale) does not count as a reason — it's
 * evidence a pass happened, not evidence of why.
 */
export function selectPassDecision(
  decisions: RawDecision[]
): SelectedDecisions {
  const sorted = [...decisions].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const currentIdx = sorted.findIndex((d) => d.decision === "pass" && hasRealRationale(d));
  if (currentIdx === -1) return { current: null, superseded: sorted.slice(0, 2) };
  // Everything else, newest first — usually all older than the pass, but a
  // decision recorded after it (someone reopened interest) still counts as
  // background the note should never silently ignore.
  return {
    current: sorted[currentIdx],
    superseded: sorted.filter((_, i) => i !== currentIdx).slice(0, 2),
  };
}

/* ── Length calibration ───────────────────────────────────────────────────── */

export interface RelationshipDepth {
  meetingCount: number;
  emailCount: number;
  /** A real, explicit pass reason exists and diligence materials were supplied. */
  extensiveDiligence: boolean;
}

export interface LengthBand {
  min: number;
  max: number;
  label: string;
}

/**
 * How much diligence happened sets how much the note owes the founder. A
 * two-line rejection after a real process reads as careless; a five
 * paragraph essay after one intro call reads as performative.
 */
export function passLengthBand(depth: RelationshipDepth): LengthBand {
  const contact = depth.meetingCount + depth.emailCount;
  if (depth.extensiveDiligence || depth.meetingCount >= 3) {
    return { min: 350, max: 550, label: "extensive diligence" };
  }
  if (depth.meetingCount >= 2 || contact >= 4) {
    return { min: 220, max: 350, label: "multiple meetings" };
  }
  if (depth.meetingCount >= 1 || contact >= 1) {
    return { min: 140, max: 230, label: "an introductory call" };
  }
  return { min: 80, max: 140, label: "a brief or out-of-scope interaction" };
}

/* ── Thin-context detection ───────────────────────────────────────────────── */

export interface ContextSignals {
  hasPassReason: boolean;
  hasCompanyFacts: boolean;
  hasMeetings: boolean;
  hasEmailHistory: boolean;
  hasFounderName: boolean;
  hasCompanyName: boolean;
}

/**
 * Whether there's enough real signal to write a genuine note, or whether
 * the model would have to invent one. A missing pass reason alone isn't
 * disqualifying, since meetings or company facts can still ground an
 * honest generic note; it's the CONJUNCTION of "no reason" and "nothing
 * else to go on" that means any specific claim would be fiction.
 */
export function isThinContext(s: ContextSignals): boolean {
  if (!s.hasFounderName || !s.hasCompanyName) return true;
  if (s.hasPassReason) return false;
  return !s.hasCompanyFacts && !s.hasMeetings && !s.hasEmailHistory;
}

/** What's missing, in the order the spec's own checklist names them. */
export function missingContextFields(s: ContextSignals): string[] {
  const missing: string[] = [];
  if (!s.hasPassReason) missing.push("primary pass reason");
  if (!s.hasPassReason || (!s.hasCompanyFacts && !s.hasMeetings)) {
    missing.push("evidence supporting the reason");
  }
  if (!s.hasFounderName) missing.push("founder name");
  if (!s.hasCompanyName) missing.push("company name");
  if (!s.hasMeetings && !s.hasEmailHistory) missing.push("relationship stage");
  return missing;
}

/* ── Context budget ───────────────────────────────────────────────────────── */

export interface ContextSection {
  label: string;
  text: string;
  /** Lower drops first when the budget is tight. 0 is the decision itself
   *  and must never be cut. */
  priority: number;
}

/**
 * Join labeled sections under a character budget, dropping the LOWEST
 * priority sections whole rather than truncating every section a little.
 * A half-sentence of "why we're passing" is worse than a fully-omitted
 * research section — this keeps the sections that survive intact and
 * legible instead of shredding all of them evenly.
 */
export function assembleContextBudget(
  sections: ContextSection[],
  maxChars: number
): string {
  const nonEmpty = sections.filter((s) => s.text.trim());
  // Ascending by priority: index 0 is the weakest section, dropped first.
  const bySize = [...nonEmpty].sort((a, b) => a.priority - b.priority);
  const included = new Set(bySize.map((s) => s.label));
  let total = bySize.reduce((n, s) => n + s.text.length + 2, 0);
  // Priority 0 (the decision) is never removed, even over budget — the
  // spec is explicit that the decision and its evidence must survive.
  const droppable = bySize.filter((s) => s.priority > 0);
  for (const section of droppable) {
    if (total <= maxChars) break;
    included.delete(section.label);
    total -= section.text.length + 2;
  }
  return nonEmpty
    .filter((s) => included.has(s.label))
    .map((s) => s.text)
    .join("\n\n");
}
