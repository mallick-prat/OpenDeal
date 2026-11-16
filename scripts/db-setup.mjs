#!/usr/bin/env node
/**
 * One-command database setup.
 *
 *   npm run db:setup              apply sql/schema.sql, create the first admin
 *   npm run db:setup -- --seed    ...and load a few fictional demo deals
 *
 * Reads DATABASE_URL (or the legacy SUPABASE_DB_URL) from the environment or
 * from .env.local. Safe to re-run: the schema is idempotent, the admin is only
 * created if you have no users yet, and the seed only runs on an empty board.
 *
 * The first admin comes from FIRST_ADMIN_EMAIL. The app has no signup page:
 * sign-in is limited to people in the app_users table, so without this row
 * nobody could ever log in. Add teammates afterwards in Settings → Members.
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Minimal .env.local loader (no dependency). Real environment variables win.
for (const file of [".env.local", ".env"]) {
  const path = resolve(root, file);
  if (!existsSync(path)) continue;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith("#")) continue;
    const value = m[2].replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}

const rawUrl = process.env.DATABASE_URL?.trim() || process.env.SUPABASE_DB_URL?.trim();
// Same as src/lib/dbConfig.ts: drop libpq-only parameters (Neon's default
// strings carry channel_binding=require), which Postgres would reject.
const url = (() => {
  if (!rawUrl) return rawUrl;
  try {
    const u = new URL(rawUrl);
    let changed = false;
    for (const key of ["channel_binding", "gssencmode"]) {
      if (u.searchParams.has(key)) { u.searchParams.delete(key); changed = true; }
    }
    return changed ? u.toString() : rawUrl;
  } catch {
    return rawUrl;
  }
})();
if (!url) {
  console.error(
    "\nDATABASE_URL is not set.\n" +
      "Copy .env.example to .env.local, paste your Postgres connection string,\n" +
      "and run this again. See docs/SETUP.md, step 3.\n"
  );
  process.exit(1);
}

function sslMode() {
  const mode = process.env.DATABASE_SSL?.trim().toLowerCase();
  if (["disable", "false", "off"].includes(mode ?? "")) return false;
  if (["require", "true", "on"].includes(mode ?? "")) return "require";
  try {
    const host = new URL(url).hostname;
    if (["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) return false;
  } catch {
    /* fall through */
  }
  return "require";
}

const sql = postgres(url, { ssl: sslMode(), max: 1, prepare: false, onnotice: () => {} });

async function main() {
  const host = (() => {
    try {
      return new URL(url).host;
    } catch {
      return "(database)";
    }
  })();
  console.log(`Connecting to ${host} ...`);
  await sql`select 1`;

  console.log("Applying sql/schema.sql ...");
  await sql.unsafe(readFileSync(resolve(root, "sql/schema.sql"), "utf8"));
  console.log("  schema ok");

  const adminEmail = process.env.FIRST_ADMIN_EMAIL?.trim().toLowerCase();
  const [{ n }] = await sql`select count(*)::int as n from app_users`;
  if (n === 0) {
    if (!adminEmail || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(adminEmail)) {
      console.error(
        "\nYou have no users yet, and FIRST_ADMIN_EMAIL is missing or not an email.\n" +
          "Set it in .env.local (the address you'll sign in with) and run this again.\n" +
          "Without it, nobody can log in.\n"
      );
      process.exit(1);
    }
    const name = process.env.FIRST_ADMIN_NAME?.trim() || adminEmail.split("@")[0];
    await sql`
      insert into app_users (email, name, role)
      values (${adminEmail}, ${name}, 'super_admin')
      on conflict (email) do nothing`;
    console.log(`  created first admin: ${adminEmail}`);
  } else {
    console.log(`  ${n} user(s) already exist; leaving them alone`);
  }

  if (process.argv.includes("--seed")) {
    const [{ deals }] = await sql`select count(*)::int as deals from deals`;
    if (deals > 0) {
      console.log(`  skipping seed: you already have ${deals} deal(s)`);
    } else {
      await sql.unsafe(readFileSync(resolve(root, "sql/seed.sql"), "utf8"));
      console.log("  loaded demo deals (all fictional)");
    }
  }

  // File storage (optional): create the private bucket deals' files live in.
  const storageUrl = process.env.SUPABASE_URL?.trim();
  const storageKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() || process.env.SUPABASE_SECRET_KEY?.trim();
  if (storageUrl && storageKey) {
    const res = await fetch(`${storageUrl.replace(/\/+$/, "")}/storage/v1/bucket`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${storageKey}`,
        apikey: storageKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ id: "opendeal-docs", name: "opendeal-docs", public: false }),
    }).catch((e) => ({ ok: false, status: 0, text: async () => String(e) }));
    const body = await res.text();
    if (res.ok) console.log("  created storage bucket opendeal-docs");
    else if (/already exists|Duplicate/i.test(body)) console.log("  storage bucket already exists");
    else console.log(`  WARNING: could not create the storage bucket (${res.status}): ${body.slice(0, 200)}`);
  } else {
    console.log("  file storage not configured (optional): attachments stay disabled");
  }

  console.log("\nDone. Next: npm run dev, then open http://localhost:3000\n");
}

main()
  .catch((err) => {
    console.error("\nSetup failed:", err.message ?? err, "\n");
    process.exitCode = 1;
  })
  .finally(() => sql.end({ timeout: 5 }));
