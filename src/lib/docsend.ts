import "server-only";
import { crm } from "@/config/crm.config";
import { createHash } from "node:crypto";
import { sql } from "./db";
import { logError, logEvent } from "./log";
import { record } from "./perf";
import { extractVerificationLink } from "./docsendPure";
import type { DeckKind } from "./emailParse";

/**
 * ── DocSend → PDF (docsend2pdf.com API) ─────────────────────────────────────
 * Converts a gated DocSend link to PDF through docsend2pdf.com's public API
 * (POST /api/convert → poll /api/task/{id}); serverless-friendly, unlike the
 * old Python-CLI engine this replaces. The viewer identity is
 * DOCSEND_VIEWER_EMAIL (defaults to your inbound mailbox) — DocSend logs that email with every
 * access, which is the honest, intended trade.
 *
 * Edge cases handled:
 *   verify   DocSend emailed a one-time verification to the viewer address.
 *            We search that mailbox for the mail, open its link server-side,
 *            and re-run the conversion once ("pinged and rerun"). If DocSend
 *            still insists on an interactive check, we say so plainly.
 *   gated    Passcode required or wrong. Callers mine candidate emails for
 *            passcodes and can pass one; the UI offers an input as the last
 *            resort.
 *   429      One polite wait on Retry-After, then one retry.
 *   errors   The service's user_message is surfaced, never swallowed.
 */

export type CaptureStatus = "ok" | "gated" | "verify" | "unavailable" | "error";

export interface CaptureResult {
  status: CaptureStatus;
  /** Composited deck PDF bytes when status is "ok". */
  pdf: Buffer | null;
  note: string;
}

export interface CaptureOpts {
  passcode?: string;
  /** Total time to spend converting (poll included). */
  budgetMs?: number;
  /** Skip the mailbox verification loop (ingestion path stays fast). */
  noVerifyLoop?: boolean;
}

const API = "https://docsend2pdf.com";

/** Only DocSend is convertible today; other hosts stay as links. */
export function isCapturable(kind: DeckKind): boolean {
  return kind === "docsend";
}

export function viewerEmail(): string {
  return process.env.DOCSEND_VIEWER_EMAIL ?? crm.inbound.address;
}

/* Task-resume: a big deck can outlive one server action's budget. The task
   keeps cooking at docsend2pdf for ~5 minutes, so we remember its id and the
   NEXT Enrich click resumes polling instead of paying for a fresh convert. */
async function rememberTask(url: string, taskId: string): Promise<void> {
  try {
    await sql`
      insert into api_cache (provider, cache_key, payload)
      values ('docsend-task', ${createHash("sha256").update(url).digest("hex")}, ${sql.json({ taskId } as never)})
      on conflict (provider, cache_key) do update
        set payload = excluded.payload, created_at = now()`;
  } catch {
    // best-effort
  }
}
async function recallTask(url: string): Promise<string | null> {
  try {
    const rows = await sql<{ payload: { taskId?: string }; created_at: Date }[]>`
      select payload, created_at from api_cache
       where provider = 'docsend-task'
         and cache_key = ${createHash("sha256").update(url).digest("hex")}`;
    const hit = rows[0];
    if (!hit || Date.now() - hit.created_at.getTime() > 6 * 60_000) return null;
    return hit.payload.taskId ?? null;
  } catch {
    return null;
  }
}
async function forgetTask(url: string): Promise<void> {
  await sql`
    delete from api_cache
     where provider = 'docsend-task'
       and cache_key = ${createHash("sha256").update(url).digest("hex")}`.catch(() => {});
}

type ConvertOutcome =
  | { kind: "pdf"; bytes: Buffer }
  | { kind: "verify" }
  | { kind: "gated"; message: string }
  | { kind: "error"; message: string };

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

