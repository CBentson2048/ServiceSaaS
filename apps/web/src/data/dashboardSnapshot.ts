import type {
  DashboardInventoryAlertsResponse,
  DashboardKpisResponse,
  DashboardLocationKpiSummary,
  DashboardStylistPerformance,
  DashboardStylistPerformanceResponse,
  DashboardTopServicesResponse,
} from '@sheer/domain';

/**
 * Domain shape for a single owner-dashboard snapshot.
 *
 * This file is intentionally UI-agnostic: it knows nothing about Tailwind
 * classes or component prop types. Treat it as the contract the analytics
 * API will eventually fulfil. Presentation hints (tones, labels) are derived
 * by `src/pages/dashboardMappers.ts` before reaching components.
 *
 * Currency amounts are stored in major units (GBP whole + decimals) as
 * `number`. Switch to minor units (pence) when the real API lands and
 * adjust the mapper accordingly.
 */

export type SalonStatus = 'on-track-green' | 'on-track-amber' | 'needs-attention';

export type StylistPerformance = 'on-track' | 'above-3x' | 'behind';

/** How a stylist's number is trending relative to their own target. */
export type Momentum = 'default' | 'good' | 'bad';

export type DiagnosticTone = 'good' | 'warn' | 'bad' | 'purple' | 'ink';

export type KpiHintTone = 'good' | 'purple' | 'muted';

export interface DashboardGreeting {
  ownerName: string;
  locationCount: number;
  stylistsOnToday: number;
  /** Human label for the snapshot's freshness, e.g. "just now", "2 min ago". */
  lastUpdatedLabel: string;
}

export interface DashboardKpi {
  id: string;
  label: string;
  valueGbp: number;
  hint?: string;
  hintTone?: KpiHintTone;
}

export interface SalonSnapshot {
  id: string;
  name: string;
  street: string;
  stylists: number;
  status: SalonStatus;
  generatedGbp: number;
  targetGbp: number;
  /** 0-100. Pre-rounded by backend so chart bars match KPI text. */
  generatedPct: number;
  /** 0-100. Forecast track including booked + average upsell. */
  projectedPct: number;
  bookedRemainingGbp: number;
  projectedTotalGbp: number;
  inToday: { present: number; scheduled: number };
  aboveThreeX: number;
  needsPush: number;
}

export interface StylistSnapshot {
  id: string;
  name: string;
  location: string;
  generatedGbp: number;
  targetGbp: number;
  projectedGbp: number;
  /** Omit when generated value should render in the default tone. */
  generatedMomentum?: Momentum;
  projectedMomentum: Momentum;
  performance: StylistPerformance;
}

export interface DiagnosticRowSnapshot {
  label: string;
  value: string;
  valueTone?: DiagnosticTone;
  /** 0-100, when present an inline mini-bar is rendered. */
  pct?: number;
  caption?: string;
}

export interface DiagnosticSnapshot {
  id: string;
  title: string;
  subtitle: string;
  rows: DiagnosticRowSnapshot[];
  footerLabel: string;
  footerValue: string;
  footerTone?: DiagnosticTone;
}

export interface DashboardSnapshot {
  greeting: DashboardGreeting;
  kpis: DashboardKpisResponse;
  topServices: DashboardTopServicesResponse;
  inventoryAlerts: DashboardInventoryAlertsResponse;
  salons: DashboardLocationKpiSummary[];
  stylists: DashboardStylistPerformance[];
  diagnostics: DiagnosticSnapshot[];
}

const EMPTY_KPIS: DashboardKpisResponse = {
  rangeStart: '',
  rangeEnd: '',
  scope: 'owner',
  locations: [],
  summary: {
    totalRevenueCents: 0,
    totalBookings: 0,
    completedBookings: 0,
    cancelledBookings: 0,
    noShowBookings: 0,
    newClients: 0,
    repeatClients: 0,
    rebookedVisits: 0,
    rebookingRatePercent: 0,
    stylistRebookedVisits: 0,
    clientRebookedVisits: 0,
    completedPaidBookings: 0,
    averageBookingValueCents: 0,
    lowStockProducts: 0,
    currencyCode: 'GBP',
  },
  byLocation: [],
};

const EMPTY_TOP_SERVICES: DashboardTopServicesResponse = {
  rangeStart: '',
  rangeEnd: '',
  scope: 'owner',
  services: [],
};

const EMPTY_STYLISTS: DashboardStylistPerformanceResponse = {
  rangeStart: '',
  rangeEnd: '',
  scope: 'owner',
  stylists: [],
};

const EMPTY_INVENTORY_ALERTS: DashboardInventoryAlertsResponse = {
  scope: 'owner',
  count: 0,
  alerts: [],
};

export function emptyDashboardSnapshot(): DashboardSnapshot {
  return {
    greeting: {
      ownerName: '',
      locationCount: 0,
      stylistsOnToday: 0,
      lastUpdatedLabel: 'just now',
    },
    kpis: EMPTY_KPIS,
    topServices: EMPTY_TOP_SERVICES,
    inventoryAlerts: EMPTY_INVENTORY_ALERTS,
    salons: [],
    stylists: EMPTY_STYLISTS.stylists,
    diagnostics: [],
  };
}

