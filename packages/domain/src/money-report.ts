/**
 * R1 Money report body (QLOOQO V1.1 Week 8, Ticket B).
 *
 * Money as QLOOQO recorded it, per location and per that location's own report
 * window. Every figure is computed by the API; the web only formats. A category
 * QLOOQO does not record is an explicit unavailable amount, never zero.
 * Decision record: docs/V1.1/week-8-ticket-b-r1-money.md.
 *
 * Browser-safe: types only, no clock, no Intl.
 */
import type { LocalDate } from './local-date';

export type MoneyUnavailableReason =
  /** QLOOQO has no reliable source for this figure. */
  | 'not_captured'
  /** The scoped facts carry more than one currency, so they are not summed. */
  | 'mixed_currencies'
  /** A partially refunded deposit is in scope and its refund amount is not stored. */
  | 'partial_refund_amount_not_recorded'
  /** No approved product definition exists yet. */
  | 'definition_pending';

export type MoneyAmount =
  | { availability: 'available'; cents: number }
  | { availability: 'unavailable'; reason: MoneyUnavailableReason }
  /** Every scoped location's window is still in the future. */
  | { availability: 'not_started' };

export interface MoneyVatBreakdown {
  gross: MoneyAmount;
  /** The stored ex-VAT snapshot. Not a net position and not profit. */
  netOfVat: MoneyAmount;
  vat: MoneyAmount;
}

/**
 * What paid bills were made of. Each key is a recorded bill line type, plus
 * `not_itemised` for any part of a bill's gross its lines do not cover. The
 * figures always sum to paid bill gross.
 */
export type MoneyBillComponentKey =
  | 'service'
  /** The QLAB colour charge. Inside the bill total; never added to it. */
  | 'product_usage'
  /** Ledger reconciliation on a bill: VAT 0, may be negative. */
  | 'adjustment'
  | 'retail'
  | 'deposit_credit'
  | 'discount'
  | 'not_itemised';

/** How paid bills were settled. Always sums to paid bill gross. */
export type MoneySettlementKey = 'cash' | 'card_reader' | 'deposits_applied' | 'not_itemised';

/** Tender recorded on retail sales. Always sums to retail sales recorded. */
export type MoneyRetailMethodKey = 'cash' | 'card_reader' | 'other' | 'not_recorded';

export interface MoneyTotals {
  paidBills: MoneyVatBreakdown;
  /** Always lists service, product_usage, adjustment and not_itemised; other line types only when present. */
  composition: Array<{ key: MoneyBillComponentKey; gross: MoneyAmount }>;
  /** The product_usage lines of paid bills: a breakdown of paid bill revenue. */
  colour: MoneyVatBreakdown;
  settlement: Array<{ key: MoneySettlementKey; amount: MoneyAmount }>;
  retail: {
    /** Σ retail sale totals as recorded. Separate from paid bill revenue. */
    recorded: MoneyAmount;
    /** Always unavailable: retail sales carry no VAT fields. */
    vat: MoneyAmount;
    byMethod: Array<{ key: MoneyRetailMethodKey; amount: MoneyAmount }>;
  };
  /** Three separate events. Never netted against each other or against revenue. */
  deposits: {
    /** Deposits whose payment was recorded in the window, whatever happened later. */
    collected: MoneyAmount;
    /** Deposits applied to paid bills in the window (inside paid bill gross). */
    redeemed: MoneyAmount;
    /** Full deposit refunds made in QLOOQO in the window. */
    refunded: MoneyAmount;
  };
  /** Always unavailable until a net position is defined by the product owner. */
  netPosition: MoneyAmount;
}

export interface MoneyLocationTotals {
  locationId: string;
  totals: MoneyTotals;
}

/** Categories QLOOQO does not record. Always listed; never rendered as a number. */
export type MoneyNotRecordedCategory =
  | 'discounts'
  | 'till_refunds'
  | 'voids'
  | 'tips'
  | 'retail_vat'
  | 'forfeited_deposits'
  | 'outside_deposit_refunds';

export const MONEY_NOT_RECORDED_CATEGORIES: readonly MoneyNotRecordedCategory[] = [
  'discounts',
  'till_refunds',
  'voids',
  'tips',
  'retail_vat',
  'forfeited_deposits',
  'outside_deposit_refunds',
];

export interface MoneyCoverage {
  /**
   * Till payments recorded in the window whose visit has no paid bill snapshot.
   * Real money that is not (yet) in paid bill revenue.
   */
  tillPaymentsWithoutBill: { count: number; amount: MoneyAmount };
}

export type MoneyDetailRowKind = 'paid_bill' | 'retail_sale' | 'deposit_collected' | 'deposit_refunded';

interface MoneyDetailRowBase {
  /** Stable, unique across kinds. */
  rowKey: string;
  locationId: string;
  /** The location's local calendar date of the event. */
  localDate: LocalDate;
  /** The location's local wall-clock time, `HH:MM` (24h). */
  localTime: string;
  /** The row's own currency (rows are never converted or summed across currencies). */
  currencyCode: string;
  amount: MoneyAmount;
}

export type MoneyDetailRow =
  | (MoneyDetailRowBase & {
      kind: 'paid_bill';
      billNumber: number;
      netOfVat: MoneyAmount;
      vat: MoneyAmount;
      colour: MoneyAmount;
      cash: MoneyAmount;
      cardReader: MoneyAmount;
      depositApplied: MoneyAmount;
    })
  | (MoneyDetailRowBase & { kind: 'retail_sale'; quantity: number; method: MoneyRetailMethodKey })
  | (MoneyDetailRowBase & { kind: 'deposit_collected' })
  | (MoneyDetailRowBase & { kind: 'deposit_refunded' });

export interface MoneyDetailPage {
  rows: MoneyDetailRow[];
  /** Opaque. Pass back as `cursor` with the same filter for the next page; `null` at the end. */
  nextCursor: string | null;
}

export interface MoneyReportBody {
  /** The single currency of the scoped facts; `null` when there are none or they are mixed. */
  currencyCode: string | null;
  summary: MoneyTotals;
  /** One per resolved location, in the same order. Additive figures sum to the summary. */
  locations: MoneyLocationTotals[];
  notRecorded: MoneyNotRecordedCategory[];
  coverage: MoneyCoverage;
  /** Present when the request asked for the detail view. */
  detail: MoneyDetailPage | null;
}

/** Detail rows per page. */
export const MONEY_DETAIL_PAGE_SIZE = 50;
