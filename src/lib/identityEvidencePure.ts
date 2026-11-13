import { isInternalEmail } from "./companiesPure";
import { companyFromDealName } from "./founders";

/**
 * Pure half of the identity service (identityEvidence.ts): reason codes,
 * the evidence-email guard, and the deal-name base rule. Unit-tested here;
 * the server half only adds the SQL that feeds these.
 */

export const EVIDENCE_REASONS = [
  "founder_email",
  "founder_name",
  "company_row",
  "name_base_company",
  "name_base_domain",
  "thread",
] as const;
export type EvidenceReason = (typeof EVIDENCE_REASONS)[number];

/** Match strength per reason — one ladder for every consumer. */
export const EVIDENCE_STRENGTH: Record<EvidenceReason, number> = {
  founder_email: 5,
  founder_name: 4,
  company_row: 3,
  name_base_company: 2,
  name_base_domain: 2,
  thread: 1,
};

/** The plain-language sentence a reason renders as, given its detail. */
export function reasonText(reason: EvidenceReason, detail: string): string {
  switch (reason) {
    case "founder_email":
      return `${detail} is a founder on this deal`;
    case "founder_name":
      return `${detail} is a founder on this deal (matched by name)`;
    case "company_row":
      return `Same company record (${detail})`;
    case "name_base_company":
      return `Deal name matches “${detail}”`;
    case "name_base_domain":
      return `Deal name matches the domain ${detail}`;
    case "thread":
      return "Earlier email on this thread is filed under this deal";
  }
}

/**
 * An address that may serve as founder identity: lowered, plausible, and
 * NEVER internal — a partner forwarding a pitch must not become evidence
 * that ties the partner's every meeting and note to that deal.
 */
export function normalizeEvidenceEmail(raw: string | null | undefined): string | null {
  const e = (raw ?? "").trim().toLowerCase();
  if (!e || !e.includes("@") || e.length > 320) return null;
  return isInternalEmail(e) ? null : e;
}

/**
 * The company base of a deal name: the part after the last "//", lowered,
 * non-alphanumerics stripped. deals.name_base (identityEvidence.ensureNameBase)
 * is the SAME rule as a stored generated column — change one and you must
 * change the other; the test suite pins their parity on sample names.
 */
export function nameBaseOf(dealName: string): string {
  return companyFromDealName(dealName).toLowerCase().replace(/[^a-z0-9]/g, "");
}
