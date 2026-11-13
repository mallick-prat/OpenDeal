import { NextResponse } from "next/server";
import { currentAppUser } from "@/lib/users";
import { collectDealExport, zipDealExport } from "@/lib/dealExport";
import { logError } from "@/lib/log";

// Gathering meetings, emails, and every stored document takes real time on
// document-heavy deals; give the collection room to finish.
export const maxDuration = 60;

const GID = /^(\d{1,30}|local-[0-9a-f-]{36})$/;

/**
 * Member-gated due-diligence export: the whole deal as one zip (record,
 * meetings, emails, documents, team notes, intel) structured for AI
 * ingestion. Streamed, so document-heavy bundles clear the platform's
 * buffered-response ceiling.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ gid: string }> }
) {
  const user = await currentAppUser();
  if (!user) return NextResponse.json({ ok: false }, { status: 401 });
  const { gid } = await params;
  if (!GID.test(gid)) return NextResponse.json({ ok: false }, { status: 400 });
  try {
    const bundle = await collectDealExport(gid);
    if (!bundle) return NextResponse.json({ ok: false }, { status: 404 });
    const zip = zipDealExport(bundle);
    const CHUNK = 256 * 1024;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < zip.byteLength; i += CHUNK) {
          controller.enqueue(zip.subarray(i, Math.min(i + CHUNK, zip.byteLength)));
        }
        controller.close();
      },
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${bundle.zipName}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    logError("dealExport", "export failed", err, { gid });
    return NextResponse.json({ ok: false, error: "Export failed." }, { status: 500 });
  }
}
