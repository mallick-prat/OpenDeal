import { NextResponse } from "next/server";
import { currentAppUser } from "@/lib/users";
import { getDocument, signedDocumentUrl } from "@/lib/documents";

// A stalled pool retries for ~22s; the platform default (15s) would 504
// first. Explicit ceiling so retries get to finish.
export const maxDuration = 30;


const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Member-gated document viewer: redirects to a short-lived signed URL. */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await currentAppUser();
  if (!user) return NextResponse.json({ ok: false }, { status: 401 });
  const { id } = await params;
  if (!UUID.test(id)) return NextResponse.json({ ok: false }, { status: 400 });
  const doc = await getDocument(id);
  if (!doc) return NextResponse.json({ ok: false }, { status: 404 });
  const url = await signedDocumentUrl(doc.storage_key);
  if (!url) return NextResponse.json({ ok: false, error: "storage unavailable" }, { status: 503 });
  return NextResponse.redirect(url, 302);
}
