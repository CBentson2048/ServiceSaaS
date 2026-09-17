/**
 * R2 Team wording and formatting. Formatting only: every figure — money, counts,
 * percentages, averages — arrives computed from the API, and nothing here adds,
 * subtracts, divides or derives one. An unavailable figure is words, never 0.
 */
import type {
  LocalDate,
  MoneyAmount,
  MoneyUnavailableReason,
  TeamAmount,
  TeamCommissionRestriction,
  TeamCount,
  TeamEmploymentStatus,
  TeamGreaterOf,
  TeamLocalDateTime,
  TeamRatio,
  TeamReportBody,
  TeamStaffIdentity,
  TeamStaffRow,
  TeamStatementCurrency,
  TeamUnavailableMetric,
  TeamUnavailableMetricKey,
  TeamUnavailableReason,
} from '@sheer/domain';
import { NOT_STARTED, formatMoneyAmount } from '../money/moneyLabels';
import { formatReportDate } from '../reportScopeLine';

type TeamOnlyReason = Exclude<TeamUnavailableReason, MoneyUnavailableReason>;

const TEAM_TEXT: Record<TeamOnlyReason, string> = {
  no_bills: 'No bills',
  no_service_revenue: 'No service revenue',
  no_clients_seen: 'No clients seen',
  no_rostered_time: 'No rostered time',
  availability_scope_ambiguous: 'Unavailable',
  currency_unverified: 'Currency not verified',
  no_pay_statements: 'No pay statements',
};

/**
 * Why utilisation reads "Unavailable". Deliberately neutral: it never names a
 * location, leave, or how many days — the viewer may not see what caused it.
 */
export const AVAILABILITY_SCOPE_TEXT = 'Utilisation is unavailable because staff availability cannot be resolved safely for this period.';

/** Whether any utilisation figure in the report is unavailable for that reason (a presence check, no arithmetic). */
export function hasAvailabilityScopeAmbiguity(body: TeamReportBody): boolean {
  const ambiguous = (metrics: TeamMetricsLike) =>
    metrics.utilisation.utilisation.availability === 'unavailable' && metrics.utilisation.utilisation.reason === 'availability_scope_ambiguous';
  return (
    ambiguous(body.summary) ||
    (body.selectedStaff !== null && ambiguous(body.selectedStaff)) ||
    body.locations.some((location) => ambiguous(location.totals) || (location.selectedStaff !== null && ambiguous(location.selectedStaff))) ||
    body.staffRows.some((row) => ambiguous(row.metrics))
  );
}

type TeamMetricsLike = Pick<TeamReportBody['summary'], 'utilisation'>;

/** A pay statement's currency code, only when payroll recorded it; never a default. */
export function statementCurrencyCode(currency: TeamStatementCurrency): string | null {
  return currency.status === 'verified' ? currency.code : null;
}

export const COMMISSION_CURRENCY_UNVERIFIED_TEXT =
  'Some amounts aren’t shown because payroll didn’t record which currency those pay statements were calculated in. They are never shown in a guessed currency.';

/** Whether any pay statement or period total in the report has an unverified currency. */
export function hasUnverifiedCommissionCurrency(body: TeamReportBody): boolean {
  return body.finalisedCommission.periods.some(
    (period) =>
      (period.total.availability === 'unavailable' && period.total.reason === 'currency_unverified') ||
      period.lines.some((line) => line.currency.status === 'unverified'),
  );
}

function isTeamOnly(reason: TeamUnavailableReason): reason is TeamOnlyReason {
  return Object.prototype.hasOwnProperty.call(TEAM_TEXT, reason);
}

function unavailableText(reason: TeamUnavailableReason): string {
  return isTeamOnly(reason) ? TEAM_TEXT[reason] : formatMoneyAmount({ availability: 'unavailable', reason }, null);
}

/** `currencyCode` is the figure's own currency, from the API; there is no default. */
export function formatTeamAmount(amount: TeamAmount, currencyCode: string | null): string {
  if (amount.availability === 'unavailable' && isTeamOnly(amount.reason)) return TEAM_TEXT[amount.reason];
  return formatMoneyAmount(amount as MoneyAmount, currencyCode);
}

