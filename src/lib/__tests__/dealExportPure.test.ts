import { describe, expect, it } from "vitest";
import {
  dealMarkdown,
  exportZipName,
  fmtET,
  isoDayET,
  manifestJson,
  meetingMarkdown,
  orderComments,
  pad3,
  readmeMarkdown,
  safeFilename,
  slugify,
  teamNotesMarkdown,
  threadMarkdown,
  type XCounts,
  type XDeal,
} from "../dealExportPure";

const deal: XDeal = {
  gid: "1217287862530926",
  name: "Andrew Paulsen // Brinlyx, Inc.",
  company: "Brinlyx, Inc.",
  founderLine: "Andrew Paulsen",
  stage: "New",
  round: "SAFE",
  financing: "$3M",
  schools: ["Harvard"],
  owner: "alex@example.com",
  source: "inbound",
  metAtEvent: null,
  createdOn: "2026-08-01T12:00:00.000Z",
  notes: "Logistics platform for regional carriers.",
};

const counts: XCounts = {
  meetings: 1,
  pitchEmails: 2,
  emailThreads: 1,
  documents: 3,
  comments: 2,
  decisions: 1,
};

describe("slugify / filenames", () => {
  it("slugs to safe ascii and never returns empty", () => {
    expect(slugify("Brinlyx, Inc.")).toBe("brinlyx-inc");
    expect(slugify("Café Müller // Zürich!")).toBe("cafe-muller-zurich");
    expect(slugify("!!!")).toBe("untitled");
  });

  it("clamps long slugs without a trailing dash", () => {
    const s = slugify("a".repeat(30) + " " + "b".repeat(30), 32);
    expect(s.length).toBeLessThanOrEqual(32);
    expect(s.endsWith("-")).toBe(false);
  });

  it("makes stored filenames zip-safe and keeps the extension", () => {
    expect(safeFilename("../../etc/passwd")).toBe("passwd.pdf");
    expect(safeFilename("Pitch Deck (v3) FINAL.PDF")).toBe("pitch-deck-v3-final.pdf");
    expect(safeFilename("weird")).toBe("weird.pdf");
  });

  it("pads indexes to three digits", () => {
    expect(pad3(7)).toBe("007");
    expect(pad3(123)).toBe("123");
  });
});

describe("dates", () => {
  it("formats in ET and survives garbage", () => {
    expect(fmtET("2026-08-19T16:00:00.000Z")).toBe("Aug 19, 2026");
    expect(isoDayET("2026-08-20T02:00:00.000Z")).toBe("2026-08-19"); // 10 PM ET the day before
    expect(fmtET(null)).toBe("unknown date");
    expect(isoDayET("nonsense")).toBe("undated");
  });
});