export const dashboardSnapshotMock = {
  greeting: {
    ownerName: 'Luke',
    locationCount: 4,
    stylistsOnToday: 28,
    lastUpdatedLabel: 'just now',
  },
  kpis: [
    {
      id: 'total-generated',
      label: 'Total generated',
      valueGbp: 4820,
      hint: '↑ 12% vs last week',
      hintTone: 'good',
    },
    {
      id: 'combined-target',
      label: 'Combined target',
      valueGbp: 6240,
      hint: '77% achieved',
      hintTone: 'muted',
    },
    {
      id: 'projected-total',
      label: 'Projected total',
      valueGbp: 6890,
      hint: 'Diary + avg upsell',
      hintTone: 'purple',
    },
    {
      id: 'commission-liability',
      label: 'Commission liability',
      valueGbp: 340,
      hint: 'If trajectory holds',
      hintTone: 'muted',
    },
  ],
  salons: [
    {
      id: 'pinner',
      name: 'Pinner',
      street: 'High Street',
      stylists: 8,
      status: 'on-track-green',
      generatedGbp: 1640,
      targetGbp: 2160,
      generatedPct: 76,
      projectedPct: 92,
      bookedRemainingGbp: 420,
      projectedTotalGbp: 2200,
      inToday: { present: 8, scheduled: 8 },
      aboveThreeX: 6,
      needsPush: 1,
    },
    {
      id: 'thame',
      name: 'Thame',
      street: 'High Street',
      stylists: 7,
      status: 'needs-attention',
      generatedGbp: 880,
      targetGbp: 1890,
      generatedPct: 47,
      projectedPct: 62,
      bookedRemainingGbp: 290,
      projectedTotalGbp: 1170,
      inToday: { present: 6, scheduled: 7 },
      aboveThreeX: 2,
      needsPush: 4,
    },
    {
      id: 'kensington',
      name: 'Kensington',
      street: 'Church Street',
      stylists: 6,
      status: 'on-track-amber',
      generatedGbp: 1240,
      targetGbp: 1620,
      generatedPct: 77,
      projectedPct: 88,
      bookedRemainingGbp: 190,
      projectedTotalGbp: 1560,
      inToday: { present: 6, scheduled: 6 },
      aboveThreeX: 4,
      needsPush: 2,
    },
    {
      id: 'abingdon',
      name: 'Abingdon',
      street: 'Stert Street',
      stylists: 7,
      status: 'on-track-amber',
      generatedGbp: 1060,
      targetGbp: 1890,
      generatedPct: 56,
      projectedPct: 82,
      bookedRemainingGbp: 490,
      projectedTotalGbp: 1720,
      inToday: { present: 7, scheduled: 7 },
      aboveThreeX: 3,
      needsPush: 4,
    },
  ],
  stylists: [
    {
      id: 'jade',
      name: 'Jade A.',
      location: 'Pinner',
      generatedGbp: 960,
      targetGbp: 1080,
      projectedGbp: 1180,
      projectedMomentum: 'good',
      performance: 'on-track',
    },
    {
      id: 'marcus',
      name: 'Marcus T.',
      location: 'Pinner',
      generatedGbp: 1340,
      targetGbp: 1080,
      projectedGbp: 1520,
      projectedMomentum: 'good',
      performance: 'above-3x',
    },
    {
      id: 'priya',
      name: 'Priya S.',
      location: 'Thame',
      generatedGbp: 280,
      targetGbp: 945,
      projectedGbp: 490,
      generatedMomentum: 'bad',
      projectedMomentum: 'bad',
      performance: 'behind',
    },
    {
      id: 'chloe',
      name: 'Chloe W.',
      location: 'Kensington',
      generatedGbp: 890,
      targetGbp: 810,
      projectedGbp: 1040,
      generatedMomentum: 'good',
      projectedMomentum: 'good',
      performance: 'above-3x',
    },
    {
      id: 'ryan',
      name: 'Ryan K.',
      location: 'Thame',
      generatedGbp: 140,
      targetGbp: 810,
      projectedGbp: 320,
      generatedMomentum: 'bad',
      projectedMomentum: 'bad',
      performance: 'behind',
    },
  ],
  diagnostics: [
    {
      id: 'booking-capacity',
      title: 'Booking capacity',
      subtitle: 'Slots filled vs available today',
      rows: [
        { label: 'Pinner', value: '94%', valueTone: 'good', pct: 94 },
        { label: 'Thame', value: '58%', valueTone: 'bad', pct: 58 },
        { label: 'Kensington', value: '81%', valueTone: 'warn', pct: 81 },
        { label: 'Abingdon', value: '76%', valueTone: 'warn', pct: 76 },
      ],
      footerLabel: 'Overall',
      footerValue: '77% booked',
    },
    {
      id: 'commission-tiers',
      title: 'Commission tiers',
      subtitle: '% of stylists at each tier now',
      rows: [
        { label: 'At 30% (all KPIs)', value: '18%', valueTone: 'good', pct: 18 },
        { label: 'At 15% (3.5x+)', value: '29%', valueTone: 'good', pct: 29 },
        { label: 'At 10% (3x+)', value: '35%', valueTone: 'warn', pct: 35 },
        { label: 'Below target', value: '18%', valueTone: 'bad', pct: 18 },
      ],
      footerLabel: 'Liability if holds',
      footerValue: '£340 today',
    },
    {
      id: 'sheer-lab',
      title: 'Qlooqo Lab',
      subtitle: 'Colour revenue vs waste today',
      rows: [
        { label: 'Colour revenue', value: '£284', valueTone: 'purple', caption: 'all salons' },
        { label: 'Colour margin', value: '68%', valueTone: 'good', pct: 68 },
        { label: 'Waste cost', value: '£38', valueTone: 'bad', caption: 'Thame highest' },
        { label: 'Formulas mixed', value: '24', valueTone: 'ink' },
      ],
      footerLabel: 'Waste as % of colour rev',
      footerValue: '13.4%',
      footerTone: 'bad',
    },
  ],
};
