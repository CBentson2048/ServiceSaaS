import type {
  PayStructureAcceleratorConditionInput,
  PayrollComparator,
  ThresholdBasis,
} from '@sheer/domain';
import { ACCELERATOR_METRIC_LABELS } from '@sheer/domain';
import { formatMoney } from '../kpi/format';
import { formatLocalDate } from './format';

/**
 * Presentation helpers shared by the pay-structure pages and wizard. Version
 * and assignment windows arrive with an EXCLUSIVE end date (matching the DB),
 * so display labels subtract one day. Dates go through Date.UTC so a DST
 * boundary can never shift a label.
 */

export const COMPARATOR_SYMBOLS: Record<PayrollComparator, string> = {
  gte: '≥',
  gt: '>',
  lte: '≤',
  lt: '<',
  eq: '=',
};

/** The LAST day a window covers: exclusive end date − 1 day, formatted. */
export function exclusiveEndDayLabel(isoExclusive: string): string {
  const [year, month, day] = isoExclusive.split('-').map(Number);
  if (!year || !month || !day) return isoExclusive;
  return new Date(Date.UTC(year, month - 1, day - 1)).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/** "6 Jan 2026 → in force" or "6 Jan 2026 – 3 Apr 2026" (end exclusive → −1 day). */
export function versionWindowLabel(effectiveFrom: string, effectiveTo: string | null): string {
  const from = formatLocalDate(effectiveFrom);
  return effectiveTo === null
    ? `${from} → in force`
    : `${from} – ${exclusiveEndDayLabel(effectiveTo)}`;
}

/** A band's "From" bound rendered in the threshold basis's own unit. */
export function bandFromLabel(
  basis: ThresholdBasis | null,
  band: {
    fromMultiple?: number | null;
    fromAmountCents?: number | null;
    fromPercent?: number | null;
  },
  currency: string,
): string {
  switch (basis) {
    case 'multiple_of_base_pay':
      return `${band.fromMultiple ?? 0}× base pay`;
    case 'absolute':
      return formatMoney(band.fromAmountCents ?? 0, currency);
    case 'per_client':
      return `${formatMoney(band.fromAmountCents ?? 0, currency)} per client`;
    case 'percent_of_service_target':
    case 'percent_of_service_revenue':
      return `${band.fromPercent ?? 0}%`;
    default:
      return '—';
  }
}

/** One accelerator condition as a sentence, threshold in its own unit. */
export function acceleratorConditionLabel(
  condition: Pick<
    PayStructureAcceleratorConditionInput,
    'metric' | 'comparator' | 'basis' | 'thresholdValue'
  >,
  currency: string,
): string {
  const metric = ACCELERATOR_METRIC_LABELS[condition.metric];
  const symbol = COMPARATOR_SYMBOLS[condition.comparator];
  switch (condition.basis) {
    case 'percent':
      return `${metric} ${symbol} ${condition.thresholdValue ?? 0}%`;
    case 'absolute_amount':
      return `${metric} ${symbol} ${formatMoney(condition.thresholdValue ?? 0, currency)}`;
    case 'staff_benchmark':
      return `${metric} ${symbol} the staff member's benchmark`;
    case 'target_met':
      return `${metric} — target met`;
    default:
      return metric;
  }
}
