# Setup guide

Two paths: [run it locally](#a-run-it-locally) (10 minutes, to try it) and
[deploy it for your team](#b-deploy-to-production-vercel) (30 to 45 minutes,
most of it clicking through Google Cloud). Do A first; B builds on it.

Requirements: Node 20.9 or newer (`node --version`), git, and a Postgres
database (step A2).

---

## A. Run it locally

### A1. Get the code

1. Open https://github.com/mallick-prat/OpenDeal and click **Use this
   template, Create a new repository**. Pick your account, any name, and
   **Private**. (No GitHub account? Download the ZIP from the green **Code**
   button instead and skip B1's repo step until you have one.)
2. Clone your new repo:

```bash
git clone https://github.com/<your-username>/<your-repo>.git
cd <your-repo>
npm ci
cp .env.example .env.local
```

Open `.env.local` in an editor. You will fill it in over the next steps.
`.env.local` is gitignored; never commit it.

### A2. Create a Postgres database

Pick one.

**Supabase (recommended; also gives you file storage later)**
1. supabase.com, New project. Pick a region near you and save the database password.
2. Click **Connect** at the top of the project page.
3. Choose **Transaction pooler** (port 6543) and copy the URI. Replace
   `[YOUR-PASSWORD]` with your database password.
4. Paste it into `.env.local` as `DATABASE_URL=...`.

**Neon**
1. neon.tech, create a project, copy the **pooled** connection string.
2. Paste it as `DATABASE_URL=...`.

**Local Postgres (no signup)**
```bash
createdb opendeal
```
then `DATABASE_URL=postgres://localhost:5432/opendeal` (TLS is turned off
automatically for localhost).

### A3. Set the minimum configuration

In `.env.local`:

```
AUTH_SECRET=<output of: openssl rand -base64 32>
AUTH_URL=http://localhost:3000
FIRST_ADMIN_EMAIL=you@yourfund.com
FIRST_ADMIN_NAME=Your Name
NEXT_PUBLIC_ORG_NAME=Your Fund
NEXT_PUBLIC_TEAM_DOMAINS=yourfund.com
NEXT_PUBLIC_TIMEZONE=America/New_York
NEXT_PUBLIC_BRAND_COLOR="#0e7c66"   # keep the quotes in .env.local (a bare # is a comment)
```

`FIRST_ADMIN_EMAIL` matters: there is no signup page. Only people in the
`app_users` table can sign in, and this creates the first one.

### A4. Create the tables

```bash
npm run db:setup -- --seed
```

This applies `sql/schema.sql`, creates your admin user, and loads a handful of
clearly fictional demo deals (drop `-- --seed` for an empty board). It is safe
to re-run. If it fails through the Supabase pooler, switch `DATABASE_URL`
temporarily to the **Direct connection** (port 5432) string, run it once, then
switch back.

### A5. Start it and sign in

```bash
npm run dev
```

Open http://localhost:3000. Enter `FIRST_ADMIN_EMAIL` and click **Send code**.
With no email provider configured, the 6-digit code is printed in the terminal
where `npm run dev` is running (look for `[send-code]`). Paste it in.

You are in. Invite teammates at **Settings, Members** once you deploy (they need
a way to sign in, see B3).

---

## B. Deploy to production (Vercel)

### B1. Your own repository

If you used **Use this template** in A1, you already have one; skip ahead.
If you cloned this repo directly instead, move it to a repo you own:

```bash
git remote remove origin
gh repo create <your-repo> --private --source=. --push
```

Keep it private once your team's name or config is in it.

### B2. Create the Vercel project

1. vercel.com, **Add New, Project**, import your repo. Framework: Next.js (auto-detected).
2. Before the first deploy, open **Environment Variables** and add, for Production:

| Name | Value |
| --- | --- |
| `DATABASE_URL` | the pooler connection string from A2 |
| `AUTH_SECRET` | the same value you generated (or a new `openssl rand -base64 32`) |
| `AUTH_URL` | your production URL, for example `https://deals.yourfund.com` (set after B4 if you add a domain; the `*.vercel.app` URL works to start) |
| `AUTH_TRUST_HOST` | `true` |
| `CRON_SECRET` | `openssl rand -hex 24` (16+ characters; cron jobs are disabled without it) |
| `NEXT_PUBLIC_ORG_NAME`, `NEXT_PUBLIC_TEAM_DOMAINS`, `NEXT_PUBLIC_TIMEZONE`, `NEXT_PUBLIC_BRAND_COLOR` | as in A3 |

3. **Deploy.**

`NEXT_PUBLIC_*` values are baked in at build time, so changing one requires a redeploy.

The database tables already exist (you created them in A4 against the same
database), so there is nothing to migrate.

### B3. Sign-in for your team (pick at least one)

**Option 1: Google sign-in (recommended)**
1. console.cloud.google.com, create a project.
2. **APIs & Services, OAuth consent screen**: user type External (or Internal if
   you have Google Workspace), app name = your fund, support email = yours. Add
   yourself and teammates as **Test users** until you publish the app.
3. **Credentials, Create credentials, OAuth client ID**, type **Web application**.
   Authorized redirect URIs (add all four):
   - `https://<your-domain>/api/auth/callback/google`
   - `https://<your-domain>/api/google/callback`
   - `http://localhost:3000/api/auth/callback/google`
   - `http://localhost:3000/api/google/callback`
4. Copy the client ID and secret into Vercel as `AUTH_GOOGLE_ID` and
   `AUTH_GOOGLE_SECRET`, then redeploy.

**Option 2: emailed codes via Resend**
1. resend.com, create an API key, and add and verify your sending domain.
2. In Vercel: `RESEND_API_KEY=re_...` and
   `EMAIL_FROM=Your Fund <deals@yourfund.com>` (an address on the verified
   domain). Redeploy. Until you verify a domain, Resend only delivers to your own
   account email.

Either way, a person can only sign in if an admin added them: **Settings,
Members, add email**. The first admin was created by `db:setup`. Because both
local and production use the same database in this walkthrough, that admin
already exists in production.

### B4. Custom domain (optional)

Vercel, your project, **Settings, Domains**, add `deals.yourfund.com` and create
the DNS record Vercel shows. Then update `AUTH_URL`, the Google redirect URIs
(B3), and redeploy.

### B5. Scheduled jobs

`vercel.json` ships three daily jobs (inbound mailbox, calendar, Granola). They
run automatically once `CRON_SECRET` is set. Daily schedules work on every Vercel
plan; if you want them more often (say every 15 minutes), edit `vercel.json`, and
check your plan's cron limits in Vercel's docs first. Every job route rejects calls without the secret.

---

## C. Optional features

Each is off until you set its key. Add keys in Vercel (and `.env.local` for
local runs), then redeploy.

### C1. AI: pitch parsing and pass notes
`ANTHROPIC_API_KEY` from console.anthropic.com. Powers extraction from inbound
emails and decks, pass-note drafts, and meeting-note summaries.
`PERPLEXITY_API_KEY` (optional) adds web research for founder lookups.

### C2. File attachments
Needs Supabase (the project from A2 works).
1. Supabase, **Project Settings, API**: copy the project URL and the
   **service_role** key.
2. Set `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` (server-side only; never
   prefix with `NEXT_PUBLIC_`).
3. Run `npm run db:setup` once more with those in `.env.local`; it creates the
   private `opendeal-docs` bucket. (You can also create a private bucket with
   that exact name in the Supabase dashboard.)

Uploads are capped at 4 MB per request on Vercel. Larger files can arrive as
email attachments through the inbound mailbox.

### C3. Inbound pitch mailbox
See [INBOUND.md](INBOUND.md). Needs Google OAuth (B3, Option 1), the Gmail API
enabled, and `ANTHROPIC_API_KEY`.

### C4. Google Calendar and Gmail context
Google Cloud, **APIs & Services, Library**: enable **Gmail API** and **Google
Calendar API**. Each member then connects their own account at **Settings,
Google**. Scopes requested are read-only for calendar and read plus send for
Gmail (send is used only for pass notes you approve).

### C5. Granola meeting notes
Set `GRANOLA_API_KEY` (a `grn_...` key from your Granola workspace settings).
Notes then sync daily (and on demand) into the **Inbox** for triage.

---

## D. First 10 minutes after launch

1. Settings, Members: add each teammate's email and send the invite. Partner sees
   everything; Contributor sees only their own deals (see CONFIGURE.md).
2. Delete the demo deals if you loaded them.
3. Pipeline, **New deal**: add your first real company.
4. Open a deal and try: add a founder, change stage, leave a comment, copy the
   share link and open it in a private window (it works without login).

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `DATABASE_URL is not set` | `.env.local` must be in the project root; no quotes needed. |
| `db:setup` hangs or `prepared statement` errors | Use the pooler for the app and the **direct** string for `db:setup`. |
| Code email never arrives (production) | Resend domain not verified, or `EMAIL_FROM` is not on it. Check Resend logs. |
| "Continue with Google" says redirect_uri_mismatch | The redirect URI in B3 must match your `AUTH_URL` host exactly, including `https`. |
| Signed in with Google but bounced to login | That email is not in Settings, Members. Add it first. |
| Everything redirects to `localhost` after deploy | `AUTH_URL` still points at localhost; fix and redeploy. |
| Attachments say "File storage isn't configured" | Set `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` (C2). |
| Cron routes return 401 | `CRON_SECRET` missing or shorter than 16 characters. |
| Dev server errors with "Could not find the module ... in the React Client Manifest" | Stale build cache (often after `npm run build`). Stop the server, `rm -rf .next`, start again. |
| `JWTSessionError: no matching decryption secret` in the log | A cookie from an older `AUTH_SECRET`. Harmless; sign in again. |
