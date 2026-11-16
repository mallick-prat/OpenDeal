# Agent setup runbook

This file is written for a coding agent (Claude Code, Codex, Cursor, Gemini
CLI, or similar) that a person has asked to install and deploy OpenDeal for
them. A person can follow it too; [SETUP.md](SETUP.md) is the longer manual
version.

The goal is a live, signed-in CRM in about 15 minutes. The person should only
have to do four things: create two accounts, approve a browser login or two,
and answer a few questions. You do the rest.

## Ground rules for the agent

1. **Do every step you can yourself.** Run the commands, edit the files, read
   the output, and fix problems. Stop for the person only when a step needs
   their account, a browser click, a payment method, or a decision.
2. **When you need the person, give one step at a time** with the exact URL,
   the exact buttons to click, and what to paste back. Number the steps. Don't
   send them to read this file.
3. **Secrets never leave the machine except into Vercel.** Generate them
   locally. Don't print them, commit them, or put them in URLs or command
   history you show. When the person gives you an API key, put it straight
   into Vercel and `.env.local` and don't repeat it back.
4. **Verify each phase before moving on.** Each phase below ends with a check.
5. **Don't skip the minimum.** The minimum is a database, `AUTH_SECRET`, the
   first admin, and a deploy. Everything in phase 8 is optional; offer it once
   at the end, briefly.
6. Commands assume macOS or Linux. On Windows, use WSL or translate them.

## The fast path at a glance

| Phase | Who | Time |
| --- | --- | --- |
| 1. Ask the setup questions | person answers | 1 min |
| 2. Check tools | agent | 1 min |
| 3. Make the person's own copy of the repo | agent, person approves GitHub login if needed | 2 min |
| 4. Vercel account and project | person signs up, agent links | 3 min |
| 5. Database (Neon through Vercel) | agent, person may accept terms in a browser | 2 min |
| 6. Secrets and config | agent | 1 min |
| 7. Create tables, deploy, sign in | agent, person clicks the sign-in link | 5 min |
| 8. Optional add-ons | person creates keys, agent wires them | 2 to 15 min each |

---

## Phase 1. Ask the setup questions

Ask these in **one** message. Offer the defaults so the person can just say
"defaults".

1. Your fund or team name (shown in the app). Example: `Northwind Ventures`.
2. Your name and the email you'll sign in with. This becomes the first admin.
3. Your team's email domain(s), comma-separated, for example
   `northwind.vc`. People at these domains are never mistaken for founders.
   Default: the domain of the email in question 2.
4. Brand color as a hex code. Default `#0f62fe` (blue).
5. Timezone for dates. Default: this computer's timezone
   (`node -e "console.log(Intl.DateTimeFormat().resolvedOptions().timeZone)"`).
6. Load a few fictional demo deals so the board isn't empty? Default yes.
7. Deploy to the web now, or only run on this computer? Default deploy.

Write the answers down. Pick a short project slug from the name, for example
`northwind-deals`.

## Phase 2. Check tools

```bash
node --version   # needs 20.9 or newer
git --version
gh --version     # optional; makes phase 3 one command
npx vercel@latest --version
```

- Node missing or too old: tell the person to install the LTS from
  https://nodejs.org (or `brew install node`), then continue.
- Use `npx vercel@latest` everywhere below if `vercel` isn't installed
  globally. (Installing it with `npm i -g vercel` is fine too.)

**Check:** Node is 20.9 or newer.

## Phase 3. Make the person's own copy of the repo

The person should own a private copy. Their team's data never goes in this
public repo.

With the GitHub CLI:

```bash
gh auth status || gh auth login --web       # person approves in the browser
gh repo create <slug> --template mallick-prat/OpenDeal --private --clone
cd <slug>
npm ci
```

Without `gh`, or if the person has no GitHub account and doesn't want one yet:

```bash
git clone https://github.com/mallick-prat/OpenDeal.git <slug>
cd <slug>
git remote remove origin    # they can create their own repo later (SETUP.md, B1)
npm ci
```

If the person needs a GitHub account, send them to https://github.com/signup
and continue once they're signed in.

**Check:** `npm ci` finished and `package.json` has `"name": "opendeal"`.

## Phase 4. Vercel account and project

Vercel hosts the app and creates the database in phase 5. The free Hobby plan
is enough to start.

Tell the person:

