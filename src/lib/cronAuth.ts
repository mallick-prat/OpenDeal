import { timingSafeEqual } from "crypto";

/**
 * Shared-secret gate for cron and ops routes (Vercel Cron sends
 * `Authorization: Bearer $CRON_SECRET` automatically when the variable is set).
 *
 * Fails CLOSED: with no secret configured, nothing is authorized. The naive
 * check `header === \`Bearer ${process.env.CRON_SECRET}\`` compares against the
 * literal string "Bearer undefined" when the variable is missing, which would
 * let anyone in by sending exactly that.
 */
export function isCronAuthorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret || secret.length < 16) return false;
  const given = req.headers.get("authorization") ?? "";
  const want = `Bearer ${secret}`;
  const a = Buffer.from(given);
  const b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
}
