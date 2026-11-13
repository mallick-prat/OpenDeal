# Configure it for your team

Everything that says "who we are" lives in two places: four environment
variables, and one file, `src/config/crm.config.ts`.

## Environment variables (no code change)

Set in Vercel (Settings, Environment Variables) or `.env.local`, then redeploy
(they are `NEXT_PUBLIC_*`, baked in at build time).

| Variable | Default | Effect |
| --- | --- | --- |
| `NEXT_PUBLIC_ORG_NAME` | `Your Fund` | Name in the header, login, emails, page titles, share pages, and the logo mark (initials). |
| `NEXT_PUBLIC_TEAM_DOMAINS` | `example.com` | Your team's email domains, comma-separated. People at these domains are "internal": never treated as a founder, and meetings with only them are skipped. **Set this correctly or your own colleagues will show up as founders.** |
| `NEXT_PUBLIC_TIMEZONE` | `America/New_York` | Every date renders in this zone for everyone, so "added Jul 8" means the same day to the whole team. |
| `NEXT_PUBLIC_BRAND_COLOR` | `#0f62fe` | One hex themes buttons, links, focus rings, the logo, charts, emails, and the favicon. A 9-step ramp is derived automatically; very dark and very light colors are handled. In `.env.local` write it quoted (`"#0e7c66"`) or without the `#` (`0e7c66`): an unquoted `#` starts a comment. In Vercel's UI no quoting is needed. |
| `NEXT_PUBLIC_INBOUND_MAILBOX` | empty | Shared address for pitches. Empty means the inbound queue is off. See [INBOUND.md](INBOUND.md). |
| `EMAIL_FROM` | `<Org> <onboarding@resend.dev>` | From header for sign-in codes and invites. |
| `APP_URL` | `AUTH_URL` | Base URL for links in emails. |

## `src/config/crm.config.ts`

### Stages

```ts
stages: [
  { key: "to-meet", label: "To Meet", short: "To Meet", color: "#d0e2ff", active: true },
  ...
]
```

- Change `label`, `short`, `color`, and `active` freely. Reorder by moving entries.
- **Do not rename or remove a `key`.** Keys are stored in the database and used
  by logic: new deals start at `to-meet`, passing a deal moves it to `passed`,
  the "Partner Review" step is `elevate`.
- `active: true` means the stage counts as live pipeline in funnel stats.
- Want fewer stages? Keep all eight keys but relabel two to read the same, or
  mark unused ones `active: false`. (Removing stages is deliberately not
  supported: it would strand existing deals.)

Example: a two-person angel group

```ts
{ key: "to-meet",       label: "Inbox",        short: "Inbox",   color: "#d0e2ff", active: true },
{ key: "first-meeting", label: "Intro Call",   short: "Intro",   color: "#78a9ff", active: true },
{ key: "cultivate",     label: "Watching",     short: "Watch",   color: "#4589ff", active: true },
{ key: "elevate",       label: "IC",           short: "IC",      color: "#0f62fe", active: true },
{ key: "diligence",     label: "Diligence",    short: "DD",      color: "#0043ce", active: true },
{ key: "offered",       label: "Committed",    short: "Funded",  color: "#002d9c", active: true },
{ key: "to-pass",       label: "Pass (draft)", short: "To Pass", color: "#c6c6c6", active: false },
{ key: "passed",        label: "Passed",       short: "Passed",  color: "#e0e0e0", active: false },
```

### Tags

Deals carry free-form tags. Call them whatever fits:

```ts
tags: { singular: "Sector", plural: "Sectors", quickFilters: ["Fintech", "Health"], colors: { fintech: "#0e7c66" } },
```

`quickFilters` are pinned at the top of the tag filter; `colors` is keyed by
lowercase tag name. (Internally the database column is still called `schools`;
the label you set here is what people see.)

### Other

- `pipelineName`: the heading above the board.
- `rounds`: financing rounds in the deal form, also the only values AI
  extraction may set. Existing deals with a value not in the list keep it.

## Team and roles

| Role (stored as) | Sees | Can also |
| --- | --- | --- |
| **Owner** (`super_admin`) | every deal, the inbox | change roles, remove members, read the activity log, "view as" another member. The first admin from `db:setup` is an Owner. The last Owner can never be removed or demoted. |
| **Partner** (`admin`) | every deal, the inbox | invite members (as Partner or Contributor) |
| **Contributor** (`user`) | only deals they own, co-own, or created | add and edit their own deals. No inbox triage. Good for scouts, fellows, or venture partners. |

Invite people at **Settings, Members**. New invites default to Partner.

Trust model: this is built for a small team that trusts each other. Any
signed-in member who has a file's or export's link can open it; Contributor
limits apply to the board and editing, not to every read path.

## Visibility model

| Value | Meaning |
| --- | --- |
| `team` | Visible to every signed-in member (the default). |
| `private` | Listed only for its owner (for example an unreviewed draft). |
| `restricted` | Inbound candidates before someone approves them. |

Share links (`/deals/<id>`) work with no login for anyone holding the URL, in
every mode. Treat them like an unlisted link and share accordingly.