/* eslint-disable @typescript-eslint/no-explicit-any */
async function convertOnce(url: string, passcode: string | undefined, budgetMs: number): Promise<ConvertOutcome> {
  const deadline = Date.now() + budgetMs;
  // A previous click may have left a task mid-flight — resume it for free.
  const resumed = await recallTask(url);
  if (resumed) {
    const out = await pollTask(url, resumed, deadline);
    if (out) return out;
    await forgetTask(url); // expired or finished elsewhere — start fresh
  }
  let res: Response;
  try {
    res = await fetch(`${API}/api/convert`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url,
        email: viewerEmail(),
        ...(passcode ? { passcode } : {}),
        async: true,
      }),
      signal: AbortSignal.timeout(45_000),
    });
  } catch (err) {
    return { kind: "error", message: `docsend2pdf unreachable (${err instanceof Error ? err.message : "network"})` };
  }

  // Politeness: one wait-and-retry on rate limit.
  if (res.status === 429) {
    const wait = Math.min(15, Number(res.headers.get("retry-after")) || 3);
    await sleep(wait * 1000);
    return convertOnce(url, passcode, deadline - Date.now());
  }

  if (res.ok && (res.headers.get("content-type") ?? "").includes("application/pdf")) {
    return { kind: "pdf", bytes: Buffer.from(await res.arrayBuffer()) };
  }

  const first = (await res.json().catch(() => ({}))) as any;
  if (!res.ok && res.status !== 202) {
    const msg = String(first.user_message ?? first.error ?? `HTTP ${res.status}`);
    return /passcode|password/i.test(msg) ? { kind: "gated", message: msg } : { kind: "error", message: msg };
  }
  if (String(first.status ?? "") === "email_verification_required") return { kind: "verify" };

  const taskId = String(first.task_id ?? "");
  if (!taskId) return { kind: "error", message: "docsend2pdf accepted the job but returned no task id." };
  const polled = await pollTask(url, taskId, deadline);
  if (polled) return polled;
  await rememberTask(url, taskId);
  return {
    kind: "error",
    message: "Large deck — still converting. Run Enrich again in a minute and it will pick up where it left off.",
  };
}

