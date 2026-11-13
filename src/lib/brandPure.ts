/**
 * ── Brand color → full shade ramp ───────────────────────────────────────────
 * The UI is themed by a ramp of ten shades (--brand-red-50 … --brand-red-950;
 * the "red" in the token names is historical, the values follow YOUR color).
 * You set ONE hex (NEXT_PUBLIC_BRAND_COLOR); the rest is derived here by
 * keeping the hue and sliding lightness, so a friend's rebrand is one line.
 *
 * Pure: no env, no DOM, so it tests.
 */

export type RampStep = 50 | 100 | 200 | 300 | 500 | 600 | 700 | 800 | 950;

const HEX = /^#?([0-9a-f]{6})$/i;

export function normalizeHex(input: string | null | undefined, fallback: string): string {
  const m = (input ?? "").trim().match(HEX);
  return m ? `#${m[1].toLowerCase()}` : fallback;
}

function hexToHsl(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return [0, 0, l * 100];
  const s = d / (1 - Math.abs(2 * l - 1));
  let h: number;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [(h * 60 + 360) % 360, s * 100, l * 100];
}

function hslToHex(h: number, s: number, l: number): string {
  const sat = Math.max(0, Math.min(100, s)) / 100;
  const lig = Math.max(0, Math.min(100, l)) / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = sat * Math.min(lig, 1 - lig);
  const f = (n: number) => lig - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const to = (x: number) => Math.round(x * 255).toString(16).padStart(2, "0");
  return `#${to(f(0))}${to(f(8))}${to(f(4))}`;
}

/** Ten-ish shades from one color. 500 is the color itself, exactly. */
export function brandRamp(primary: string): Record<RampStep, string> {
  const base = normalizeHex(primary, "#0f62fe");
  const [h, s, l] = hexToHsl(base);
  // Light tints keep the hue but pale out; dark shades step down from the base.
  const tint = (lightness: number, satScale: number) => hslToHex(h, s * satScale, lightness);
  // Interpolate toward a near-black floor, so even a very dark brand color
  // keeps four distinct, ordered darker steps (subtracting a fixed amount
  // bottoms out and collapses them into the same value).
  const FLOOR = 8;
  const shade = (t: number) => hslToHex(h, s, l + (FLOOR - l) * t);
  return {
    50: tint(96, 0.9),
    100: tint(91, 0.95),
    200: tint(83, 1),
    300: tint(72, 1),
    500: base,
    600: shade(0.2),
    700: shade(0.42),
    800: shade(0.62),
    950: shade(0.85),
  };
}

/** CSS that overrides the ramp tokens, for injection into <head>. */
export function brandCss(primary: string): string {
  const r = brandRamp(primary);
  const decl = (Object.keys(r) as unknown as RampStep[])
    .map((k) => `--brand-red-${k}:${r[k]}`)
    .join(";");
  return `:root{${decl};--text-link:${r[500]};--text-link-hover:${r[700]};--border-focus:${r[500]}}`;
}

/** "Acme Ventures" → "AV"; "Acme" → "AC"; "" → "D". For the logo and favicon. */
export function orgInitials(name: string | null | undefined): string {
  const words = (name ?? "").trim().split(/[\s\-_/]+/).filter(Boolean);
  if (words.length === 0) return "D";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}
