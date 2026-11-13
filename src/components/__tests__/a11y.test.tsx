// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import axe from "axe-core";
import { STAGE_BY_KEY } from "@/lib/stages";

// OwnerPicker (avatar source for OwnerFilter) imports server actions; in the
// real app Next swaps them for fetch stubs, here we do it ourselves.
vi.mock("@/app/actions", () => {
  const ok = async () => ({ ok: true });
  return {
    addDealOwner: ok,
    removeDealOwner: ok,
    draftPassEmailAction: async () => ({ ok: true, subject: "s", body: "b" }),
    sendPassEmailAction: ok,
    addPeopleToGroupAction: ok,
    addPersonEducationAction: ok,
    getPersonNotesAction: async () => ({ ok: true, notes: [] }),
    removePersonFromGroupAction: ok,
    researchPersonAction: ok,
    savePersonContactAction: ok,
    savePersonLocationAction: ok,
    setPersonStarAction: ok,
    setPersonFirmPriorityAction: ok,
    clearPersonFirmPriorityAction: ok,
    setPersonFlagAction: ok,
    clearPersonFlagAction: ok,
    applyGranolaUpdatesAction: ok,
    dismissGranolaUpdatesAction: ok,
    undoGranolaApplyAction: ok,
    attachNoteToDealAction: ok,
    createDeal: ok,
    attachNoteToPersonAction: ok,
    ignoreGranolaNoteAction: ok,
    suggestDealsForNoteAction: async () => ({ ok: true, suggestions: [] }),
    noteReviewBootstrapAction: async () => ({
      ok: true,
      extraction: {
        version: "review-v1",
        company: {
          name: "Acme Robotics",
          domain: "acme.com",
          description: null,
          location: null,
          evidence: "Acme Robotics builds arms",
        },
        financing: {
          amount: "$3M–$5M",
          security: "SAFE",
          round: null,
          valuation: null,
          status: "planned",
          targetClose: "mid-October",
          investors: [],
          evidence: "raising $3M–$5M in SAFEs",
        },
        people: [
          {
            key: "jane@acme.com",
            name: "Jane Doe",
            email: "jane@acme.com",
            title: "CEO",
            company: "Acme Robotics",
            school: null,
            gradYear: null,
            city: null,
            linkedin: null,
            role: "founder",
            evidence: null,
            fromCalendar: true,
          },
        ],
      },
      matches: {
        company: {
          state: "new",
          companyId: null,
          companyName: "Acme Robotics",
          evidence: null,
          deals: [],
        },
        people: [
          {
            key: "jane@acme.com",
            state: "new",
            personId: null,
            label: null,
            tracked: false,
            candidates: [],
          },
        ],
      },
      enrich: {},
      extracted: true,
    }),
    extractNoteReviewAction: async () => ({ ok: true }),
    enrichNoteCompanyAction: async () => ({ ok: true, slot: { status: "done", at: "", fields: {} } }),
    enrichNotePersonAction: async () => ({ ok: true, slot: { status: "done", at: "", fields: {} } }),
    commitNoteReviewAction: async () => ({ ok: true, results: [], dealGid: null }),
    scheduleRosterAction: async () => ({ ok: true, roster: [] }),
    scheduleSuggestAction: async () => ({ ok: true, slots: [] }),
    setPersonTagsAction: ok,
    toggleTrackPerson: ok,
    trackExistingPersonAction: ok,
  };
});
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
  usePathname: () => "/",
}));

import { CandidateQueue, type CandidateCard } from "../CandidateQueue";
import { OwnerFilter } from "../OwnerFilter";
import { LiveDeals } from "../RecentDeals";
import { PassComposer } from "../PassComposer";
import type { Deal } from "@/lib/types";

/**
 * X-01: structural accessibility on the redesigned list surfaces. Static
 * server markup rendered into jsdom, audited by axe-core. Color-contrast is
 * excluded — no stylesheets load here, so computed colors would be
 * defaults, not the app's; contrast stays a browser-level check.
 */

async function audit(html: string, opts: { pageLevel?: boolean } = {}): Promise<axe.Result[]> {
  // Page-level components bring their own <main>; fragments get one here.
  document.body.innerHTML = opts.pageLevel ? html : `<main>${html}</main>`;
  const res = await axe.run(document.body, {
    rules: { "color-contrast": { enabled: false } },
  });
  return res.violations;
}

