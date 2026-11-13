import { NextResponse } from "next/server";
import { ingestSince } from "@/lib/inbound";
import { logError, logEvent } from "@/lib/log";
import { record } from "@/lib/perf";
import { isCronAuthorized } from "@/lib/cronAuth";
import { inboundConfigured } from "@/lib/inboundMailbox";

export const maxDuration = 120;

/**
 * Inbound mailbox pull + queue heal + pending reparse. Deliberately narrow —
 * no calendar, no digest. Vercel cron runs this on the schedule in
 * vercel.json (every ten minutes on Pro, daily on Hobby), which is the sync floor: a pitch is never more than
 * ~10 minutes from the queue even with push unarmed. An idle tick costs one
 * Gmail history read and nothing else. Gmail push (Pub/Sub) remains the true
 * real-time path once GMAIL_PUBSUB_TOPIC is set; this is the floor under it.
 * Every step is fenced and idempotent, so overlapping runs are harmless.
 */

function cronAuthorized(req: Request): boolean {
  return isCronAuthorized(req);
}

async function run(full: boolean) {
  const t0 = Date.now();
  // No inbound mailbox configured: nothing to ingest. (Not an error.)
  if (!inboundConfigured()) return { ok: true, configured: false as const };

  // 1. Pull anything new from the sourcing mailbox.
  let ingested: Record<string, number> | null = null;
  try {
    const r = await ingestSince();
    ingested = { fetched: r.fetched, stored: r.stored, parsed: r.parsed, errors: r.errors };
  } catch (err) {
    logError("inbound", "frequent ingest failed", err);
  }

  // 2. Nothing stored may stay invisible. An email reaches the queue only once
  //    it has a candidate row; a connection dropped between those writes
  //    strands it with no error and nothing retrying. This heals that.
  //    First pass of each invocation only — healing and reparse are repair
  //    work on stored rows; repeating them within one cron tick buys nothing.
  let heal: { processed: number; remaining: number } | null = null;
  if (full) try {
    const { backfillCandidatesBatch } = await import("@/lib/candidates");
    heal = await backfillCandidatesBatch(200);
    if (heal.processed > 0) {
      logEvent("warn", "inbound", "stranded emails recovered into the queue", {
        recovered: heal.processed,
        still_missing: heal.remaining,
      });
    }
  } catch (err) {
    logError("inbound", "queue heal failed", err);
  }

  // 3. Drain anything whose extraction never ran. Those sit in the queue as
  //    "parsing" forever — visible but unreadable — because nothing retried
  //    them. Drained a few per run rather than all at once: each one is an LLM
  //    call, so a backlog clears over several minutes instead of one spike.
  //    Already-reviewed mail is untouched; only 'pending' qualifies.
  let reparsed: { attempted: number; parsed: number; skipped: number; failed: number } | null = null;
  if (full) try {
    const { sql } = await import("@/lib/db");
    const { inboundAddress } = await import("@/lib/inboundMailbox");
    const stuck = await sql<{ id: string }[]>`
      select id from inbound_emails
       where status = 'pending' and lower(mailbox) = ${inboundAddress()}
         and received_at > now() - interval '48 hours'
       order by received_at desc nulls last
       limit ${Number(process.env.INBOUND_REPARSE_BATCH ?? 5)}
    `;
    const { reparseInbound } = await import("@/lib/inbound");
    const tally = { attempted: stuck.length, parsed: 0, skipped: 0, failed: 0 };
    for (const row of stuck) {
      try {
        const out = await reparseInbound(row.id);
        if (out === "parsed") tally.parsed++;
        else if (out === "skipped") tally.skipped++;
        else tally.failed++;
      } catch (err) {
        tally.failed++;
        logError("inbound", "reparse failed", err, { id: row.id });
        // Two strikes on the ten-minute lane: the first failure stamps the
        // error; a repeat parks the email as 'error' so a poison message
        // never burns an extraction call every tick. (In an UPDATE the RHS
        // reads the row's OLD values, so this is exactly two attempts.)
        await sql`
          update inbound_emails
          set status = case when error is not null then 'error' else status end,
              error = coalesce(error, ${String(err).slice(0, 300)})
          where id = ${row.id}
        `.catch(() => {});
      }
    }
    reparsed = tally;
  } catch (err) {
    logError("inbound", "reparse drain failed", err);
  }

  const busy =
    (ingested?.fetched ?? 0) > 0 ||
    (ingested?.errors ?? 0) > 0 ||
    (heal?.processed ?? 0) > 0 ||
    (reparsed?.attempted ?? 0) > 0;
  if (busy) {
    logEvent(
      "info",
      "inbound",
      "frequent sync done",
      {
        ingested: JSON.stringify(ingested ?? {}),
        heal: JSON.stringify(heal ?? {}),
        reparsed: JSON.stringify(reparsed ?? {}),
      },
      Date.now() - t0
    );
  }
  return { ok: true, ingested, heal, reparsed };
}

/**
 * Cron fires four times a day (morning / afternoon / evening / night ET).
 * Extra in-invocation passes (INBOUND_PASSES) are opt-in; Gmail push is the
 * low-latency path. Overlapping invocations are harmless because ingest
 * dedupes on message id.
 */
const PASSES = Number(process.env.INBOUND_PASSES ?? 1);
const PASS_GAP_MS = Number(process.env.INBOUND_PASS_GAP_MS ?? 20_000);
const TIME_BUDGET_MS = 100_000; // maxDuration is 120s; leave headroom

async function runPasses() {
  const t0 = Date.now();
  // Repair legs (heal + reparse) run once; later passes are detection only.
  let last = await run(true);
  for (let pass = 1; pass < PASSES; pass++) {
    if (Date.now() - t0 + PASS_GAP_MS > TIME_BUDGET_MS) break;
    await new Promise((r) => setTimeout(r, PASS_GAP_MS));
    last = await run(false);
  }
  record("cron.inbound_sync", Date.now() - t0);
  return last;
}

export async function GET(req: Request) {
  if (!cronAuthorized(req)) return NextResponse.json({ ok: false }, { status: 401 });
  return NextResponse.json(await runPasses());
}

/** POST is accepted too so any scheduler or webhook can drive it. */
export async function POST(req: Request) {
  if (!cronAuthorized(req)) return NextResponse.json({ ok: false }, { status: 401 });
  return NextResponse.json(await runPasses());
}
