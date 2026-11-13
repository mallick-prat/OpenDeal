import { NextResponse } from "next/server";
import { currentAppUser } from "@/lib/users";
import { INBOUND_SCOPES, inboundAddress } from "@/lib/inboundMailbox";
import { signGoogleState } from "@/lib/googleOauthState";

// A stalled pool retries for ~22s; the platform default (15s) would 504
// first. Explicit ceiling so retries get to finish.
export const maxDuration = 30;


/**
 * Connects the shared sourcing mailbox (NEXT_PUBLIC_INBOUND_MAILBOX) for inbound deal
 * ingestion. Admin-only: whoever clicks must then sign into the mailbox's
 * Google account and grant Gmail readonly + modify. The refresh token is
 * stored system-wide (not per member) and the connecting admin is recorded.
 */
export async function GET(req: Request) {
  const member = await currentAppUser();
  if (!member) return NextResponse.redirect(new URL("/login", req.url));
  const isAdmin = member.role === "admin" || member.role === "super_admin";
  if (!isAdmin) {
    const settings = new URL("/settings", req.url);
    settings.searchParams.set("inbox", "forbidden");
    return NextResponse.redirect(settings);
  }

  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", process.env.AUTH_GOOGLE_ID!);
  url.searchParams.set(
    "redirect_uri",
    new URL("/api/google/callback", req.url).toString()
  );
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", INBOUND_SCOPES);
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  // Nudge the account chooser toward the mailbox; the admin still picks.
  url.searchParams.set("login_hint", inboundAddress());
  // state carries the connecting admin (recorded as connected_by).
  url.searchParams.set("state", signGoogleState(member.email, "inbox"));
  return NextResponse.redirect(url);
}
