import { isInternalEmail } from "./companiesPure";

/**
 * ── Deal candidates, pure ───────────────────────────────────────────────────
 * A candidate is review STATE layered over an ingested email — separated so
 * triage (assign, snooze, pass, ignore) never contorts the ingestion status
 * machine. The investor is the triager; these helpers rank and label, they
 * never decide.
 */

export type CandidateStatus =
  | "detected"
  | "parsing"
  | "ready"
  | "assigned"
  | "snoozed"
  | "approved"
  | "attached"
  | "passed"
  | "ignored"
  | "parse_failed";

export const OPEN_STATUSES: CandidateStatus[] = [
  "detected",
  "parsing",
  "ready",
  "assigned",
  "snoozed",
];

export function isOpen(status: CandidateStatus): boolean {
  return (OPEN_STATUSES as string[]).includes(status);
}

/** Map a legacy inbound_emails.status onto the candidate state machine. */
export function statusFromInbound(
  inboundStatus: string
): { status: CandidateStatus; reviewed: boolean } {
  switch (inboundStatus) {
    case "pending":
      return { status: "parsing", reviewed: false };
    case "parsed":
      return { status: "ready", reviewed: false };
    case "created":
      return { status: "approved", reviewed: true };
    case "skipped":
      return { status: "ignored", reviewed: true };
    case "error":
      return { status: "parse_failed", reviewed: false };
    default:
      return { status: "ready", reviewed: false };
  }
}

export interface RankableCandidate {
  status: CandidateStatus;
  assignedTo: string | null;
  classification: string | null; // pitch|referral|update|scheduling|internal|other|uncertain
  confidence: number | null;
  meetingScheduled: boolean;
  receivedAt: string | null;
  snoozedUntil: string | null;
}

/**
 * PRD §9.2 queue priority: meeting scheduled → warm intro → assigned to me →
 * high-confidence pitch → possible update → the rest. Lower = higher priority.
 */
export function priorityBand(c: RankableCandidate, viewerEmail: string): number {
  if (c.meetingScheduled) return 0;
  if (c.classification === "referral") return 1;
  if (c.assignedTo && c.assignedTo.toLowerCase() === viewerEmail.toLowerCase()) return 2;
  if (c.classification === "pitch" && (c.confidence ?? 0) >= 0.7) return 3;
  if (c.classification === "update") return 4;
  return 5;
}

/** Full comparator: band, then most recent activity first. */
export function compareCandidates(
  a: RankableCandidate,
  b: RankableCandidate,
  viewerEmail: string
): number {
  const band = priorityBand(a, viewerEmail) - priorityBand(b, viewerEmail);
  if (band !== 0) return band;
  return (b.receivedAt ?? "").localeCompare(a.receivedAt ?? "");
}

/** A snooze has lapsed when its wake time is in the past. */
export function snoozeLapsed(c: RankableCandidate, now: Date): boolean {
  if (c.status !== "snoozed" || !c.snoozedUntil) return false;
  return new Date(c.snoozedUntil).getTime() <= now.getTime();
}

/**
 * "Known / missing" slots for the triage card — missing fields are facts
 * about the thread, rendered honestly, never invented (triage doctrine).
 */
export interface ParsedSummary {
  companyName?: string | null;
  oneLiner?: string | null;
  raiseAmount?: string | null;
  round?: string | null;
  founders?: { fullName?: string | null }[] | null;
}

export function missingSlots(
  parsed: ParsedSummary | null,
  hasDeck: boolean
): string[] {
  const missing: string[] = [];
  if (!parsed?.companyName?.trim()) missing.push("No company name");
  if (!hasDeck) missing.push("No deck yet");
  if (!parsed?.raiseAmount?.trim() && !parsed?.round?.trim()) missing.push("No raise stated");
  if (!parsed?.founders?.some((f) => f.fullName?.trim())) missing.push("No founders named");
  return missing;
}

/**
 * ── Founder list management (foundersMeta claim) ────────────────────────────
 * The email extraction is read-only truth, so reorders/removals live in the
 * claims ledger as ONE field: `foundersMeta` = {"order": names, "removed":
 * names}. This helper applies that meta identically wherever founders render
 * (candidate workspace) or flow onward (deal boarding prefill) — one function,
 * no drift.
 */
