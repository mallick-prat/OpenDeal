import { NextResponse } from "next/server";
import { currentAppUser } from "@/lib/users";
import { getCandidate } from "@/lib/candidates";
import {
  downloadDocument,
  listDocumentsForEmail,
  listDocumentsForThread,
} from "@/lib/documents";
import { buildZip, bundleFilename, safeZipName, type ZipEntry } from "@/lib/zipPure";

/** Fetching a dozen objects out of storage and framing them takes longer
 *  than the platform default allows. */
export const maxDuration = 60;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The whole bundle is held in memory, so it needs a real ceiling. */
const MAX_BUNDLE_BYTES = 45 * 1024 * 1024;

/**
 * Every stored document for one candidate, as a single archive. Built on
 * demand rather than stored: the corpus grows as a thread continues, and a
 * bundle written at intake would be stale by the time anyone downloaded it.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await currentAppUser();
  if (!user) return NextResponse.json({ ok: false }, { status: 401 });

  const { id } = await params;
  if (!UUID.test(id)) return NextResponse.json({ ok: false }, { status: 400 });

  // getCandidate applies the viewer's visibility rules — a member who can't
  // see the candidate can't pull its materials either.
  const candidate = await getCandidate(id, user.email);
  if (!candidate) return NextResponse.json({ ok: false }, { status: 404 });

  // Thread-scoped when we have one: a pitch's materials arrive across
  // several replies, and the reviewer wants all of them, not just the
  // first message's.
  const docs = candidate.gmail_thread_id
    ? await listDocumentsForThread(candidate.gmail_thread_id)
    : candidate.source_email_id
      ? await listDocumentsForEmail(candidate.source_email_id)
      : [];
  if (docs.length === 0)
    return NextResponse.json(
      { ok: false, error: "no stored materials" },
      { status: 404 }
    );

  const taken = new Set<string>();
  const entries: ZipEntry[] = [];
  const skipped: string[] = [];
  const seen = new Set<string>();
  let total = 0;

  for (const doc of docs) {
    // The same deck forwarded down a thread is one document referenced from
    // several messages. Storage already dedupes it by checksum; the bundle
    // must too, or the reviewer unpacks three identical "deck (2).pdf".
    if (seen.has(doc.checksum)) continue;
    seen.add(doc.checksum);
    if (total + doc.bytes > MAX_BUNDLE_BYTES) {
      skipped.push(doc.filename);
      continue;
    }
    const bytes = await downloadDocument(doc.storage_key);
    // A document that won't come out of storage is named in the manifest
    // rather than silently dropped — a short archive that looks complete is
    // worse than one that says what's missing.
    if (!bytes) {
      skipped.push(doc.filename);
      continue;
    }
    total += bytes.length;
    entries.push({ name: safeZipName(doc.filename, taken), bytes });
  }

  if (entries.length === 0)
    return NextResponse.json(
      { ok: false, error: "materials unavailable" },
      { status: 503 }
    );

  if (skipped.length > 0) {
    entries.push({
      name: safeZipName("NOT-INCLUDED.txt", taken),
      bytes: Buffer.from(
        `These documents could not be added to this bundle:\n\n${skipped
          .map((f) => `  · ${f}`)
          .join("\n")}\n\nDownload them individually from the candidate page.\n`,
        "utf8"
      ),
    });
  }

  const zip = buildZip(entries);
  const name = bundleFilename(
    (candidate.parsed as { companyName?: string | null } | null)?.companyName ??
      candidate.subject
  );

  return new NextResponse(new Uint8Array(zip), {
    headers: {
      "Content-Type": "application/zip",
      "Content-Length": String(zip.length),
      "Content-Disposition": `attachment; filename="${name}"`,
      // Materials accrue over the life of a thread; never serve a stale one.
      "Cache-Control": "private, no-store",
    },
  });
}
