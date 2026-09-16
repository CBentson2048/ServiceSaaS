/**
 * R2 Team report body (QLOOQO V1.1 Week 8).
 *
 * Team performance per staff member and per location, over each location's own
 * report window. Money comes from R1 Money's paid-bill universe and retail
 * sales; every figure is computed by the API and the web only formats. A figure
 * that cannot be stated honestly is an explicit unavailable value, never zero.
 * Decision record: docs/V1.1/week-8-r2-team.md.
 *
 * Browser-safe: types only, no clock, no Intl.
 */
import type { LocalDate } from './local-date';
import type { MoneyUnavailableReason } from './money-report';

export type TeamUnavailableReason =
  | MoneyUnavailableReason
  /** No bill with a line counts towards this average bill. */
  | 'no_bills'
  /** Retail share needs service revenue above zero. */
  | 'no_service_revenue'
  /** No eligible client visit, so there is no Future Booking population. */
  | 'no_clients_seen'
  /** No rostered time remains after breaks, book-outs and leave. */
  | 'no_rostered_time'
  /**
   * Approved leave recorded at another location covers a rostered day here. Whether
   * it removes this location's rostered time is not decided, so utilisation is not
   * stated rather than guessed.
   */
  | 'leave_location_ambiguous';

export type TeamAmount =
  | { availability: 'available'; cents: number }
  | { availability: 'unavailable'; reason: TeamUnavailableReason }
  /** No scoped day has started. */
  | { availability: 'not_started' };

export type TeamCount =
  | { availability: 'available'; count: number }
  | { availability: 'unavailable'; reason: TeamUnavailableReason }
  | { availability: 'not_started' };

/** A percentage with its parts. `basisPoints` = round(numerator × 10000 ÷ denominator). */
export type TeamRatio =
  | { availability: 'available'; numerator: number; denominator: number; basisPoints: number }
  | { availability: 'unavailable'; reason: TeamUnavailableReason }
  | { availability: 'not_started' };

/** Gross including VAT is the headline; net of VAT is shown alongside. */
export interface TeamMoneyPair {
  gross: TeamAmount;
  netOfVat: TeamAmount;
}

export interface TeamAverageBill {
  /** Σ gross of the lines counted. */
  total: TeamAmount;
  /** Distinct paid bills holding at least one counted line. */
  bills: TeamCount;
  /** `total ÷ bills`, rounded to the penny; unavailable (`no_bills`) with no bill. */
  average: TeamAmount;
}

export interface TeamUtilisation {
  /** Rostered minutes after breaks, reducing book-outs and same-location leave. */
  availableMinutes: TeamCount;
  /** Occupied appointment minutes on days with available time. */
  bookedMinutes: TeamCount;
  /** booked ÷ available. Not capped: above 100% stays visible. */
  utilisation: TeamRatio;
}

/**
 * Future Booking: of the distinct clients with an eligible visit in scope, how many
 * currently hold a future appointment (anywhere in the business, with anyone).
 * Always "as at" the report's generation time — never as at the end of the period.
 */
export interface TeamFutureBooking {
  clientsSeen: TeamCount;
  /** Future appointment pending or accepted. */
  withFutureBooking: TeamRatio;
  /** Future appointment accepted. */
  withConfirmedFutureBooking: TeamRatio;
}

export interface TeamMetrics {
  /** R1 paid bill `service` lines. */
  serviceRevenue: TeamMoneyPair;
  /** R1 paid bill `product_usage` lines. Separate from service revenue. */
  colour: TeamMoneyPair;
  averageBill: TeamAverageBill;
  utilisation: TeamUtilisation;
  futureBooking: TeamFutureBooking;
  /** Retail sales recorded, by seller. */
  retailRevenue: TeamAmount;
}

/** Team and location totals: computed from the whole universe, never from staff averages. */
export interface TeamTotals extends TeamMetrics {
  /** Retail revenue ÷ service revenue (gross). Team and location only. */
  retailShareOfServiceRevenue: TeamRatio;
  /** Bill lines that are neither service nor colour (adjustments): never attributed to staff. */
  otherBillLines: TeamAmount;
  /** The part of paid bill gross no line covers (R1's "not itemised"). */
  notItemised: TeamAmount;
}

/** The current state of a staff member, labelled as current — never as their history. */
export type TeamEmploymentStatus = 'active' | 'on_leave' | 'notice' | 'terminated';

export type TeamStaffIdentity =
  | {
      kind: 'staff';
      staffProfileId: string;
      name: string;
      /** Current employment status (today), not during the period. */
      currentEmploymentStatus: TeamEmploymentStatus;
      /** Currently holds an active membership at this row's location (today). */
      currentlyActiveHere: boolean;
    }
  /** Facts reference a staff profile that no longer exists. */
  | { kind: 'former'; staffProfileId: string }
  /** Facts that carry no staff member. */
  | { kind: 'unattributed' };

export interface TeamStaffRow {
  /** `${locationId}:${staffProfileId | 'unattributed'}` — stable and unique. */
  rowKey: string;
  /** The facts' own location. */
  locationId: string;
  staff: TeamStaffIdentity;
  /** The location's single currency; `null` when mixed or unknown. */
  currencyCode: string | null;
  metrics: TeamMetrics;
}

