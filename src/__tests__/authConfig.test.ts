import { describe, expect, it } from "vitest";
import { authConfig } from "@/auth.config";

/** Run the middleware route gate for a URL with/without a session. */
function allowed(url: string, signedIn: boolean): boolean {
  const nextUrl = new URL(url, "https://app.example.com");
  const result = authConfig.callbacks.authorized({
    auth: signedIn
      ? { user: { email: "member@example.com" }, expires: "" }
      : null,
    request: { nextUrl } as never,
  });
  return result === true;
}

describe("route gate (middleware authorized callback)", () => {
  it("keeps the CRM and boards sign-in only", () => {
    expect(allowed("/", false)).toBe(false);
    expect(allowed("/deals", false)).toBe(false);
    expect(allowed("/people", false)).toBe(false);
    expect(allowed("/inbox", false)).toBe(false);
  });

  it("the bare tracking board stays sign-in only", () => {
    expect(allowed("/tracking", false)).toBe(false);
    // An empty deal param is not a capability URL.
    expect(allowed("/tracking?deal=", false)).toBe(false);
  });

  it("a specific deal share page is public", () => {
    expect(allowed("/deals/1207515409062623", false)).toBe(true);
    expect(allowed("/deals/local-abc", false)).toBe(true);
  });

  it("the tracking deep link passes through for logged-out visitors", () => {
    // The page then renders that deal's public read-only tracking card.
    expect(allowed("/tracking?deal=1207515409062623", false)).toBe(true);
  });

  it("signed-in members reach everything", () => {
    expect(allowed("/", true)).toBe(true);
    expect(allowed("/tracking", true)).toBe(true);
    expect(allowed("/tracking?deal=1207515409062623", true)).toBe(true);
  });
});
