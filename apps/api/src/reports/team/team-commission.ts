/**
 * R2 finalised commission. Pure — no I/O, no clock.
 *
 * Reads locked or paid pay statements only and shows them per actual pay period:
 * never recalculated, never rolled up across periods, and never approved, review
 * or draft figures. Visibility follows the period's own scope:
 * - a business-wide period is shown to owners only;
 * - a location period is shown when the viewer's membership grant at that
 *   location carries `report.commission.view` (owners always).
 * Never `primary_location_id`, merged permissions or `allowedLocationIds`.
 * docs/V1.1/week-8-r2-team.md §7.
 */
import {
  isReportOwner,
  reportGrantLocationIds,
  type ReportAccessUser,
  type TeamAmount,
  type TeamCommissionLine,
  type TeamCommissionPeriod,
  type TeamCommissionRestriction,
  type TeamCommissionStaff,
} from '@sheer/domain';
import { addDays } from '../../payroll/period-dates';
import type { LocalDateRange, PayPeriodRow, PaySummaryRow } from './team-source';

export interface CommissionWindow extends LocalDateRange {
  locationId: string;
}

/** Periods overlapping the report dates that this viewer may see. */
export function visiblePayPeriods(
  actor: ReportAccessUser,
  periods: readonly PayPeriodRow[],
  windows: readonly CommissionWindow[],
): { periods: PayPeriodRow[]; restrictions: TeamCommissionRestriction[] } {
  const owner = isReportOwner(actor);
  const resolvedIds = windows.map((window) => window.locationId);
  const commissionLocations = new Set(reportGrantLocationIds(actor, 'report.commission.view', resolvedIds));
  const overlaps = (period: PayPeriodRow, window: LocalDateRange) => period.periodStart <= window.to && period.periodEnd > window.from;
  const visible = periods.filter((period) => {
    if (period.locationId === null) return owner && windows.some((window) => overlaps(period, window));
    const window = windows.find((candidate) => candidate.locationId === period.locationId);
    return window !== undefined && commissionLocations.has(period.locationId) && overlaps(period, window);
  });
  visible.sort((a, b) => (a.periodStart !== b.periodStart ? (a.periodStart < b.periodStart ? 1 : -1) : a.id < b.id ? -1 : 1));
  const restrictions: TeamCommissionRestriction[] = [];
  if (!owner) restrictions.push('business_wide_owner_only');
  if (resolvedIds.some((id) => !commissionLocations.has(id))) restrictions.push('location_commission_permission_required');
  return { periods: visible, restrictions };
}

export function commissionPeriods(
  periods: readonly PayPeriodRow[],
  summaries: readonly PaySummaryRow[],
  identityOf: (staffProfileId: string) => TeamCommissionStaff,
  selected: ReadonlySet<string> | null,
): TeamCommissionPeriod[] {
  const byPeriod = new Map<string, PaySummaryRow[]>();
  for (const summary of summaries) {
    const list = byPeriod.get(summary.payPeriodId);
    if (list) list.push(summary);
    else byPeriod.set(summary.payPeriodId, [summary]);
  }
  return periods.map((period) => {
    const statements = [...(byPeriod.get(period.id) ?? [])].sort((a, b) => (a.staffProfileId < b.staffProfileId ? -1 : a.staffProfileId > b.staffProfileId ? 1 : 0));
    const currencies = new Set(statements.map((statement) => statement.currencyCode));
    const total: TeamAmount =
      currencies.size > 1
        ? { availability: 'unavailable', reason: 'mixed_currencies' }
        : { availability: 'available', cents: statements.reduce((sum, statement) => sum + statement.commissionCents, 0) };
    const lines: TeamCommissionLine[] = statements
      .filter((statement) => selected === null || selected.has(statement.staffProfileId))
      .map((statement) => ({
        staff: identityOf(statement.staffProfileId),
        currencyCode: statement.currencyCode,
        commission: { availability: 'available', cents: statement.commissionCents },
        adjustments: { availability: 'available', cents: statement.adjustmentsCents },
        greaterOf: !statement.greaterOfApplied ? 'not_applied' : statement.greaterOfWinner === 'base_pay' ? 'base_pay_won' : 'commission_won',
      }));
    return {
      payPeriodId: period.id,
      label: period.label,
      periodStart: period.periodStart,
      // Stored exclusive; shown as the inclusive last date.
      periodEnd: addDays(period.periodEnd, -1),
      scope: period.locationId === null ? { kind: 'business' } : { kind: 'location', locationId: period.locationId },
      status: period.status,
      lines,
      total,
      currencyCode: currencies.size === 1 ? [...currencies][0] : null,
      statements: statements.length,
    };
  });
}

/** Staff on visible statements: business-wide ones carry no location. */
export function commissionStaff(periods: readonly PayPeriodRow[], summaries: readonly PaySummaryRow[]): Map<string, Set<string>> {
  const locationOf = new Map(periods.map((period) => [period.id, period.locationId]));
  const staff = new Map<string, Set<string>>();
  for (const summary of summaries) {
    const locations = staff.get(summary.staffProfileId) ?? new Set<string>();
    const locationId = locationOf.get(summary.payPeriodId);
    if (locationId) locations.add(locationId);
    staff.set(summary.staffProfileId, locations);
  }
  return staff;
}
