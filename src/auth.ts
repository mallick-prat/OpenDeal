import NextAuth from "next-auth";
import Google from "next-auth/providers/google";
import Credentials from "next-auth/providers/credentials";
import { authConfig } from "./auth.config";
import { sql } from "./lib/db";
import { verifyCodeCookie, verifyMagicToken } from "./lib/loginCode";
import { withRetry } from "./lib/retry";
import { logError, logEvent } from "./lib/log";

/**
 * The sign-in allowlist lives in the app_users table (managed from
 * Settings → Members). Queried inline here rather than via lib/users.ts to
 * avoid a circular import (users.ts imports auth).
 *
 * A membership check has three honest outcomes: member, not a member, or
 * "couldn't check" (DB/DNS blip). The last one must NEVER read as a denial —
 * it retries, then surfaces as a temporary failure the user can retry.
 */
type MemberCheck =
  | { status: "member"; email: string; name: string }
  | { status: "not-member" }
  | { status: "unavailable" };

async function checkMember(email?: string | null): Promise<MemberCheck> {
  if (!email) return { status: "not-member" };
  try {
    const rows = await withRetry(
      () => sql<{ email: string; name: string }[]>`
        select email, name from app_users where email = ${email.toLowerCase()}
      `
    );
    return rows[0]
      ? { status: "member", email: rows[0].email, name: rows[0].name }
      : { status: "not-member" };
  } catch (err) {
    logError("auth", "membership check unavailable", err, {
      email: email?.toLowerCase() ?? "",
    });
    return { status: "unavailable" };
  }
}

/** Record the sign-in: refresh profile fields + audit trail. Non-fatal. */
async function touchLogin(
  email: string,
  name?: string | null,
  image?: string | null
): Promise<void> {
  try {
    await sql`
      update app_users set
        last_login_at = now(),
        name = case when ${name ?? ""} <> '' then ${name ?? ""} else name end,
        image = coalesce(${image ?? null}, image)
      where email = ${email.toLowerCase()}
    `;
    await sql`
      insert into activity_log (actor, action) values (${email.toLowerCase()}, 'signed_in')
    `;
  } catch {
    // an audit hiccup must not block the sign-in
  }
}

function readCookie(header: string | null, name: string): string | undefined {
  if (!header) return undefined;
  const hit = header
    .split(/;\s*/)
    .find((c) => c.startsWith(`${name}=`));
  return hit ? decodeURIComponent(hit.slice(name.length + 1)) : undefined;
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  providers: [
    Google({
      clientId: process.env.AUTH_GOOGLE_ID,
      clientSecret: process.env.AUTH_GOOGLE_SECRET,
      authorization: { params: { prompt: "select_account" } },
    }),
    Credentials({
      id: "email-code",
      name: "Email code",
      credentials: { email: {}, code: {} },
      async authorize(creds, request) {
        const email = String(creds?.email ?? "").trim().toLowerCase();
        const code = String(creds?.code ?? "").trim();
        if (!/^\d{6}$/.test(code)) return null;
        // Verify the code FIRST (pure crypto, can't flake), then membership.
        const cookieVal = readCookie(request.headers.get("cookie"), "od_code");
        if (!verifyCodeCookie(cookieVal, email, code, process.env.AUTH_SECRET!))
          return null;
        const member = await checkMember(email);
        if (member.status === "unavailable")
          // Thrown so it surfaces as a server problem, not "wrong code".
          throw new Error("Membership check unavailable — database unreachable.");
        if (member.status !== "member") return null;
        return { id: email, email, name: member.name || email.split("@")[0] };
      },
    }),
    Credentials({
      id: "magic-link",
      name: "Magic link",
      credentials: { token: {} },
      async authorize(creds) {
        const email = verifyMagicToken(
          String(creds?.token ?? ""),
          process.env.AUTH_SECRET!
        );
        if (!email) return null;
        const member = await checkMember(email);
        if (member.status === "unavailable")
          throw new Error("Membership check unavailable — database unreachable.");
        if (member.status !== "member") return null;
        return { id: email, email, name: member.name || email.split("@")[0] };
      },
    }),
  ],
  callbacks: {
    ...authConfig.callbacks,
    async signIn({ user }) {
      const member = await checkMember(user.email);
      if (member.status === "unavailable")
        return "/login?error=TemporaryFailure";
      if (member.status !== "member") {
        logEvent("warn", "auth", "sign-in denied (not a member)", {
          email: user.email?.toLowerCase() ?? "",
        });
        return false;
      }
      await touchLogin(member.email, user.name, user.image);
      return true;
    },
  },
});
