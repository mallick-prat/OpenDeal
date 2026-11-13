import { crm } from "@/config/crm.config";
import { getPublicDeal } from "@/lib/publicDeal";
import { schoolColor } from "@/lib/stages";

/**
 * The read-only page a logged-out visitor sees at /deals/[gid]. Shows every
 * ENTERED field of the deal — company, founders, schools, financing, round, the
 * full description, date — but nothing internal (comments, decisions, owners,
 * activity) and nothing interactive. Public-leaning: the share link works for
 * any deal that exists.
 */
export async function PublicDealView({ gid }: { gid: string }) {
  const deal = await getPublicDeal(gid).catch(() => null);

  if (!deal) {
    return (
      <main className="flex min-h-[100dvh] flex-col items-center justify-center bg-bg-soft px-4 py-10">
        <div className="w-full max-w-md rounded-2xl border border-line bg-bg p-8 text-center">
          <div className="text-[15px] font-bold tracking-tight text-primary">{crm.org.name}</div>
          <h1 className="mt-3 text-[20px] font-normal text-ink">This deal isn&apos;t available</h1>
          <p className="mt-2 text-[13px] text-sub">The link may be wrong, or the deal was removed.</p>
          <a
            href="/login"
            className="mt-6 inline-block rounded-lg bg-primary px-5 py-2.5 text-[14px] font-semibold text-white hover:bg-primary-pressed"
          >
            Sign in to open the pipeline
          </a>
        </div>
      </main>
    );
  }

  const financing = [deal.financing, deal.round].filter(Boolean).join(" · ");

  return (
    <main className="min-h-[100dvh] bg-bg-soft px-4 py-8">
      <div className="mx-auto flex w-full max-w-xl flex-col gap-4">
        {/* Hero identity card */}
        <div
          className="relative aspect-[1.9/1] w-full overflow-hidden rounded-2xl text-white shadow-lg"
          style={{ background: `linear-gradient(135deg, ${deal.schoolColor} 0%, #12100e 92%)` }}
        >
          <div
            className="pointer-events-none absolute -left-12 -top-12 h-48 w-48 rounded-full"
            style={{ background: "radial-gradient(closest-side, rgba(255,255,255,0.28), transparent)" }}
          />
          <div className="relative flex h-full flex-col justify-between p-6">
            <div className="flex items-start justify-between">
              {deal.school ? (
                <span className="rounded-full bg-white/15 px-3 py-1 text-[12px] font-semibold backdrop-blur-sm">
                  {deal.school}
                </span>
              ) : (
                <span />
              )}
              <span className="text-[15px] font-bold tracking-tight text-white/90">Xf</span>
            </div>
            <div>
              {deal.founder && (
                <div className="mb-1 truncate text-[13px] font-medium text-white/70">{deal.founder}</div>
              )}
              <div className="text-[30px] font-light leading-tight">{deal.company}</div>
              <div className="mt-3 flex items-center gap-2 text-[13px] text-white/80">
                {financing && <span className="font-semibold text-white">{financing}</span>}
                {financing && <span className="text-white/40">·</span>}
                <span>{deal.created}</span>
              </div>
            </div>
          </div>
        </div>

        {/* About — the full entered description */}
        {deal.description && (
          <section className="rounded-2xl border border-line bg-bg p-5">
            <h2 className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-faint">About</h2>
            <p className="whitespace-pre-wrap text-[14px] leading-relaxed text-body">{deal.description}</p>
          </section>
        )}

        {/* Founders */}
        {deal.founders.length > 0 && (
          <section className="rounded-2xl border border-line bg-bg p-5">
            <h2 className="mb-3 text-[12px] font-semibold uppercase tracking-wide text-faint">
              Founder{deal.founders.length > 1 ? "s" : ""}
            </h2>
            <ul className="flex flex-col gap-2.5">
              {deal.founders.map((f, i) => {
                const href = f.linkedin
                  ? f.linkedin.startsWith("http")
                    ? f.linkedin
                    : `https://${f.linkedin}`
                  : null;
                return (
                  <li key={i} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                    <span className="text-[14px] font-semibold text-ink">{f.name}</span>
                    {f.school && <span className="text-[13px] text-sub">· {f.school}</span>}
                    {href && (
                      <a
                        href={href}
                        target="_blank"
                        rel="noreferrer"
                        className="text-[13px] font-medium text-primary hover:underline"
                      >
                        LinkedIn
                      </a>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        {/* Details */}
        <section className="rounded-2xl border border-line bg-bg p-5">
          <h2 className="mb-3 text-[12px] font-semibold uppercase tracking-wide text-faint">Details</h2>
          <dl className="flex flex-col gap-2.5 text-[14px]">
            {deal.round && (
              <div className="flex justify-between gap-4">
                <dt className="text-sub">Round</dt>
                <dd className="text-right font-medium text-ink">{deal.round}</dd>
              </div>
            )}
            {deal.financing && (
              <div className="flex justify-between gap-4">
                <dt className="text-sub">Financing</dt>
                <dd className="text-right font-medium text-ink">{deal.financing}</dd>
              </div>
            )}
            {deal.schools.length > 0 && (
              <div className="flex items-start justify-between gap-4">
                <dt className="text-sub">School{deal.schools.length > 1 ? "s" : ""}</dt>
                <dd className="flex flex-wrap justify-end gap-1">
                  {deal.schools.map((s) => (
                    <span
                      key={s}
                      className="rounded px-2 py-0.5 text-[12px] font-semibold text-white"
                      style={{ backgroundColor: schoolColor(s) }}
                    >
                      {s}
                    </span>
                  ))}
                </dd>
              </div>
            )}
            <div className="flex justify-between gap-4">
              <dt className="text-sub">Added</dt>
              <dd className="text-right font-medium text-ink">{deal.created}</dd>
            </div>
          </dl>
        </section>

        <div className="flex flex-col items-center gap-2 pt-1 pb-6">
          <a
            href="/login"
            className="rounded-lg bg-primary px-5 py-2.5 text-[14px] font-semibold text-white transition-colors hover:bg-primary-pressed"
          >
            Sign in to open the pipeline
          </a>
          <span className="text-[12px] text-faint">Shared from {crm.org.name}</span>
        </div>
      </div>
    </main>
  );
}
