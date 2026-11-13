import Link from "next/link";
import { redirect } from "next/navigation";
import {
  currentAppUser,
  listAppUsers,
  recentActivity,
} from "@/lib/users";
import {
  ActivityLog,
  MembersAdmin,
  type ActivityView,
  type MemberView,
} from "@/components/AdminSettings";
import { GoogleConnect } from "@/components/GoogleConnect";
import { GranolaCard } from "@/components/GranolaCard";
import { MeetingSyncCard } from "@/components/MeetingSyncCard";
import { InboundMailbox } from "@/components/InboundMailbox";
import { KeysSpend } from "@/components/KeysSpend";
import { MailSyncCard } from "@/components/MailSyncCard";
import { getGoogleConnection, interactionCounts } from "@/lib/googleSync";
import { mailConnectionOverview, mailCounts, scopesAllowSend } from "@/lib/mailSync";
import { getInboundMailbox, inboundAddress } from "@/lib/inboundMailbox";
import { meetingNotesOverview } from "@/lib/meetingNotes";
import { keyStatuses, providerUsage, type ProviderUsage } from "@/lib/usage";
import { perfSummary, type PerfSummaryRow } from "@/lib/perf";
import { AppNav } from "@/components/AppNav";
import { crm } from "@/config/crm.config";

// Give slow-database renders room to finish (or fail gracefully) instead of
// hitting the platform default and returning a bare 504.
export const maxDuration = 60;

