import type { KpiItem } from '../components/dashboard/KpiStrip';
import type { LocationCardProps } from '../components/dashboard/LocationCard';
import type { StylistRow } from '../components/dashboard/StylistsTable';
import type {
  DashboardKpi,
  SalonSnapshot,
  SalonStatus,
  StylistSnapshot,
} from '../data/dashboardSnapshot';

const SALON_STATUS_LABEL: Record<SalonStatus, string> = {
  'on-track-green': 'On track',
  'on-track-amber': 'On track',
  'needs-attention': 'Needs attention',
};

const GBP = new Intl.NumberFormat('en-GB', {
  style: 'currency',
  currency: 'GBP',
  maximumFractionDigits: 0,
});

function formatGbp(amount: number): string {
  return GBP.format(amount);
}

export function toKpiItem(kpi: DashboardKpi): KpiItem {
  return {
    value: formatGbp(kpi.valueGbp),
    label: kpi.label,
    hint: kpi.hint,
    hintTone: kpi.hintTone,
  };
}

export function toLocationCardProps(salon: SalonSnapshot): LocationCardProps {
  return {
    name: salon.name,
    street: salon.street,
    stylists: salon.stylists,
    status: salon.status,
    statusLabel: SALON_STATUS_LABEL[salon.status],
    generated: formatGbp(salon.generatedGbp),
    target: formatGbp(salon.targetGbp),
    generatedPct: salon.generatedPct,
    projectedPct: salon.projectedPct,
    bookedRemaining: formatGbp(salon.bookedRemainingGbp),
    projectedTotal: formatGbp(salon.projectedTotalGbp),
    inToday: `${salon.inToday.present}/${salon.inToday.scheduled}`,
    aboveThreeX: salon.aboveThreeX,
    needsPush: salon.needsPush,
  };
}

export function toStylistRow(stylist: StylistSnapshot): StylistRow {
  return {
    id: stylist.id,
    name: stylist.name,
    location: stylist.location,
    generated: formatGbp(stylist.generatedGbp),
    generatedOf: formatGbp(stylist.targetGbp),
    generatedTone: stylist.generatedMomentum,
    target: formatGbp(stylist.targetGbp),
    projected: formatGbp(stylist.projectedGbp),
    projectedTone: stylist.projectedMomentum,
    status: stylist.performance,
  };
}
