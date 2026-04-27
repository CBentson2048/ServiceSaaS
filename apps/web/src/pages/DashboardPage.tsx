import { useState } from 'react';
import { AppText } from '../design';
import { DiagnosticCard } from '../components/dashboard/DiagnosticCard';
import { KpiStrip } from '../components/dashboard/KpiStrip';
import { LocationCard } from '../components/dashboard/LocationCard';
import { RangeTabs, type DashboardRange } from '../components/dashboard/RangeTabs';
import { SectionLabel } from '../components/dashboard/SectionLabel';
import { StylistsTable } from '../components/dashboard/StylistsTable';
import { useDashboardSnapshot } from '../hooks/useDashboardSnapshot';
import { toKpiItem, toLocationCardProps, toStylistRow } from './dashboardMappers';

export function DashboardPage() {
  const [range, setRange] = useState<DashboardRange>('today');
  const { data } = useDashboardSnapshot(range);
  const { greeting, kpis, salons, stylists, diagnostics } = data;

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6 lg:px-8">
      <div className="overflow-hidden rounded-card-lg border border-border-strong bg-bg">
        <div className="flex flex-col gap-3 border-b border-border bg-surface px-6 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <AppText as="div" variant="subtitle" weight="medium">
              Good morning, {greeting.ownerName}
            </AppText>
            <AppText as="div" variant="caption" tone="muted" className="mt-0.5">
              {greeting.locationCount} locations · {greeting.stylistsOnToday} stylists on today · Last updated {greeting.lastUpdatedLabel}
            </AppText>
          </div>
          <RangeTabs value={range} onChange={setRange} />
        </div>

        <KpiStrip items={kpis.map(toKpiItem)} />

        <div className="px-6 py-5">
          <SectionLabel>Salons at a glance</SectionLabel>
          <div className="mb-6 grid gap-3.5 md:grid-cols-2">
            {salons.map((salon) => (
              <LocationCard key={salon.id} {...toLocationCardProps(salon)} />
            ))}
          </div>

          <SectionLabel>All stylists today</SectionLabel>
          <div className="mb-6">
            <StylistsTable rows={stylists.map(toStylistRow)} />
          </div>

          <SectionLabel>Diagnostics</SectionLabel>
          <div className="grid gap-3.5 lg:grid-cols-3">
            {diagnostics.map((d) => (
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
