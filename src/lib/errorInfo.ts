/**
 * Flatten any thrown value into loggable fields. Pure — safe to unit test
 * and to call from anywhere.
 */
export function errorInfo(err: unknown): Record<string, string> {
  if (err instanceof Error) {
    const e = err as Error & { code?: unknown; digest?: unknown };
    const out: Record<string, string> = {
      name: err.name,
      message: err.message.slice(0, 500),
    };
    if (typeof e.code === "string") out.code = e.code;
    if (typeof e.digest === "string") out.digest = e.digest;
    if (err.stack) {
      // First few frames locate the throw; the rest is noise in a log row.
      out.stack = err.stack.split("\n").slice(0, 4).join("\n").slice(0, 600);
    }
    if (err.cause instanceof Error) {
      out.cause = `${err.cause.name}: ${err.cause.message.slice(0, 200)}`;
    }
    return out;
  }
  if (typeof err === "string") return { message: err.slice(0, 500) };
  try {
    return { message: JSON.stringify(err).slice(0, 500) };
  } catch {
    return { message: String(err).slice(0, 500) };
  }
}
