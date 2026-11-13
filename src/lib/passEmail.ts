import "server-only";
import { randomUUID } from "crypto";
import { sql } from "./db";
import { withRetry } from "./retry";
import { logEvent, logError } from "./log";
import { callClaude, fenceUntrusted, modelJson, clampStr, UNTRUSTED_NOTICE } from "./llm";
import {
  assembleContextBudget,
  isThinContext,
  missingContextFields,
  passLengthBand,
  scrubPassDraft,
  selectPassDecision,
  type ContextSection,
  type RawDecision,
} from "./passEmailPure";

/**
 * ── The thoughtful pass ─────────────────────────────────────────────────────
 * Drafting reads EVERYTHING the system knows about a deal; the note that
 * comes back is written for the founder. The strict separation lives in the
 * prompt (reason from context, never quote it) plus a deterministic scrub
 * before anyone sees the draft. Sending goes out through the deals@ Gmail
 * connection, records itself into the deal's email history, sets the pass
 * decision, and moves the stage, so the card tells the whole story.
 */

/* ── Context assembly ─────────────────────────────────────────────────────── */

/**
 * Everything gathered about the deal before it's organized into sections.
 * Split from assembly so the thin-context check and the length calibration
 * can read the same facts the prompt does, instead of re-deriving them from
 * a flattened string.
 */
interface PassContextData {
  companyName: string;
  founderName: string | null;
  decision: RawDecision | null;
  supersededDecisions: RawDecision[];
  hasCompanyFacts: boolean;
  hasMeetings: boolean;
  hasEmailHistory: boolean;
  meetingCount: number;
  emailCount: number;
  sections: ContextSection[];
}

