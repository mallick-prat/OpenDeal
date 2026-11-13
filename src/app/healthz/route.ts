import { NextResponse } from "next/server";

/** Extension connectivity ping (no auth, no data). */
export function GET() {
  return NextResponse.json({ ok: true, ts: new Date().toISOString() });
}
