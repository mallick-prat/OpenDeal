import { redirect } from "next/navigation";
import { currentAppUser } from "@/lib/users";
import { loadAnalytics } from "@/lib/analyticsData";
import { resolvePeriod } from "@/lib/analyticsPure";
import { STAGES } from "@/lib/stages";
import type { StageKey } from "@/lib/types";
import { AnalyticsApp } from "@/components/AnalyticsApp";
import { AppNav } from "@/components/AppNav";

// Aggregations are cheap, but give a cold pool room to answer.
export const maxDuration = 60;
export const dynamic = "force-dynamic";

const STAGE_KEYS = new Set(STAGES.map((s) => s.key as string));

export default async function AnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await currentAppUser();
  if (!user) redirect("/login");

  const sp = await searchParams;
  const one = (k: string) => {
    const v = sp[k];
    return typeof v === "string" && v.trim() ? v.trim() : undefined;
  };

  const today = new Date().toISOString().slice(0, 10);
  const period = resolvePeriod(one("period") ?? "12m", one("from"), one("to"), today);
  const stageParam = one("stage");
  const stage = stageParam && STAGE_KEYS.has(stageParam) ? (stageParam as StageKey) : undefined;
  const owner = one("owner")?.slice(0, 80);
  const school = one("school")?.slice(0, 80);

  const payload = await loadAnalytics({ period, stage, owner, school });

  return (
    <div className="flex min-h-[100dvh]">
      <AppNav user={{ name: user.name, email: user.email, image: user.image }} role={user.role} />
      <div className="min-w-0 flex-1">
        <AnalyticsApp
          payload={payload}
          period={period}
          stage={stage ?? null}
          owner={owner ?? null}
          school={school ?? null}
        />
      </div>
    </div>
  );
}
