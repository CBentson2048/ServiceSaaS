import type { PayPeriod, PayPeriodStatus } from '@sheer/domain';
import type { StatusTone } from '../../design';

/**
 * Presentation helpers shared by the payroll review pages. Period boundaries
 * arrive as local 'YYYY-MM-DD' strings with an EXCLUSIVE periodEnd (matching
 * the DB), so display windows subtract one day. Dates are parsed through
 * Date.UTC and rendered in UTC so a DST boundary inside the period can never
 * shift a label by a day.
 */

export const PAY_PERIOD_STATUS_TONES: Record<PayPeriodStatus, StatusTone> = {
  draft: 'neutral',
  ready_for_review: 'warning',
  approved: 'success',
  locked: 'success',
  paid: 'success',
};

function parseLocalDate(iso: string, addDays = 0): Date | null {
  const [year, month, day] = iso.split('-').map(Number);
  if (!year || !month || !day) return null;
  return new Date(Date.UTC(year, month - 1, day + addDays));
}

function formatDay(date: Date): string {
  return date.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/** "1 Jul 2026 – 31 Jul 2026" — periodEnd is exclusive, so display end − 1 day. */
export function payPeriodWindowLabel(period: Pick<PayPeriod, 'periodStart' | 'periodEnd'>): string {
  const start = parseLocalDate(period.periodStart);
  const endInclusive = parseLocalDate(period.periodEnd, -1);
  if (!start || !endInclusive) return `${period.periodStart} – ${period.periodEnd}`;
  return `${formatDay(start)} – ${formatDay(endInclusive)}`;
}

/** A single local 'YYYY-MM-DD' service date, e.g. on itemised lines. */
export function formatLocalDate(iso: string): string {
  const date = parseLocalDate(iso);
  return date ? formatDay(date) : iso;
}

/** Today's LOCAL calendar date as YYYY-MM-DD (not UTC — periods are local-date bounded). */
export function todayLocalIso(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

/** Lifecycle timestamps (generated/approved/locked/paid) with NaN guard. */
export function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatHours(hours: number): string {
  return `${Number.isInteger(hours) ? hours : hours.toFixed(1)}h`;
}
