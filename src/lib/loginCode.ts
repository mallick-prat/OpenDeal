import { createHmac, timingSafeEqual } from "crypto";

/**
 * The email-code sign-in is stateless: /api/send-code emails a 6-digit code
 * and sets a signed cookie binding {email, expiry} to that code's HMAC.
 * The credentials provider verifies the submitted code against the cookie.
 * Pure functions, shared by both sides so they can never drift apart.
 */

export const CODE_TTL_MS = 10 * 60 * 1000;

function mac(email: string, exp: number, code: string, secret: string): string {
  return createHmac("sha256", secret)
    .update(`${email.toLowerCase()}|${exp}|${code}`)
    .digest("hex");
}

/** Build the value for the od_code cookie. */
export function makeCodeCookie(
  email: string,
  code: string,
  secret: string,
  now = Date.now()
): { value: string; exp: number } {
  const normalized = email.trim().toLowerCase();
  const exp = now + CODE_TTL_MS;
  const payload = Buffer.from(
    JSON.stringify({ email: normalized, exp })
  ).toString("base64url");
  return { value: `${payload}.${mac(normalized, exp, code, secret)}`, exp };
}

/* ── Magic links ─────────────────────────────────────────────────────────────
 * A magic link carries a signed {email, exp} token: whoever holds the link
 * can sign in as that member until it expires (7 days). Stateless — no DB
 * row — so treat the link itself as a credential.
 */

export const MAGIC_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function magicMac(email: string, exp: number, secret: string): string {
  return createHmac("sha256", secret)
    .update(`magic|${email.toLowerCase()}|${exp}`)
    .digest("hex");
}

/** Build a signed magic-link token for a member. */
export function makeMagicToken(
  email: string,
  secret: string,
  now = Date.now()
): string {
  const normalized = email.trim().toLowerCase();
  const exp = now + MAGIC_TTL_MS;
  const payload = Buffer.from(
    JSON.stringify({ email: normalized, exp })
  ).toString("base64url");
  return `${payload}.${magicMac(normalized, exp, secret)}`;
}

/** Verify a magic-link token; returns the email or null. */
export function verifyMagicToken(
  token: string | undefined,
  secret: string,
  now = Date.now()
): string | null {
  if (!token) return null;
  const [payloadB64, gotMac] = token.split(".");
  if (!payloadB64 || !gotMac) return null;
  let payload: { email?: string; exp?: number };
  try {
    payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString());
  } catch {
    return null;
  }
  if (!payload.email || !payload.exp || now > payload.exp) return null;
  const expected = magicMac(payload.email, payload.exp, secret);
  const a = Buffer.from(expected);
  const b = Buffer.from(gotMac);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return payload.email;
}

/** Verify a submitted 6-digit code against the signed cookie. */
export function verifyCodeCookie(
  cookieVal: string | undefined,
  email: string,
  code: string,
  secret: string,
  now = Date.now()
): boolean {
  if (!cookieVal) return false;
  const [payloadB64, gotMac] = cookieVal.split(".");
  if (!payloadB64 || !gotMac) return false;
  let payload: { email?: string; exp?: number };
  try {
    payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString());
  } catch {
    return false;
  }
  if (!payload.email || !payload.exp) return false;
  if (payload.email.toLowerCase() !== email.trim().toLowerCase()) return false;
  if (now > payload.exp) return false;
  const expected = mac(payload.email, payload.exp, code, secret);
  const a = Buffer.from(expected);
  const b = Buffer.from(gotMac);
  return a.length === b.length && timingSafeEqual(a, b);
}
