import { NextResponse } from "next/server";
import { currentAppUser } from "@/lib/users";
import { personalConnectionIdFor, syncConnection } from "@/lib/mailSync";
import { logError } from "@/lib/log";

export const maxDuration = 60;

/** "Sync now" for the member's OWN personal-inbox connection. */
export async function POST() {
  const member = await currentAppUser();
  if (!member) {
    return NextResponse.json(
      { ok: false, error: "Not signed in." },
      { status: 401 }
    );
  }
  const connectionId = await personalConnectionIdFor(member.email);
  if (!connectionId) {
    return NextResponse.json(
      { ok: false, error: "Personal inbox isn't connected yet." },
      { status: 404 }
    );
  }
  try {
    const counts = await syncConnection(connectionId);
    return NextResponse.json({ ok: true, counts });
  } catch (err) {
    logError("mail", "manual personal sync failed", err, {
      email: member.email,
    });
    return NextResponse.json(
      { ok: false, error: "Sync failed — see the system log." },
      { status: 500 }
    );
  }
}
