import "server-only";
import {
  dealStub,
  getCandidate,
  openCandidateQueue,
  type CandidateView,
} from "./candidates";
import { claimsFor } from "./claims";
import { isHumanClaim, type FieldClaims } from "./claimsPure";
import {
  applyFoundersMeta,
  missingSlots,
  parseFoundersMeta,
  type ParsedSummary,
} from "./candidatesPure";
import { teamHistoryFor, type TeamHistory } from "./teamHistory";
import type { DocumentRow } from "./documents";
import type { DealPrefill } from "@/components/CreateDealModal";

/**
 * ── The candidate payload: one candidate's whole workspace, serialized ──────
 * Everything /inbox/[id] used to compute server-side per view, assembled once
 * so the server page AND the payload actions share one implementation. The
 * triage miniapp swaps these objects client-side — no route navigation.
 *
 * Split in two stages so a page turn never waits on slow reads:
 *  · CORE — the candidate itself, parsed facts, claims ledger, prefill. One
 *    fast query pair; enough to render the whole above-the-fold workspace.
 *  · EXTRAS — team history + stored documents (the slow, join-heavy reads).
 *    They live below the fold and fade in when they land.
 */

/** The extraction as the workspace reads it (superset of ParsedSummary). */
export type ParsedCandidate = Omit<ParsedSummary, "founders"> & {
  summary?: string | null;
  sector?: string | null;
  website?: string | null;
  location?: string | null;
  valuation?: string | null;
  traction?: string | null;
  founders?: {
    fullName?: string;
    email?: string;
    linkedinUrl?: string;
    title?: string;
    school?: string | null;
  }[];
};

/** Stage 1 — everything a page turn needs to render instantly. */
export interface CandidateCore {
  candidate: CandidateView;
  parsed: ParsedCandidate | null;
  /** Normalized (always arrays) views of the source email's links/files. */
  deckLinks: { url: string; kind: string }[];
  attachments: { filename: string; mimeType: string; size: number }[];
  /** "Known / missing" slots — facts about the thread, never invented. */
  missing: string[];
  /** The provenance ledger, grouped by field with the winner resolved. */
  claims: Record<string, FieldClaims>;
  /** Whether triage actions apply (not approved/attached/passed/ignored). */
  isOpenStatus: boolean;
  /** A live deal this email is about (DD questions, a follow-up): file it there. */
  proposedDeal: { gid: string; name: string; stage: string } | null;
  /** The full boarding form seed, claims folded in. */
  dealPrefill: DealPrefill;
}

/** Stage 2 — the slow below-the-fold reads. */
export interface CandidateExtras {
  storedDocs: DocumentRow[];
  history: TeamHistory | null;
  /** What the calendar knows about this company: met before? meeting soon? */
  meetingContext: import("./dealContext").ContextPreview | null;
}

export interface CandidatePayload extends CandidateCore, CandidateExtras {
  /** The viewer's open queue at assembly time, priority-ordered. */
  queue: string[];
  /** True when the boot skipped extras — the client fetches them instead. */
  extrasPending?: boolean;
}

/** Stage 1 body: one claims read; everything else derives from the row. */
async function coreOf(c: CandidateView): Promise<CandidateCore> {
  const parsed = (c.parsed ?? null) as ParsedCandidate | null;
  const deckLinks = Array.isArray(c.deck_links) ? c.deck_links : [];
  const attachments = Array.isArray(c.attachments) ? c.attachments : [];
  const missing = missingSlots(parsed, deckLinks.length + attachments.length > 0);

  const [claims, proposedDeal] = await Promise.all([
    claimsFor("candidate", c.id).catch(() => ({}) as Record<string, FieldClaims>),
    c.proposed_deal_gid && !c.promoted_deal_gid
      ? dealStub(c.proposed_deal_gid).catch(() => null)
      : Promise.resolve(null),
  ]);

  const isOpenStatus = !["approved", "attached", "passed", "ignored"].includes(c.status);

  // The full boarding form, seeded from the pitch. Notes carry the summary,
  // metrics, links, and a provenance line back to the source email.
  const prefillFounders = (parsed?.founders ?? [])
    .filter((f) => f.fullName?.trim())
    .map((f) => {
      const name = f.fullName!.trim();
      const li = claims[`founderLinkedin:${name}`]?.current;
      const sch = claims[`founderSchool:${name}`]?.current;
      return {
        name,
        school: f.school ?? (typeof sch?.value === "string" ? sch.value : ""),
        linkedin:
          f.linkedinUrl ??
          (li && isHumanClaim(li) && typeof li.value === "string" ? li.value : ""),
        // The extraction usually catches the founder's address — carry it
        // onto the boarding form instead of making the reviewer re-type it.
        email: f.email?.trim().toLowerCase() ?? "",
      };
    })
    .concat(
      // Web-discovered founders join the deal once their LinkedIn is
      // human-confirmed — discovery alone doesn't board anyone.
      Object.entries(claims)
        .filter(([k]) => k.startsWith("founderDiscovered:"))
        .map(([k]) => k.slice("founderDiscovered:".length))
        .filter(
          (n) =>
            !(parsed?.founders ?? []).some(
              (f) => (f.fullName ?? "").trim().toLowerCase() === n.toLowerCase()
            )
        )
        .flatMap((n) => {
          const li = claims[`founderLinkedin:${n}`]?.current;
          if (!li || !isHumanClaim(li) || typeof li.value !== "string" || !li.value) return [];
          const sch = claims[`founderSchool:${n}`]?.current;
          return [{
            name: n,
            school: typeof sch?.value === "string" ? sch.value : "",
            linkedin: li.value,
            email: "",
          }];
        })
    );

  const dealPrefill: DealPrefill = {
    company: parsed?.companyName ?? "",
    financing: parsed?.raiseAmount ?? "",
    round: parsed?.round ?? "",
    // The team's arrangement (foundersMeta reorders/removals) carries onto
    // the boarding form — the deal matches what the reviewer laid out.
    founders: applyFoundersMeta(
      prefillFounders,
      parseFoundersMeta(claims["foundersMeta"]?.current?.value)
    ),
    notes: [
      parsed?.oneLiner,
      parsed?.summary,
      parsed?.traction ? `Traction: ${parsed.traction}` : null,
      parsed?.sector ? `Sector: ${parsed.sector}` : null,
      parsed?.website ? `Website: ${parsed.website}` : null,
      deckLinks.length
        ? `Decks:\n${deckLinks.map((d) => `• (${d.kind}) ${d.url}`).join("\n")}`
        : null,
      `Ingested from the inbox — "${c.subject ?? ""}" (${c.from_email ?? "unknown"})`,
    ]
      .filter(Boolean)
      .join("\n\n"),
  };

  return {
    candidate: c,
    parsed,
    deckLinks,
    attachments,
    missing,
    claims,
    isOpenStatus,
    proposedDeal,
    dealPrefill,
  };
}

