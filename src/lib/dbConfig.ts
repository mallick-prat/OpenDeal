/**
 * Where the database is and whether to use TLS. Shared by the app's pool
 * (db.ts), the maintenance sweep (dbHealth.ts), and scripts/db-setup.mjs.
 *
 *   DATABASE_URL      any Postgres connection string (preferred name)
 *   SUPABASE_DB_URL   legacy name, still honored
 *   DATABASE_SSL      "require" | "disable"; default: TLS for remote hosts,
 *                     off for localhost
 */
export function databaseUrl(): string | undefined {
  const raw = process.env.DATABASE_URL?.trim() || process.env.SUPABASE_DB_URL?.trim();
  return raw ? withoutLibpqOnlyParams(raw) : undefined;
}

/**
 * Query parameters only libpq understands. postgres.js forwards unknown
 * parameters to the server as settings, and Postgres rejects them
 * ("unrecognized configuration parameter"). Neon's default connection
 * strings include channel_binding=require, so strip these before connecting.
 */
const LIBPQ_ONLY_PARAMS = ["channel_binding", "gssencmode"];

export function withoutLibpqOnlyParams(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  let changed = false;
  for (const key of LIBPQ_ONLY_PARAMS) {
    if (parsed.searchParams.has(key)) {
      parsed.searchParams.delete(key);
      changed = true;
    }
  }
  return changed ? parsed.toString() : url;
}

export function databaseSsl(url: string | undefined): "require" | false {
  const mode = process.env.DATABASE_SSL?.trim().toLowerCase();
  if (mode === "disable" || mode === "false" || mode === "off") return false;
  if (mode === "require" || mode === "true" || mode === "on") return "require";
  try {
    const host = new URL(url ?? "").hostname;
    if (host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]") return false;
  } catch {
    // unparseable URL: fall through to the safe default
  }
  return "require";
}
