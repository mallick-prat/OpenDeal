import { describe, it, expect } from "vitest";
import { noteExcerpt } from "../dealPresentation";

describe("noteExcerpt", () => {
  it("is null/undefined-safe (the pipeline-crash regression)", () => {
    // A deal row whose notes came back NULL used to crash the ENTIRE board
    // render via `r.notes.replace(...)`. These must return "", not throw.
    expect(noteExcerpt(null)).toBe("");
    expect(noteExcerpt(undefined)).toBe("");
    expect(() => noteExcerpt(null)).not.toThrow();
  });

  it("collapses whitespace and trims", () => {
    expect(noteExcerpt("  hello   world \n\n foo ")).toBe("hello world foo");
    expect(noteExcerpt("")).toBe("");
    expect(noteExcerpt("   ")).toBe("");
  });

  it("clips long notes with an ellipsis, keeps short ones whole", () => {
    const short = "a short note";
    expect(noteExcerpt(short)).toBe(short);

    const long = "x".repeat(300);
    const out = noteExcerpt(long);
    expect(out.length).toBe(178); // 177 chars + ellipsis (matches prior behavior)
    expect(out.endsWith("…")).toBe(true);
    expect(out.slice(0, 177)).toBe("x".repeat(177));
  });

  it("does not add an ellipsis at exactly the threshold", () => {
    expect(noteExcerpt("y".repeat(180))).toBe("y".repeat(180));
    expect(noteExcerpt("y".repeat(181)).endsWith("…")).toBe(true);
  });
});
