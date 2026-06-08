import { useCallback, useEffect, useMemo, useState } from 'react';
import type { StylistKpiListResponse, StylistKpiResult } from '@sheer/domain';
import { AppText } from '../design';
import { RangeTabs, rangeToQueryParams, type CustomRange, type DashboardRange } from '../components/dashboard/RangeTabs';
import { SectionLabel } from '../components/dashboard/SectionLabel';
import { StylistKpiCard } from '../components/kpi/StylistKpiCard';
import { StylistKpiDetailModal } from '../components/kpi/StylistKpiDetailModal';
import { useAuth } from '../auth/AuthProvider';
import { ApiRequestError, getStylistKpis } from '../auth/api';

const RANGE_LABEL: Record<DashboardRange, string> = {
  today: 'today',
  week: 'this week',
  month: 'this month',
  custom: 'a custom range',
};

export function PerformancePage() {
  const { user, session } = useAuth();
  const accessToken = session?.accessToken;
  const [range, setRange] = useState<DashboardRange>('week');
  const [customRange, setCustomRange] = useState<CustomRange>({ from: '', to: '' });
  const [locationId, setLocationId] = useState<string>('all');
  const [data, setData] = useState<StylistKpiListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<StylistKpiResult | null>(null);

  const customFrom = customRange.from;
  const customTo = customRange.to;

  const load = useCallback(async () => {
    if (!accessToken) return;
    const queryParams = rangeToQueryParams(range, { from: customFrom, to: customTo });
    if (!queryParams) {
      // Custom range not fully selected yet.
      setData(null);
      setLoading(false);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const result = await getStylistKpis(accessToken, {
        ...queryParams,
        locationId: locationId !== 'all' ? locationId : undefined,
      });
      setData(result);
    } catch (err: unknown) {
      if (err instanceof ApiRequestError) setError(err.message);
      else if (err instanceof Error) setError(err.message);
      else setError('Could not load KPI data');
    } finally {
      setLoading(false);
    }
  }, [accessToken, range, customFrom, customTo, locationId]);

  useEffect(() => {
    void load();
  }, [load]);

  const stylists = useMemo(() => data?.stylists ?? [], [data]);
  const sortedStylists = useMemo(
    () =>
      [...stylists].sort(
        (a, b) =>
          Number(b.allKpisMet) - Number(a.allKpisMet) ||
          b.serviceTargetProgressPercent - a.serviceTargetProgressPercent,
      ),
    [stylists],
  );
  const locations = data?.locations ?? user?.locations ?? [];

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6 lg:px-8">
      <header className="mb-6 flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <AppText as="h1" variant="heading" weight="medium">
            Performance &amp; KPI
          </AppText>
          <AppText as="p" variant="caption" tone="muted" className="mt-1">
            Live targets and KPI status per stylist — the inputs that unlock commission. Showing {RANGE_LABEL[range]}.
          </AppText>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <RangeTabs
            value={range}
            onChange={setRange}
            allowCustom
            customRange={customRange}
            onCustomRangeChange={setCustomRange}
          />
          {user?.role === 'owner' && locations.length > 1 ? (
            <select
              value={locationId}
              onChange={(event) => setLocationId(event.target.value)}
              className="h-9 rounded-input-lg border border-border-strong bg-surface px-3 text-[13px] outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20"
            >
              <option value="all">All locations</option>
              {locations.map((location) => (
                <option key={location.id} value={location.id}>
                  {location.name}
                </option>
              ))}
            </select>
          ) : null}
        </div>
      </header>

      {data ? (
        <div className="mb-5 grid gap-3 sm:grid-cols-3">
          <SummaryStat label="Stylists" value={String(stylists.length)} />
          <SummaryStat
            label="Commission ready"
            value={`${data.commissionReadyCount} / ${stylists.length}`}
            tone={data.commissionReadyCount > 0 ? 'success' : 'muted'}
          />
          <SummaryStat label="Period" value={periodLabel(data)} />
        </div>
      ) : null}

      {error ? (
        <div className="mb-4 rounded-input-lg border border-danger-border bg-danger-soft px-4 py-3 text-[13px] text-danger">
          {error}
        </div>
      ) : null}

      {loading && !data ? (
        <div className="rounded-input-lg border border-border bg-surface-alt px-4 py-10 text-center text-[13px] text-text-secondary">
          Loading KPI data…
        </div>
      ) : !loading && stylists.length === 0 ? (
        <div className="rounded-input-lg border border-border bg-surface-alt px-4 py-10 text-center text-[13px] text-text-secondary">
          No stylists in scope for this period.
        </div>
      ) : (
        <>
          <SectionLabel>Stylist KPI status</SectionLabel>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {sortedStylists.map((stylist) => (
              <StylistKpiCard
                key={stylist.staffProfileId}
                stylist={stylist}
                onOpenDetail={() => setSelected(stylist)}
              />
            ))}
          </div>
        </>
      )}

      <StylistKpiDetailModal
        stylist={selected}
        periodLabel={data ? periodLabel(data) : RANGE_LABEL[range]}
        canManageBenchmarks={user?.role === 'owner'}
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
    <div className="rounded-card border border-border bg-surface px-4 py-3 shadow-sm">
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

function periodLabel(data: StylistKpiListResponse): string {
  const start = new Date(data.periodStart);
  const end = new Date(data.periodEnd);
  const fmt: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short' };
  // periodEnd is exclusive; show the inclusive last day.
  const lastDay = new Date(end.getTime() - 1);
  const startLabel = start.toLocaleDateString('en-GB', fmt);
  const endLabel = lastDay.toLocaleDateString('en-GB', fmt);
  return startLabel === endLabel ? startLabel : `${startLabel} – ${endLabel}`;
}
