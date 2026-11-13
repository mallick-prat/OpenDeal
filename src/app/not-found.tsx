import { crm } from "@/config/crm.config";
import Link from "next/link";

/**
 * The app had no not-found boundary, so any 404 rendered Next's bare default:
 * a stark "This page could not be found" with no branding and no way back.
 *
 * Genuine 404s should now be rare — a missing triage candidate redirects to
 * the queue rather than dead-ending here — so this is the last resort for a
 * mistyped or stale URL, and its job is simply to offer a way onward.
 */
export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-[100dvh] w-full max-w-lg flex-col items-center justify-center gap-4 px-6 text-center">
      <p className="eyebrow">{crm.org.name}</p>
      <h1 className="text-[24px] font-light text-ink">
        There&rsquo;s nothing at this address.
      </h1>
      <p className="text-[14px] text-sub">
        The link may be stale, or the deal or candidate it pointed at has since
        been removed.
      </p>
      <div className="mt-2 flex items-center gap-4">
        <Link
          href="/"
          className="text-[13px] font-medium text-primary transition-colors hover:text-primary-pressed"
        >
          Back to the dashboard
        </Link>
        <Link
          href="/inbox"
          className="text-[13px] font-medium text-primary transition-colors hover:text-primary-pressed"
        >
          Go to the inbox
        </Link>
      </div>
    </main>
  );
}