/** Poll one task until PDF/terminal status; null when the budget runs out. */
/* eslint-disable @typescript-eslint/no-explicit-any */
async function pollTask(url: string, taskId: string, deadline: number): Promise<ConvertOutcome | null> {
  while (Date.now() < deadline) {
    await sleep(4_000);
    let poll: Response;
    try {
      poll = await fetch(`${API}/api/task/${encodeURIComponent(taskId)}`, {
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      continue; // transient poll failure — the task keeps cooking server-side
    }
    if (poll.status === 404) return null; // expired/unknown → caller starts fresh
    if ((poll.headers.get("content-type") ?? "").includes("application/pdf")) {
      await forgetTask(url);
      return { kind: "pdf", bytes: Buffer.from(await poll.arrayBuffer()) };
    }
    const body = (await poll.json().catch(() => ({}))) as any;
    const status = String(body.status ?? "");
    if (status === "email_verification_required") return { kind: "verify" };
    if (status === "queued" || status === "processing" || poll.status === 200) {
      if (!poll.ok) {
        const msg = String(body.user_message ?? body.error ?? `HTTP ${poll.status}`);
        return /passcode|password/i.test(msg) ? { kind: "gated", message: msg } : { kind: "error", message: msg };
      }
      continue;
    }
    if (!poll.ok) {
      const msg = String(body.user_message ?? body.error ?? `HTTP ${poll.status}`);
      await forgetTask(url);
      return /passcode|password/i.test(msg) ? { kind: "gated", message: msg } : { kind: "error", message: msg };
    }
  }
  return null;
}

/**
 * Search the viewer's connected mailbox for DocSend's verification email and
 * open its link. Returns what happened, for the caller's note.
 */
async function pingVerification(): Promise<"opened" | "no-mail" | "no-mailbox"> {
  const addr = viewerEmail().toLowerCase();
  const conns = await sql<
    { id: string; kind: string; address: string; user_email: string; refresh_token_enc: string; scopes: string; status: string }[]
  >`
    select id, kind, address, user_email, refresh_token_enc, scopes, status
      from mailbox_connections
     where lower(address) = ${addr} and status = 'ok'
     limit 1`.catch(() => []);
  const conn = conns[0];
  if (!conn) return "no-mailbox";

  const { gmailAccessTokenFor } = await import("./mailSync");
  const token = await gmailAccessTokenFor(conn as never);
  if (!token) return "no-mailbox";

  // The verification mail lands within seconds; give it three short tries.
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await sleep(5_000);
    try {
      const q = encodeURIComponent("from:docsend.com newer_than:1h");
      const list = (await (
        await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${q}&maxResults=3`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(15_000),
        })
      ).json()) as any;
      for (const m of list.messages ?? []) {
        const full = (await (
          await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=full`, {
            headers: { Authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(15_000),
          })
        ).json()) as any;
        const parts: string[] = [];
        const walk = (p: any) => {
          if (!p) return;
          if (p.body?.data) parts.push(Buffer.from(p.body.data, "base64url").toString("utf8"));
          for (const c of p.parts ?? []) walk(c);
        };
        walk(full.payload);
        const link = extractVerificationLink(parts.join("\n"));
        if (link) {
          await fetch(link, { redirect: "follow", signal: AbortSignal.timeout(20_000) }).catch(() => {});
          logEvent("info", "inbound", "docsend verification link opened", { link: link.slice(0, 120) });
          return "opened";
        }
      }
    } catch (err) {
      logError("inbound", "docsend verification hunt failed", err, {});
    }
  }
  return "no-mail";
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export async function captureDeck(url: string, opts: CaptureOpts = {}): Promise<CaptureResult> {
  const t0 = Date.now();
  const budget = opts.budgetMs ?? 150_000;
  try {
    let out = await convertOnce(url, opts.passcode, budget);

    // "Pinged and rerun": open the verification email, then try once more.
    if (out.kind === "verify" && !opts.noVerifyLoop) {
      const ping = await pingVerification();
      if (ping === "opened") {
        await sleep(4_000);
        out = await convertOnce(url, opts.passcode, Math.max(45_000, t0 + budget - Date.now()));
        if (out.kind === "verify") {
          return {
            status: "verify",
            pdf: null,
            note: `DocSend emailed a verification to ${viewerEmail()} and the link was opened, but the deck still wants an interactive check — open it once in a browser as ${viewerEmail()}, then run Enrich again.`,
          };
        }
      } else if (ping === "no-mail") {
        return {
          status: "verify",
          pdf: null,
          note: `DocSend wants to verify ${viewerEmail()} but no verification email has arrived yet — run Enrich again in a minute.`,
        };
      } else {
        return {
          status: "verify",
          pdf: null,
          note: `DocSend wants to verify ${viewerEmail()}, but that mailbox isn't connected in Settings, so the verification email can't be read automatically.`,
        };
      }
    }

    if (out.kind === "pdf") {
      record("docsend.convert", Date.now() - t0, { ok: true });
      logEvent("info", "inbound", "docsend converted", { url: url.slice(0, 120), bytes: out.bytes.length }, Date.now() - t0);
      return {
        status: "ok",
        pdf: out.bytes,
        note: `Converted deck to PDF (${Math.round(out.bytes.length / 1024)}KB).`,
      };
    }
    if (out.kind === "verify") {
      return { status: "verify", pdf: null, note: `DocSend wants to verify ${viewerEmail()} before showing this deck.` };
    }
    record("docsend.convert", Date.now() - t0, { ok: false });
    if (out.kind === "gated") {
      return {
        status: "gated",
        pdf: null,
        note: opts.passcode
          ? "That passcode didn't unlock the deck."
          : "This deck needs a passcode.",
      };
    }
    logError("inbound", "docsend convert failed", new Error(out.message), { url: url.slice(0, 120) });
    return { status: "error", pdf: null, note: `Deck conversion failed: ${out.message.slice(0, 160)}` };
  } catch (err) {
    logError("inbound", "docsend capture crashed", err, { url: url.slice(0, 120) });
    return { status: "error", pdf: null, note: "Deck conversion crashed." };
  }
}
