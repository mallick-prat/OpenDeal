import { crm } from "@/config/crm.config";
import Link from "next/link";
import { redirect } from "next/navigation";
import { currentAppUser } from "@/lib/users";
import { recentEvents } from "@/lib/log";
import { SystemLog, type SystemEventView } from "@/components/SystemLog";

export const maxDuration = 60;

/** Unlinked troubleshooting page. Super admins only. */
export default async function SystemLogPage() {
  const member = await currentAppUser();
  if (!member) redirect("/login");
  if (member.role !== "super_admin") redirect("/");

  const events: SystemEventView[] = (await recentEvents(500)).map((r) => ({
    ...r,
    created_at: r.created_at.toISOString(),
  }));

  return (
    <main className="mx-auto w-full max-w-4xl px-6 py-16">
      <Link
        href="/"
        className="mb-6 inline-block text-[14px] font-medium text-primary hover:text-primary-pressed"
      >
        ← Back to the dashboard
      </Link>
      <p className="eyebrow">{crm.org.name}</p>
      <h1 className="mt-1 text-[34px] font-light text-ink">System log</h1>

      <section className="card mt-8 p-6">
        <SystemLog rows={events} />
      </section>
    </main>
  );
}
