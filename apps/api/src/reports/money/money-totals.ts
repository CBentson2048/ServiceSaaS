/**
 * R1 Money arithmetic: facts in, figures out. Pure — no I/O, no clock.
 *
 * Reconciliation is built in, not checked afterwards:
 * - composition = one figure per line type + not itemised, which is each bill's
 *   gross minus its own lines, so composition always sums to paid bill gross;
 * - settlement = cash + card reader + deposits applied + not itemised, which is
 *   each bill's gross minus its payments and deposit, so it too sums to gross;
 * - retail by method always sums to retail sales recorded.
 * docs/V1.1/week-8-ticket-b-r1-money.md §3.
 */
import type {
  MoneyAmount,
  MoneyBillComponentKey,
  MoneyRetailMethodKey,
  MoneySettlementKey,
  MoneyTotals,
  MoneyUnavailableReason,
} from '@sheer/domain';
import type { BillLineRow, BillLineType, DepositEventRow, PaidBillRow, RetailSaleRow, TillPaymentRow } from './money-source';

export interface BillFacts {
  bill: PaidBillRow;
  lines: readonly BillLineRow[];
  payments: readonly TillPaymentRow[];
}

/** Everything R1 needs for one location (or for the whole scope). */
export interface MoneyFacts {
  bills: readonly BillFacts[];
  retail: readonly RetailSaleRow[];
  depositsCollected: readonly DepositEventRow[];
  depositsRefunded: readonly DepositEventRow[];
}

export const EMPTY_FACTS: MoneyFacts = { bills: [], retail: [], depositsCollected: [], depositsRefunded: [] };

const ALWAYS_LISTED: readonly BillLineType[] = ['service', 'product_usage', 'adjustment'];
const LISTED_WHEN_PRESENT: readonly BillLineType[] = ['retail', 'deposit_credit', 'discount'];
const SETTLEMENT_KEYS: readonly MoneySettlementKey[] = ['cash', 'card_reader', 'deposits_applied', 'not_itemised'];
const RETAIL_METHOD_KEYS: readonly MoneyRetailMethodKey[] = ['cash', 'card_reader', 'other', 'not_recorded'];

interface Tally {
  gross: number;
  net: number;
  tax: number;
  lineGross: Map<BillLineType, number>;
  notItemised: number;
  colour: { gross: number; net: number; tax: number };
  cash: number;
  cardReader: number;
  depositsApplied: number;
  settlementNotItemised: number;
  retail: number;
  retailByMethod: Map<MoneyRetailMethodKey, number>;
  collected: number;
  refunded: number;
  partialRefundInScope: boolean;
}

/** Per-bill figures, shared by the totals and the detail rows. */
export function billFigures(facts: BillFacts): {
  colour: { gross: number; net: number; tax: number };
  cash: number;
  cardReader: number;
  lineGross: Map<BillLineType, number>;
} {
  const colour = { gross: 0, net: 0, tax: 0 };
  const lineGross = new Map<BillLineType, number>();
  for (const line of facts.lines) {
    lineGross.set(line.lineType, (lineGross.get(line.lineType) ?? 0) + line.grossCents);
    if (line.lineType === 'product_usage') {
      colour.gross += line.grossCents;
      colour.net += line.netCents;
      colour.tax += line.taxCents;
    }
  }
  let cash = 0;
  let cardReader = 0;
  for (const payment of facts.payments) {
    if (payment.method === 'cash') cash += payment.amountCents;
    else cardReader += payment.amountCents;
  }
  return { colour, cash, cardReader, lineGross };
}

function tally(facts: MoneyFacts): Tally {
  const t: Tally = {
    gross: 0,
    net: 0,
    tax: 0,
    lineGross: new Map(),
    notItemised: 0,
    colour: { gross: 0, net: 0, tax: 0 },
    cash: 0,
    cardReader: 0,
    depositsApplied: 0,
    settlementNotItemised: 0,
    retail: 0,
    retailByMethod: new Map(),
    collected: 0,
    refunded: 0,
    partialRefundInScope: false,
  };
  for (const billFacts of facts.bills) {
    const { bill } = billFacts;
    const figures = billFigures(billFacts);
    t.gross += bill.grossCents;
    t.net += bill.netCents;
    t.tax += bill.taxCents;
    let linesGross = 0;
    for (const [type, gross] of figures.lineGross) {
      t.lineGross.set(type, (t.lineGross.get(type) ?? 0) + gross);
      linesGross += gross;
    }
    t.notItemised += bill.grossCents - linesGross;
    t.colour.gross += figures.colour.gross;
    t.colour.net += figures.colour.net;
    t.colour.tax += figures.colour.tax;
    t.cash += figures.cash;
    t.cardReader += figures.cardReader;
    t.depositsApplied += bill.depositAppliedCents;
    t.settlementNotItemised += bill.grossCents - figures.cash - figures.cardReader - bill.depositAppliedCents;
  }
  for (const sale of facts.retail) {
    t.retail += sale.totalCents;
    t.retailByMethod.set(sale.method, (t.retailByMethod.get(sale.method) ?? 0) + sale.totalCents);
  }
  for (const deposit of facts.depositsCollected) t.collected += deposit.amountCents;
  for (const deposit of facts.depositsRefunded) {
    if (deposit.status === 'partially_refunded') t.partialRefundInScope = true;
    else t.refunded += deposit.amountCents;
  }
  return t;
}