/** Stage 2 body: the slow reads (documents + team history), in parallel. */
async function extrasOf(c: CandidateView): Promise<CandidateExtras> {
  const parsed = (c.parsed ?? null) as ParsedCandidate | null;
  const founderEmails = (parsed?.founders ?? [])
    .map((f) => f.email ?? "")
    .filter(Boolean);
  const website = (parsed?.website ?? "")
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split("/")[0];
  const [storedDocs, meetingContext, history] = await Promise.all([
    c.source_email_id
      ? import("./documents").then((m) =>
          c.gmail_thread_id
            ? m.listDocumentsForThread(c.gmail_thread_id)
            : m.listDocumentsForEmail(c.source_email_id!)
        )
      : Promise.resolve([] as DocumentRow[]),
    // The triage decision changes when you know you already met them — or
    // that they're on the calendar for Tuesday. Read-only, evidence-joined.
    import("./dealContext")
      .then((m) =>
        m.previewDealContext({
          emails: founderEmails,
          domains: website ? [website] : [],
        })
      )
      .catch(() => null),
    teamHistoryFor({
      companyName: parsed?.companyName,
      website: parsed?.website,
      senderEmail: c.from_email,
      founderNames: (parsed?.founders ?? [])
        .map((f) => f.fullName ?? "")
        .filter(Boolean),
      founderEmails: (parsed?.founders ?? [])
        .map((f) => f.email ?? "")
        .filter(Boolean),
      excludeEmailId: c.source_email_id,
    }),
  ]);
  return { storedDocs, history, meetingContext };
}

// structuredClone (below, everywhere): postgres.js rows ride in Array
// subclasses (RowList) — clone down to plain objects/arrays so payloads
// serialize cleanly through both RSC props and server-action returns.

/** Stage 1 alone — the fast read a page turn waits on. Null: gone/hidden. */
export async function buildCandidateCore(
  id: string,
  viewerEmail: string
): Promise<CandidateCore | null> {
  const c = await getCandidate(id, viewerEmail);
  if (!c) return null;
  return structuredClone(await coreOf(c));
}

/** Batched stage 1 — one action round trip warms many queue slots at once. */
export async function buildCandidateCores(
  ids: string[],
  viewerEmail: string
): Promise<Record<string, CandidateCore>> {
  const results = await Promise.all(
    ids.map((id) => buildCandidateCore(id, viewerEmail).catch(() => null))
  );
  const cores: Record<string, CandidateCore> = {};
  ids.forEach((id, i) => {
    const core = results[i];
    if (core) cores[id] = core;
  });
  return cores;
}

/** Stage 2 alone — fetched in the background, never blocks a turn. */
export async function buildCandidateExtras(
  id: string,
  viewerEmail: string
): Promise<CandidateExtras | null> {
  const c = await getCandidate(id, viewerEmail);
  if (!c) return null;
  return structuredClone(await extrasOf(c));
}

/**
 * Assemble the workspace for one candidate (server page boot). Returns null
 * when the candidate doesn't exist or the viewer can't see it (visibility
 * rules). With `extras: false` the boot skips the slow stage entirely —
 * first paint waits only on core + queue, and the client fades extras in
 * exactly the way it already does for every later card in the session.
 */
export async function buildCandidatePayload(
  id: string,
  viewerEmail: string,
  opts: { extras?: boolean } = {}
): Promise<CandidatePayload | null> {
  const c = await getCandidate(id, viewerEmail);
  if (!c) return null;
  const wantExtras = opts.extras !== false;
  const [core, extras, queue] = await Promise.all([
    coreOf(c),
    wantExtras
      ? extrasOf(c)
      : Promise.resolve<CandidateExtras>({ storedDocs: [], history: null, meetingContext: null }),
    openCandidateQueue(viewerEmail),
  ]);
  return structuredClone({
    ...core,
    ...extras,
    queue,
    ...(wantExtras ? {} : { extrasPending: true as const }),
  });
}
