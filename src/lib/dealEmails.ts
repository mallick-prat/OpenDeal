import "server-only";
import { sql } from "./db";
import { withRetry } from "./retry";
import { logError } from "./log";
import { canExpandToDomain } from "./emailDomains";
import { founderEmailsForDeal } from "./identityEvidence";
import { INTERNAL_DOMAINS } from "./companiesPure";
import { crm } from "@/config/crm.config";

/**
 * ── The deal's email history, normalized ────────────────────────────────────
 * One relationship, one list. Two stores feed it:
 *   · inbound_emails — mail filed under the deal (deals@ pitches, updates)
 *   · email_messages — the team's synced mailboxes, matched by the founders'
 *     addresses and their corporate domain (full bodies included)
 * Messages dedupe by Gmail id, categorize by sender (founder / internal /
 * external), split their own content from quoted history, and group into
 * conversations by normalized subject. Calendar notifications become compact
 * event rows, never "messages from the founder". Presentation never sees a
 * provider — only this shape.
 */

export interface HistoryAddress {
  name: string | null;
  email: string;
}

export interface HistoryMessage {
  id: string;
  threadKey: string;
  sentAt: string | null;
  subject: string | null;
  sender: { name: string | null; email: string | null; category: "founder" | "internal" | "external" };
  to: HistoryAddress[];
  cc: HistoryAddress[];
  /** The message's own content, complete. */
  body: string | null;
  /** Quoted reply history, collapsed behind a toggle. */
  quoted: string | null;
  preview: string | null;
  attachments: { name: string }[];
  deckLinks: { url: string; kind: string | null }[];
  /** Automated calendar notification — rendered as a compact event row. */
  isEvent: boolean;
  /** Deep link into Gmail when a Message-Id is known. */
  gmailUrl: string | null;
}

export interface HistoryStats {
  total: number;
  founder: number;
  team: number;
  first: string | null;
  last: string | null;
  threads: number;
  /** Who the ball is with, from the last substantive message — null if unclear. */
  awaiting: "team" | "founder" | null;
}

export interface DealDocument {
  url: string | null;
  filename: string | null;
  kind: string | null;
  fromSubject: string | null;
  receivedAt: string | null;
}

export interface DealEmailHistory {
  messages: HistoryMessage[];
  stats: HistoryStats;
  documents: DealDocument[];
  /** False when the deal has no founder addresses to search by. */
  foundersKnown: boolean;
}

const EVENT_RE =
  /^(accepted|declined|tentative|invitation|updated invitation|cancell?ed)/i;

const subjectNorm = (subj: string | null): string =>
  (subj ?? "")
    .replace(/^\s*(?:(?:re|fwd?|fw)\s*:\s*)+/i, "")
    .trim()
    .toLowerCase();

/** Split a body into its own content and the quoted tail. */
function splitQuoted(body: string | null): { body: string | null; quoted: string | null } {
  if (!body) return { body: null, quoted: null };
  const markers = [
    /^On .{5,120} wrote:\s*$/m,
    /^-{3,}\s*Forwarded message\s*-{3,}/m,
    /^_{10,}\s*$/m,
    /^From:\s.+$/m,
  ];
  let cut = body.length;
  for (const m of markers) {
    const hit = body.match(m);
    if (hit?.index !== undefined && hit.index > 0 && hit.index < cut) cut = hit.index;
  }
  const own = body.slice(0, cut).trim();
  const quoted = body.slice(cut).trim();
  return {
    body: (own || body.trim()).slice(0, 12_000) || null,
    quoted: own && quoted ? quoted.slice(0, 10_000) : null,
  };
}

function isInternal(email: string | null | undefined): boolean {
  const e = (email ?? "").toLowerCase();
  return INTERNAL_DOMAINS.has(e.slice(e.lastIndexOf("@") + 1));
}

