import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { StylistKpiResult } from '@sheer/domain';
import { cn } from '@sheer/utils';
import { AppCard, AppText, StatusBadge } from '../../design';
import { ApiRequestError, getStylistKpis } from '../../auth/api';
import { useAuth } from '../../auth/AuthProvider';
import type { DashboardRange } from './RangeTabs';

const COLS = '1.7fr 1fr 1fr 1fr 96px';

/**
 * Dashboard surface for KPI / commission readiness. Self-contained — it fetches
 * the per-stylist KPI list (`/kpi/stylists`) for the dashboard's current range
 * and location, so it never entangles the main snapshot flow. Every value is
 * real backend KPI output; `allKpisMet` is the commission unlock gate.
 */
export function CommissionReadinessCard({
  range,
  locationId,
}: {
  range: DashboardRange;
  locationId: string;
}) {
  const { session } = useAuth();
  const accessToken = session?.accessToken;
  const [stylists, setStylists] = useState<StylistKpiResult[]>([]);
  const [readyCount, setReadyCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!accessToken) return;
    setLoading(true);
    setError(null);
    try {
      const result = await getStylistKpis(accessToken, {
        period: range,
        locationId: locationId !== 'all' ? locationId : undefined,
      });
      setStylists(result.stylists);
      setReadyCount(result.commissionReadyCount);
    } catch (err: unknown) {
      if (err instanceof ApiRequestError) setError(err.message);
      else if (err instanceof Error) setError(err.message);
      else setError('Could not load commission readiness');
    } finally {
      setLoading(false);
    }
  }, [accessToken, range, locationId]);

  useEffect(() => {
    void load();
  }, [load]);

  const sorted = useMemo(
    () =>
      [...stylists].sort(
        (a, b) =>
          Number(b.allKpisMet) - Number(a.allKpisMet) ||
          b.serviceTargetProgressPercent - a.serviceTargetProgressPercent,
      ),
    [stylists],
  );

  return (
    <AppCard padding="none" elevation="none" className="overflow-hidden border-[1.5px]">
      <div className="flex items-center justify-between gap-3 border-b border-border bg-surface-alt px-4 py-3">
        <div className="flex items-baseline gap-2">
          <AppText as="span" variant="title" weight="medium">
            {readyCount}
          </AppText>
          <AppText as="span" variant="caption" tone="muted">
            of {stylists.length} commission-ready
          </AppText>
        </div>
        <Link
          to="/performance"
          className="text-[12px] font-medium text-primary transition hover:text-primary-deep"
        >
          View full performance →
        </Link>
      </div>

      {loading && stylists.length === 0 ? (
        <div className="px-4 py-8 text-center text-[13px] text-text-secondary">Loading KPI status…</div>
      ) : error ? (
        <div className="px-4 py-4 text-[13px] text-danger">{error}</div>
      ) : stylists.length === 0 ? (
        <div className="px-4 py-8 text-center text-[13px] text-text-secondary">
          No stylists in scope for this range.
        </div>
      ) : (
        <>
          <div
            className="grid items-center bg-surface-alt px-4 py-2.5"
            style={{ gridTemplateColumns: COLS }}
          >
            {['Stylist', 'Rebooking', 'Retail', 'Avg bill', 'Commission'].map((heading) => (
              <AppText key={heading} as="div" variant="micro" weight="medium" uppercase className="text-text-subtle">
                {heading}
              </AppText>
            ))}
          </div>

          {sorted.map((stylist) => (
            <div
              key={stylist.staffProfileId}
              className={cn(
                'grid items-center border-t border-border-divider px-4 py-3',
                stylist.allKpisMet ? 'bg-success-soft' : 'bg-surface',
              )}
              style={{ gridTemplateColumns: COLS }}
            >
              <div className="min-w-0">
                <AppText as="div" weight="medium" className="truncate text-[13px]">
                  {stylist.stylistName}
                </AppText>
                <AppText as="div" variant="micro" className="mt-0.5 truncate text-text-subtle">
                  {stylist.locationName}
                </AppText>
              </div>
              <KpiCell
                met={stylist.rebookingKpiMet}
                text={`${stylist.rebooking.rebookingRatePercent}%`}
              />
              <KpiCell met={stylist.retailKpiMet} text={`${stylist.retailTargetProgressPercent}%`} />
              <KpiCell
                met={stylist.averageBillKpiMet}
                text={stylist.averageBill.hasBenchmark ? 'set' : 'no benchmark'}
              />
              <StatusBadge
                label={stylist.allKpisMet ? 'Ready' : 'Locked'}
                tone={stylist.allKpisMet ? 'success' : 'neutral'}
              />
            </div>
          ))}
        </>
      )}
    </AppCard>
  );
}

/** A single KPI verdict cell: met → success dot + value, otherwise muted. */
function KpiCell({ met, text }: { met: boolean; text: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <span
        className={cn('h-1.5 w-1.5 shrink-0 rounded-full', met ? 'bg-success-fill' : 'bg-border-strong')}
        aria-hidden
      />
      <AppText as="span" variant="caption" tone={met ? 'success' : 'muted'} className="truncate">
        {text}
      </AppText>
    </div>
  );
}