export interface TeamLocalDateTime {
  localDate: LocalDate;
  /** `HH:MM`, 24h. */
  localTime: string;
}

export interface TeamLocationTotals {
  locationId: string;
  currencyCode: string | null;
  /** Every fact at the location, whatever the staff filter. */
  totals: TeamTotals;
  /** The selected staff only; `null` without a staff filter. */
  selectedStaff: TeamMetrics | null;
  /** The generation instant in this location's local calendar and clock. */
  futureBookingAsAt: TeamLocalDateTime;
}

/** One entry of the staff picker: staff this viewer may filter by for this selection. */
export interface TeamStaffOption {
  staffProfileId: string;
  kind: 'staff' | 'former';
  /** `null` for former staff. */
  name: string | null;
  /** Resolved locations where the staff member has a row (facts or a current membership). */
  locationIds: string[];
}

export type TeamGreaterOf = 'not_applied' | 'base_pay_won' | 'commission_won';

/** A staff member on a pay statement. Statements are per person, not per location. */
export type TeamCommissionStaff = { kind: 'staff'; staffProfileId: string; name: string } | { kind: 'former'; staffProfileId: string };

export interface TeamCommissionLine {
  staff: TeamCommissionStaff;
  /** The statement's own currency. */
  currencyCode: string;
  /** As locked on the pay statement. When base pay won a greater-of comparison this is 0. */
  commission: TeamAmount;
  /** Corrections carried into the statement, shown separately from commission. */
  adjustments: TeamAmount;
  greaterOf: TeamGreaterOf;
}

export interface TeamCommissionPeriod {
  payPeriodId: string;
  label: string | null;
  periodStart: LocalDate;
  /** Inclusive last date of the pay period. */
  periodEnd: LocalDate;
  scope: { kind: 'business' } | { kind: 'location'; locationId: string };
  status: 'locked' | 'paid';
  /** Narrowed by the staff filter. */
  lines: TeamCommissionLine[];
  /** Σ commission over every statement in the period (unfiltered); unavailable when currencies differ. */
  total: TeamAmount;
  /** The statements' single currency; `null` when they differ or there are none. */
  currencyCode: string | null;
  /** Live statements in the period, whatever the staff filter. */
  statements: number;
}

/** Why some pay periods are not shown to this viewer — stated whether or not any exist. */
export type TeamCommissionRestriction =
  /** Business-wide pay periods are shown to owners only. */
  | 'business_wide_owner_only'
  /** Some resolved locations lack commission access for this viewer. */
  | 'location_commission_permission_required';

export interface TeamFinalisedCommission {
  /** Locked or paid pay periods overlapping the report dates, newest first. Never recalculated. */
  periods: TeamCommissionPeriod[];
  restrictions: TeamCommissionRestriction[];
}

export type TeamUnavailableMetricKey = 'rebooking_at_source' | 'service_revenue_target' | 'retail_attach' | 'live_commission';

export type TeamUnavailableMetricReason =
  /** Rebooking At Source is not captured at the source visit yet. */
  | 'capture_not_implemented'
  /** There is no target model for individual, role, location and business targets yet. */
  | 'target_model_not_available'
  /** Retail sales are not reliably linked to the visit they were sold in. */
  | 'retail_visit_linkage_not_captured'
  /** The payroll engine does not implement the approved commission rules yet. */
  | 'payroll_rules_not_implemented';

export interface TeamUnavailableMetric {
  metric: TeamUnavailableMetricKey;
  reason: TeamUnavailableMetricReason;
}

/** Metrics R2 names but cannot state yet. Never rendered as a number. */
export const TEAM_UNAVAILABLE_METRICS: readonly TeamUnavailableMetric[] = [
  { metric: 'rebooking_at_source', reason: 'capture_not_implemented' },
  { metric: 'service_revenue_target', reason: 'target_model_not_available' },
  { metric: 'retail_attach', reason: 'retail_visit_linkage_not_captured' },
  { metric: 'live_commission', reason: 'payroll_rules_not_implemented' },
];

export interface TeamDataQuality {
  /** Service lines not itemised per service: credited to the appointment's stylist. */
  rolledUpServiceLines: number;
  /** Booked appointment days with no rota shift for that stylist. */
  bookedWithoutRota: number;
  /** Booked appointment days where the stylist was rostered at another location. */
  bookedAtAnotherLocation: number;
  /** Rostered staff-days covered by approved leave recorded at another location. */
  leaveAtAnotherLocation: number;
}

export interface TeamReportBody {
  /** The report's generation instant (ISO 8601, UTC). Future Booking is as at this instant. */
  generatedAt: string;
  /** The single currency of the scope; `null` when mixed or unknown. */
  currencyCode: string | null;
  summary: TeamTotals;
  /** The selected staff across all locations; `null` without a staff filter. */
  selectedStaff: TeamMetrics | null;
  /** One per resolved location, in the same order. */
  locations: TeamLocationTotals[];
  /** Narrowed by the staff filter. Ordered by location, then name. */
  staffRows: TeamStaffRow[];
  /** The whole picker, whatever the staff filter. */
  staffOptions: TeamStaffOption[];
  finalisedCommission: TeamFinalisedCommission;
  unavailableMetrics: TeamUnavailableMetric[];
  dataQuality: TeamDataQuality;
}
