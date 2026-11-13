import { NextResponse } from "next/server";
import { saveGoogleConnection, syncGoogle } from "@/lib/googleSync";
import {
  saveInboundMailbox,
  inboundAddress,
  inboundAccessToken,
  type InboundMailbox,
} from "@/lib/inboundMailbox";
import { verifyGoogleState } from "@/lib/googleOauthState";
import { logError, logEvent } from "@/lib/log";
import { after } from "next/server";

export const maxDuration = 60;

async function exchangeCode(
  req: Request,
  code: string
): Promise<{ refresh_token: string; scope: string; id_token?: string }> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.AUTH_GOOGLE_ID!,
      client_secret: process.env.AUTH_GOOGLE_SECRET!,
      code,
      grant_type: "authorization_code",
      redirect_uri: new URL("/api/google/callback", req.url).toString(),
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const data = (await res.json()) as {
    refresh_token?: string;
    scope?: string;
    id_token?: string;
    error?: string;
  };
  if (!res.ok || !data.refresh_token) {
    throw new Error(data.error ?? `token exchange ${res.status} (no refresh token)`);
  }
  return { refresh_token: data.refresh_token, scope: data.scope ?? "", id_token: data.id_token };
}

/** Which Gmail account actually granted consent (guards mailbox mismatch). */
async function grantedGmailAddress(refreshToken: string, scope: string): Promise<string> {
  const token = await inboundAccessToken({ refresh_token: refreshToken } as InboundMailbox);
  const res = await fetch(
    "https://gmail.googleapis.com/gmail/v1/users/me/profile",
    { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) }
  );
  if (!res.ok) throw new Error(`Gmail profile ${res.status}`);
  const data = (await res.json()) as { emailAddress?: string };
  if (!data.emailAddress) throw new Error("Gmail profile returned no address.");
  void scope;
  return data.emailAddress.toLowerCase();
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const settings = new URL("/settings", req.url);
  const code = url.searchParams.get("code");
  const verified = verifyGoogleState(url.searchParams.get("state") ?? "");

  if (!code || !verified) {
    settings.searchParams.set("google", "failed");
    return NextResponse.redirect(settings);
  }

  // ── Shared inbound mailbox connection ──────────────────────────────────────
  if (verified.kind === "inbox") {
    const connectedBy = verified.email; // the admin who kicked it off
    try {
      const { refresh_token, scope } = await exchangeCode(req, code);
      const account = await grantedGmailAddress(refresh_token, scope);
      const { ensureInboundSchema } = await import("@/lib/inbound");
      await ensureInboundSchema();
      if (account !== inboundAddress()) {
        logEvent("warn", "inbound", "mailbox connect: wrong account", {
          expected: inboundAddress(),
          got: account,
        });
        settings.searchParams.set("inbox", "wrong-account");
        return NextResponse.redirect(settings);
      }
      await saveInboundMailbox(account, refresh_token, scope, connectedBy);
      logEvent("info", "inbound", "mailbox connected", { account, connectedBy });
      // Arm the real-time Gmail watch (and seed the history watermark) so
      // pitches ingest the moment they arrive. No-op if Pub/Sub isn't set up.
      after(async () => {
        try {
          const { startWatch } = await import("@/lib/inbound");
          await startWatch();
        } catch (err) {
          logError("inbound", "arming watch after connect failed", err, { account });
        }
      });
      settings.searchParams.set("inbox", "connected");
      return NextResponse.redirect(settings);
    } catch (err) {
      logError("inbound", "mailbox oauth callback failed", err, { connectedBy });
      settings.searchParams.set("inbox", "failed");
      return NextResponse.redirect(settings);
    }
  }

  // ── Per-member personal-inbox connection (gmail.readonly) ─────────────────
  if (verified.kind === "mail") {
    const email = verified.email;
    try {
      const { refresh_token, scope } = await exchangeCode(req, code);
      const account = await grantedGmailAddress(refresh_token, scope);
      // A member may only sync the mailbox they sign in with — anything else
      // would let one person feed another's mail into the store.
      if (account !== email.toLowerCase()) {
        logEvent("warn", "mail", "personal inbox connect: wrong account", {
          expected: email,
          got: account,
        });
        settings.searchParams.set("mail", "wrong-account");
        return NextResponse.redirect(settings);
      }
      const { ensureMailSchema, saveMailConnection } = await import(
        "@/lib/mailSync"
      );
      await ensureMailSchema();
      await saveMailConnection(account, email, refresh_token, scope);
      logEvent("info", "mail", "personal inbox connected", { email });
      // Kick the first sync in the background so the card fills in quickly.
      after(async () => {
        try {
          const { personalConnectionIdFor, syncConnection } = await import(
            "@/lib/mailSync"
          );
          const id = await personalConnectionIdFor(email);
          if (id) await syncConnection(id);
        } catch (err) {
          logError("mail", "initial personal sync failed", err, { email });
        }
      });
      settings.searchParams.set("mail", "connected");
      return NextResponse.redirect(settings);
    } catch (err) {
      logError("mail", "personal inbox oauth callback failed", err, { email });
      settings.searchParams.set("mail", "error");
      return NextResponse.redirect(settings);
    }
  }

  // ── Per-member Calendar/Gmail metadata connection ──────────────────────────
  const email = verified.email;
  try {
    const { refresh_token, scope } = await exchangeCode(req, code);
    await saveGoogleConnection(email, refresh_token, scope);
    logEvent("info", "google", "account connected", { email });
    after(async () => {
      try {
        await syncGoogle(email);
      } catch (err) {
        logError("google", "initial sync failed", err, { email });
      }
    });
    settings.searchParams.set("google", "connected");
    return NextResponse.redirect(settings);
  } catch (err) {
    logError("google", "oauth callback failed", err, { email });
    settings.searchParams.set("google", "failed");
    return NextResponse.redirect(settings);
  }
}
