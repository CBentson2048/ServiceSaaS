import { useCallback, useEffect, useMemo, useState } from 'react';
import type { StylistKpiListResponse, StylistKpiResult } from '@sheer/domain';
import { userHasRole } from '@sheer/domain';
import { cn } from '@sheer/utils';
import { AppCard, AppText, StatusBadge, type StatusTone } from '../design';
import { RangeTabs, type DashboardRange } from '../components/dashboard/RangeTabs';
import { SectionLabel } from '../components/dashboard/SectionLabel';
import { StylistKpiDetailModal } from '../components/kpi/StylistKpiDetailModal';
import { formatMoney, tierLabel } from '../components/kpi/format';
import { useAuth } from '../auth/AuthProvider';
import { useLocationScope } from '../components/LocationScopeContext';
import { ApiRequestError, getStylistKpis } from '../auth/api';

const RANGE_LABEL: Record<DashboardRange, string> = {
  today: 'today',
  week: 'this week',
  month: 'this month',
  custom: 'a custom range',
};

const COLS = '1.8fr 0.8fr 1.3fr 0.7fr 1fr 92px';

const TIER_TONE: Record<StylistKpiResult['commission']['tier'], StatusTone> = {
  below_3x: 'neutral',
  tier_3x: 'warning',
  tier_3_5x: 'warning',
  tier_3_5x_unlocked: 'success',
};

