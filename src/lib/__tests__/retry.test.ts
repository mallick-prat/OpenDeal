import { describe, expect, it } from "vitest";
import { isTransientNetworkError, withRetry } from "../retry";

function netErr(code: string): Error {
  const e = new Error(code) as Error & { code: string };
  e.code = code;
  return e;
}

describe("isTransientNetworkError", () => {
  it("recognizes DNS and socket failures", () => {
    expect(isTransientNetworkError(netErr("ENOTFOUND"))).toBe(true);
    expect(isTransientNetworkError(netErr("ECONNRESET"))).toBe(true);
    expect(isTransientNetworkError(netErr("CONNECT_TIMEOUT"))).toBe(true);
  });

  it("does not treat app errors as transient", () => {
    expect(isTransientNetworkError(new Error("column does not exist"))).toBe(false);
    expect(isTransientNetworkError(null)).toBe(false);
    expect(isTransientNetworkError("ENOTFOUND")).toBe(false);
  });
});

describe("withRetry", () => {
  it("retries a transient failure and succeeds", async () => {
    let calls = 0;
    const result = await withRetry(async () => {
      calls++;
      if (calls === 1) throw netErr("ENOTFOUND");
      return "ok";
    }, 2, 1);
    expect(result).toBe("ok");
    expect(calls).toBe(2);
  });

  it("does NOT retry non-transient errors", async () => {
    let calls = 0;
    await expect(
      withRetry(async () => {
        calls++;
        throw new Error("syntax error at or near");
      }, 3, 1)
    ).rejects.toThrow("syntax error");
    expect(calls).toBe(1);
  });

  it("gives up after the attempt budget", async () => {
    let calls = 0;
    await expect(
      withRetry(async () => {
        calls++;
        throw netErr("EAI_AGAIN");
      }, 2, 1)
    ).rejects.toThrow("EAI_AGAIN");
    expect(calls).toBe(2);
  });

  it("passes through the first result when nothing fails", async () => {
    expect(await withRetry(async () => 42, 2, 1)).toBe(42);
  });
});

describe("withRetry attempt deadline", () => {
  it("converts a hang into a retryable failure", async () => {
    let calls = 0;
    const result = await withRetry(
      () => {
        calls++;
        if (calls === 1) return new Promise<string>(() => {}); // hangs forever
        return Promise.resolve("recovered");
      },
      2,
      1,
      50 // 50ms attempt deadline for the test
    );
    expect(result).toBe("recovered");
    expect(calls).toBe(2);
  });

  it("gives up if every attempt hangs", async () => {
    await expect(
      withRetry(() => new Promise(() => {}), 2, 1, 30)
    ).rejects.toThrow("No response after 30ms");
  });
});

describe("withRetry deadline cancellation", () => {
  it("cancels the abandoned attempt so it can't zombie", async () => {
    let cancelled = 0;
    const makeHang = () => {
      const p = new Promise<string>(() => {}) as Promise<string> & {
        cancel: () => void;
      };
      p.cancel = () => {
        cancelled++;
      };
      return p;
    };
    let calls = 0;
    const result = await withRetry(
      () => {
        calls++;
        return calls === 1 ? makeHang() : Promise.resolve("ok");
      },
      2,
      1,
      30
    );
    expect(result).toBe("ok");
    expect(cancelled).toBe(1);
  });
});
