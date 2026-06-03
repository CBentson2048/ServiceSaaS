import { useState } from 'react';
import type { DashboardInventoryAlertsResponse, DashboardTopServicesResponse } from '@sheer/domain';
import { AppText } from '../design';
import { CommissionReadinessCard } from '../components/dashboard/CommissionReadinessCard';
import { DiagnosticCard } from '../components/dashboard/DiagnosticCard';
import { KpiStrip } from '../components/dashboard/KpiStrip';
import { LocationCard } from '../components/dashboard/LocationCard';
import { RangeTabs, type DashboardRange } from '../components/dashboard/RangeTabs';
import { SectionLabel } from '../components/dashboard/SectionLabel';
import { StylistsTable } from '../components/dashboard/StylistsTable';
import { useAuth } from '../auth/AuthProvider';
import { useDashboardSnapshot } from '../hooks/useDashboardSnapshot';
import { useSheerLabAnalytics } from '../hooks/useSheerLabAnalytics';
import { toKpiItems, toLocationCardProps, toStylistRow } from './dashboardMappers';

export function DashboardPage() {
  const { user } = useAuth();
  const [range, setRange] = useState<DashboardRange>('today');
  const { data, isLoading, error, locationId, setLocationId } = useDashboardSnapshot(range);
  const { data: labAnalytics, isLoading: labAnalyticsLoading } = useSheerLabAnalytics(range);
  const { greeting, kpis, salons, stylists, diagnostics, topServices, inventoryAlerts } = data;
  const hasDashboardData =
    kpis.summary.totalBookings > 0 || kpis.summary.totalRevenueCents > 0 || kpis.summary.lowStockProducts > 0;
  // Owners compare multiple salons side-by-side; a manager only sees their own
  // single location, which the KPI strip above already summarises — so the
  // per-salon comparison grid is only meaningful when there is more than one.
  const showSalonsAtAGlance = user?.role === 'owner' && salons.length > 1;

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6 lg:px-8">
      <div className="overflow-hidden rounded-card-lg border border-border-strong bg-bg">
        <div className="flex flex-col gap-3 border-b border-border bg-surface px-6 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <AppText as="div" variant="subtitle" weight="medium">
              Good morning, {user?.profile.fullName.split(' ')[0] ?? greeting.ownerName}
            </AppText>
            <AppText as="div" variant="caption" tone="muted" className="mt-0.5">
              {user?.role === 'owner' ? 'Owner' : 'Manager'} ·{' '}
              {user?.locations.length ?? greeting.locationCount} accessible locations ·{' '}
              {greeting.stylistsOnToday} stylists on today · Last updated {greeting.lastUpdatedLabel}
            </AppText>
          </div>
          <div className="flex flex-col gap-2 sm:items-end">
            <RangeTabs value={range} onChange={setRange} />
            {user?.role === 'owner' && kpis.locations.length > 1 ? (
              <select
                value={locationId}
                onChange={(event) => setLocationId(event.target.value)}
                className="h-9 rounded-input-lg border border-border-strong bg-surface px-3 text-[13px] outline-none focus:border-primary"
              >
                <option value="all">All locations</option>
                {kpis.locations.map((location) => (
                  <option key={location.id} value={location.id}>
                    {location.name}
                  </option>
                ))}
              </select>
            ) : null}
          </div>
        </div>

        <KpiStrip items={toKpiItems(kpis.summary)} />

        <div className="px-6 py-5">
          {isLoading ? (
            <div className="mb-4 rounded-input-lg border border-border bg-surface-alt px-4 py-3 text-[13px] text-text-secondary">
              Loading dashboard KPIs...
            </div>
          ) : null}
          {error ? (
            <div className="mb-4 rounded-input-lg border border-danger-border bg-danger-soft px-4 py-3 text-[13px] text-danger">
              {error.message}
            </div>
          ) : null}
          {!isLoading && !error && !hasDashboardData ? (
            <div className="mb-4 rounded-input-lg border border-border bg-surface-alt px-4 py-3 text-[13px] text-text-secondary">
              No KPI data for this date range yet.
            </div>
          ) : null}

          {showSalonsAtAGlance ? (
            <>
              <SectionLabel>
                Salons at a glance
                <span className="ml-2 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-primary-soft px-1.5 text-[11px] font-medium normal-case tracking-normal text-primary">
                  {salons.length}
                </span>
              </SectionLabel>
              <div className="mb-6 grid gap-3.5 md:grid-cols-2 xl:grid-cols-3">
                {salons.map((salon) => (
                  <LocationCard key={salon.locationId} {...toLocationCardProps(salon)} />
                ))}
              </div>
            </>
          ) : null}

          <SectionLabel>{user?.role === 'owner' ? 'All stylists today' : 'Your team today'}</SectionLabel>
          <div className="mb-6">
            <StylistsTable rows={stylists.map(toStylistRow)} />
          </div>

          <SectionLabel>KPI &amp; commission readiness</SectionLabel>
          <div className="mb-6">
            <CommissionReadinessCard range={range} locationId={locationId} />
          </div>

          <SectionLabel>Diagnostics</SectionLabel>
          <div className="grid gap-3.5 lg:grid-cols-3">
            <DiagnosticCard
              title="Top Services"
              subtitle="Most booked services in selected range"
              rows={toTopServiceRows(topServices)}
              footerLabel="Services"
              footerValue={topServices.services.length}
              footerTone="purple"
            />
            <DiagnosticCard
              title="Inventory Alerts"
              subtitle="Products at or below threshold"
              rows={toInventoryAlertRows(inventoryAlerts)}
              footerLabel="Low stock"
              footerValue={inventoryAlerts.count}
              footerTone={inventoryAlerts.count > 0 ? 'warn' : 'good'}
            />
            <DiagnosticCard
              title="Sheer Lab"
              subtitle={labAnalyticsLoading ? 'Loading formula analytics' : 'Colour formulas, waste, and stock'}
              rows={toSheerLabDiagnosticRows(labAnalytics)}
              footerLabel="Waste / revenue"
              footerValue={labAnalytics ? `${labAnalytics.summary.wastePercentOfRevenue.toFixed(1)}%` : '0.0%'}
              footerTone={
                labAnalytics && labAnalytics.summary.wastePercentOfRevenue > 8
                  ? 'bad'
                  : labAnalytics && labAnalytics.summary.wastePercentOfRevenue > 4
                    ? 'warn'
                    : 'good'
              }
            />
            {diagnostics.slice(0, 1).map((d) => (
              <DiagnosticCard
                key={d.id}
                title={d.title}
                subtitle={d.subtitle}
                rows={d.rows}
                footerLabel={d.footerLabel}
                footerValue={d.footerValue}
                footerTone={d.footerTone}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function toSheerLabDiagnosticRows(
  analytics: ReturnType<typeof useSheerLabAnalytics>['data'],
) {
  if (!analytics) {
    return [
      { label: 'Colour revenue', value: '£0', valueTone: 'ink' as const },
      { label: 'Margin', value: '0.0%', valueTone: 'ink' as const },
      { label: 'Waste cost', value: '£0', valueTone: 'good' as const },
      { label: 'Formulas mixed', value: '0', valueTone: 'ink' as const },
      { label: 'Low stock', value: '0 open', valueTone: 'good' as const },
    ];
  }

  const { summary } = analytics;
  return [
    {
      label: 'Colour revenue',
      value: formatMoney(summary.colourRevenueCents, summary.currencyCode),
      valueTone: 'purple' as const,
    },
    {
      label: 'Margin',
      value: `${summary.grossMarginPercent.toFixed(1)}%`,
      valueTone: summary.grossMarginPercent >= 60 ? ('good' as const) : ('warn' as const),
      pct: summary.grossMarginPercent,
    },
    {
      label: 'Waste cost',
      value: formatMoney(summary.wasteCostCents, summary.currencyCode),
      valueTone: summary.wastePercentOfRevenue > 8 ? ('bad' as const) : ('warn' as const),
    },
    {
      label: analytics.scope === 'owner' ? 'Worst location' : 'Location',
      value: summary.worstLocationName ?? 'No formulas',
      valueTone: 'ink' as const,
    },
    {
      label: 'Formulas mixed',
      value: summary.formulasMixed.toString(),
      valueTone: 'ink' as const,
      caption: `${analytics.lowStockAlerts.length} low-stock alerts`,
    },
  ];
}

function toTopServiceRows(topServices: DashboardTopServicesResponse) {
  if (topServices.services.length === 0) {
    return [{ label: 'No services booked', value: '0', valueTone: 'ink' as const }];
  }

  return topServices.services.slice(0, 5).map((service) => ({
    label: service.serviceName,
    value: service.bookingCount.toString(),
    valueTone: service.revenueCents > 0 ? ('purple' as const) : ('ink' as const),
    caption: formatMoney(service.revenueCents, service.currencyCode),
  }));
}

function toInventoryAlertRows(inventoryAlerts: DashboardInventoryAlertsResponse) {
  if (inventoryAlerts.alerts.length === 0) {
    return [{ label: 'No low stock products', value: '0', valueTone: 'good' as const }];
  }

  return inventoryAlerts.alerts.slice(0, 5).map((alert) => ({
    label: alert.brand ? `${alert.brand} ${alert.productName}` : alert.productName,
    value: `${Math.round(alert.quantityOnHandGrams)}g`,
    valueTone: 'warn' as const,
    caption: `${alert.locationName} · threshold ${Math.round(alert.thresholdGrams)}g`,
  }));
}

function formatMoney(cents: number, currencyCode: string): string {
  return new Intl.NumberFormat('en-GB', {
    style: 'currency',
    currency: currencyCode,
    maximumFractionDigits: 0,
  }).format(cents / 100);
}
