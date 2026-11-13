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
  return process.env.DATABASE_URL?.trim() || process.env.SUPABASE_DB_URL?.trim() || undefined;
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
