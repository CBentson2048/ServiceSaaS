import type { CommissionTier, KpiDataNote } from '@sheer/domain';

/**
 * Formatting helpers shared by the KPI components. All KPI money values arrive
 * from the backend in integer cents; nothing here invents or rounds business
 * data — it only presents the real values the API returns.
 */

/** Format an integer-cents amount as currency. Drops `.00` for whole amounts. */
export function formatMoney(cents: number, currencyCode: string): string {
  const safeCents = Number.isFinite(cents) ? Math.round(cents) : 0;
  const hasFraction = safeCents % 100 !== 0;
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: currencyCode || 'GBP',
    minimumFractionDigits: hasFraction ? 2 : 0,
    maximumFractionDigits: hasFraction ? 2 : 0,
  }).format(safeCents / 100);
}

/** Signed money — “+£12” / “−£12” / “£0” — for variances and net payable. */
export function signedMoney(cents: number, currencyCode: string): string {
  const sign = cents > 0 ? '+' : cents < 0 ? '−' : '';
  return `${sign}${formatMoney(Math.abs(cents), currencyCode)}`;
}

/** Clamp a percentage to the 0–100 range for progress-bar fills. */
export function clampPercent(percent: number): number {
  if (!Number.isFinite(percent)) return 0;
  return Math.max(0, Math.min(100, percent));
}

/** Short label for a commission tier. */
export function tierLabel(tier: CommissionTier): string {
  switch (tier) {
    case 'below_3x':
      return 'Below 3×';
    case 'tier_3x':
      return '3× (10%)';
    case 'tier_3_5x':
      return '3.5× (15%)';
    case 'tier_3_5x_unlocked':
      return '3.5× unlocked (30%)';
    default:
      return tier;
  }
}

/** Human-readable label for a KPI data-quality note flag. */
export function noteLabel(note: KpiDataNote): string {
  switch (note) {
    case 'no_hours_worked':
      return 'No rostered hours this period';
    case 'no_completed_visits':
      return 'No completed visits yet';
    case 'missing_benchmark':
      return 'No average-bill benchmark set';
    case 'retail_attribution_approximate':
      return 'Retail figures are approximate';
    default:
      return note;
  }
}
