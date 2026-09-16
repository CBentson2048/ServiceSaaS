/**
 * R7 Cash Up wording and formatting. Formatting only: every figure arrives
 * computed from the API, and nothing here adds, subtracts or derives money.
 * An unavailable figure or a missing cash-up is words, never £0.00.
 */
import type {
  CashUpAmount,
  CashUpCount,
  CashUpDayRow,
  CashUpThresholdCheck,
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
  return Object.prototype.hasOwnProperty.call(CASH_UP_TEXT, reason);
}

/** `currencyCode` is the figure's own currency, from the API; there is no default. */
export function formatCashUpAmount(amount: CashUpAmount, currencyCode: string | null): string {
  if (amount.availability === 'unavailable' && isCashUpOnly(amount.reason)) return CASH_UP_TEXT[amount.reason];
  return formatMoneyAmount(amount as MoneyAmount, currencyCode);
}

/**
 * Refunds, voids and the opening float are typed in on End of Day, and the column
 * stores zero when nothing is typed. A stored zero can't show whether anyone
 * entered zero, so it reads "£0.00 recorded" — never "None entered", which would
 * claim no entry was made. A non-zero value can only come from an entry.
 */
export function formatManualEntry(amount: CashUpAmount, currencyCode: string | null): string {
  const text = formatCashUpAmount(amount, currencyCode);
  return amount.availability === 'available' && amount.cents === 0 ? `${text} recorded` : text;
}

export const MANUAL_ENTRY_NOTE =
  'Refunds, voids and the opening float are typed in on End of Day, and zero is stored when nothing is typed. A zero marked “recorded” can’t show whether anyone entered it.';

export const CURRENT_THRESHOLD_NOTE =
  'Days outside the current threshold compare each day’s variance with the location’s threshold as it is now. The threshold in force at sign-off was not stored, so it may have been different.';

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

const THRESHOLD_TEXT: Record<CashUpThresholdCheck, string> = {
  within: 'Within',
  outside: 'Outside',
  not_signed_off: 'Not signed off',
  no_threshold: 'No threshold set',
  not_comparable: 'Not comparable',
};

export function thresholdLabel(check: CashUpThresholdCheck): string {
  return THRESHOLD_TEXT[check];
}

const EXCLUDED_TEXT: Partial<Record<CashUpUnavailableReason, string>> = {
  london_trading_day: 'End of Day used a London trading day for the location',
  currency_mismatch: 'the cash-up is stored in another currency than the location’s',
  currency_not_recorded: 'the location has no currency set',
  mixed_currencies: 'the location’s takings are in more than one currency',
  not_captured: 'a stored figure is missing',
};

/** Why signed-off days were left out of the recorded figures, in words. */
export function excludedDaysNote(days: number, reasons: readonly CashUpUnavailableReason[]): string {
  const why = reasons.map((reason) => EXCLUDED_TEXT[reason] ?? 'a figure can’t be stated').join('; ');
  return days === 1
    ? `1 signed-off day is not included in these figures: ${why}.`
    : `${days} signed-off days are not included in these figures: ${why}.`;
}