describe("markdown composers", () => {
  it("deal.md carries the snapshot, founders, and full notes", () => {
    const md = dealMarkdown(
      deal,
      [
        {
          name: "Andrew Paulsen",
          role: "CEO",
          school: "Harvard",
          degree: "AB",
          gradYear: 2024,
          title: "Founder",
          organization: "Brinlyx",
          linkedin: "https://linkedin.com/in/ap",
          emails: ["andrew@brinlyx.com"],
          context: null,
        },
      ],
      [{ name: "Jane Ref", email: "jane@x.com", hop: 1 }],
      "2026-09-16T12:00:00.000Z",
      "https://app.example.com"
    );
    expect(md).toContain("# Brinlyx, Inc.");
    expect(md).toContain("- Round: SAFE");
    expect(md).toContain("- Raising: $3M");
    expect(md).toContain("### Andrew Paulsen (CEO)");
    expect(md).toContain("Jane Ref <jane@x.com>");
    expect(md).toContain("Logistics platform for regional carriers.");
    expect(md).toContain("https://app.example.com/deals/1217287862530926");
  });

  it("meeting md includes when, who, and both note bodies", () => {
    const md = meetingMarkdown({
      title: "Intro call",
      startsAt: "2026-08-19T16:00:00.000Z",
      participants: [{ name: "Alex", email: "alex@example.com" }],
      summaryMd: "Short summary.",
      notesMd: "Long notes.",
      noteUrl: "https://granola.ai/n/1",
      provider: "granola",
    });
    expect(md).toContain("# Meeting: Intro call");
    expect(md).toContain("Alex <alex@example.com>");
    expect(md).toContain("## Summary");
    expect(md).toContain("## Full notes");
    expect(md).toContain("granola (https://granola.ai/n/1)");
  });

  it("thread md renders messages chronologically with headers", () => {
    const md = threadMarkdown({
      subject: "Following up",
      firstAt: "2026-08-01T10:00:00.000Z",
      lastAt: "2026-08-02T10:00:00.000Z",
      messages: [
        {
          direction: "inbound",
          from: { name: "Andrew", email: "andrew@brinlyx.com" },
          to: [{ name: "Alex", email: "alex@example.com" }],
          cc: [],
          sentAt: "2026-08-01T10:00:00.000Z",
          bodyText: "Deck attached.",
        },
        {
          direction: "outbound",
          from: { name: "Alex", email: "alex@example.com" },
          to: [{ name: "Andrew", email: "andrew@brinlyx.com" }],
          cc: [{ name: "", email: "team@example.com" }],
          sentAt: "2026-08-02T10:00:00.000Z",
          bodyText: "Thanks, reviewing.",
        },
      ],
    });
    expect(md).toContain("# Email thread: Following up");
    expect(md).toContain("2 messages");
    expect(md.indexOf("Deck attached.")).toBeLessThan(md.indexOf("Thanks, reviewing."));
    expect(md).toContain("Cc: team@example.com");
  });

  it("team notes quote replies and lead with decisions", () => {
    const md = teamNotesMarkdown(
      [{ decision: "Pass", rationale: "Too early.", actor: "Alex", at: "2026-09-01T12:00:00.000Z" }],
      [
        { author: "Alex", at: "2026-08-20T12:00:00.000Z", body: "Strong team.", depth: 0 },
        { author: "Sam", at: "2026-08-21T12:00:00.000Z", body: "Agreed.", depth: 1 },
      ]
    );
    expect(md).toContain("### Pass by Alex");
    expect(md).toContain("Too early.");
    expect(md).toContain("Strong team.");
    expect(md).toContain("> Agreed.");
  });
});

describe("orderComments", () => {
  it("keeps roots chronological with replies nested under them", () => {
    const out = orderComments([
      { id: "b", parentId: null, author: "B", at: "2026-01-02T00:00:00Z", body: "second root" },
      { id: "a", parentId: null, author: "A", at: "2026-01-01T00:00:00Z", body: "first root" },
      { id: "r", parentId: "a", author: "R", at: "2026-01-03T00:00:00Z", body: "reply to first" },
    ]);
    expect(out.map((c) => c.body)).toEqual(["first root", "reply to first", "second root"]);
    expect(out[1].depth).toBe(1);
  });

  it("treats orphaned replies as roots instead of dropping them", () => {
    const out = orderComments([
      { id: "r", parentId: "gone", author: "R", at: "2026-01-01T00:00:00Z", body: "orphan" },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].depth).toBe(0);
  });
});

describe("record link", () => {
  it("is omitted entirely when the app URL isn't known, never a broken link", () => {
    const md = dealMarkdown(deal, [], [], "2026-09-16T12:00:00.000Z");
    expect(md).not.toContain("- Record:");
    expect(md).not.toContain("/deals/");
  });
});

describe("manifest and readme", () => {
  it("manifest is valid json with the deal core and file index", () => {
    const parsed = JSON.parse(
      manifestJson({
        deal,
        founders: [],
        files: [{ path: "deal.md", type: "deal_record", title: "Brinlyx, Inc.", date: null }],
        counts,
        generatedAt: "2026-09-16T12:00:00.000Z",
        warnings: ["one gap"],
        recordBase: "https://app.example.com",
      })
    );
    expect(parsed.kind).toBe("opendeal-diligence-bundle");
    expect(parsed.deal.company).toBe("Brinlyx, Inc.");
    expect(parsed.deal.record).toContain(deal.gid);
    expect(parsed.files).toHaveLength(1);
    expect(parsed.warnings).toEqual(["one gap"]);
  });

  it("readme lists only sections that exist and surfaces gaps", () => {
    const md = readmeMarkdown("Brinlyx, Inc.", counts, "2026-09-16T12:00:00.000Z", ["Missing deck."]);
    expect(md).toContain("due-diligence bundle");
    expect(md).toContain("1 meeting note");
    expect(md).toContain("2 inbound pitches and 1 synced thread");
    expect(md).toContain("3 raw files");
    expect(md).toContain("Missing deck.");
  });

  it("zip name is slugged company plus ET date", () => {
    expect(exportZipName("Brinlyx, Inc.", "2026-09-16T12:00:00.000Z")).toBe(
      "dd-brinlyx-inc-2026-09-16.zip"
    );
  });
});
