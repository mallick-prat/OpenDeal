import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildZip, bundleFilename, crc32, safeZipName } from "../zipPure";

describe("crc32", () => {
  it("matches the published check values", () => {
    // The ZIP/PKZIP CRC-32 of "123456789" is 0xCBF43926 — the standard vector.
    expect(crc32(Buffer.from("123456789"))).toBe(0xcbf43926);
    expect(crc32(Buffer.from(""))).toBe(0);
  });
});

describe("safeZipName", () => {
  it("keeps a path from escaping the archive", () => {
    const taken = new Set<string>();
    expect(safeZipName("../../etc/passwd", taken)).toBe("passwd");
    expect(safeZipName("C:\\decks\\deck.pdf", new Set())).toBe("deck.pdf");
  });

  it("de-duplicates repeated filenames", () => {
    const taken = new Set<string>();
    expect(safeZipName("deck.pdf", taken)).toBe("deck.pdf");
    expect(safeZipName("deck.pdf", taken)).toBe("deck (2).pdf");
    expect(safeZipName("deck.pdf", taken)).toBe("deck (3).pdf");
  });

  it("never returns an empty name", () => {
    expect(safeZipName("...", new Set())).toBe("document");
  });
});

describe("bundleFilename", () => {
  it("slugs the company, falls back when there isn't one", () => {
    expect(bundleFilename("Acme Health")).toBe("acme-health-materials.zip");
    expect(bundleFilename(null)).toBe("materials.zip");
  });
});

describe("buildZip", () => {
  const dir = mkdtempSync(join(tmpdir(), "zip-test-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("produces an archive the system unzip accepts and round-trips", () => {
    // A PDF-ish binary payload with high bytes — the thing a hand-rolled
    // writer is most likely to corrupt.
    const deck = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff, 0xfe, 0x0a]);
    const memo = Buffer.from("thesis notes\n", "utf8");
    const zip = buildZip(
      [
        { name: "deck.pdf", bytes: deck },
        { name: "memo.txt", bytes: memo },
      ],
      new Date(2026, 0, 15, 12, 30, 0)
    );

    const path = join(dir, "bundle.zip");
    writeFileSync(path, zip);

    // `unzip -t` verifies every CRC and the central directory.
    expect(execFileSync("unzip", ["-t", path], { encoding: "utf8" })).toContain(
      "No errors detected"
    );

    execFileSync("unzip", ["-o", "-q", path, "-d", join(dir, "out")]);
    expect(readFileSync(join(dir, "out", "deck.pdf")).equals(deck)).toBe(true);
    expect(readFileSync(join(dir, "out", "memo.txt")).equals(memo)).toBe(true);
  });

  it("stores non-ASCII filenames as UTF-8 and flags them as such", () => {
    // Checked by reading the archive back rather than by shelling out: the
    // Info-ZIP build shipped with macOS predates the UTF-8 flag and mangles
    // these names on extraction even though the bytes it read were correct.
    const zip = buildZip([{ name: "memo—résumé.txt", bytes: Buffer.from("x") }]);
    expect(zip.readUInt16LE(6) & 0x0800).toBe(0x0800); // UTF-8 flag set
    const nameLen = zip.readUInt16LE(26);
    expect(zip.subarray(30, 30 + nameLen).toString("utf8")).toBe(
      "memo—résumé.txt"
    );
    const path = join(dir, "utf8.zip");
    writeFileSync(path, zip);
    expect(execFileSync("unzip", ["-t", path], { encoding: "utf8" })).toContain(
      "No errors detected"
    );
  });

  it("writes a valid empty archive", () => {
    const zip = buildZip([]);
    expect(zip).toHaveLength(22); // end-of-central-directory record only
    expect(zip.readUInt32LE(0)).toBe(0x06054b50);
  });

  it("clamps timestamps to the DOS epoch instead of overflowing", () => {
    const zip = buildZip([{ name: "a.txt", bytes: Buffer.from("a") }], new Date(1970, 0, 1));
    const path = join(dir, "old.zip");
    writeFileSync(path, zip);
    expect(execFileSync("unzip", ["-t", path], { encoding: "utf8" })).toContain(
      "No errors detected"
    );
  });
});
