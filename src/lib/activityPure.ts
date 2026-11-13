/**
 * ── Activity: pure helpers ───────────────────────────────────────────────────
 * Turn an audit-log (action, detail) pair into a human sentence for the deal's
 * Activity timeline. No I/O, so it's unit-tested; the query lives in actions.ts.
 */
import { STAGE_BY_KEY } from "./stages";
import { decisionMeta } from "./decisionsPure";
import type { StageKey } from "./types";

/** "created this deal", "moved it to Cultivate", "set the decision to Pass"… */
export function describeActivity(
  action: string,
  detail: Record<string, unknown> = {}
): string {
  const to = typeof detail.to === "string" ? detail.to : "";
  const from = typeof detail.from === "string" ? detail.from : "";
  const decision = typeof detail.decision === "string" ? detail.decision : "";
  // Owner detail is an email; show the readable local part.
  const owner = typeof detail.owner === "string" ? detail.owner.split("@")[0] : "";
  switch (action) {
    case "created_deal":
      return "created this deal";
    case "inbound_created_deal":
      return "created this deal from an inbound email";
    case "moved_deal": {
      const toLabel = STAGE_BY_KEY[to as StageKey]?.label;
      const fromLabel = STAGE_BY_KEY[from as StageKey]?.label;
      if (fromLabel && toLabel && fromLabel !== toLabel)
        return `moved it from ${fromLabel} to ${toLabel}`;
      return toLabel ? `moved it to ${toLabel}` : "moved it to a new stage";
    }
    case "added_owner":
      return owner ? `added ${owner} as an owner` : "added an owner";
    case "removed_owner":
      return owner ? `removed ${owner} as an owner` : "removed an owner";
    case "set_decision": {
      const label = decisionMeta(decision)?.label;
      return label ? `set the decision to ${label}` : "set a decision";
    }
    case "commented":
      return "left a comment";
    case "deleted_deal":
      return "deleted this deal";
    default:
      return action.replace(/_/g, " ");
  }
}
