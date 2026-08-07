/**
 * Presentation helpers shared by the My pay screens. Formatting only — every
 * figure comes from the payroll API; nothing here computes pay.
 */

import type { PayPeriodStatus } from '@sheer/domain';

/**
 * Stylist-facing status wording. Only approved/locked/paid periods ever reach
 * the self-view screens; "locked" is an internal workflow step, so both
 * pre-payment states read as Confirmed.
 */
export const PAY_STATUS_LABELS: Record<PayPeriodStatus, string> = {
  draft: 'Draft',
  ready_for_review: 'In review',
  approved: 'Confirmed',
  locked: 'Confirmed',
  paid: 'Paid',
};

export function formatMoney(cents: number, currencyCode: string): string {
  const safe = Number.isFinite(cents) ? Math.round(cents) : 0;
  const hasFraction = safe % 100 !== 0;
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: currencyCode || 'GBP',
    minimumFractionDigits: hasFraction ? 2 : 0,
    maximumFractionDigits: hasFraction ? 2 : 0,
  }).format(safe / 100);
}

export function formatHours(hours: number): string {
  return `${Number.isInteger(hours) ? hours : hours.toFixed(1)}h`;
}

/**
 * "27 Jul – 2 Aug 2026" from an inclusive start and an EXCLUSIVE end date.
 * Parsed via Date.UTC so a DST boundary can never shift the label by a day.
 */
export function periodWindowLabel(periodStart: string, periodEndExclusive: string): string {
  const start = parseUtcDate(periodStart);
  const endExclusive = parseUtcDate(periodEndExclusive);
  if (!start || !endExclusive) return `${periodStart} – ${periodEndExclusive}`;
  const end = new Date(endExclusive.getTime() - 24 * 60 * 60 * 1000);
  const sameYear = start.getUTCFullYear() === end.getUTCFullYear();
  const startLabel = start.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: sameYear ? undefined : 'numeric',
    timeZone: 'UTC',
  });
  const endLabel = end.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
  return `${startLabel} – ${endLabel}`;
}

function parseUtcDate(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
}