/** Every currency the facts carry, payments included. */
export function currenciesOf(facts: MoneyFacts): Set<string> {
  const codes = new Set<string>();
  for (const { bill, payments } of facts.bills) {
    codes.add(bill.currencyCode);
    for (const payment of payments) codes.add(payment.currencyCode);
  }
  for (const row of [...facts.retail, ...facts.depositsCollected, ...facts.depositsRefunded]) codes.add(row.currencyCode);
  return codes;
}

const UNAVAILABLE = (reason: MoneyUnavailableReason): MoneyAmount => ({ availability: 'unavailable', reason });
const NOT_STARTED: MoneyAmount = { availability: 'not_started' };

/**
 * The figures for a set of facts. `null` means no scoped window has started:
 * every measurable figure is then Not started, never zero.
 */
export function moneyTotals(facts: MoneyFacts | null): MoneyTotals {
  const mixed = facts !== null && currenciesOf(facts).size > 1;
  const t = facts === null ? null : tally(facts);
  const amount = (cents: (tally: Tally) => number): MoneyAmount => {
    if (t === null) return NOT_STARTED;
    if (mixed) return UNAVAILABLE('mixed_currencies');
    return { availability: 'available', cents: cents(t) };
  };

  const listed: BillLineType[] = [...ALWAYS_LISTED, ...LISTED_WHEN_PRESENT.filter((type) => t?.lineGross.has(type))];
  const composition: Array<{ key: MoneyBillComponentKey; gross: MoneyAmount }> = [
    ...listed.map((type) => ({ key: type as MoneyBillComponentKey, gross: amount((x) => x.lineGross.get(type) ?? 0) })),
    { key: 'not_itemised', gross: amount((x) => x.notItemised) },
  ];

  const settlementCents: Record<MoneySettlementKey, (x: Tally) => number> = {
    cash: (x) => x.cash,
    card_reader: (x) => x.cardReader,
    deposits_applied: (x) => x.depositsApplied,
    not_itemised: (x) => x.settlementNotItemised,
  };

  let refunded: MoneyAmount;
  if (t === null) refunded = NOT_STARTED;
  else if (mixed) refunded = UNAVAILABLE('mixed_currencies');
  else if (t.partialRefundInScope) refunded = UNAVAILABLE('partial_refund_amount_not_recorded');
  else refunded = { availability: 'available', cents: t.refunded };

  return {
    paidBills: { gross: amount((x) => x.gross), netOfVat: amount((x) => x.net), vat: amount((x) => x.tax) },
    composition,
    colour: {
      gross: amount((x) => x.colour.gross),
      netOfVat: amount((x) => x.colour.net),
      vat: amount((x) => x.colour.tax),
    },
    settlement: SETTLEMENT_KEYS.map((key) => ({ key, amount: amount(settlementCents[key]) })),
    retail: {
      recorded: amount((x) => x.retail),
      vat: UNAVAILABLE('not_captured'),
      byMethod: RETAIL_METHOD_KEYS.map((key) => ({ key, amount: amount((x) => x.retailByMethod.get(key) ?? 0) })),
    },
    deposits: {
      collected: amount((x) => x.collected),
      redeemed: amount((x) => x.depositsApplied),
      refunded,
    },
    netPosition: UNAVAILABLE('definition_pending'),
  };
}

/** Concatenate facts (e.g. the started locations, for the summary). */
export function combineFacts(all: readonly MoneyFacts[]): MoneyFacts {
  return {
    bills: all.flatMap((facts) => facts.bills),
    retail: all.flatMap((facts) => facts.retail),
    depositsCollected: all.flatMap((facts) => facts.depositsCollected),
    depositsRefunded: all.flatMap((facts) => facts.depositsRefunded),
  };
}
