import { describe, expect, it } from "vitest";
import { verifyMagicToken } from "../loginCode";
import { signinToken } from "../../../scripts/signin-link.mjs";

describe("scripts/signin-link.mjs", () => {
  it("makes tokens the app accepts", () => {
    const token = signinToken(" Alex@Example.com ", "test-secret");
    expect(verifyMagicToken(token, "test-secret")).toBe("alex@example.com");
  });

  it("is refused with a different secret", () => {
    expect(verifyMagicToken(signinToken("alex@example.com", "a"), "b")).toBeNull();
  });

  it("expires after 7 days", () => {
    const now = Date.now();
    const token = signinToken("alex@example.com", "s", now);
    expect(verifyMagicToken(token, "s", now + 6 * 86400e3)).toBe("alex@example.com");
    expect(verifyMagicToken(token, "s", now + 8 * 86400e3)).toBeNull();
  });
});
