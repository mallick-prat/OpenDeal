import { describe, expect, it } from "vitest";
import { errorInfo } from "../errorInfo";

describe("errorInfo", () => {
  it("captures name, message, and trimmed stack from an Error", () => {
    const info = errorInfo(new Error("boom"));
    expect(info.name).toBe("Error");
    expect(info.message).toBe("boom");
    expect(info.stack!.split("\n").length).toBeLessThanOrEqual(4);
  });

  it("captures node-style error codes", () => {
    const e = new Error("dns") as Error & { code: string };
    e.code = "ENOTFOUND";
    expect(errorInfo(e).code).toBe("ENOTFOUND");
  });

  it("captures the cause chain", () => {
    const e = new Error("outer", { cause: new Error("inner") });
    expect(errorInfo(e).cause).toBe("Error: inner");
  });

  it("handles strings, objects, and circular junk without throwing", () => {
    expect(errorInfo("plain failure").message).toBe("plain failure");
    expect(errorInfo({ weird: true }).message).toContain("weird");
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(errorInfo(circular).message).toBeTruthy();
  });

  it("truncates enormous messages", () => {
    expect(errorInfo(new Error("x".repeat(9000))).message.length).toBe(500);
  });
});