const card = (over: Partial<CandidateCard> = {}): CandidateCard => ({
  id: "11111111-1111-4111-8111-111111111111",
  status: "ready",
  assignedTo: null,
  classification: "pitch",
  confidence: 0.9,
  receivedAt: new Date("2026-07-30T12:00:00Z").toISOString(),
  snoozedUntil: null,
  companyName: "Acme Robotics",
  oneLiner: "Robots for warehouses.",
  fromName: "Jane Doe",
  fromEmail: "jane@acme.com",
  subject: "Acme — seed round",
  round: "Seed",
  raiseAmount: "$2M",
  deckCount: 1,
  attachmentCount: 1,
  missing: [],
  promotedDealGid: null,
  founders: "Jane Doe, Bo Chen",
  ...over,
});

describe("axe: inbox rail (CandidateQueue)", () => {
  it("renders list mode without violations", async () => {
    const html = renderToStaticMarkup(
      <CandidateQueue
        items={[
          card(),
          card({ id: "22222222-2222-4222-8222-222222222222", status: "passed", confidence: 0.3 }),
          card({ id: "33333333-3333-4333-8333-333333333333", status: "approved" }),
          card({
            id: "44444444-4444-4444-8444-444444444444",
            source: "granola",
            href: "/inbox/note/44444444-4444-4444-8444-444444444444",
            subject: "Acme Fund <> Piassa",
            companyName: "Piassa",
            oneLiner: "2 proposed updates from the meeting — review and apply",
          }),
        ]}
        viewerEmail="alex@example.com"
      />
    );
    expect(html).toContain("Granola");
    expect(html).toContain("/inbox/note/44444444-4444-4444-8444-444444444444");
    const violations = await audit(html);
    expect(violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  });
});

const liveDeal = (over: Partial<Deal> = {}): Deal => ({
  gid: "1234567890",
  name: "Jane Doe // Acme Robotics",
  note: "Raising a seed round.",
  stage: "elevate",
  schools: ["Harvard"],
  owner: "Alex Morgan",
  created: "2026-07-01",
  modified: "2026-07-30",
  url: "",
  financing: "$2M",
  round: "Seed",
  attachmentCount: 0,
  offered: false,
  createdBy: null,
  owners: [],
  visibility: "team",
  ...over,
});

describe("axe: Live deals stage control", () => {
  it("renders the color-coded pill with a short label and a working select, no violations", async () => {
    const html = renderToStaticMarkup(
      <LiveDeals
        deals={[
          liveDeal(),
          liveDeal({ gid: "1234567891", name: "Bo Chen // Piassa", stage: "diligence" }),
        ]}
        onEdit={() => {}}
        onOpenCrm={() => {}}
        onMove={() => {}}
        stageKeys={["to-meet", "first-meeting", "cultivate", "elevate", "to-pass", "diligence", "offered"]}
      />
    );
    // Short labels only: the long label is what overflowed the box. (Read
    // from the config, so renaming a stage there doesn't break this test.)
    const elevate = STAGE_BY_KEY.elevate;
    expect(html).toContain(`>${elevate.short}<`);
    expect(html).not.toContain(`${elevate.label}</option>`);
    // The swatch carries the stage color; the overlay select does the picking.
    expect(html).toContain(`background:${elevate.color}`);
    expect(html).toContain("aria-label=\"Stage for Jane Doe // Acme Robotics\"");
    const violations = await audit(html);
    expect(violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  });
});

describe("axe: pass composer (collapsed trigger)", () => {
  it("renders the Pass entry with labeled fields available and no violations", async () => {
    const html = renderToStaticMarkup(
      <PassComposer
        gid="1234567890"
        companyName="Acme Robotics"
        founders={[{ name: "Jane Doe", email: "jane@acme.dev" }]}
        viewerName="Alex Morgan"
      />
    );
    expect(html).toContain(">Pass<");
    expect(html).not.toContain("—");
    const violations = await audit(html);
    expect(violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  });
});

describe("axe: owner filter trigger", () => {
  it("renders closed state without violations", async () => {
    const html = renderToStaticMarkup(
      <OwnerFilter
        owners={["Alex Morgan", "Jordan Lee", "Unassigned"]}
        counts={new Map([["Alex Morgan", 12], ["Jordan Lee", 9], ["Unassigned", 3]])}
        members={[
          { email: "alex@example.com", name: "Alex Morgan", image: null },
          { email: "ajordan@example.com", name: "Jordan Lee", image: null },
        ]}
        selected={new Set()}
        onChange={() => {}}
      />
    );
    const violations = await audit(html);
    expect(violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  });
});

describe("axe: Granola note triage (Inbox)", () => {
  it("review workspace: status line, enrich, save, ignore — no violations", async () => {
    const { NoteTriage } = await import("../NoteTriage");
    const html = renderToStaticMarkup(
      <NoteTriage
        note={{
          id: "33333333-3333-4333-8333-333333333333",
          title: "Acme Fund <> Acme Robotics",
          startsAt: "2026-08-11T15:00:00Z",
          participants: [
            { name: "Jane Doe", email: "jane@acme.dev" },
            { name: "Alex Morgan", email: "alex@example.com" },
          ],
          dealGid: "1234567890",
          dealName: "Jane Doe // Acme Robotics",
          matchState: "unmatched",
          reviewState: "none",
          confidence: 0.62,
          evidence: { kind: "attendee_email", value: "jane@acme.dev" },
          updates: [],
          summary: "Discussed the seed round and the pilot with a large 3PL.",
          notes: "Longer raw notes here.",
          noteUrl: "https://notes.granola.ai/d/example",
        }}
        sections={[{ gid: "100", name: "To Meet", stage: "to-meet" }]}
        schoolNames={["Harvard", "MIT"]}
      />
    );
    expect(html).toContain("Acme Fund &lt;&gt; Acme Robotics");
    expect(html).toContain("Loading…");
    expect(html).toContain("Enrich");
    expect(html).toContain("Save 1 update");
    expect(html).toContain("Ignore");
    expect(html).toContain("del");
    expect(html).toContain("Original notes");
    expect(html).toContain("aria-live=\"polite\"");
    const violations = await audit(html);
    expect(violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  });
});

describe("axe: Analytics", () => {
  it("KPIs, distribution, flow, university, team, attention render clean", async () => {
    const { AnalyticsApp } = await import("../AnalyticsApp");
    const { resolvePeriod, AGE_BUCKETS } = await import("@/lib/analyticsPure");
    const { STAGES } = await import("@/lib/stages");
    const period = resolvePeriod("90d", undefined, undefined, "2026-08-09");
    const counts: Record<string, number> = {
      "to-meet": 5, "first-meeting": 6, cultivate: 9, elevate: 3,
      "to-pass": 3, passed: 2022, diligence: 3, offered: 22,
    };
    const pt = (b: string, label: string, count: number) => ({ b, label, count });
    const html = renderToStaticMarkup(
      <AnalyticsApp
        period={period}
        stage={null}
        owner={null}
        school={null}
        payload={{
          generatedAt: "2026-08-09T12:00:00Z",
          kpis: { newDeals: 143, newDealsPrev: 120, meetings: 57, meetingsPrev: 44, active: 48, diligence: 3, offered: 22 },
          distribution: STAGES.map((s) => ({ stage: s.key, count: counts[s.key] ?? 0 })),
          ageBuckets: AGE_BUCKETS.map((b, i) => ({ key: b.key, label: b.label, count: [4, 11, 9, 24][i] })),
          medianAgeDays: 34,
          oldestAgeDays: 210,
          flow: {
            deals: [pt("2026-07-27", "Wk of Jul 27", 12), pt("2026-08-03", "Wk of Aug 3", 34)],
            dealsPrev: [pt("2026-04-27", "Wk of Apr 27", 9), pt("2026-05-04", "Wk of May 4", 15)],
            meetings: [pt("2026-07-27", "Wk of Jul 27", 3), pt("2026-08-03", "Wk of Aug 3", 4)],
            meetingsPrev: [pt("2026-04-27", "Wk of Apr 27", 2), pt("2026-05-04", "Wk of May 4", 1)],
          },
          university: [
            {
              school: "Harvard",
              byGroup: { early: 2, cultivate: 1, elevate: 1, diligence: 1, offered: 1, passed: 320 },
              active: 6, total: 326, signal: 2,
            },
          ],
          team: [
            { owner: "Alex Morgan", active: 10, diligence: 1, offered: 2, meetings: 5, total: 251 },
            { owner: "Unassigned", active: 8, diligence: 0, offered: 0, meetings: 0, total: 128 },
          ],
          attention: [
            { key: "unowned", count: 8, title: "Active deals with no owner", rule: "Stage is active and owner is empty" },
          ],
          completeness: {
            activeTotal: 48, activeWithSchool: 40, activeWithOwner: 44,
            allTotal: 2073, allWithSchool: 1467, allWithOwner: 1945, withSource: 34,
          },
          options: { owners: ["Alex Morgan"], schools: ["Harvard"] },
        }}
      />
    );
    expect(html).toContain("Analytics");
    expect(html).toContain("Current pipeline distribution");
    expect(html).toContain("Pipeline by tag");
    expect(html).toContain("Needs attention");
    // Honest labeling: a distribution by name, never a conversion funnel.
    expect(html).toContain("Current pipeline distribution");
    expect(html).not.toContain("Conversion funnel");
    const violations = await audit(html, { pageLevel: true });
    expect(violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  });
});
