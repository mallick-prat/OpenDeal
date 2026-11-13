import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { encryptToken, decryptToken } from "../tokenCrypt";

beforeEach(() => {
  vi.stubEnv("AUTH_SECRET", "unit-test-secret-please-do-not-reuse");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("tokenCrypt", () => {
  it("round-trips a token", () => {
    const token = "1//0gRefreshTokenValue-abc_XYZ";
    expect(decryptToken(encryptToken(token))).toBe(token);
  });

  it("emits the v1:<iv>:<ciphertext> format", () => {
    const out = encryptToken("hello");
    const parts = out.split(":");
    expect(parts).toHaveLength(3);
    expect(parts[0]).toBe("v1");
    expect(Buffer.from(parts[1], "base64")).toHaveLength(12);
    // ciphertext(5 bytes) + 16-byte GCM tag
    expect(Buffer.from(parts[2], "base64")).toHaveLength(21);
  });

  it("uses a random IV — same plaintext encrypts differently, both decrypt", () => {
    const a = encryptToken("same");
    const b = encryptToken("same");
    expect(a).not.toBe(b);
    expect(decryptToken(a)).toBe("same");
    expect(decryptToken(b)).toBe("same");
  });

  it("returns null when a ciphertext byte is flipped", () => {
    const out = encryptToken("tamper-me");
    const [v, iv, ct] = out.split(":");
    const bytes = Buffer.from(ct, "base64");
    bytes[0] ^= 0xff;
    expect(decryptToken(`${v}:${iv}:${bytes.toString("base64")}`)).toBeNull();
  });

  it("returns null when an IV byte is flipped", () => {
    const out = encryptToken("tamper-me");
    const [v, iv, ct] = out.split(":");
    const bytes = Buffer.from(iv, "base64");
    bytes[3] ^= 0x01;
    expect(decryptToken(`${v}:${bytes.toString("base64")}:${ct}`)).toBeNull();
  });

  it("returns null on malformed input", () => {
    expect(decryptToken("")).toBeNull();
    expect(decryptToken("garbage")).toBeNull();
    expect(decryptToken("v1:")).toBeNull();
    expect(decryptToken("v1:onlytwo")).toBeNull();
    expect(decryptToken("v2:aaaa:bbbb")).toBeNull();
    expect(decryptToken("v1:aaaa:bbbb")).toBeNull(); // iv too short
    expect(decryptToken("v1:!!!!:@@@@")).toBeNull();
  });

  it("returns null when decrypting under a different secret", () => {
    const out = encryptToken("cross-key");
    vi.stubEnv("AUTH_SECRET", "a-completely-different-secret");
    expect(decryptToken(out)).toBeNull();
  });
});
