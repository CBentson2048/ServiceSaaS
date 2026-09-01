import { useCallback, useEffect, useState } from 'react';
import type { MessageUsageResponse } from '@sheer/domain';
import { ApiRequestError, getMessageUsage } from '../../auth/api';

/**
 * Monthly message usage for the account (Wrike 4507284256).
 *
 * Sits under the plan card, which already states what the tier INCLUDES; this
 * says what has actually been USED. Usage visibility only — deliberately not a
 * billing portal, and there is no control here that could change a counter,
 * because usage is derived from messaging events and nothing else.
 *
 * The warning is in-app and nowhere else. Warning a salon by WhatsApp that they
 * are near their WhatsApp allowance would consume the very thing it warns about.
 */
export function MessageUsagePanel({ accessToken }: { accessToken: string }) {
  const [usage, setUsage] = useState<MessageUsageResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setUsage(await getMessageUsage(accessToken));
      setError(null);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not load message usage');
    } finally {
      setLoading(false);
    }
  }, [accessToken]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <Shell><p className="text-[13px] text-text-secondary">Loading usage…</p></Shell>;
  if (error || !usage) {
    return (
      <Shell>
        <p className="text-[13px] text-text-secondary">{error ?? 'Usage is unavailable right now.'}</p>
      </Shell>
    );
  }

  const c = usage.current;
  const tone =
    c.status === 'overage' ? 'danger' : c.status === 'at_limit' || c.status === 'near_limit' ? 'warning' : 'neutral';

  return (
    <Shell periodLabel={formatPeriod(c.periodStart)}>
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="text-[22px] font-semibold tabular-nums text-text-primary">
          {c.used.toLocaleString()}
        </span>
        <span className="text-[14px] text-text-secondary">
          {c.isUnlimited
            ? 'messages sent'
            : c.allowance === null
              ? 'messages sent'
              : `of ${c.allowance.toLocaleString()} included`}
        </span>
      </div>

      {c.allowance !== null && c.percentUsed !== null ? (
        <>
          <div className="mt-2 h-2 w-full overflow-hidden rounded-pill bg-surface-alt">
            <div
              className={`h-full rounded-pill ${
                tone === 'danger' ? 'bg-danger' : tone === 'warning' ? 'bg-warning' : 'bg-primary'
              }`}
              // Capped at 100% so an overage does not render a bar past its track.
              style={{ width: `${Math.min(100, c.percentUsed)}%` }}
            />
          </div>
          <p className="mt-1.5 text-[13px] text-text-secondary">
            {c.overage > 0
              ? `${c.overage.toLocaleString()} over your allowance`
              : `${(c.remaining ?? 0).toLocaleString()} remaining · ${c.percentUsed}% used`}
          </p>
        </>
      ) : (
        <p className="mt-1.5 text-[13px] text-text-secondary">
          {c.isUnlimited ? 'Your plan includes unlimited client messages.' : 'No allowance is configured for this plan yet.'}
        </p>
      )}

      {c.status === 'near_limit' ? (
        <Note tone="warning">
          {c.percentUsed}% of this month&apos;s message allowance has been used.
        </Note>
      ) : null}
      {c.status === 'at_limit' ? (
        <Note tone="warning">
          This month&apos;s message allowance is fully used.
          {c.enforcementMode === 'block_at_cap' ? ' Further messages will not be sent.' : ' Further messages count as overage.'}
        </Note>
      ) : null}
      {c.status === 'overage' ? (
        <Note tone="danger">
          You have exceeded this month&apos;s allowance by {c.overage.toLocaleString()} message
          {c.overage === 1 ? '' : 's'}.
        </Note>
      ) : null}

      {usage.history.length > 0 ? (
        <div className="mt-4">
          <p className="text-[11px] font-medium uppercase tracking-wide text-text-secondary">
            Previous months
          </p>
          <ul className="mt-1 space-y-0.5">
            {usage.history.slice(0, 6).map((row) => (
              <li key={row.periodStart} className="flex justify-between gap-3 text-[12px]">
                <span className="text-text-secondary">{formatPeriod(row.periodStart)}</span>
                <span className="tabular-nums text-text-primary">
                  {row.used.toLocaleString()}
                  {row.allowance !== null ? ` / ${row.allowance.toLocaleString()}` : ''}
                  {row.overage > 0 ? ` (+${row.overage.toLocaleString()} over)` : ''}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </Shell>
  );
}

function Shell({ children, periodLabel }: { children: React.ReactNode; periodLabel?: string }) {
  return (
    <section className="rounded-input-lg border border-border bg-surface px-5 py-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-[14px] font-semibold text-text-primary">Messaging usage</h2>
        {periodLabel ? <span className="text-[12px] text-text-secondary">{periodLabel}</span> : null}
      </div>
      <div className="mt-2">{children}</div>
    </section>
  );
}

function Note({ tone, children }: { tone: 'warning' | 'danger'; children: React.ReactNode }) {
  const cls = tone === 'danger' ? 'bg-danger-soft text-danger' : 'bg-warning-soft text-warning';
  return <p className={`mt-3 rounded-input-lg px-3 py-2 text-[12px] ${cls}`}>{children}</p>;
}

function formatPeriod(periodStart: string): string {
  const [year, month] = periodStart.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, 1)).toLocaleDateString(undefined, {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}
