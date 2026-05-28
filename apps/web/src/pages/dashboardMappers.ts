import type { KpiItem } from '../components/dashboard/KpiStrip';
import type { LocationCardProps } from '../components/dashboard/LocationCard';
import type { StylistRow } from '../components/dashboard/StylistsTable';
import type {
  SalonStatus,
} from '../data/dashboardSnapshot';
import type {
  DashboardKpiSummary,
  DashboardLocationKpiSummary,
  DashboardStylistPerformance,
} from '@sheer/domain';

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

function formatMoney(cents: number): string {
  return GBP.format(cents / 100);
}

export function toKpiItems(kpi: DashboardKpiSummary): KpiItem[] {
  return [
    {
      value: formatMoney(kpi.totalRevenueCents),
      label: 'Total Revenue',
      hint: `${kpi.completedBookings} completed`,
      hintTone: 'good',
    },
    {
      value: kpi.totalBookings.toString(),
      label: 'Total Bookings',
      hint: 'Selected range',
      hintTone: 'muted',
    },
    {
      value: kpi.completedBookings.toString(),
      label: 'Completed Bookings',
      hint: 'Status completed',
      hintTone: 'good',
    },
    {
      value: kpi.cancelledBookings.toString(),
      label: 'Cancelled Bookings',
      hint: 'Status cancelled',
      hintTone: 'muted',
    },
    {
      value: kpi.noShowBookings.toString(),
      label: 'No-show Bookings',
      hint: 'Status no_show',
      hintTone: 'muted',
    },
    {
      value: kpi.newClients.toString(),
      label: 'New Clients',
      hint: 'First booking in range',
      hintTone: 'purple',
    },
    {
      value: kpi.repeatClients.toString(),
      label: 'Repeat Clients',
      hint: 'Booked before range',
      hintTone: 'purple',
    },
    {
      value: `${kpi.rebookingRatePercent}%`,
      label: 'Rebooking Rate',
      hint: `${kpi.rebookedVisits} linked (${kpi.stylistRebookedVisits} staff / ${kpi.clientRebookedVisits} client)`,
      hintTone: kpi.rebookedVisits > 0 ? 'good' : 'muted',
    },
    {
      value: kpi.lowStockProducts.toString(),
      label: 'Low Stock Products',
      hint: 'At or below threshold',
      hintTone: kpi.lowStockProducts > 0 ? 'purple' : 'muted',
    },
  ];
}

export function toLocationCardProps(salon: DashboardLocationKpiSummary): LocationCardProps {
  const status = locationStatus(salon);
  return {
    name: salon.locationName,
    street: 'Selected period',
    stylists: 0,
    status,
    statusLabel: SALON_STATUS_LABEL[status],
    generated: formatMoney(salon.totalRevenueCents),
    target: formatMoney(salon.averageBookingValueCents),
    generatedPct: completionPct(salon),
    projectedPct: bookingHealthPct(salon),
    bookedRemaining: `${salon.totalBookings} bookings`,
    projectedTotal: `${salon.completedBookings} completed`,
    inToday: `${salon.completedBookings}/${salon.totalBookings}`,
    aboveThreeX: salon.newClients,
    needsPush: salon.cancelledBookings + salon.noShowBookings,
  };
}

export function toStylistRow(stylist: DashboardStylistPerformance): StylistRow {
  return {
    id: `${stylist.staffProfileId ?? 'unassigned'}:${stylist.locationId}`,
    name: stylist.stylistName,
    location: stylist.locationName,
    generated: formatMoney(stylist.revenueCents),
    generatedOf: `${stylist.completedBookings} completed`,
    generatedTone: stylist.revenueCents > 0 ? 'good' : 'default',
    target: `${stylist.totalBookings} bookings`,
    projected: formatMoney(stylist.averageBookingValueCents),
    projectedTone: stylist.averageBookingValueCents > 0 ? 'good' : 'default',
    status:
      stylist.cancelledBookings + stylist.noShowBookings > 0
        ? 'behind'
        : stylist.completedBookings >= 3
          ? 'above-3x'
          : 'on-track',
  };
}

function completionPct(salon: DashboardLocationKpiSummary): number {
  if (salon.totalBookings === 0) return 0;
  return Math.round((salon.completedBookings / salon.totalBookings) * 100);
}

function bookingHealthPct(salon: DashboardLocationKpiSummary): number {
  if (salon.totalBookings === 0) return 0;
  const healthyBookings = salon.totalBookings - salon.cancelledBookings - salon.noShowBookings;
  return Math.round((healthyBookings / salon.totalBookings) * 100);
}

function locationStatus(salon: DashboardLocationKpiSummary): SalonStatus {
  if (salon.totalBookings === 0) return 'on-track-amber';
  const exceptionRate = (salon.cancelledBookings + salon.noShowBookings) / salon.totalBookings;
  if (exceptionRate >= 0.25) return 'needs-attention';
  if (exceptionRate > 0) return 'on-track-amber';
  return 'on-track-green';
}
