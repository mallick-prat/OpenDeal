import NextAuth from "next-auth";
import { authConfig } from "./auth.config";

export default NextAuth(authConfig).auth;

export const config = {
  // Gate everything EXCEPT the paths below. Every exemption must authenticate
  // itself, because middleware will not do it for them. Keep this list as
  // short as possible: anything you add here is reachable without a session.
  //
  //   api/auth, api/send-code   sign-in itself
  //   api/cron, api/diag        shared-secret routes (see lib/cronAuth.ts)
  //   api/inbound/              email + Gmail push webhooks (shared secrets)
  //   api/google/callback       trusts only its HMAC-signed OAuth state
  //   healthz, manifest, sw.js, offline, static assets, icons
  //
  // (/deals/<gid> is a public read-only share page; it is allowed through by
  // the `authorized` callback in auth.config.ts, not by this matcher.)
  matcher: [
    "/((?!api/auth|api/send-code|api/cron|api/diag|api/inbound/|api/google/callback|healthz|manifest.webmanifest|sw.js|offline|_next/static|_next/image|icon|favicon.ico).*)",
  ],
};
