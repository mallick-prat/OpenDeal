import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from "node:crypto";

/**
 * ── Refresh-token encryption at rest ─────────────────────────────────────────
 * AES-256-GCM over small strings (OAuth refresh tokens). The key is derived
 * from AUTH_SECRET via HKDF-SHA256 with a fixed salt, so no extra env var is
 * needed and rotating AUTH_SECRET invalidates stored tokens (members simply
 * reconnect). Output format: "v1:<base64 iv>:<base64 ciphertext+tag>".
 *
 * decryptToken NEVER throws on bad input — malformed or tampered values
 * return null so callers can route the connection to "reauth needed".
 * No I/O beyond the env read; unit-tested with a stubbed AUTH_SECRET.
 */

const VERSION = "v1";
const HKDF_SALT = "opendeal-token-v1";
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

function deriveKey(): Buffer {
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new Error("AUTH_SECRET is not set — cannot handle tokens.");
  return Buffer.from(hkdfSync("sha256", secret, HKDF_SALT, "", KEY_BYTES));
}

export function encryptToken(plain: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", deriveKey(), iv);
  const sealed = Buffer.concat([
    cipher.update(plain, "utf8"),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  return `${VERSION}:${iv.toString("base64")}:${sealed.toString("base64")}`;
}

/** Decrypt a value produced by encryptToken; null on anything malformed. */
export function decryptToken(value: string): string | null {
  try {
    if (typeof value !== "string") return null;
    const parts = value.split(":");
    if (parts.length !== 3 || parts[0] !== VERSION) return null;
    const iv = Buffer.from(parts[1], "base64");
    const sealed = Buffer.from(parts[2], "base64");
    if (iv.length !== IV_BYTES || sealed.length < TAG_BYTES) return null;
    const tag = sealed.subarray(sealed.length - TAG_BYTES);
    const ciphertext = sealed.subarray(0, sealed.length - TAG_BYTES);
    const decipher = createDecipheriv("aes-256-gcm", deriveKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    // Wrong key, flipped bytes, bad base64 — all mean "not recoverable".
    return null;
  }
}
