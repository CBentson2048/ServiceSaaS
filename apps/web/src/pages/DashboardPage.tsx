import { useState } from 'react';
import { AppText } from '../design';
import { DiagnosticCard } from '../components/dashboard/DiagnosticCard';
import { KpiStrip } from '../components/dashboard/KpiStrip';
import { LocationCard } from '../components/dashboard/LocationCard';
import { RangeTabs, type DashboardRange } from '../components/dashboard/RangeTabs';
import { SectionLabel } from '../components/dashboard/SectionLabel';
import { StylistsTable } from '../components/dashboard/StylistsTable';
import { useAuth } from '../auth/AuthProvider';
import { useDashboardSnapshot } from '../hooks/useDashboardSnapshot';
import { toKpiItem, toLocationCardProps, toStylistRow } from './dashboardMappers';

export function DashboardPage() {
  const { user } = useAuth();
  const [range, setRange] = useState<DashboardRange>('today');
  const { data } = useDashboardSnapshot(range);
  const { greeting, kpis, salons, stylists, diagnostics } = data;
  const scopedLocationNames = new Set(user?.locations.map((location) => location.name.toLowerCase()) ?? []);
  const scopedSalons =
    user?.role === 'manager'
      ? salons.filter((salon) => scopedLocationNames.has(salon.name.toLowerCase()))
      : salons;
  const scopedStylists =
    user?.role === 'manager'
      ? stylists.filter((stylist) => scopedLocationNames.has(stylist.location.toLowerCase()))
      : stylists;

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
          <RangeTabs value={range} onChange={setRange} />
        </div>

        <KpiStrip items={kpis.map(toKpiItem)} />

        <div className="px-6 py-5">
          <div className="mb-5 rounded-card border border-primary/20 bg-primary-soft px-4 py-3">
            <AppText as="div" variant="caption" weight="medium">
              {user?.role === 'owner'
                ? 'Full business scope from backend auth'
                : 'Manager location scope from backend auth'}
            </AppText>
            <AppText as="div" variant="caption" tone="muted" className="mt-1">
              {user?.locations.length
                ? user.locations.map((location) => location.name).join(' · ')
                : 'No locations are assigned to this session.'}
            </AppText>
          </div>

          <SectionLabel>Salons at a glance</SectionLabel>
          <div className="mb-6 grid gap-3.5 md:grid-cols-2">
            {scopedSalons.map((salon) => (
              <LocationCard key={salon.id} {...toLocationCardProps(salon)} />
            ))}
          </div>

          <SectionLabel>All stylists today</SectionLabel>
          <div className="mb-6">
            <StylistsTable rows={scopedStylists.map(toStylistRow)} />
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
