import { describe, it, expect } from "vitest";
import { describeActivity } from "../activityPure";
import { STAGE_BY_KEY } from "../stages";

// Labels come from src/config/crm.config.ts, so renaming a stage there must
// not break this suite: assert against the config, not hardcoded strings.
const label = (k: keyof typeof STAGE_BY_KEY) => STAGE_BY_KEY[k].label;

describe("describeActivity", () => {
  it("describes deal lifecycle actions", () => {
    expect(describeActivity("created_deal")).toBe("created this deal");
    expect(describeActivity("inbound_created_deal")).toBe("created this deal from an inbound email");
    expect(describeActivity("deleted_deal")).toBe("deleted this deal");
  });

  it("maps a stage move to the stage's label", () => {
    expect(describeActivity("moved_deal", { to: "cultivate" })).toBe(`moved it to ${label("cultivate")}`);
    expect(describeActivity("moved_deal", { to: "elevate" })).toBe(`moved it to ${label("elevate")}`);
    expect(describeActivity("moved_deal", {})).toBe("moved it to a new stage");
    // An unknown stage key falls back rather than echoing a raw key.
    expect(describeActivity("moved_deal", { to: "bogus" })).toBe("moved it to a new stage");
  });

  it("shows from→to when both stages are known and differ", () => {
    expect(describeActivity("moved_deal", { from: "first-meeting", to: "passed" })).toBe(
      `moved it from ${label("first-meeting")} to ${label("passed")}`
    );
    // Same from/to collapses to the simple form.
    expect(describeActivity("moved_deal", { from: "cultivate", to: "cultivate" })).toBe(
      `moved it to ${label("cultivate")}`
    );
  });

  it("names the owner (email local part) on owner changes", () => {
    expect(describeActivity("added_owner", { owner: "alex@example.com" })).toBe(
      "added alex as an owner"
    );
    expect(describeActivity("removed_owner", { owner: "sam@example.com" })).toBe(
      "removed sam as an owner"
    );
    expect(describeActivity("added_owner", {})).toBe("added an owner");
  });

  it("describes a comment", () => {
    expect(describeActivity("commented")).toBe("left a comment");
  });

  it("maps a decision to its label", () => {
    expect(describeActivity("set_decision", { decision: "pass" })).toBe("set the decision to Pass");
    expect(describeActivity("set_decision", { decision: "invest" })).toBe("set the decision to Invest");
    expect(describeActivity("set_decision", {})).toBe("set a decision");
  });

  it("handles owners and falls back for unknown actions", () => {
    expect(describeActivity("added_owner")).toBe("added an owner");
    expect(describeActivity("removed_owner")).toBe("removed an owner");
    expect(describeActivity("some_new_thing")).toBe("some new thing");
  });
});
