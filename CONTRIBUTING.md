# Contributing

Issues and pull requests are welcome.

```bash
npm ci
cp .env.example .env.local   # DATABASE_URL, AUTH_SECRET, FIRST_ADMIN_EMAIL
npm run db:setup -- --seed
npm run dev
```

Before opening a PR:

```bash
npm run typecheck
npm run lint
npm test
```

Guidelines:

- Keep customization in `src/config/crm.config.ts`; do not hardcode an org name,
  domain, or stage label anywhere else.
- Read `docs/ARCHITECTURE.md` first. Schema changes go in `sql/schema.sql` and
  must be idempotent (`create ... if not exists`, `add column if not exists`).
- Add a test for any pure logic you touch (`src/lib/__tests__`).
- This repo uses Next.js 16. Check `node_modules/next/dist/docs/` before relying
  on older Next.js conventions.
- Never commit `.env.local`, real people's data, or API keys.