/** A whole number with thousands separators, by grouping its digits (no locale read). */
function grouped(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

export function formatTeamCount(count: TeamCount): string {
  switch (count.availability) {
    case 'available':
      return grouped(count.count);
    case 'unavailable':
      return unavailableText(count.reason);
    case 'not_started':
      return NOT_STARTED;
  }
}

/**
 * A percentage from the API's basis points, by placing the decimal point in the
 * digits — "1020" is "10.2%" — so the browser never divides.
 */
export function basisPointsText(basisPoints: number): string {
  const text = String(basisPoints);
  const sign = text.startsWith('-') ? '-' : '';
  const digits = text.replace('-', '').padStart(3, '0');
  const whole = digits.slice(0, -2);
  const fraction = digits.slice(-2).replace(/0+$/, '');
  return `${sign}${whole}${fraction ? `.${fraction}` : ''}%`;
}

export function formatTeamRatio(ratio: TeamRatio): string {
  switch (ratio.availability) {
    case 'available':
      return basisPointsText(ratio.basisPoints);
    case 'unavailable':
      return unavailableText(ratio.reason);
    case 'not_started':
      return NOT_STARTED;
  }
}

/** "4 of 10 clients" beside a percentage, only when the parts are known. */
export function clientsParts(ratio: TeamRatio): string | null {
  if (ratio.availability !== 'available') return null;
  return `${grouped(ratio.numerator)} of ${grouped(ratio.denominator)} ${ratio.denominator === 1 ? 'client' : 'clients'}`;
}

/** "2 bills", only when the count is known. */
export function billsText(count: TeamCount): string | null {
  if (count.availability !== 'available') return null;
  return count.count === 1 ? '1 bill' : `${grouped(count.count)} bills`;
}

export function formatMinutes(count: TeamCount): string {
  return count.availability === 'available' ? `${grouped(count.count)} min` : formatTeamCount(count);
}

/** "120 min booked of 420 min" when both are known; otherwise the reason, once. */
export function bookedOfRostered(booked: TeamCount, available: TeamCount): string {
  if (booked.availability === 'available' && available.availability === 'available') {
    return `${formatMinutes(booked)} booked of ${formatMinutes(available)}`;
  }
  return formatTeamCount(available.availability !== 'available' ? available : booked);
}

/** "16 Sept 2026, 11:00": a location's local date and time. */
export function asAtWhen(at: TeamLocalDateTime): string {
  return `${formatReportDate(at.localDate as LocalDate)}, ${at.localTime}`;
}

const EMPLOYMENT_TEXT: Record<TeamEmploymentStatus, string> = {
  active: 'Active',
  on_leave: 'On leave',
  notice: 'On notice',
  terminated: 'Left',
};

export function staffName(staff: TeamStaffIdentity): string {
  switch (staff.kind) {
    case 'staff':
      return staff.name;
    case 'former':
      return formerStaffLabel(staff.staffProfileId);
    case 'unattributed':
      return 'Unattributed';
  }
}

/** Former staff have no name left: a short reference keeps two of them apart. */
export function formerStaffLabel(staffProfileId: string): string {
  return `Former staff (profile removed, ref ${staffProfileId.slice(-4)})`;
}

/** A current member with nothing recorded at this location in the period says so, rather than looking like figures of zero. */
export function activityText(row: TeamStaffRow): string | null {
  return row.hasRecordedActivity ? null : 'No recorded activity here in this period';
}

/** Today's status, always labelled as current — never as where someone worked in the period. */
export function currentStatusText(staff: TeamStaffIdentity): string | null {
  if (staff.kind !== 'staff') return null;
  const employment = EMPLOYMENT_TEXT[staff.currentEmploymentStatus];
  return staff.currentlyActiveHere ? `Current: ${employment}, at this location` : `Current: ${employment}, not at this location`;
}

export const GREATER_OF_TEXT: Record<TeamGreaterOf, string> = {
  not_applied: '—',
  base_pay_won: 'Base pay was higher',
  commission_won: 'Commission was higher',
};

export const COMMISSION_RESTRICTION_TEXT: Record<TeamCommissionRestriction, string> = {
  business_wide_owner_only: 'Business-wide pay periods are shown to owners only.',
  location_commission_permission_required: 'Pay periods of locations where you can’t view commission are not shown.',
};

export const UNAVAILABLE_METRIC_LABELS: Record<TeamUnavailableMetricKey, string> = {
  rebooking_at_source: 'Rebooking At Source',
  service_revenue_target: 'Revenue vs target',
  retail_attach: 'Retail attach',
  live_commission: 'Live commission',
};

export function unavailableMetricText(metric: TeamUnavailableMetric): string {
  switch (metric.reason) {
    case 'capture_not_implemented':
      return 'Not available yet: whether the next appointment was booked during the visit isn’t captured yet. A later online booking is never counted as rebooked at source.';
    case 'target_model_not_available':
      return 'Not available yet: individual, role, location and business targets can’t be set up yet.';
    case 'retail_visit_linkage_not_captured':
      return 'Not available yet: retail sales aren’t reliably linked to the visit they were sold in.';
    case 'payroll_rules_not_implemented':
      return 'Not available yet: the payroll engine doesn’t apply the approved commission rules yet. Finalised commission from locked pay runs is shown below.';
  }
}
