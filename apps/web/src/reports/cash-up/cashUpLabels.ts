/**
 * R7 Cash Up wording and formatting. Formatting only: every figure arrives
 * computed from the API, and nothing here adds, subtracts or derives money.
 * An unavailable figure or a missing cash-up is words, never £0.00.
 */
import type {
  CashUpAmount,
  CashUpCount,
  CashUpDayRow,
  CashUpUnavailableReason,
  MoneyAmount,
  MoneyUnavailableReason,
} from '@sheer/domain';
import { formatMoneyAmount } from '../money/moneyLabels';

type CashUpOnlyReason = Exclude<CashUpUnavailableReason, MoneyUnavailableReason>;

const CASH_UP_TEXT: Record<CashUpOnlyReason, string> = {
  not_signed_off: 'Not signed off',
  london_trading_day: 'Not comparable (London trading day)',
  currency_mismatch: 'Not comparable (currency)',
  threshold_not_set: 'No threshold set',
};

function isCashUpOnly(reason: CashUpUnavailableReason): reason is CashUpOnlyReason {
  return reason in CASH_UP_TEXT;
}

/** `currencyCode` is the figure's own currency, from the API; there is no default. */
export function formatCashUpAmount(amount: CashUpAmount, currencyCode: string | null): string {
  if (amount.availability === 'unavailable' && isCashUpOnly(amount.reason)) return CASH_UP_TEXT[amount.reason];
  return formatMoneyAmount(amount as MoneyAmount, currencyCode);
}

/** Refunds and voids are manual entries whose zero can't be told apart from "not entered". */
export function formatEntered(amount: CashUpAmount, currencyCode: string | null): string {
  if (amount.availability === 'available' && amount.cents === 0) return 'None entered';
  return formatCashUpAmount(amount, currencyCode);
}

export function formatCount(count: CashUpCount): string {
  if (count.availability === 'available') return String(count.count);
  return isCashUpOnly(count.reason) ? CASH_UP_TEXT[count.reason] : formatMoneyAmount({ availability: 'unavailable', reason: count.reason }, null);
}

export function dayStatusLabel(row: Pick<CashUpDayRow, 'status' | 'isToday'>): string {
  switch (row.status) {
    case 'signed_off':
      return 'Signed off';
    case 'open':
      return row.isToday ? 'In progress (not signed off)' : 'Not signed off';
    case 'none':
      return row.isToday ? 'Not cashed up yet' : 'No cash-up recorded';
  }
}

export function thresholdLabel(outsideThreshold: boolean | null): string {
  if (outsideThreshold === null) return '—';
  return outsideThreshold ? 'Outside' : 'Within';
}