> 1. Open https://vercel.com/signup and choose **Continue with GitHub** (or email).
> 2. Tell me when you're signed in.

Then:

```bash
npx vercel@latest login              # person approves in the browser
npx vercel@latest link --yes --project <slug>
```

`link --yes` creates the project under their default team and writes
`.vercel/` (gitignored).

**Check:** `.vercel/project.json` exists.

If they chose "only run on this computer" in phase 1, you can skip Vercel:
use any Postgres (`createdb opendeal` for a local one, or a Neon or Supabase
connection string the person pastes), write `.env.local` by hand from
`.env.example` with the values from phase 6, and jump to phase 7's local
check.

## Phase 5. Database (Neon through Vercel)

```bash
npx vercel@latest integration add neon
```

This creates a free Neon Postgres database, connects it to the project, and
adds `DATABASE_URL` (pooled) and `DATABASE_URL_UNPOOLED` to every environment.
The first time, Vercel may ask the person to accept Neon's terms in a browser,
or the command may prompt for a region and plan. If your shell can't answer
prompts, ask the person to run that one command in their own terminal and
accept the defaults (free plan, a region near them).

Any other Postgres 14+ works too. If the person already has Supabase or Neon,
have them paste the **pooled** connection string and add it yourself:

```bash
printf '%s' "$URL" | npx vercel@latest env add DATABASE_URL production
printf '%s' "$URL" | npx vercel@latest env add DATABASE_URL development
```

Neon strings that end in `channel_binding=require` are fine; the app drops
that parameter.

**Check:** `npx vercel@latest env ls` lists `DATABASE_URL`.

## Phase 6. Secrets and config

Generate the secrets locally and store them in Vercel for **production** and
**development**. Use the **same** `AUTH_SECRET` in both, so the sign-in link
you make in phase 7 works on the live site.

```bash
AUTH_SECRET=$(openssl rand -base64 32)
CRON_SECRET=$(openssl rand -hex 24)

add() {  # add NAME VALUE ENV...
  local name=$1 value=$2; shift 2
  for env in "$@"; do
    printf '%s' "$value" | npx vercel@latest env add "$name" "$env" --force >/dev/null
  done
}

add AUTH_SECRET "$AUTH_SECRET" production development
add CRON_SECRET "$CRON_SECRET" production
add AUTH_TRUST_HOST true production development
add AUTH_URL http://localhost:3000 development
add FIRST_ADMIN_EMAIL "<email>" production development
add FIRST_ADMIN_NAME "<name>" production development
add NEXT_PUBLIC_ORG_NAME "<fund name>" production development
add NEXT_PUBLIC_TEAM_DOMAINS "<domains>" production development
add NEXT_PUBLIC_TIMEZONE "<timezone>" production development
add NEXT_PUBLIC_BRAND_COLOR "<#hex>" production development

npx vercel@latest env pull .env.local --environment development --yes
```

`AUTH_URL` for production is set in phase 7, once the URL is known. Preview
deployments only need these if the person wants previews; add them with
`preview` the same way.

**Check:** `.env.local` contains `DATABASE_URL`, `AUTH_SECRET`, and
`FIRST_ADMIN_EMAIL` (check that the names are present, without printing the values).

## Phase 7. Create tables, deploy, sign in

**Create the tables and the first admin:**

```bash
npm run db:setup -- --seed     # drop "-- --seed" if they said no demo deals
```

If it hangs or errors through the pooler, run it once on the direct string:
`DATABASE_URL="$(grep ^DATABASE_URL_UNPOOLED= .env.local | cut -d= -f2- | tr -d '"')" npm run db:setup -- --seed`.

**Optional local check** (worth 30 seconds):

```bash
npm run dev    # in the background
npm run signin-link -- <email>
```

Open the printed `http://localhost:3000/magic?token=...` link yourself if you
can drive a browser, or give it to the person. They should land on the
dashboard. Stop the dev server afterwards.

**Deploy:**

```bash
npx vercel@latest deploy --prod --yes
```

The last line of output is the deployment URL. The stable production URL is
usually `https://<slug>.vercel.app`; confirm it with
`npx vercel@latest project inspect` or the deploy output, then:

```bash
add AUTH_URL "https://<production-host>" production
npx vercel@latest deploy --prod --yes
```

`NEXT_PUBLIC_*` values are baked in at build time, so any change to them
needs another deploy.

