/**
 * R1 Money wording and formatting. Formatting only: every figure arrives
 * computed from the API, and nothing here adds, subtracts or derives money.
 * An unavailable figure is words, never £0.00.
 */
import type {
  MoneyAmount,
  MoneyBillComponentKey,
  MoneyDetailRowKind,
  MoneyNotRecordedCategory,
  MoneyRetailMethodKey,
  MoneySettlementKey,
  MoneyUnavailableReason,
} from '@sheer/domain';
import { formatCurrency } from '@sheer/utils';

export const NOT_RECORDED = 'Not recorded';
export const NOT_STARTED = 'Not started';

const UNAVAILABLE_TEXT: Record<MoneyUnavailableReason, string> = {
  not_captured: NOT_RECORDED,
  mixed_currencies: 'Not totalled (mixed currencies)',
  partial_refund_amount_not_recorded: 'Not recorded (partial refund amount)',
  definition_pending: 'Definition pending',
};

/**
 * `currencyCode` is the figure's own currency. It is null only when there are
 * no facts at all, where every available figure is a genuine zero; the
 * platform's default currency is used to write that zero.
 */
export function formatMoneyAmount(amount: MoneyAmount, currencyCode: string | null): string {
  switch (amount.availability) {
    case 'available':
      return formatCurrency(amount.cents, { currency: currencyCode ?? 'GBP', minorUnits: true });
    case 'unavailable':
      return UNAVAILABLE_TEXT[amount.reason];
    case 'not_started':
      return NOT_STARTED;
  }
}

export const COMPOSITION_LABELS: Record<MoneyBillComponentKey, string> = {
  service: 'Services',
  product_usage: 'Colour (product use)',
  adjustment: 'Till reconciliation adjustments',
  retail: 'Retail lines on bills',
  deposit_credit: 'Deposit credit lines',
  discount: 'Discount lines',
  not_itemised: 'Not itemised',
};

export const SETTLEMENT_LABELS: Record<MoneySettlementKey, string> = {
  cash: 'Cash',
  card_reader: 'Card reader',
  deposits_applied: 'Deposits applied',
  not_itemised: 'Not itemised',
};

export const RETAIL_METHOD_LABELS: Record<MoneyRetailMethodKey, string> = {
  cash: 'Cash',
  card_reader: 'Card reader',
  other: 'Other',
  not_recorded: 'Method not recorded',
};

export const NOT_RECORDED_LABELS: Record<MoneyNotRecordedCategory, string> = {
  discounts: 'Discounts',
  till_refunds: 'Till refunds',
  voids: 'Voids',
  tips: 'Tips',
  retail_vat: 'VAT on retail sales',
  forfeited_deposits: 'Forfeited deposits',
  outside_deposit_refunds: 'Deposit refunds made outside QLOOQO',
};

export const DETAIL_KIND_LABELS: Record<MoneyDetailRowKind, string> = {
  paid_bill: 'Paid bill',
  retail_sale: 'Retail sale',
  deposit_collected: 'Deposit collected',
  deposit_refunded: 'Deposit refunded',
};
