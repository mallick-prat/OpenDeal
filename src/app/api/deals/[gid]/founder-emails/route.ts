import { NextResponse } from "next/server";
import { currentAppUser } from "@/lib/users";
import {
  founderEmailState,
  addFounderEmail,
  setPrimaryFounderEmail,
  dismissFounderEmail,
  removeFounderEmail,
} from "@/lib/founderEmails";
import { logError } from "@/lib/log";
import { logActivity } from "@/lib/users";

export const maxDuration = 30;

/**
 * A deal's founder addresses: what we hold, and what the calendar suggests we
 * might be missing. Session-gated — these are real people's contact details.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ gid: string }> }
) {
  const member = await currentAppUser();
  if (!member) return NextResponse.json({ ok: false }, { status: 401 });
  const { gid } = await params;
  try {
    return NextResponse.json({ ok: true, founders: await founderEmailState(gid) });
  } catch (err) {
    logError("pipeline", "founder emails failed", err, { gid });
    return NextResponse.json({ ok: false }, { status: 500 });
  }
}

const ADDR = /^[^@\s]+@[^@\s.]+\.[^@\s]+$/;

export async function POST(
  req: Request,
  { params }: { params: Promise<{ gid: string }> }
) {
  const member = await currentAppUser();
  if (!member) return NextResponse.json({ ok: false }, { status: 401 });
  const { gid } = await params;

  let body: { action?: string; personId?: string; email?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Bad payload." }, { status: 400 });
  }

  const personId = String(body.personId ?? "");
  const email = String(body.email ?? "").trim().toLowerCase();
  // Deliberately permissive — real addresses are stranger than any regex.
  if (!personId || !ADDR.test(email) || email.length > 320) {
    return NextResponse.json(
      { ok: false, error: "That doesn't look like an email address." },
      { status: 400 }
    );
  }

  try {
    switch (body.action) {
      case "add":
        await addFounderEmail(personId, email);
        break;
      case "primary":
        await setPrimaryFounderEmail(personId, email);
        break;
      case "dismiss":
        await dismissFounderEmail(personId, email, member.email);
        break;
      case "remove":
        await removeFounderEmail(personId, email);
        break;
      default:
        return NextResponse.json({ ok: false, error: "Unknown action." }, { status: 400 });
    }
    void logActivity(member.email, `founder_email_${body.action ?? "?"}`, gid, { email });
    return NextResponse.json({ ok: true, founders: await founderEmailState(gid) });
  } catch (err) {
    logError("pipeline", "founder email update failed", err, { gid, action: body.action ?? "?" });
    return NextResponse.json(
      { ok: false, error: "Couldn't save that address." },
      { status: 500 }
    );
  }
}
