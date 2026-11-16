#!/usr/bin/env node
/**
 * Print a 7-day sign-in link for a member, signed with AUTH_SECRET.
 *
 *   npm run signin-link -- you@yourfund.com
 *   npm run signin-link -- you@yourfund.com --url https://deals.yourfund.com
 *
 * This is how the first admin signs in to a fresh deploy before email
 * (Resend) or Google sign-in is set up. It is the same link the app makes
 * from Settings, Members (the copy icon), and /magic exchanges it for a
 * session. The person must already be a member (db:setup creates the first
 * admin). Treat the link like a password: anyone holding it can sign in as
 * that person until it expires.
 *
 * Reads AUTH_SECRET and AUTH_URL from the environment or .env.local. The
 * secret must be the one the target deployment uses, or the link is refused.
 */
import { createHmac } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const MAGIC_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Same format as makeMagicToken in src/lib/loginCode.ts (tested against it). */
export function signinToken(email, secret, now = Date.now()) {
  const normalized = email.trim().toLowerCase();
  const exp = now + MAGIC_TTL_MS;
  const payload = Buffer.from(JSON.stringify({ email: normalized, exp })).toString("base64url");
  const mac = createHmac("sha256", secret).update(`magic|${normalized}|${exp}`).digest("hex");
  return `${payload}.${mac}`;
}

function loadEnvLocal(root) {
  for (const file of [".env.local", ".env"]) {
    const path = resolve(root, file);
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!m || line.trim().startsWith("#")) continue;
      const value = m[2].replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
      if (process.env[m[1]] === undefined) process.env[m[1]] = value;
    }
  }
}

function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  loadEnvLocal(root);
  const args = process.argv.slice(2);
  const urlFlag = args.indexOf("--url");
  const base = (urlFlag >= 0 ? args[urlFlag + 1] : process.env.APP_URL || process.env.AUTH_URL || "http://localhost:3000")
    ?.trim()
    .replace(/\/+$/, "");
  const email = args.find((a, i) => !a.startsWith("--") && i !== urlFlag + 1);
  const secret = process.env.AUTH_SECRET?.trim();
  if (!email || !email.includes("@")) {
    console.error("Usage: npm run signin-link -- you@yourfund.com [--url https://your-app.vercel.app]");
    process.exit(1);
  }
  if (!secret) {
    console.error("AUTH_SECRET is not set (in the environment or .env.local).");
    process.exit(1);
  }
  console.log(`${base}/magic?token=${encodeURIComponent(signinToken(email, secret))}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
