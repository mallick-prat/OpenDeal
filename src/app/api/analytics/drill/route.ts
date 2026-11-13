import { NextResponse } from "next/server";
import { currentAppUser } from "@/lib/users";
import { drillDeals, type DrillParams } from "@/lib/analyticsData";
import { STAGES } from "@/lib/stages";
import { logError } from "@/lib/log";
import type { StageKey } from "@/lib/types";

export const maxDuration = 30;

const STAGE_KEYS = new Set(STAGES.map((s) => s.key as string));
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The deals behind any number on /analytics. Every filter is a typed WHERE
 * clause over existing columns — the drawer never invents membership.
 */
export async function GET(req: Request) {
  const member = await currentAppUser();
  if (!member) return NextResponse.json({ ok: false }, { status: 401 });
  const q = new URL(req.url).searchParams;
  const s = (k: string) => {
    const v = q.get(k)?.trim();
    return v ? v.slice(0, 120) : undefined;
  };
  const day = (k: string) => {
    const v = s(k);
    return v && DATE.test(v) ? v : undefined;
  };
  const num = (k: string) => {
    const v = Number(q.get(k));
    return Number.isFinite(v) && v >= 0 && v <= 100000 ? Math.floor(v) : undefined;
  };
  const p: DrillParams = {
    stages: s("stages")
      ?.split(",")
      .filter((x): x is StageKey => STAGE_KEYS.has(x))
      .slice(0, 8),
    owner: s("owner"),
    school: s("school"),
    noSchool: q.get("noSchool") === "1",
    unowned: q.get("unowned") === "1",
    activeOnly: q.get("active") === "1",
    ageMin: num("ageMin"),
    ageMax: num("ageMax"),
    createdFrom: day("createdFrom"),
    createdTo: day("createdTo"),
    meetingFrom: day("meetingFrom"),
    meetingTo: day("meetingTo"),
    modifiedBefore: day("modifiedBefore"),
  };
  try {
    const deals = await drillDeals(p);
    return NextResponse.json({ ok: true, deals });
  } catch (err) {
    logError("analytics", "drill query failed", err);
    return NextResponse.json({ ok: false }, { status: 500 });
  }
}
