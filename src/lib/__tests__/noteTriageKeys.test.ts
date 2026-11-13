// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { isTypingTarget, noteIgnoreKey } from "../noteTriageKeys";

describe("noteIgnoreKey", () => {
  it("arms on the first Delete", () => {
    expect(noteIgnoreKey("idle", "Delete")).toEqual({ phase: "armed", action: "arm" });
  });

  it("confirms on a second Delete", () => {
    expect(noteIgnoreKey("armed", "Delete")).toEqual({ phase: "idle", action: "confirm" });
  });

  it("cancels an armed confirm with Escape", () => {
    expect(noteIgnoreKey("armed", "Escape")).toEqual({ phase: "idle", action: "cancel" });
  });

  it("does nothing on Escape while idle", () => {
    expect(noteIgnoreKey("idle", "Escape")).toEqual({ phase: "idle", action: "none" });
  });

  it("leaves e / s / i and Backspace to existing handlers", () => {
    for (const key of ["e", "s", "i", "ArrowLeft", "ArrowRight", "Backspace"]) {
      expect(noteIgnoreKey("idle", key)).toEqual({ phase: "idle", action: "none" });
      expect(noteIgnoreKey("armed", key)).toEqual({ phase: "armed", action: "none" });
    }
  });
});

describe("isTypingTarget", () => {
  it("treats input, textarea, select, and contenteditable as typing", () => {
    expect(isTypingTarget(document.createElement("input"))).toBe(true);
    expect(isTypingTarget(document.createElement("textarea"))).toBe(true);
    expect(isTypingTarget(document.createElement("select"))).toBe(true);

    const editable = document.createElement("div");
    editable.setAttribute("contenteditable", "true");
    document.body.appendChild(editable);
    const inner = document.createElement("span");
    editable.appendChild(inner);
    expect(isTypingTarget(editable)).toBe(true);
    expect(isTypingTarget(inner)).toBe(true);
  });

  it("allows shortcuts on ordinary page elements", () => {
    expect(isTypingTarget(document.createElement("button"))).toBe(false);
    expect(isTypingTarget(document.createElement("p"))).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});