export async function emailHistoryForDeal(gid: string): Promise<DealEmailHistory> {
  const empty: DealEmailHistory = {
    messages: [],
    stats: { total: 0, founder: 0, team: 0, first: null, last: null, threads: 0, awaiting: null },
    documents: [],
    foundersKnown: false,
  };
  try {
    // Who counts as "the founder": their addresses plus corporate domain —
    // from the ONE identity service, so this list can never disagree with
    // what the matchers consider founder evidence.
    const founderList = await founderEmailsForDeal(gid);
    const founderEmails = new Set(founderList);
    const founderDomains = [
      ...new Set(founderList.map((e) => e.split("@")[1]).filter((d) => canExpandToDomain(d))),
    ];

    const [inboundRows, syncedRows] = await Promise.all([
      withRetry(
        () => sql<
          {
            gmail_message_id: string;
            subject: string | null;
            from_name: string | null;
            from_email: string | null;
            received_at: Date | null;
            body_text: string | null;
            snippet: string | null;
            deck_links: { url?: string; kind?: string }[] | null;
            attachments: { filename?: string }[] | null;
          }[]
        >`
          select gmail_message_id, subject, from_name, from_email, received_at,
                 body_text, snippet, deck_links, attachments
            from inbound_emails
           where deal_gid = ${gid}
           order by received_at desc nulls last
           limit 60
        `
      ).catch(() => []),
      founderList.length > 0
        ? withRetry(
            () => sql<
              {
                provider_message_key: string;
                sent_at: Date | null;
                from_addr: { name?: string; email?: string } | null;
                to_addrs: { name?: string; email?: string }[] | null;
                cc_addrs: { name?: string; email?: string }[] | null;
                subject: string | null;
                message_id_hdr: string | null;
                body_text: string | null;
                snippet: string | null;
              }[]
            >`
              select provider_message_key, sent_at, from_addr, to_addrs, cc_addrs,
                     coalesce(m.headers->>'Subject', m.headers->>'subject') as subject,
                     coalesce(m.headers->>'Message-Id', m.headers->>'Message-ID') as message_id_hdr,
                     body_text, snippet
                from email_messages m
               where lower(m.from_addr->>'email') = any(${founderList})
                  or (${founderDomains.length > 0} and split_part(lower(m.from_addr->>'email'), '@', 2) = any(${founderDomains}))
                  or exists (
                    select 1 from jsonb_array_elements(coalesce(m.to_addrs, '[]'::jsonb) || coalesce(m.cc_addrs, '[]'::jsonb)) t
                     where lower(t->>'email') = any(${founderList})
                        or (${founderDomains.length > 0} and split_part(lower(t->>'email'), '@', 2) = any(${founderDomains}))
                  )
               order by sent_at desc nulls last
               limit 100
            `
          ).catch(() => [])
        : Promise.resolve([]),
    ]);

    const seen = new Set<string>();
    const messages: HistoryMessage[] = [];
    const addr = (a: { name?: string; email?: string } | null | undefined): HistoryAddress | null =>
      a?.email ? { name: a.name ?? null, email: a.email.toLowerCase() } : null;
    const category = (email: string | null): HistoryMessage["sender"]["category"] => {
      const e = (email ?? "").toLowerCase();
      if (founderEmails.has(e)) return "founder";
      if (founderDomains.includes(e.split("@")[1] ?? "")) return "founder";
      if (isInternal(e)) return "internal";
      return "external";
    };
    const noReply = (email: string | null) =>
      /(calendar-notification|no-?reply|notifications?@|mailer-daemon)/.test((email ?? "").toLowerCase());

    for (const r of syncedRows) {
      if (seen.has(r.provider_message_key)) continue;
      seen.add(r.provider_message_key);
      const split = splitQuoted(r.body_text ?? r.snippet ?? null);
      const fromEmail = r.from_addr?.email?.toLowerCase() ?? null;
      const isEvent = EVENT_RE.test(r.subject ?? "") || noReply(fromEmail);
      messages.push({
        id: r.provider_message_key,
        threadKey: subjectNorm(r.subject) || `solo-${r.provider_message_key}`,
        sentAt: r.sent_at ? r.sent_at.toISOString() : null,
        subject: r.subject,
        sender: { name: r.from_addr?.name ?? null, email: fromEmail, category: category(fromEmail) },
        to: (r.to_addrs ?? []).map(addr).filter((a): a is HistoryAddress => !!a),
        cc: (r.cc_addrs ?? []).map(addr).filter((a): a is HistoryAddress => !!a),
        body: split.body,
        quoted: split.quoted,
        preview: (r.snippet ?? split.body ?? "").replace(/\s+/g, " ").slice(0, 140) || null,
        attachments: [],
        deckLinks: [],
        isEvent,
        gmailUrl: r.message_id_hdr
          ? `https://mail.google.com/mail/u/0/#search/rfc822msgid:${encodeURIComponent(
              r.message_id_hdr.replace(/^<|>$/g, "")
            )}`
          : null,
      });
    }
    for (const r of inboundRows) {
      if (seen.has(r.gmail_message_id)) continue;
      seen.add(r.gmail_message_id);
      const split = splitQuoted(r.body_text ?? r.snippet ?? null);
      const fromEmail = r.from_email?.toLowerCase() ?? null;
      messages.push({
        id: r.gmail_message_id,
        threadKey: subjectNorm(r.subject) || `solo-${r.gmail_message_id}`,
        sentAt: r.received_at ? r.received_at.toISOString() : null,
        subject: r.subject,
        sender: { name: r.from_name, email: fromEmail, category: category(fromEmail) },
        to: [{ name: null, email: crm.inbound.address || "shared inbox" }],
        cc: [],
        body: split.body,
        quoted: split.quoted,
        preview: (r.snippet ?? split.body ?? "").replace(/\s+/g, " ").slice(0, 140) || null,
        attachments: (r.attachments ?? [])
          .filter((a): a is { filename: string } => !!a?.filename)
          .map((a) => ({ name: a.filename })),
        deckLinks: (r.deck_links ?? [])
          .filter((l): l is { url: string; kind?: string } => !!l?.url)
          .map((l) => ({ url: l.url, kind: l.kind ?? null })),
        isEvent: EVENT_RE.test(r.subject ?? ""),
        gmailUrl: null,
      });
    }

    messages.sort((a, b) => (a.sentAt ?? "").localeCompare(b.sentAt ?? ""));
    const capped = messages.slice(-120);

    const substantive = capped.filter((m) => !m.isEvent);
    const founderCount = substantive.filter((m) => m.sender.category !== "internal").length;
    const teamCount = substantive.filter((m) => m.sender.category === "internal").length;
    const lastSub = substantive[substantive.length - 1] ?? null;
    const stats: HistoryStats = {
      total: substantive.length,
      founder: founderCount,
      team: teamCount,
      first: substantive[0]?.sentAt ?? null,
      last: lastSub?.sentAt ?? null,
      threads: new Set(substantive.map((m) => m.threadKey)).size,
      awaiting:
        lastSub === null
          ? null
          : lastSub.sender.category === "founder"
            ? "team"
            : lastSub.sender.category === "internal"
              ? "founder"
              : null,
    };

    // Documents: every deck link and attachment across the trail, deduped.
    const documents: DealDocument[] = [];
    const seenDoc = new Set<string>();
    for (const m of [...capped].reverse()) {
      for (const l of m.deckLinks) {
        if (seenDoc.has(l.url)) continue;
        seenDoc.add(l.url);
        documents.push({ url: l.url, filename: null, kind: l.kind, fromSubject: m.subject, receivedAt: m.sentAt });
      }
      for (const a of m.attachments) {
        const key = `file:${a.name}`;
        if (seenDoc.has(key)) continue;
        seenDoc.add(key);
        documents.push({ url: null, filename: a.name, kind: "attachment", fromSubject: m.subject, receivedAt: m.sentAt });
      }
    }

    return { messages: capped, stats, documents, foundersKnown: founderList.length > 0 };
  } catch (err) {
    logError("pipeline", "emailHistoryForDeal failed", err, { gid });
    return empty;
  }
}