async function gatherPassContext(gid: string): Promise<PassContextData | null> {
  const deals = await withRetry(
    () => sql<
      {
        name: string;
        notes: string;
        stage: string;
        round: string | null;
        financing_amount: string | null;
        created_on: string | null;
      }[]
    >`select name, notes, stage, round, financing_amount, created_on::text as created_on
        from deals where gid = ${gid}`
  );
  const deal = deals[0];
  if (!deal) return null;

  const sections: ContextSection[] = [];
  sections.push({
    label: "deal",
    priority: 5,
    text: `DEAL: ${deal.name}\nStage: ${deal.stage}\nRound: ${deal.round ?? "unknown"} · Raise: ${deal.financing_amount ?? "unknown"} · First seen: ${deal.created_on ?? "unknown"}`,
  });

  // The ORIGINAL pitch extraction — company description, sector, traction,
  // valuation, website. This is the primary source of "quantitative company
  // facts" the spec asks for; deals.notes is a human-editable field that
  // often drifts or gets overwritten, so the extraction is read directly
  // from its source rather than trusted to have survived in notes.
  let hasCompanyFacts = false;
  try {
    const pitch = await withRetry(
      () => sql<{ parsed: Record<string, unknown> | null }[]>`
        select e.parsed
          from deal_candidates dc join inbound_emails e on e.id = dc.source_email_id
         where dc.promoted_deal_gid = ${gid}
         order by dc.created_at desc limit 1`
    ).catch(() => []);
    const parsed = pitch[0]?.parsed as
      | {
          oneLiner?: string | null;
          summary?: string | null;
          sector?: string | null;
          website?: string | null;
          valuation?: string | null;
          traction?: string | null;
        }
      | null
      | undefined;
    if (parsed) {
      const lines = [
        parsed.oneLiner ? `What they do: ${parsed.oneLiner}` : null,
        parsed.summary ? `Summary: ${parsed.summary}` : null,
        parsed.sector ? `Sector: ${parsed.sector}` : null,
        parsed.traction ? `Traction at the time: ${parsed.traction}` : null,
        parsed.valuation ? `Valuation/terms: ${parsed.valuation}` : null,
        parsed.website ? `Website: ${parsed.website}` : null,
      ].filter((l): l is string => l !== null);
      if (lines.length > 0) {
        hasCompanyFacts = true;
        sections.push({
          label: "companyFacts",
          priority: 5,
          text: `COMPANY FACTS (from the original pitch):\n${lines.join("\n")}`,
        });
      }
    }
  } catch {
    // extraction unavailable; the note survives on deal.notes alone
  }

  // deals.notes is what the team wrote AFTER boarding — later memo lines,
  // research, hand-typed additions, and Granola's own auto-appended
  // summaries. It's kept separate from COMPANY FACTS above so the model
  // isn't asked to guess which parts are the original pitch versus later
  // internal commentary.
  if (deal.notes?.trim()) {
    sections.push({
      label: "dealNotes",
      priority: 2,
      text: `INTERNAL DEAL NOTES (added after boarding; memo, research, meeting summaries):\n${deal.notes.slice(0, 4000)}`,
    });
  }

  // Founders: identity plus how the relationship started. introduced_by and
  // first_met_context already live on network_people but were never read
  // here — they're exactly the "how long in process" and "introducer"
  // signal the note benefits from.
  const founders = await withRetry(
    () => sql<
      {
        name: string;
        email: string | null;
        school: string | null;
        current_title: string | null;
        introduced_by: string | null;
        first_met_at: Date | null;
        first_met_context: string | null;
        context_summary: string | null;
      }[]
    >`
      select p.name, p.email, p.school, p.current_title, p.introduced_by,
             p.first_met_at, p.first_met_context, p.context_summary
        from deal_founders df join network_people p on p.id = df.person_id
       where df.deal_gid = ${gid} limit 6`
  ).catch(() => []);
  const founderName = founders.find((f) => f.name.trim())?.name.trim() ?? null;
  if (founders.length > 0) {
    sections.push({
      label: "founders",
      priority: 5,
      text: `FOUNDERS:\n${founders
        .map((f) => {
          const bits = [
            f.school ? f.school : null,
            f.current_title ?? null,
            f.introduced_by ? `introduced by ${f.introduced_by}` : null,
            f.first_met_at
              ? `known since ${f.first_met_at.toDateString()}${f.first_met_context ? ` (${f.first_met_context})` : ""}`
              : null,
            f.context_summary ?? null,
          ].filter((b): b is string => !!b);
          return `- ${f.name}${bits.length ? `: ${bits.join("; ")}` : ""}`;
        })
        .join("\n")}`,
    });
  }

  // The team's decisions: the CURRENT pass reason is the authoritative
  // source, kept structurally separate from anything recorded earlier so
  // an old, more enthusiastic decision never reads as the live view.
  const decisionRows = await withRetry(
    () => sql<{ decision: string; rationale: string | null; created_at: Date }[]>`
      select decision, rationale, created_at from deal_decisions
       where deal_gid = ${gid} order by created_at desc limit 8`
  ).catch(() => []);
  const rawDecisions: RawDecision[] = decisionRows.map((d) => ({
    decision: d.decision,
    rationale: d.rationale,
    createdAt: d.created_at.toISOString(),
  }));
  const { current, superseded } = selectPassDecision(rawDecisions);
  if (current) {
    sections.push({
      label: "decision",
      priority: 0,
      text: `DECISION (authoritative, most recent; this is why we are passing):\n${current.rationale ?? "(no rationale recorded)"}\nRecorded ${new Date(current.createdAt).toDateString()}.`,
    });
  }
  if (superseded.length > 0) {
    sections.push({
      label: "supersededDecisions",
      priority: 1,
      text: `EARLIER DECISIONS (superseded by the pass above; background only, never the current view):\n${superseded
        .map((d) => `- ${d.decision}${d.rationale ? `: ${d.rationale}` : ""} (${new Date(d.createdAt).toDateString()})`)
        .join("\n")}`,
    });
  }

  // Team comments — the closest thing to partner/IC notes this schema has.
  const comments = await withRetry(
    () => sql<{ author_name: string | null; body: string }[]>`
      select author_name, body from deal_comments
       where deal_gid = ${gid} order by created_at desc limit 10`
  ).catch(() => []);
  if (comments.length > 0) {
    sections.push({
      label: "comments",
      priority: 4,
      text: `TEAM COMMENTS (INTERNAL, never quote or attribute):\n${comments
        .map((c) => `- ${c.body.slice(0, 400)}`)
        .join("\n")}`,
    });
  }

  // Meetings and their Granola notes — what was actually discussed. The
  // most recent meeting is tagged explicitly: per the context hierarchy,
  // it outranks older ones when they'd otherwise conflict.
  let hasMeetings = false;
  let meetingCount = 0;
  try {
    const { meetingsWithNotesForDeal } = await import("./meetings");
    const { meetings, looseNotes } = await meetingsWithNotesForDeal(gid);
    meetingCount = meetings.length;
    hasMeetings = meetings.length > 0 || looseNotes.length > 0;
    const recent = meetings.slice(0, 1);
    const older = meetings.slice(1, 6);
    const line = (m: (typeof meetings)[number], tag: string) => {
      const when = new Date(m.startsAt).toDateString();
      const note = m.granola?.summary ? ` Notes: ${m.granola.summary.slice(0, 900)}` : "";
      return `- ${m.title || "Meeting"} (${when})${tag}.${note}`;
    };
    if (recent.length > 0) {
      sections.push({
        label: "recentMeeting",
        priority: 5,
        text: `MOST RECENT MEETING:\n${recent.map((m) => line(m, " [most recent]")).join("\n")}`,
      });
    }
    const olderLines = [
      ...older.map((m) => line(m, "")),
      ...looseNotes
        .slice(0, 3)
        .map((n) => `- Note: ${n.title ?? "Meeting note"}. ${(n.summary ?? "").slice(0, 700)}`),
    ];
    if (olderLines.length > 0) {
      sections.push({
        label: "olderMeetings",
        priority: 2,
        text: `EARLIER MEETINGS AND NOTES:\n${olderLines.join("\n")}`,
      });
    }
  } catch {
    // meetings unavailable; the note survives without them
  }

  // Email history: cadence plus the last few substantive messages.
  let hasEmailHistory = false;
  let emailCount = 0;
  try {
    const { emailHistoryForDeal } = await import("./dealEmails");
    const hist = await emailHistoryForDeal(gid);
    if (hist.stats.total > 0) {
      hasEmailHistory = true;
      emailCount = hist.stats.total;
      const substantive = hist.messages.filter((m) => !m.isEvent).slice(0, 5);
      sections.push({
        label: "emailHistory",
        priority: 3,
        text: [
          `EMAIL RELATIONSHIP: ${hist.stats.total} messages (${hist.stats.founder} from the founders), first ${hist.stats.first ?? "?"}, last ${hist.stats.last ?? "?"}.`,
          substantive.length > 0
            ? `RECENT EMAILS:\n${substantive
                .map(
                  (m) =>
                    `- ${m.sentAt ? new Date(m.sentAt).toDateString() : "undated"} · ${m.sender.category}: ${(m.subject ?? "").slice(0, 90)}\n  ${(m.body ?? "").slice(0, 400)}`
                )
                .join("\n")}`
            : null,
        ]
          .filter(Boolean)
          .join("\n"),
      });
    }
  } catch {
    // no mail context
  }

  return {
    companyName: deal.name,
    founderName,
    decision: current,
    supersededDecisions: superseded,
    hasCompanyFacts,
    hasMeetings,
    hasEmailHistory,
    meetingCount,
    emailCount,
    sections,
  };
}

