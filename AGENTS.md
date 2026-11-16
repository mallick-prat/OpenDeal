<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes: APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices. (For example, `middleware.ts` is now `proxy.ts`.)
<!-- END:nextjs-agent-rules -->

# OpenDeal: agent guide

A self-hosted deal-flow CRM for small investment teams. See `README.md` for
the product and `docs/ARCHITECTURE.md` for how it fits together.

## Setting up or deploying for someone

If the person asks you to install, set up, or deploy OpenDeal, follow
`docs/AGENT_SETUP.md` from the top.

## Rules of thumb

- **Customization lives in `src/config/crm.config.ts`.** Org name, team email
  domains, brand color, timezone, stage labels, and tag labels are all read
  from there (plus `NEXT_PUBLIC_*` env vars). Never hardcode them elsewhere.
- **Share links (`/deals/<gid>`) work without login.** They are capability
  URLs. Do not "fix" them by requiring auth.
- **Stage keys are internal ids** (`to-meet`, `first-meeting`, `cultivate`,
  `elevate`, `diligence`, `offered`, `to-pass`, `passed`). Change labels, not keys.
- **Cron and webhook routes fail closed** (`src/lib/cronAuth.ts`). Keep it that way.
- Database access is `postgres` (postgres.js) via `src/lib/db.ts`, no prepared
  statements (pooler-safe). Schema source of truth: `sql/schema.sql`.
- Tests: `npm test` (vitest). Run `npm run typecheck` and `npm test` before
  calling work done. Never commit `.env.local`.
- UI tokens: see `DESIGN_SYSTEM.md`. Reuse Carbon icons (`@carbon/icons-react`).
