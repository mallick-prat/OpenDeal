import { NextResponse } from "next/server";
import { currentAppUser } from "@/lib/users";
import { dealInteractions } from "@/lib/interactions";
import { logError } from "@/lib/log";

export const maxDuration = 30;

/**
 * Every touchpoint with a deal's founders — synced mail plus calendar — pulled
 * on demand from a card. Session-gated; the board is already members-only, and
 * this returns real correspondence.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ gid: string }> }
) {
  const member = await currentAppUser();
  if (!member) return NextResponse.json({ ok: false }, { status: 401 });

  const { gid } = await params;
  try {
    return NextResponse.json({ ok: true, ...(await dealInteractions(gid)) });
  } catch (err) {
    logError("pipeline", "deal interactions failed", err, { gid });
    return NextResponse.json({ ok: false }, { status: 500 });
  }
}
