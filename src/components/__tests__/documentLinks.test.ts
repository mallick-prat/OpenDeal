import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * ── Download-link invariant ──────────────────────────────────────────────
 * Every link that opens a stored document or the materials bundle must
 * open in a new tab, never navigate the triage page itself away — the
 * reviewer is mid-workflow, not done with the page. A source check rather
 * than a DOM render: DealCardWorkspace takes a full CandidateCore prop
 * (candidate, parsed extraction, claims ledger, team history, documents),
 * and building a valid mock of that just to assert two anchor attributes
 * would be a lot of brittle setup for what this can verify directly and
 * exactly. It catches the actual regression class: a new download link
 * added without target="_blank" — which is precisely what happened here
 * (the "Download all" materials link shipped without it while the
 * per-document links right next to it had it).
 */

const SOURCE = readFileSync(
  join(__dirname, "../DealCardWorkspace.tsx"),
  "utf8"
);

/** Every `<a ...>` tag, so each can be checked for its own attributes. */
function anchorTags(source: string): string[] {
  return source.match(/<a\b[^>]*>/g) ?? [];
}

describe("document and materials links open in a new tab", () => {
  const downloadHrefPattern = /href=\{`\/api\/(documents|candidates)\//;

  it("every download-route anchor has target=_blank and rel=noreferrer", () => {
    const downloadAnchors = anchorTags(SOURCE).filter((tag) =>
      downloadHrefPattern.test(tag)
    );
    // If this is 0, the pattern above no longer matches the real markup —
    // a silent pass here would be worse than useless.
    expect(downloadAnchors.length).toBeGreaterThan(0);
    for (const tag of downloadAnchors) {
      expect(tag).toContain('target="_blank"');
      expect(tag).toContain('rel="noreferrer"');
    }
  });

  it("the per-document link specifically opens in a new tab", () => {
    const tag = anchorTags(SOURCE).find((t) => t.includes("/api/documents/"));
    expect(tag).toBeDefined();
    expect(tag).toContain('target="_blank"');
  });

  it("the materials bundle link specifically opens in a new tab", () => {
    const tag = anchorTags(SOURCE).find((t) =>
      t.includes("/api/candidates/${c.id}/materials")
    );
    expect(tag).toBeDefined();
    expect(tag).toContain('target="_blank"');
  });
});