const CONTEXT_BUDGET_CHARS = 24_000;

async function buildPassContext(
  gid: string
): Promise<{ text: string; data: PassContextData } | null> {
  const data = await gatherPassContext(gid);
  if (!data) return null;
  return { text: assembleContextBudget(data.sections, CONTEXT_BUDGET_CHARS), data };
}

/* ── Drafting ─────────────────────────────────────────────────────────────── */

/**
 * Built once per draft rather than as one static string, because the one
 * variable that most changes what a good note looks like is how deep the
 * relationship went — the same fixed prompt can't honestly cover both a
 * two-line reply to a cold inbound and a 500-word note after an IC process.
 */
function passSystemPrompt(length: { min: number; max: number; label: string }): string {
  return `You are drafting a founder-facing pass note on behalf of an early-stage venture investor. Your job is not merely to produce a polite rejection. Your job is to communicate the investment decision with honesty, specificity, good judgment, and respect for the founder's time.

First, silently analyze the supplied context. Determine:
1. The exact investment decision.
2. The strongest thing genuinely appreciated about the company, supported by the context.
3. The primary reason for passing.
4. At most one additional reason, only if it materially affected the decision.
5. The concrete evidence supporting each reason.
6. Whether the decision reflects a company risk, a fund constraint, a timing issue, or some combination.
7. Whether there is a genuine, specific condition under which the company would be revisited.
8. Whether a real offer to help was made that should be repeated.
Do not reveal this analysis. Use it to write the note.

CONTEXT PRIORITY. The DECISION section is the explicit, authoritative reason for passing; nothing may override it. A section marked EARLIER DECISIONS or superseded is background only, never the current view, even if it reads more enthusiastic. The MOST RECENT MEETING outranks earlier meetings when they'd otherwise conflict. If two sources conflict and the sequence isn't clear, do not silently pick one; omit the disputed detail rather than guess. Never let your own inference override an explicit recorded decision.

STRUCTURE, not a fill-in-the-blank template:
1. Personal acknowledgment. Thank the founder for the conversation or process. Name one specific idea, product insight, customer observation, or founder quality that genuinely stood out, only if the context actually supports it. Never praise something the context doesn't back up.
2. Clear decision, stated early, normally the first or second paragraph. Say plainly that you are not moving forward. Never bury the decision under several paragraphs of compliments, and never leave it ambiguous.
3. Actual reasoning. A useful pass reason has three parts: the relevant fact or observation, the concern it creates, and why that concern prevents investing today. Specify what's actually unproven or missing rather than gesturing at it. If the reason is a fund constraint (stage, check size, ownership, sector fit), own that directly; do not disguise a portfolio-construction issue as criticism of the company.
4. Appropriate close. If the pass is final, close warmly without manufacturing an invitation to keep sending updates. If genuinely conditional, name the precise reopening condition (a specific milestone, metric, or proof point), never a vague "keep us posted." Only offer introductions, recruiting help, or other assistance if the context shows it's real and intended.

REASON SELECTION. Choose one primary reason. Add a second only when it materially improves the founder's understanding. This is not an investment committee memo; do not list every possible risk. When evidence is incomplete, write "we weren't able to develop conviction that..." or "we still had an open question around...", never state an uncertain judgment as objective fact.

CONFIDENTIALITY. Never reveal partner disagreements, individual votes, confidential reference feedback, information from another company, comparisons to portfolio companies, internal scores, or sensitive personal assessments. A team-related concern may appear only if central to the decision, expressed as a capability the business needs rather than a personal judgment. Bad: "we didn't think the team was strong enough." Better: "we'd want to see deeper commercial leadership given how much the wedge depends on navigating enterprise procurement."

SPECIFICITY. Use specific details only when the provided context supports them; never invent a reason, a number, a customer, or a metric. Don't force a numerical detail into the note when it may be stale or confidential. The founder's correct name and the company's correct name are required.

TONE. Thoughtful, direct, warm, calm, intellectually honest, specific, respectful, confident without sounding absolute. Never fawning, robotic, legalistic, condescending, apologetic, euphemistic, or full of venture cliches. Never sound like a performance review or a generic AI email.

The note must read like something a busy, attentive person wrote themselves, not something generated. Use contractions. Use plain words. Vary sentence length; let one sentence be short. Never start consecutive sentences the same way. No symmetrical three-part paragraph structures. Never stack multiple compliments before the decision.

Never use these words: "genuinely", "truly", "incredibly", "impressive", "excited", "journey". Never use these phrases: "at this juncture", "ultimately", "that being said", "with that in mind", "we remain impressed", "this was an incredibly difficult decision", "it is simply too early", "the space is too crowded", "we need to see more traction", "this is not a fit for our thesis", "we could not get comfortable", "please keep us updated" without a real reason attached, "we wish you the best on your journey", "thank you for the opportunity", "we were incredibly impressed", "it was a difficult decision", "this is not a reflection of the quality of the business", "we have decided not to move forward at this time", "we reviewed what you're building".

Never use an em dash.

LENGTH. This relationship is at the depth of "${length.label}." Write between ${length.min} and ${length.max} words. Do not write a long critique after a single brief call, and do not send a short form rejection after real diligence.

FORMATTING. Separate paragraphs with one blank line. Use natural paragraphs; no headings or bullet points unless the diligence was extensive enough that several genuinely distinct concerns need separating. The sign-off is exactly two adjacent lines with no blank line between them:
Rooting for you,
<sender first name>

Before returning the note, silently verify: is the pass unambiguous and stated early; is there at least one company-specific detail; is the primary reason clear with why it matters; is every claim supported by the context; is investor judgment distinguished from objective fact; does the length match the diligence depth; are there any em dashes to fix; is there any internal or confidential detail to remove; are the founder name, company name, and any numbers correct.

Reply with ONLY this JSON, no prose: {"subject": "...", "body": "..."}
The subject stays simple and specific, like "Following up on <Company>". Never use "Investment Decision" or "Rejection" in the subject. The body starts "Hi <first name>," and ends with the sign-off above. Use \\n\\n between paragraphs in the JSON string and \\n between the two sign-off lines.

${UNTRUSTED_NOTICE}`;
}

