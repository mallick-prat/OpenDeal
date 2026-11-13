import { describe, expect, it } from "vitest";
import {
  CODE_TTL_MS,
  MAGIC_TTL_MS,
  makeCodeCookie,
  makeMagicToken,
  verifyCodeCookie,
  verifyMagicToken,
} from "../loginCode";

const SECRET = "test-secret-do-not-use";

describe("email code cookie", () => {
  it("round-trips a valid code", () => {
    const { value } = makeCodeCookie("alex@example.com", "123456", SECRET);
    expect(verifyCodeCookie(value, "alex@example.com", "123456", SECRET)).toBe(true);
  });

  it("is case-insensitive on email and tolerates whitespace", () => {
    const { value } = makeCodeCookie("Alex@Example.com ", "123456", SECRET);
    expect(verifyCodeCookie(value, "  ALEX@EXAMPLE.COM", "123456", SECRET)).toBe(true);
  });

  it("rejects the wrong code", () => {
    const { value } = makeCodeCookie("alex@example.com", "123456", SECRET);
    expect(verifyCodeCookie(value, "alex@example.com", "654321", SECRET)).toBe(false);
  });

  it("rejects a different email than the cookie was issued for", () => {
    const { value } = makeCodeCookie("alex@example.com", "123456", SECRET);
    expect(verifyCodeCookie(value, "taylor@example.com", "123456", SECRET)).toBe(false);
  });

  it("rejects an expired code", () => {
    const issued = Date.now();
    const { value } = makeCodeCookie("alex@example.com", "123456", SECRET, issued);
    const later = issued + CODE_TTL_MS + 1;
    expect(verifyCodeCookie(value, "alex@example.com", "123456", SECRET, later)).toBe(false);
  });

  it("rejects a tampered payload (email swapped, old mac)", () => {
    const { value, exp } = makeCodeCookie("alex@example.com", "123456", SECRET);
    const mac = value.split(".")[1];
    const forged =
      Buffer.from(JSON.stringify({ email: "evil@x.com", exp })).toString("base64url") +
      "." +
      mac;
    expect(verifyCodeCookie(forged, "evil@x.com", "123456", SECRET)).toBe(false);
  });

  it("rejects garbage and missing cookies", () => {
    expect(verifyCodeCookie(undefined, "a@b.com", "123456", SECRET)).toBe(false);
    expect(verifyCodeCookie("", "a@b.com", "123456", SECRET)).toBe(false);
    expect(verifyCodeCookie("not-a-cookie", "a@b.com", "123456", SECRET)).toBe(false);
    expect(verifyCodeCookie("aGVsbG8.deadbeef", "a@b.com", "123456", SECRET)).toBe(false);
  });

  it("rejects a cookie signed with a different secret", () => {
    const { value } = makeCodeCookie("alex@example.com", "123456", "other-secret");
    expect(verifyCodeCookie(value, "alex@example.com", "123456", SECRET)).toBe(false);
  });
});

describe("magic link token", () => {
  it("round-trips and returns the normalized email", () => {
    const token = makeMagicToken("  Sam@Example.com", SECRET);
    expect(verifyMagicToken(token, SECRET)).toBe("sam@example.com");
  });

  it("expires after 7 days", () => {
    const issued = Date.now();
    const token = makeMagicToken("sam@example.com", SECRET, issued);
    expect(verifyMagicToken(token, SECRET, issued + MAGIC_TTL_MS - 1)).toBe(
      "sam@example.com"
    );
    expect(verifyMagicToken(token, SECRET, issued + MAGIC_TTL_MS + 1)).toBeNull();
  });

  it("rejects tampering with the email", () => {
    const token = makeMagicToken("sam@example.com", SECRET);
    const mac = token.split(".")[1];
    const exp = Date.now() + MAGIC_TTL_MS;
    const forged =
      Buffer.from(JSON.stringify({ email: "evil@x.com", exp })).toString("base64url") +
      "." +
      mac;
    expect(verifyMagicToken(forged, SECRET)).toBeNull();
  });

  it("rejects the wrong secret, garbage, and empties", () => {
    const token = makeMagicToken("sam@example.com", "other-secret");
    expect(verifyMagicToken(token, SECRET)).toBeNull();
    expect(verifyMagicToken(undefined, SECRET)).toBeNull();
    expect(verifyMagicToken("", SECRET)).toBeNull();
    expect(verifyMagicToken("junk.junk", SECRET)).toBeNull();
  });

  it("a code-cookie mac can never pass as a magic token (domain separation)", () => {
    // Same email + secret: the "magic|" prefix keeps the two HMAC families apart.
    const { value } = makeCodeCookie("alex@example.com", "123456", SECRET);
    expect(verifyMagicToken(value, SECRET)).toBeNull();
  });
});
