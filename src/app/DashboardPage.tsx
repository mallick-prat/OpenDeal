import { redirect } from "next/navigation";
import { Dashboard } from "@/components/Dashboard";
import { AutoRetry } from "@/components/AutoRetry";
import type { View } from "@/components/Sidebar";
import type { SessionUser } from "@/components/Sidebar";
import { fetchPipeline } from "@/lib/pipeline";
import { currentAppUser, listAppUsers } from "@/lib/users";
import { logError } from "@/lib/log";
import { timed } from "@/lib/perf";
import type { PipelineData } from "@/lib/types";

/** Shared server render for /, /analytics, and /deals — same data, different tab. */
export async function DashboardPage({
  initialView,
  initialDealGid,
}: {
  initialView: View;
  /** When set (the /deals/[gid] route), open this deal as an overlay on load. */
  initialDealGid?: string;
}) {
  // Membership is re-checked on every render: a removed member with a live
  // session cookie gets bounced to the login screen, not a data leak. A DB
  // blip is NOT a removal — it renders the retry screen below instead.
  let member = null;
  let memberCheckFailed = false;
  try {
    member = await currentAppUser();
  } catch (err) {
    // Next signals dynamic rendering / redirects by throwing — those must
    // pass through untouched or the error screen gets baked in at build.
    const digest = (err as { digest?: string })?.digest;
    if (typeof digest === "string") throw err;
    logError("auth", "dashboard membership check failed", err);
    memberCheckFailed = true;
  }
  if (!member && !memberCheckFailed) redirect("/login");
  if (!member) {
    return <AutoRetry title="Waking the database…" />;
  }

  const user: SessionUser = {
    name: member.name || member.email,
    email: member.email,
    image: member.image,
  };

  const isContributor = member.role === "user";
  let data: PipelineData | null = null;
  let message = "";
  let members: { email: string; name: string; image: string | null }[] = [];
  // Pipeline and members are independent reads, so one roundtrip of latency,
  // not two. The whole fetch races a hard deadline so a stalled database
  // renders the friendly retry screen below instead of a platform 504.
  const fetchP = timed(
    "page.dashboard",
    () =>
      Promise.all([
        fetchPipeline(),
        listAppUsers(),
      ]),
    { view: initialView }
  );
  // If the deadline wins, the abandoned fetch must not surface later as an
  // unhandled rejection (it already cancelled/retried internally).
  fetchP.catch(() => {});
  const deadline: { timer?: ReturnType<typeof setTimeout> } = {};
  try {
    const [pipelineData, memberRows] = await Promise.race([
      fetchP,
      new Promise<never>((_, reject) => {
        deadline.timer = setTimeout(
          () => reject(new Error("Timed out loading the pipeline (30s).")),
          30_000
        );
        deadline.timer.unref?.();
      }),
    ]);
    data = pipelineData;
    // Private deals are visible ONLY to their creator until they're
    // elevated to the team, for every role.
    data = {
      ...data,
      deals: data.deals.filter(
        (d) => d.visibility !== "private" || d.createdBy === member.email
      ),
    };
    members = memberRows.map((u) => ({
      email: u.email,
      name: u.name,
      image: u.image,
    }));


    // The 'user' role (Contributor) sees only their own board:
    // deals they own by name, plus anything they created in the app.
    if (isContributor) {
      const ownerName = member.owner_name || member.name;
      data = {
        ...data,
        deals: data.deals.filter(
          (d) =>
            d.createdBy === member.email ||
            d.owners.some((o) => o.email === member.email) ||
            (d.owner !== "Unassigned" && d.owner === ownerName)
        ),
      };
    }

  } catch (err) {
    message = err instanceof Error ? err.message : String(err);
    logError("pipeline", "dashboard render failed", err, {
      member: member.email,
      view: initialView,
    });
  } finally {
    clearTimeout(deadline.timer);
  }

  if (!data) {
    // Self-healing: retries quietly on a backoff and swaps in the real page
    // the moment the database answers — nobody reloads by hand.
    return (
      <AutoRetry
        title="Waking the pipeline…"
        detail={`The database didn't answer in time (${message || "timeout"}). Retrying automatically.`}
      />
    );
  }

  return (
    <Dashboard
      data={data}
      initialView={initialView}
      initialDealGid={initialDealGid}
      user={user}
      role={member.role}
      members={members}
    />
  );
}