export interface PassDraftResult {
  subject: string;
  body: string;
  /** True when there isn't enough real signal to write a genuine note —
   *  no recorded pass reason and no company facts, meetings, or email
   *  history to ground one. The draft below is still the best honest
   *  attempt; this flags that it's thin so a human knows before sending. */
  needsMoreContext?: boolean;
  missingContext?: string[];
}

export async function draftPassEmail(
  gid: string,
  opts: {
    mode: "replace" | "improve";
    currentDraft?: string | null;
    senderFirstName: string;
  }
): Promise<PassDraftResult | null> {
  const built = await buildPassContext(gid);
  if (!built) return null;
  const { text: context, data } = built;

  const signals = {
    hasPassReason: data.decision !== null,
    hasCompanyFacts: data.hasCompanyFacts,
    hasMeetings: data.hasMeetings,
    hasEmailHistory: data.hasEmailHistory,
    hasFounderName: !!data.founderName,
    hasCompanyName: !!data.companyName,
  };
  const thin = isThinContext(signals);
  const length = passLengthBand({
    meetingCount: data.meetingCount,
    emailCount: data.emailCount,
    extensiveDiligence: data.decision !== null && data.meetingCount >= 2,
  });

  const ask =
    opts.mode === "improve" && opts.currentDraft?.trim()
      ? `The investor already wrote a draft. Preserve their core language, structure, and any personal touches; make it more thoughtful and personalized with the context, and fix nothing that isn't broken.\n\nTheir current draft:\n${fenceUntrusted(opts.currentDraft, 4000)}\n\n`
      : "";

  const text = await callClaude({
    job: "pass_draft",
    model: process.env.PASS_MODEL ?? process.env.INBOUND_MODEL ?? "claude-sonnet-4-6",
    maxTokens: 1400,
    system: passSystemPrompt(length),
    content: `${ask}The sender signs as "${opts.senderFirstName}".\n\nEverything the firm knows about this deal:\n${fenceUntrusted(context, CONTEXT_BUDGET_CHARS)}`,
    timeoutMs: 45_000,
  }).catch((err) => {
    logError("pipeline", "pass draft failed", err, { gid });
    return null;
  });
  if (text === null) return null;

  const parsed = modelJson(text) as { subject?: unknown; body?: unknown } | null;
  const subject = clampStr(parsed?.subject, 140);
  const body = clampStr(parsed?.body, 4000);
  if (!subject || !body) return null;
  return {
    subject: scrubPassDraft(subject),
    body: scrubPassDraft(body),
    ...(thin
      ? { needsMoreContext: true, missingContext: missingContextFields(signals) }
      : {}),
  };
}

