import type { DecisionKey } from "./decisionsPure";

export type StageKey =
  | "to-meet"
  | "first-meeting"
  | "cultivate"
  | "elevate"
  | "to-pass"
  | "passed"
  | "diligence"
  | "offered";

export interface Deal {
  gid: string;
  name: string;
  note: string;
  stage: StageKey;
  schools: string[];
  owner: string;
  created: string; // YYYY-MM-DD
  modified: string; // YYYY-MM-DD
  url: string;
  financing: string | null;
  round: string | null;
  attachmentCount: number;
  /** Deal is at the Offered stage. */
  offered: boolean;
  /** Email of the member who created the deal in the app, if any. */
  createdBy: string | null;
  /** Members who own this deal (app-managed, multi-owner). */
  owners: DealOwner[];
  /** 'team' (default, public-leaning) or 'private' — private deals show only to their creator until elevated. Share links still work either way. */
  visibility: string;
  /** The team's current verdict (watch/diligence/invest/pass/lost), separate
   *  from the pipeline stage. Undefined until decisions load. */
  decision?: DecisionKey | null;
  /** ISO start of the next upcoming matched calendar meeting, if any. */
  nextMeetingAt?: string | null;
}

export interface DealOwner {
  email: string;
  name: string;
  image: string | null;
}

export interface SectionInfo {
  gid: string;
  name: string;
  stage: StageKey;
}

export interface PipelineData {
  deals: Deal[];
  fetchedAt: string;
  projectName: string;
  /** Board sections, in board order — used by the edit form's stage picker. */
  sections: SectionInfo[];
}

/** Full deal fields for the edit form, read from the database (the source
    of truth). */
export interface DealDraft {
  gid: string;
  name: string;
  notes: string;
  sectionGid: string;
  schools: string[];
  financing: string | null;
  round: string | null;
  /** Hash of the editable fields at load — sent back with the save so a
   * real concurrent edit surfaces as a conflict, not a silent overwrite.
   * Bookkeeping writes (sync stamps) don't change it. */
  baselineHash?: string | null;
  /** Latest provenance claim per field ("financing", "round", "notes"). */
  sources?: Record<
    string,
    { source: "email" | "granola" | "merge" | "manual" | "calendar"; actor: string | null; at: string }
  >;
}
