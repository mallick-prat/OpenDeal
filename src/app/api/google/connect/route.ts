import { NextResponse } from "next/server";
import { currentAppUser } from "@/lib/users";
import { GOOGLE_SCOPES } from "@/lib/googleSync";
import { signGoogleState } from "@/lib/googleOauthState";

// A stalled pool retries for ~22s; the platform default (15s) would 504
// first. Explicit ceiling so retries get to finish.
export const maxDuration = 30;


/**
 * Kicks off the incremental Google consent for Calendar/Gmail metadata.
 * Separate from login: only members who click Connect grant these scopes,
 * and the refresh token is stored for background syncing.
 */
export async function GET(req: Request) {
  const member = await currentAppUser();
  if (!member) return NextResponse.redirect(new URL("/login", req.url));

  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", process.env.AUTH_GOOGLE_ID!);
  url.searchParams.set(
    "redirect_uri",
    new URL("/api/google/callback", req.url).toString()
  );
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", GOOGLE_SCOPES);
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("login_hint", member.email);
  url.searchParams.set("state", signGoogleState(member.email, "metadata"));
  return NextResponse.redirect(url);
}
