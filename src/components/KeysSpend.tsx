import { COST_ESTIMATES, type KeyStatus, type ProviderUsage } from "@/lib/usage";

const money = (n: number) =>
  n >= 10 ? `$${n.toFixed(0)}` : `$${n.toFixed(2)}`;

/** API key inventory + estimated spend, rendered inside Settings. */
export function KeysSpend({
  keys,
  usage,
}: {
  keys: KeyStatus[];
  usage: ProviderUsage[];
}) {
  const totalMonth = usage.reduce((n, u) => n + u.estMonthCost, 0);
  return (
    <div className="flex flex-col gap-6">
      <div className="overflow-x-auto">
        <table className="table">
          <thead>
            <tr>
              <th>Provider</th>
              <th className="hidden sm:table-cell">Env var</th>
              <th>Status</th>
              <th className="hidden md:table-cell">Used for</th>
            </tr>
          </thead>
          <tbody>
            {keys.map((k) => (
              <tr key={k.env}>
                <td className="text-[14px] font-medium text-ink">
                  {k.manageUrl ? (
                    <a
                      href={k.manageUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="hover:text-primary"
                    >
                      {k.name}
                    </a>
                  ) : (
                    k.name
                  )}
                </td>
                <td className="hidden font-mono text-[12px] !text-sub sm:table-cell">
                  {k.env}
                </td>
                <td className="whitespace-nowrap text-[13px]">
                  {k.configured ? (
                    <span className="font-medium text-ink">
                      Configured{k.tail ? ` · …${k.tail}` : ""}
                    </span>
                  ) : (
                    <span className="font-semibold text-primary">Missing</span>
                  )}
                </td>
                <td className="hidden text-[13px] !text-sub md:table-cell">
                  {k.usedFor}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div>
        <h3 className="text-[14px] font-semibold text-ink">
          Usage &amp; estimated spend
        </h3>
        <p className="mt-1 text-[13px] text-sub">
          Counts are paid calls — cached results are reused for 30 days and
          cost nothing. Costs are estimates at{" "}
          {Object.entries(COST_ESTIMATES)
            .map(([p, c]) => `${p} ${money(c)}/call`)
            .join(", ")}
          ; exact numbers live in each provider&apos;s dashboard.
        </p>
        <div className="mt-3 overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th>Provider</th>
                <th>24h</th>
                <th>7 days</th>
                <th>30 days</th>
                <th className="hidden sm:table-cell">All time</th>
                <th>Est. 30-day cost</th>
                <th className="hidden md:table-cell">Quota errors (7d)</th>
              </tr>
            </thead>
            <tbody>
              {usage.map((u) => (
                <tr key={u.provider}>
                  <td className="text-[14px] font-medium text-ink">
                    {u.provider}
                  </td>
                  <td className="text-[13px]">{u.day.toLocaleString()}</td>
                  <td className="text-[13px]">{u.week.toLocaleString()}</td>
                  <td className="text-[13px]">{u.month.toLocaleString()}</td>
                  <td className="hidden text-[13px] !text-sub sm:table-cell">
                    {u.total.toLocaleString()}
                  </td>
                  <td className="text-[13px] font-medium text-ink">
                    {money(u.estMonthCost)}
                  </td>
                  <td className="hidden text-[13px] md:table-cell">
                    {u.quotaErrors7d > 0 ? (
                      <span className="font-semibold text-primary">
                        {u.quotaErrors7d}
                      </span>
                    ) : (
                      <span className="!text-sub">0</span>
                    )}
                  </td>
                </tr>
              ))}
              <tr>
                <td className="text-[14px] font-semibold text-ink">Total</td>
                <td colSpan={3} />
                <td className="hidden sm:table-cell" />
                <td className="text-[14px] font-semibold text-primary">
                  {money(totalMonth)}
                </td>
                <td className="hidden md:table-cell" />
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
