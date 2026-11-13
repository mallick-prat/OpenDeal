import { NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { canTouchDeal } from "@/lib/dealAccess";
import { documentsConfigured, saveDocument } from "@/lib/documents";
import { currentAppUser } from "@/lib/users";

// A stalled pool retries for ~22s; the platform default would 504 first.
export const maxDuration = 30;

const GID = /^(\d{1,30}|local-[0-9a-f-]{36})$/;
const MAX_FILES = 10;
// Vercel caps request bodies at 4.5MB, so keep a safe margin. For bigger
// files, upload them as email attachments to the inbound mailbox instead.
const MAX_TOTAL_BYTES = 4 * 1024 * 1024;

/**
 * Attach files to a deal. Files live in the `documents` store (Supabase
 * Storage), keyed by content hash, and show up on the deal card.
 */
export async function POST(req: Request) {
  // Membership, not just a session cookie, then per-deal access below.
  const member = await currentAppUser().catch(() => null);
  if (!member) {
    return NextResponse.json({ ok: false, error: "Not signed in." }, { status: 401 });
  }

  // Fail loudly: saveDocument no-ops when storage isn't set up, which would
  // otherwise report success while silently dropping the file.
  if (!documentsConfigured()) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "File storage isn't configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (see docs/SETUP.md, step 4).",
      },
      { status: 503 }
    );
  }

  const form = await req.formData().catch(() => null);
  if (!form) {
    return NextResponse.json({ ok: false, error: "Invalid upload." }, { status: 400 });
  }
  const dealGid = String(form.get("taskGid") ?? form.get("dealGid") ?? "");
  if (!GID.test(dealGid)) {
    return NextResponse.json({ ok: false, error: "Invalid deal id." }, { status: 400 });
  }
  if (!(await canTouchDeal(member, dealGid))) {
    return NextResponse.json(
      { ok: false, error: "That deal isn't on your board." },
      { status: 403 }
    );
  }
  const files = form.getAll("files").filter((f): f is File => f instanceof File);
  if (files.length === 0 || files.length > MAX_FILES) {
    return NextResponse.json(
      { ok: false, error: `Attach between 1 and ${MAX_FILES} files.` },
      { status: 400 }
    );
  }
  if (files.reduce((n, f) => n + f.size, 0) > MAX_TOTAL_BYTES) {
    return NextResponse.json(
      { ok: false, error: "Files exceed the 4MB upload limit." },
      { status: 400 }
    );
  }

  for (const file of files) {
    await saveDocument({
      bytes: Buffer.from(await file.arrayBuffer()),
      filename: file.name,
      mime: file.type || "application/octet-stream",
      sourceType: "upload",
      dealGid,
    });
  }
  await sql`
    update deals set attachment_count = attachment_count + ${files.length}
    where gid = ${dealGid}
  `.catch(() => {});

  return NextResponse.json({ ok: true, uploaded: files.length, failed: [] });
}