/* ── Sending ──────────────────────────────────────────────────────────────── */

function toBase64Url(s: string): string {
  return Buffer.from(s, "utf-8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** RFC 2047 header encoding for non-ASCII display names. */
function headerText(s: string): string {
  return /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, "utf-8").toString("base64")}?=`;
}

export async function sendPassEmail(
  gid: string,
  input: {
    /** Validated, lowered, deduped by the action; 1 to 5 recipients. */
    to: string[];
    /** Lowered, validated, deduped by the action; may be empty. */
    cc: string[];
    subject: string;
    body: string;
    sender: { email: string; name: string };
  }
): Promise<{ ok: true; messageId: string } | { ok: false; error: string }> {
  const { inboundAddress } = await import("./inboundMailbox");
  const { gmailAccessTokenFor, scopesAllowSend } = await import("./mailSync");

  // The note sends AS the member, from their own connected mailbox — a
  // founder replies to the partner, not to a shared robot address.
  const conns = await sql<
    { id: string; address: string; refresh_token_enc: string; scopes: string; status: string }[]
  >`
    select id, address, refresh_token_enc, scopes, status
      from mailbox_connections
     where lower(address) = ${input.sender.email.toLowerCase()}
     limit 1`;
  const conn = conns[0];
  if (!conn) {
    return {
      ok: false,
      error: `Your mailbox (${input.sender.email}) isn't connected. Connect it in Settings, then send.`,
    };
  }
  if (!scopesAllowSend(conn.scopes)) {
    return {
      ok: false,
      error: `Sending as ${input.sender.email} needs one more permission. Reconnect your mailbox in Settings (Mail sync) and try again.`,
    };
  }
  const token = await gmailAccessTokenFor(conn as never).catch(() => null);
  if (!token) {
    return {
      ok: false,
      error: `Your mailbox connection needs a reconnect (Settings, Mail sync) before it can send.`,
    };
  }
  const fromAddr = input.sender.email.toLowerCase();

  // The shared inbox (if one is configured) rides along so it archives the send; the
  // ingest side recognizes our own outbound copies and never re-triages.
  const to = input.to.map((e) => e.toLowerCase());
  const cc = [...new Set([...input.cc, inboundAddress().toLowerCase()])].filter(
    (e) => e !== "" && !to.includes(e) && e !== fromAddr
  );
  // A stable RFC id marks the message as ours across every mailbox copy.
  const rfcId = `<pass-${gid}-${randomUUID()}@${fromAddr.split("@")[1] ?? "localhost"}>`;
  const mime = [
    `From: ${headerText(input.sender.name)} <${fromAddr}>`,
    `To: ${to.map((e) => `<${e}>`).join(", ")}`,
    ...(cc.length > 0 ? [`Cc: ${cc.map((e) => `<${e}>`).join(", ")}`] : []),
    `Subject: ${headerText(input.subject)}`,
    `Message-ID: ${rfcId}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: 8bit",
    "",
    input.body,
  ].join("\r\n");

  const res = await fetch(
    "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ raw: toBase64Url(mime) }),
      signal: AbortSignal.timeout(30_000),
    }
  );
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300);
    logError("pipeline", "pass email send failed", new Error(detail), { gid });
    return { ok: false, error: `Gmail refused the send (${res.status}). Nothing was sent.` };
  }
  const sent = (await res.json()) as { id?: string; threadId?: string };
  const messageId = sent.id ?? "";

  // Record the sent note into the deal's email history store immediately —
  // the reader unions email_messages by founder address, so this shows up
  // on the card without waiting for a mailbox sync.
  try {
    const { ensureMailSchema } = await import("./mailSync");
    await ensureMailSchema();
    const threadRows = await sql<{ id: string }[]>`
      insert into email_threads (provider_thread_key, subject_norm, first_message_at, last_message_at, participants, deal_gid)
      values (${sent.threadId ?? `pass-${messageId}`}, ${input.subject.toLowerCase().slice(0, 300)}, now(), now(),
              ${sql.json([...to.map((e) => ({ email: e })), { email: fromAddr }] as never)}, ${gid})
      on conflict (provider_thread_key) do update set last_message_at = now()
      returning id`;
    await sql`
      insert into email_messages
        (thread_id, provider_message_key, direction, from_addr, to_addrs, cc_addrs, sent_at, snippet, body_text, headers)
      values
        (${threadRows[0].id}, ${messageId || `pass-${gid}-${Date.now()}`}, 'outbound',
         ${sql.json({ name: input.sender.name, email: fromAddr } as never)},
         ${sql.json(to.map((e) => ({ email: e })) as never)},
         ${sql.json(cc.map((e) => ({ email: e })) as never)}, now(),
         ${input.body.replace(/\s+/g, " ").slice(0, 400)},
         ${input.body.slice(0, 40_000)},
         ${sql.json({ Subject: input.subject, "Message-Id": rfcId } as never)})
      on conflict (provider_message_key) do nothing`;
  } catch (err) {
    logError("pipeline", "pass email history record failed", err, { gid });
  }

  // The decision and the stage move: the card now says passed, honestly.
  try {
    const { setDealDecision } = await import("./decisions");
    await setDealDecision(gid, input.sender, "pass", `Pass note sent to ${to.join(", ")}.`);
  } catch (err) {
    logError("pipeline", "pass decision record failed", err, { gid });
  }
  try {
    const { fetchSections } = await import("./sections");
    const sections = await fetchSections().catch(() => []);
    const passed = sections.find((s) => s.stage === "passed") ?? sections.find((s) => s.stage === "to-pass");
    if (passed) {
      await sql`
        update deals set stage = ${passed.stage}, section_gid = ${passed.gid},
          modified_on = current_date, synced_at = now()
        where gid = ${gid}`;
    }
  } catch (err) {
    logError("pipeline", "pass stage move failed", err, { gid });
  }

  logEvent("info", "pipeline", "pass email sent", { gid, to: to.join(", "), from: fromAddr });
  return { ok: true, messageId };
}