export interface FoundersMeta {
  /** Display order by founder name; names not listed append at the end. */
  order: string[];
  /** Names the team struck from the working list (case-insensitive). */
  removed: string[];
}

const norm = (n: string) => n.trim().toLowerCase();

/** Parse a foundersMeta claim value defensively — bad shapes read as null. */
export function parseFoundersMeta(value: unknown): FoundersMeta | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as { order?: unknown; removed?: unknown };
  const strings = (arr: unknown): string[] =>
    Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string") : [];
  return { order: strings(v.order), removed: strings(v.removed) };
}

/**
 * ── Entity identity across sends ────────────────────────────────────────────
 * The same startup arrives as many emails: re-sends, a second founder's copy,
 * the company renamed between drafts ("Nova AI" → "Nova (AirNova)"). The
 * inbox owes the reviewer ONE row per entity, so minting asks first: does an
 * existing candidate already carry this identity? Evidence, strongest first:
 * the same external sender, an overlapping founder email, or two shared
 * founder-name tokens with compatible company names. Internal addresses are
 * never identity evidence (the forwarder is not the founder).
 */

export interface EntitySignature {
  /** Lowered external sender; null when the sender is one of us. */
  senderEmail: string | null;
  /** Lowered external founder emails from the extraction. */
  founderEmails: string[];
  /** Founder-name tokens (lowered, 3+ chars) — "Jon Garner" → jon, garner. */
  nameTokens: string[];
  /** lower-alnum company name; "" when unknown. */
  companyBase: string;
}

export function entitySignature(input: {
  fromEmail: string | null;
  companyName: string | null;
  founders: { fullName?: string | null; email?: string | null }[];
}): EntitySignature {
  const sender = (input.fromEmail ?? "").trim().toLowerCase();
  const founderEmails = input.founders
    .map((f) => (f.email ?? "").trim().toLowerCase())
    .filter((e) => e.includes("@") && !isInternalEmail(e));
  const nameTokens = [
    ...new Set(
      input.founders.flatMap((f) =>
        (f.fullName ?? "")
          .toLowerCase()
          .split(/[^\p{L}]+/u)
          .filter((t) => t.length >= 3)
      )
    ),
  ];
  return {
    senderEmail: sender.includes("@") && !isInternalEmail(sender) ? sender : null,
    founderEmails,
    nameTokens,
    companyBase: (input.companyName ?? "").toLowerCase().replace(/[^a-z0-9]/g, ""),
  };
}

/** Same startup? Sender, founder email, or name-token+company agreement. */
export function sameEntity(a: EntitySignature, b: EntitySignature): boolean {
  if (a.senderEmail && a.senderEmail === b.senderEmail) return true;
  if (a.founderEmails.some((e) => b.founderEmails.includes(e))) return true;
  const shared = a.nameTokens.filter((t) => b.nameTokens.includes(t));
  if (shared.length >= 2) {
    const [x, y] = [a.companyBase, b.companyBase];
    // Renames stay in the family ("novaai" ⊆ "novaairnova"); two founders
    // who happen to share names across UNRELATED companies do not merge.
    if (!x || !y || x.includes(y) || y.includes(x)) return true;
  }
  return false;
}

/**
 * Filter out removed founders, then sort by the team's order. Names missing
 * from `order` keep their natural (extraction) order, after the ordered ones.
 */
export function applyFoundersMeta<T extends { name: string }>(
  list: T[],
  meta: FoundersMeta | null | undefined
): T[] {
  if (!meta) return list;
  const removed = new Set(meta.removed.map(norm));
  const kept = list.filter((f) => !removed.has(norm(f.name)));
  if (meta.order.length === 0) return kept;
  const rank = new Map(meta.order.map((n, i) => [norm(n), i] as const));
  return kept
    .map((f, i) => ({ f, i, o: rank.get(norm(f.name)) ?? Number.MAX_SAFE_INTEGER }))
    .sort((a, b) => a.o - b.o || a.i - b.i)
    .map((x) => x.f);
}
