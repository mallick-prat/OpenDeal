# Design system

IBM Carbon-inspired, deliberately plain: white background, strong grid, dense
but readable tables, neutral text, and ONE brand color used for action and
emphasis. Serious, precise, no decoration for its own sake.

## One color knob

Set `NEXT_PUBLIC_BRAND_COLOR` (for example `#0e7c66`) and the whole theme
follows. `src/lib/brandPure.ts` derives a 9-step ramp from that hex and
`app/layout.tsx` injects it as CSS variables, overriding the defaults in
`app/globals.css`:

| Token | Use |
| --- | --- |
| `--brand-red-50` … `--brand-red-950` | The ramp. (The `red` in the name is historical; it is your brand color.) |
| `--color-primary`, `--color-primary-hover`, `--color-primary-pressed` | Buttons, selected states |
| `--text-link`, `--text-link-hover`, `--border-focus` | Links and focus rings |
| `--danger` | Destructive actions. Stays red regardless of brand. |

## Rules

- Body text stays neutral. The brand color signals action, selection, emphasis.
- Never use color as the only signal; pair it with text or an icon.
- Tags/stages use the colors in `src/config/crm.config.ts`.
- Icons: `@carbon/icons-react`, 16/20px.
- Type: IBM Plex Sans (loaded in `app/layout.tsx`); tabular figures for numbers.