export function CommissionPage() {
  const { user, session } = useAuth();
  const accessToken = session?.accessToken;
  const { selectedLocationId: locationId } = useLocationScope();
  const [range, setRange] = useState<DashboardRange>('month');
  const [data, setData] = useState<StylistKpiListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<StylistKpiResult | null>(null);

  const load = useCallback(async () => {
    if (!accessToken) return;
    setLoading(true);
    setError(null);
    try {
      const result = await getStylistKpis(accessToken, {
        // CommissionPage only offers presets (no custom tab), but the shared
        // range type now includes 'custom' — guard to keep `period` valid.
        period: range === 'custom' ? 'month' : range,
        locationId: locationId !== 'all' ? locationId : undefined,
      });
      setData(result);
    } catch (err: unknown) {
      if (err instanceof ApiRequestError) setError(err.message);
      else if (err instanceof Error) setError(err.message);
      else setError('Could not load commission data');
    } finally {
      setLoading(false);
    }
  }, [accessToken, range, locationId]);

  useEffect(() => {
    void load();
  }, [load]);

  const stylists = useMemo(() => data?.stylists ?? [], [data]);
  const sorted = useMemo(
    () => [...stylists].sort((a, b) => b.commission.commissionAmountCents - a.commission.commissionAmountCents),
    [stylists],
  );
  const currencyCode = stylists[0]?.currencyCode ?? 'GBP';

  const totals = useMemo(() => {
    const projectedCents = stylists.reduce((sum, s) => sum + s.commission.commissionAmountCents, 0);
    const earning = stylists.filter((s) => s.commission.ratePercent > 0).length;
    const unlocked = stylists.filter((s) => s.commission.tier === 'tier_3_5x_unlocked').length;
    return { projectedCents, earning, unlocked };
  }, [stylists]);

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6 lg:px-8">
      <header className="mb-6 flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <AppText as="h1" variant="heading" weight="medium">
            Commission
          </AppText>
          <AppText as="p" variant="caption" tone="muted" className="mt-1">
            Projected commission per stylist for {RANGE_LABEL[range]}, from live KPI &amp; revenue data.
          </AppText>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <RangeTabs value={range} onChange={setRange} />
        </div>
      </header>

      {data ? (
        <div className="mb-5 grid gap-3 sm:grid-cols-3">
          <SummaryStat label="Projected commission" value={formatMoney(totals.projectedCents, currencyCode)} tone="success" />
          <SummaryStat label="Earning commission" value={`${totals.earning} / ${stylists.length}`} />
          <SummaryStat label="On 30% tier" value={`${totals.unlocked} / ${stylists.length}`} />
        </div>
      ) : null}

      {/* Tier rules legend */}
      <div className="mb-5 rounded-card border border-border bg-surface-alt px-4 py-3">
        <AppText as="div" variant="micro" weight="medium" uppercase className="text-text-subtle">
          Tiers (by service-revenue multiple of labour cost)
        </AppText>
        <AppText as="div" variant="caption" tone="muted" className="mt-1">
          Below 3× → 0% · 3×–3.5× → 10% · 3.5×+ → 15% · 3.5×+ with all KPIs met → 30%. Base is service revenue
          (incl. colour), excluding retail &amp; deposits.
        </AppText>
      </div>

      {error ? (
        <div className="mb-4 rounded-input-lg border border-danger-border bg-danger-soft px-4 py-3 text-[13px] text-danger">
          {error}
        </div>
      ) : null}

      {loading && !data ? (
        <div className="rounded-input-lg border border-border bg-surface-alt px-4 py-10 text-center text-[13px] text-text-secondary">
          Loading commission data…
        </div>
      ) : !loading && stylists.length === 0 ? (
        <div className="rounded-input-lg border border-border bg-surface-alt px-4 py-10 text-center text-[13px] text-text-secondary">
          No stylists in scope for this period.
        </div>
      ) : (
        <>
          <SectionLabel>Commission by stylist</SectionLabel>
          <AppCard padding="none" elevation="none" className="overflow-hidden border-[1.5px]">
            <div className="grid items-center bg-surface-alt px-4 py-2.5" style={{ gridTemplateColumns: COLS }}>
              {['Stylist', 'Multiple', 'Tier', 'Rate', 'Commission', ''].map((heading, idx) => (
                <AppText
                  key={heading || idx}
                  as="div"
                  variant="micro"
                  weight="medium"
                  uppercase
                  className="text-text-subtle"
                >
                  {heading}
                </AppText>
              ))}
            </div>

            {sorted.map((stylist) => (
              <div
                key={stylist.staffProfileId}
                className={cn(
                  'grid items-center border-t border-border-divider px-4 py-3',
                  stylist.commission.tier === 'tier_3_5x_unlocked' ? 'bg-success-soft' : 'bg-surface',
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
                <AppText as="div" weight="medium" className="text-[13px]">
                  {stylist.commission.serviceMultiple.toFixed(2)}×
                </AppText>
                <div>
                  <StatusBadge label={tierLabel(stylist.commission.tier)} tone={TIER_TONE[stylist.commission.tier]} />
                </div>
                <AppText as="div" weight="medium" className="text-[13px]">
                  {stylist.commission.ratePercent}%
                </AppText>
                <AppText
                  as="div"
                  weight="medium"
                  tone={stylist.commission.ratePercent > 0 ? 'success' : 'muted'}
                  className="text-[13px]"
                >
                  {formatMoney(stylist.commission.commissionAmountCents, currencyCode)}
                </AppText>
                <button
                  type="button"
                  onClick={() => setSelected(stylist)}
                  className="justify-self-end text-[11px] font-medium text-primary transition hover:text-primary-deep focus:outline-none focus-visible:underline"
                >
                  Breakdown →
                </button>
              </div>
            ))}
          </AppCard>
        </>
      )}

      <StylistKpiDetailModal
        stylist={selected}
        periodLabel={data ? `${new Date(data.periodStart).toLocaleDateString('en-GB')} – ${new Date(data.periodEnd).toLocaleDateString('en-GB')}` : RANGE_LABEL[range]}
        canManageBenchmarks={userHasRole(user, 'owner')}
        onClose={() => setSelected(null)}
      />
    </div>
  );
}

function SummaryStat({
  label,
  value,
  tone = 'primary',
}: {
  label: string;
  value: string;
  tone?: 'primary' | 'success' | 'muted';
}) {
  return (
    <div className="rounded-card border border-border bg-surface px-4 py-3 shadow-card">
      <AppText as="div" variant="micro" tone="muted" uppercase>
        {label}
      </AppText>
      <AppText
        as="div"
        variant="title"
        weight="medium"
        tone={tone === 'success' ? 'success' : tone === 'muted' ? 'muted' : 'primary'}
        className="mt-0.5"
      >
        {value}
      </AppText>
    </div>
  );
}