**Hand over the first sign-in.** Production has no email or Google sign-in
yet, so make a 7-day link signed with the same `AUTH_SECRET`:

```bash
npm run signin-link -- <email> --url https://<production-host>
```

Send the person that link and tell them to bookmark the site after signing
in. The link is a credential: give it only to them.

**Check:** the person confirms they see their dashboard on the live URL.

**Connect Git (if they have a GitHub repo from phase 3)**, so every push
deploys:

```bash
npx vercel@latest git connect
```

## Phase 8. Optional add-ons

Offer these once, in a short list, and do the ones the person picks. Each
needs a key from the person; you add it to Vercel (production and
development), re-pull `.env.local`, and redeploy.

### Teammates (no setup)
In the app: **Settings, Members**, add each email and pick Partner (sees every
deal) or Contributor (sees their own deals). The copy icon next to a member
makes a 7-day sign-in link to send them over Slack or text. For everyday sign-in
without links, add email codes or Google below.

### Email sign-in codes (Resend, about 3 minutes)
Tell the person:
> 1. Sign up at https://resend.com/signup.
> 2. Go to **API Keys**, click **Create API Key**, name it `opendeal`, keep
>    **Sending access**, and create it.
> 3. Paste the key (starts with `re_`) here.

Add `RESEND_API_KEY`. Until they verify a domain in Resend (**Domains, Add
Domain**, then the DNS records it shows), Resend only delivers to their own
Resend account email, and `EMAIL_FROM` stays
`<Fund> <onboarding@resend.dev>`. After verifying, set
`EMAIL_FROM="<Fund> <deals@theirdomain>"`.

### AI pitch parsing and pass notes (Anthropic, about 3 minutes)
Tell the person:
> 1. Sign up at https://console.anthropic.com.
> 2. Open **Billing** and add a payment method or credits. API use is billed
>    separately from any Claude subscription.
> 3. Open **API Keys**, click **Create Key**, name it `opendeal`, and paste
>    the key (starts with `sk-ant-`) here. It is shown only once.

Add `ANTHROPIC_API_KEY`. This powers inbound pitch extraction, pass-note
drafts, and meeting-note summaries.

### Google sign-in, Calendar, and Gmail (about 15 minutes, mostly clicking)
This is the slowest add-on because Google Cloud has no shortcut. Walk the
person through [SETUP.md, B3 option 1](SETUP.md#b3-sign-in-for-your-team-pick-at-least-one)
one screen at a time, using their production host in the redirect URIs. Then add
`AUTH_GOOGLE_ID` and `AUTH_GOOGLE_SECRET`. For Calendar and Gmail on deals,
also enable the two APIs in [SETUP.md, C4](SETUP.md#c4-google-calendar-and-gmail-context).

### Inbound pitch mailbox
Needs Google (above) and Anthropic. Follow [INBOUND.md](INBOUND.md).

### File attachments
Needs a Supabase project for storage, even if the database is on Neon. See
[SETUP.md, C2](SETUP.md#c2-file-attachments).

### Granola meeting notes
The person copies an API key (starts with `grn_`) from their Granola workspace
settings. Add it as `GRANOLA_API_KEY`.

After adding keys:

```bash
npx vercel@latest env pull .env.local --environment development --yes
npx vercel@latest deploy --prod --yes
```

## Finish: report to the person

End with a short summary in plain language:

- The live URL, and that the sign-in link they used expires in 7 days.
- Where their code lives (their GitHub repo, or the local folder).
- Which add-ons are on and which are off, and the one-line way to turn on each.
- How to add teammates (Settings, Members).
- That `.env.local` holds secrets and must never be committed.

## If something fails

| Symptom | Fix |
| --- | --- |
| `vercel integration add neon` waits for input | Ask the person to run it in their own terminal and accept the defaults. |
| `db:setup` fails through the pooler | Run it once with `DATABASE_URL_UNPOOLED`, as in phase 7. |
| The sign-in link says it didn't work | The link's `AUTH_SECRET` differs from production's, or the email isn't a member. Make sure both environments use the same secret, then redeploy. |
| Live site redirects to localhost | `AUTH_URL` for production is missing or wrong. Fix it and redeploy. |
| Build fails on Vercel | Read the log with `npx vercel@latest inspect <deployment-url> --logs`; most often a missing env var. |

More in [SETUP.md, Troubleshooting](SETUP.md#troubleshooting).
