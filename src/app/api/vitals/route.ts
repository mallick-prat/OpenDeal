import { NextResponse } from "next/server";
import { currentAppUser } from "@/lib/users";
import { record } from "@/lib/perf";

export const maxDuration = 10;

const NAMES = new Set(["LCP", "INP", "CLS", "FCP", "TTFB"]);

/**
 * Browser web-vitals beacon. The <WebVitals /> client component posts each
 * metric once; they land in perf_events as vitals.LCP etc. CLS is unitless —
 * stored ×1000 so the integer column keeps three decimals of resolution.
 */
export async function POST(req: Request) {
  const member = await currentAppUser().catch(() => null);
  if (!member) return NextResponse.json({ ok: false }, { status: 401 });
  try {
    const body = (await req.json()) as {
      name?: unknown;
      value?: unknown;
      path?: unknown;
    };
    const name = typeof body.name === "string" ? body.name : "";
    const value = typeof body.value === "number" && Number.isFinite(body.value) ? body.value : null;
    if (!NAMES.has(name) || value === null) {
      return NextResponse.json({ ok: false }, { status: 400 });
    }
    const path =
      typeof body.path === "string" ? body.path.slice(0, 120) : null;
    record(`vitals.${name}`, name === "CLS" ? value * 1000 : value, {
      path,
      by: member.email,
    });
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ ok: false }, { status: 400 });
  }
}
