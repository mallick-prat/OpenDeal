import { describe, it, expect } from "vitest";
import {
  nestComments,
  canDeleteComment,
  commentNotifyList,
  notificationTargets,
  normalizeCommentBody,
  type FlatComment,
} from "../commentsPure";

const c = (over: Partial<FlatComment>): FlatComment => ({
  id: "x",
  deal_gid: "d1",
  parent_id: null,
  author_email: "a@x.com",
  author_name: "A",
  author_image: null,
  body: "hi",
  mentioned_emails: [],
  created_at: "2026-07-17T00:00:00.000Z",
  ...over,
});

describe("nestComments", () => {
  it("nests replies under parents, both oldest-first", () => {
    const flat = [
      c({ id: "r1", parent_id: "p1", created_at: "2026-07-17T00:03:00Z" }),
      c({ id: "p2", created_at: "2026-07-17T00:05:00Z" }),
      c({ id: "p1", created_at: "2026-07-17T00:01:00Z" }),
      c({ id: "r2", parent_id: "p1", created_at: "2026-07-17T00:02:00Z" }),
    ];
    const tree = nestComments(flat);
    expect(tree.map((t) => t.id)).toEqual(["p1", "p2"]);
    expect(tree[0].replies.map((r) => r.id)).toEqual(["r2", "r1"]);
    expect(tree[1].replies).toEqual([]);
  });

  it("promotes an orphaned reply (missing parent) to top level", () => {
    const tree = nestComments([c({ id: "r1", parent_id: "gone" })]);
    expect(tree.map((t) => t.id)).toEqual(["r1"]);
    expect(tree[0].replies).toEqual([]);
  });

  it("returns [] for no comments", () => {
    expect(nestComments([])).toEqual([]);
  });
});

describe("canDeleteComment", () => {
  it("lets an author delete their own", () => {
    expect(canDeleteComment("me@x.com", { email: "me@x.com", role: "user" })).toBe(true);
    expect(canDeleteComment("ME@X.COM", { email: "me@x.com", role: "user" })).toBe(true);
  });
  it("blocks a non-author 'user'", () => {
    expect(canDeleteComment("other@x.com", { email: "me@x.com", role: "user" })).toBe(false);
  });
  it("lets admins and super admins delete anyone's", () => {
    expect(canDeleteComment("other@x.com", { email: "me@x.com", role: "admin" })).toBe(true);
    expect(canDeleteComment("other@x.com", { email: "me@x.com", role: "super_admin" })).toBe(true);
  });
});

describe("commentNotifyList", () => {
  it("notifies owners minus the actor, deduped + lowercased", () => {
    expect(
      commentNotifyList({
        ownerEmails: ["Owner@x.com", "owner@x.com", "two@x.com"],
        actorEmail: "owner@x.com",
      }).sort()
    ).toEqual(["two@x.com"]);
  });
  it("adds the parent author for a reply, never the actor", () => {
    expect(
      commentNotifyList({
        ownerEmails: ["owner@x.com"],
        parentAuthorEmail: "Parent@x.com",
        actorEmail: "me@x.com",
      }).sort()
    ).toEqual(["owner@x.com", "parent@x.com"]);
    expect(
      commentNotifyList({
        ownerEmails: [],
        parentAuthorEmail: "me@x.com",
        actorEmail: "me@x.com",
      })
    ).toEqual([]);
  });
  it("returns [] when the only owner is the actor", () => {
    expect(commentNotifyList({ ownerEmails: ["me@x.com"], actorEmail: "me@x.com" })).toEqual([]);
  });
});

describe("notificationTargets", () => {
  it("gives one row per person, strongest reason winning", () => {
    const rows = notificationTargets({
      ownerEmails: ["owner@x.com", "both@x.com"],
      parentAuthorEmail: "reply@x.com",
      mentionEmails: ["mention@x.com", "both@x.com"],
      actorEmail: "me@x.com",
    });
    const byEmail = Object.fromEntries(rows.map((r) => [r.email, r.type]));
    // both@x.com is an owner AND mentioned → mention (rank 3) wins.
    expect(byEmail).toEqual({
      "mention@x.com": "mention",
      "both@x.com": "mention",
      "reply@x.com": "reply",
      "owner@x.com": "comment",
    });
  });

  it("mention outranks reply outranks owner for the same person", () => {
    expect(
      notificationTargets({
        ownerEmails: ["p@x.com"],
        parentAuthorEmail: "p@x.com",
        mentionEmails: ["p@x.com"],
        actorEmail: "me@x.com",
      })
    ).toEqual([{ email: "p@x.com", type: "mention" }]);
    expect(
      notificationTargets({
        ownerEmails: ["p@x.com"],
        parentAuthorEmail: "p@x.com",
        actorEmail: "me@x.com",
      })
    ).toEqual([{ email: "p@x.com", type: "reply" }]);
  });

  it("never notifies the actor, and lowercases + dedupes", () => {
    expect(
      notificationTargets({
        ownerEmails: ["Me@x.com"],
        mentionEmails: ["ME@X.COM"],
        actorEmail: "me@x.com",
      })
    ).toEqual([]);
  });

  it("returns [] when nobody but the actor is involved", () => {
    expect(
      notificationTargets({ ownerEmails: [], actorEmail: "me@x.com" })
    ).toEqual([]);
  });
});

describe("normalizeCommentBody", () => {
  it("trims and clamps, rejecting empty", () => {
    expect(normalizeCommentBody("  hey  ")).toBe("hey");
    expect(normalizeCommentBody("   ")).toBeNull();
    expect(normalizeCommentBody("")).toBeNull();
    expect(normalizeCommentBody("a".repeat(6000))!.length).toBe(5000);
  });
  it("normalizes CRLF", () => {
    expect(normalizeCommentBody("a\r\nb")).toBe("a\nb");
  });
});
