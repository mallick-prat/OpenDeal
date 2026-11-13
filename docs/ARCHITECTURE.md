# Architecture

Read this before changing anything. It is short on purpose.

## Shape

- **Next.js 16 App Router**, server components first, server actions for
  mutations (`src/app/actions.ts`), route handlers under `src/app/api`.
- **Postgres** through postgres.js (`src/lib/db.ts`) with `prepare: false` so it
  works behind transaction poolers (Supabase, Neon). Connection settings and
  TLS rules: `src/lib/dbConfig.ts`.
- **NextAuth v5** (`src/auth.ts`): Google, emailed 6-digit codes, and invite
  magic links. Authorization is membership in the `app_users` table, not an
  allowlist env var. `src/proxy.ts` (Next 16's renamed middleware) gates every
  route except the short exemption list in its matcher.
- **Config**: `src/config/crm.config.ts` is the single source for org name,
  domains, brand, timezone, stages, and tag labels. Pure helpers live next to it
  (`src/lib/brandPure.ts`, `src/lib/stages.ts`).

## Conventions

- **`*Pure.ts` files have no I/O.** Logic that can be pure is, and is unit tested
  in `src/lib/__tests__`. Server-only modules start with `import "server-only"`.
- **Schema** is `sql/schema.sql`: idempotent, applied by `npm run db:setup`.
  Change it by adding `create ... if not exists` / `alter table ... add column
  if not exists` statements. All tables have row level security enabled with no
  policies and API-role privileges revoked (when those roles exist), so the
  Supabase public API cannot read your data; only the app's own connection can.
- **Fail closed.** Cron and webhook routes authenticate with shared secrets
  (`src/lib/cronAuth.ts` requires `CRON_SECRET` of 16+ characters, timing-safe
  compare). Anything exempted from the proxy matcher must authenticate itself.
- **Optional integrations degrade, not crash.** Missing keys produce
  "not configured" states (Granola, Anthropic, storage, inbound mailbox).

## Data model (the parts worth knowing)

| Table | Notes |
| --- | --- |
| `deals` | `gid` is the text primary key (`local-<uuid>` for deals made here). `stage` and `section_gid` both hold the stage key. `schools` is a text array: your **tags** (the name is historical). `visibility` is `team` / `private` / `restricted`. |
| `network_people` | The **people** table (historical name). Founders live here, linked to deals through `deal_founders`. |
| `app_users` | Who may sign in. Roles: `super_admin` (Owner), `admin` (Partner), `user` (Contributor: own deals only, enforced in `DashboardPage.tsx` and `lib/dealAccess.ts`). |
| `deal_owners`, `deal_comments`, `deal_decisions` | Ownership, discussion, and the decision log with rationale. |
| `inbound_mailboxes`, `inbound_emails` | The optional inbound pipeline. |
| `documents` | Content-addressed file metadata; bytes live in Supabase Storage. |
| `meeting_notes`, `calendar_events`, `email_threads`, `email_messages` | Granola, Calendar, and Gmail context. |
| `activity_log`, `perf_events` | Audit trail and lightweight performance metrics. |

Stage keys (`to-meet`, `first-meeting`, `cultivate`, `elevate`, `diligence`,
`offered`, `to-pass`, `passed`) are internal ids. Labels and colors come from
config. Logic depends on `to-meet` (default), `passed` (after a pass), and
`elevate` (promotion from private to team).

## Request flow examples

**Create a deal**: `CreateDealModal` calls the `createDeal` server action,
which validates, inserts into `deals`, upserts founders into `network_people`,
logs activity, and revalidates the dashboard.

**Public share page**: `/deals/[gid]` is exempt from sign-in
(`auth.config.ts` `authorized` callback). `getPublicDeal` returns only the
fields meant for sharing. The gid is the capability.

**Inbound pitch**: cron or Poll now calls `ingestSince` (`src/lib/inbound.ts`),
which reads Gmail, parses MIME (`emailParse.ts`), stores an `inbound_emails`
row, and for a thread's first message calls Claude (`deckExtract.ts`). A
reviewer's **Create deal** promotes the draft.

## Things to know before you extend it

- `NEXT_PUBLIC_*` config is baked at build time.
- The Postgres pool is created once per server instance; `db.ts` retries
  transient connection errors. Avoid long transactions (pooler friendly).
- Cookies are named `od_code` (sign-in code) and `od_viewas*` (admin view-as).
- Dates render, and analytics bucket days, in `crm.org.timezone`, not the browser's zone.
- Tests run against the default config (pinned in `vitest.config.ts`), so your own `NEXT_PUBLIC_*` values never affect them.