export default async function SettingsPage() {
  const member = await currentAppUser();
  if (!member) redirect("/login");

  const isAdmin = member.role === "admin" || member.role === "super_admin";
  const isSuper = member.role === "super_admin";

  // Twelve independent reads — but NOT twelve at once: a saturating burst
  // reads as a poisoned pool to the health detector (it recycles, in-flight
  // queries die CLIENT_DEADLINE, retries pile on — the 504 this comment is
  // named after). Waves of ≤4 stay inside pool capacity; every read still
  // degrades to empty rather than killing the page.
  const { timed } = await import("@/lib/perf");
  const [memberRows, activityRows, googleConn, counts] = await timed("page.settings", async () =>
    Promise.all([
      (isAdmin ? listAppUsers() : Promise.resolve([])).catch(() => []),
      (isSuper ? recentActivity(200) : Promise.resolve([])).catch(() => []),
      getGoogleConnection(member.email).catch(() => null),
      interactionCounts().catch(() => ({ calendar: 0, gmail: 0 })),
    ])
  );
  const [usage, inboundBox] = await Promise.all([
    (isSuper ? providerUsage() : Promise.resolve([] as ProviderUsage[])).catch(
      () => [] as ProviderUsage[]
    ),
    getInboundMailbox().catch(() => null),
  ]);
  const [granola, mailConn, mailStats, perfRows] = await Promise.all([
    meetingNotesOverview().catch(() => null),
    mailConnectionOverview(member.email).catch(() => null),
    mailCounts(member.email).catch(() => null),
    (isAdmin ? perfSummary(24) : Promise.resolve([] as PerfSummaryRow[])).catch(
      () => [] as PerfSummaryRow[]
    ),
  ]);
  const members: MemberView[] = memberRows.map((u) => ({
    email: u.email,
    name: u.name,
    role: u.role,
    image: u.image,
    owner_name: u.owner_name,
    last_login_at: u.last_login_at ? u.last_login_at.toISOString() : null,
  }));
  const activity: ActivityView[] = activityRows.map((r) => ({
    ...r,
    created_at: r.created_at.toISOString(),
  }));

  return (
    <div className="flex min-h-[100dvh]">
    <AppNav user={{ name: member.name, email: member.email, image: member.image }} role={member.role} />
    <main className="mx-auto w-full max-w-3xl px-6 py-16">
      <Link
        href="/"
        className="mb-6 inline-block text-[14px] font-medium text-primary hover:text-primary-pressed"
      >
        ← Back to the dashboard
      </Link>
      <p className="eyebrow">{crm.org.name}</p>
      <h1 className="mt-1 text-[34px] font-light text-ink">Settings</h1>

      <section className="card mt-8 p-6">
        <h2 className="text-[16px] font-semibold text-ink">Your account</h2>
        <dl className="mt-4 grid grid-cols-[120px_1fr] gap-y-2 text-[14px]">
          <dt className="text-sub">Name</dt>
          <dd className="text-ink">{member.name || "—"}</dd>
          <dt className="text-sub">Email</dt>
          <dd className="text-ink">{member.email}</dd>
          <dt className="text-sub">Role</dt>
          <dd className="text-ink">
            {member.role === "super_admin"
              ? "Owner"
              : member.role === "admin"
                ? "Partner"
                : "Contributor"}
          </dd>
        </dl>
      </section>

      <section className="card mt-6 p-6">
        <h2 className="text-[16px] font-semibold text-ink">Google</h2>
        <div className="mt-4">
          <GoogleConnect
            connected={!!googleConn}
            lastSyncedAt={googleConn?.last_synced_at?.toISOString() ?? null}
            calendarCount={counts.calendar}
            gmailCount={counts.gmail}
          />
        </div>
      </section>

      <section className="card mt-6 p-6">
        <h2 className="text-[16px] font-semibold text-ink">Personal inbox</h2>
        <p className="mt-1 text-[13px] text-sub">
          Read-only Gmail sync for pitches sent to you directly — separate from
          the shared deals mailbox below.
        </p>
        <div className="mt-4">
          <MailSyncCard
            connected={!!mailConn}
            address={mailConn?.address ?? member.email}
            status={mailConn?.status ?? "ok"}
            lastSyncedAt={mailConn?.last_synced_at?.toISOString() ?? null}
            messageCount={mailStats?.messages ?? 0}
            threadCount={mailStats?.threads ?? 0}
            canSend={scopesAllowSend(mailConn?.scopes ?? "")}
          />
        </div>
      </section>

      <section className="card mt-6 p-6">
        <h2 className="text-[16px] font-semibold text-ink">
          Inbound deals mailbox
        </h2>
        <p className="mt-1 text-[13px] text-sub">
          Pitches emailed to the shared sourcing inbox are parsed into deal
          drafts in the{" "}
          <Link href="/inbound" className="text-primary hover:underline">
            Inbound queue
          </Link>
          .
        </p>
        <div className="mt-4">
          <InboundMailbox
            connected={!!inboundBox}
            live={!!inboundBox?.history_id}
            address={inboundAddress()}
            isAdmin={isAdmin}
            lastPolledAt={inboundBox?.last_polled_at?.toISOString() ?? null}
            connectedBy={inboundBox?.connected_by ?? null}
            stats={
              (inboundBox?.poll_stats as {
                fetched?: number;
                parsed?: number;
                skipped?: number;
              }) ?? null
            }
          />
        </div>
      </section>

      <section className="card mt-6 p-6">
        <h2 className="text-[16px] font-semibold text-ink">
          Granola meeting notes
        </h2>
        <p className="mt-1 text-[13px] text-sub">
          Meeting notes sync from Granola and are matched to pipeline deals as
          suggestions — a human confirms before anything attaches.
        </p>
        <div className="mt-4 flex flex-col gap-3">
          <MeetingSyncCard isAdmin={isAdmin} />
          <GranolaCard
            configured={granola?.configured ?? false}
            isAdmin={isAdmin}
            lastSyncedAt={granola?.lastSyncedAt ?? null}
            counts={granola?.counts ?? { total: 0, suggested: 0, unmatched: 0, attached: 0 }}
          />
        </div>
      </section>

      {isAdmin && (
        <section className="card mt-6 p-6">
          <h2 className="text-[16px] font-semibold text-ink">Members</h2>
          <div className="mt-4">
            <MembersAdmin
              members={members}
              viewerEmail={member.email}
              viewerRole={member.role}
            />
          </div>
        </section>
      )}

      {isSuper && (
        <section className="card mt-6 p-6">
          <h2 className="text-[16px] font-semibold text-ink">
            API keys &amp; spend
          </h2>
          <p className="mt-1 text-[13px] text-sub">
            Values live in Vercel env and .env.local — only the last four
            characters show here.
          </p>
          <div className="mt-4">
            <KeysSpend keys={keyStatuses()} usage={usage} />
          </div>
        </section>
      )}

      {isAdmin && perfRows.length > 0 && (
        <section className="card mt-6 p-6">
          <h2 className="text-[16px] font-semibold text-ink">Performance</h2>
          <p className="mt-1 text-[13px] text-sub">
            Field timings from the running app, last 24 hours. Times in
            milliseconds; vitals.CLS is the layout-shift score times 1000.
          </p>
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b border-line text-left text-[11px] uppercase tracking-wide text-sub">
                  <th className="py-1.5 pr-3 font-medium">Span</th>
                  <th className="py-1.5 pr-3 text-right font-medium">Count</th>
                  <th className="py-1.5 pr-3 text-right font-medium">p50</th>
                  <th className="py-1.5 pr-3 text-right font-medium">p95</th>
                  <th className="py-1.5 text-right font-medium">Max</th>
                </tr>
              </thead>
              <tbody>
                {perfRows.map((r) => (
                  <tr key={r.name} className="border-b border-line/60">
                    <td className="py-1.5 pr-3 font-mono text-[12px] text-ink">{r.name}</td>
                    <td className="py-1.5 pr-3 text-right tabular-nums text-sub">{r.count}</td>
                    <td className="py-1.5 pr-3 text-right tabular-nums text-ink">{r.p50}</td>
                    <td className="py-1.5 pr-3 text-right tabular-nums text-ink">{r.p95}</td>
                    <td className="py-1.5 text-right tabular-nums text-sub">{r.max}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {isSuper && (
        <section className="card mt-6 p-6">
          <h2 className="text-[16px] font-semibold text-ink">Activity log</h2>
          <div className="mt-4">
            <ActivityLog rows={activity} />
          </div>
        </section>
      )}

    </main>
    </div>
  );
}
