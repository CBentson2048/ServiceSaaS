/**
 * In-memory MoneySource for tests. It applies the same predicates as
 * SupabaseMoneySource — business, status, each location inside its own window,
 * (instant, id) ordering and keyset starts — so a hand-built ledger can be
 * reconciled against the report. The adapter's query shapes are pinned
 * separately in money-source.spec.ts.
 *
 * `serverCap` imitates PostgREST's max-rows: a read never returns more rows
 * than the cap, whatever limit was asked for.
 */
import type {
  BillLineRow,
  DepositEventRow,
  DepositEventStatus,
  MoneyAfter,
  MoneySource,
  MoneyWindow,
  PaidBillRow,
  RetailSaleRow,
  TillPaymentRow,
  WindowTillPaymentRow,
} from '../money-source';

export interface LedgerBill extends PaidBillRow {
  businessId: string;
  status: 'paid' | 'voided';
}
export interface LedgerLine extends BillLineRow {}
export interface LedgerPayment extends TillPaymentRow {
  businessId: string;
  locationId: string;
  at: string;
}
export interface LedgerRetailSale extends RetailSaleRow {
  businessId: string;
}
export interface LedgerDeposit {
  id: string;
  businessId: string;
  locationId: string;
  amountCents: number;
  status: DepositEventStatus;
  paidAt: string | null;
  refundedAt: string | null;
  currencyCode: string;
}

/** A location's resolved configured currency (the adapter's settings → business-default precedence is pinned in money-source.spec.ts). */
export interface LedgerLocation {
  id: string;
  businessId: string;
  /** `null`: the currency cannot be determined. */
  currencyCode: string | null;
}

export interface Ledger {
  bills: LedgerBill[];
  lines: LedgerLine[];
  payments: LedgerPayment[];
  retail: LedgerRetailSale[];
  deposits: LedgerDeposit[];
  /** Locations with no entry have no determinable currency. */
  locations?: LedgerLocation[];
}

/** Microseconds since the epoch for an instant key or a window bound (five-digit years included). */
export function micros(value: string): bigint {
  const match = /^(\d{4,5})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{3,6})Z$/.exec(value);
  if (!match) throw new Error(`not an instant: ${value}`);
  const [, y, mo, d, h, mi, s, frac] = match;
  const ms = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
  return BigInt(ms) * 1000n + BigInt(frac.padEnd(6, '0'));
}

function inWindows(at: string, locationId: string, windows: readonly MoneyWindow[]): boolean {
  const t = micros(at);
  return windows.some((w) => w.locationId === locationId && t >= micros(w.fromUtc) && t < micros(w.toUtcExclusive));
}

function afterKeyset(at: string, id: string, after: MoneyAfter | null): boolean {
  if (after === null) return true;
  const t = micros(at);
  const k = micros(after.key);
  if ('id' in after) return t > k || (t === k && id > after.id);
  return after.op === 'gt' ? t > k : t >= k;
}

function byInstantThenId<T extends { at: string; id: string }>(a: T, b: T): number {
  const ta = micros(a.at);
  const tb = micros(b.at);
  if (ta !== tb) return ta < tb ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export interface ReadLog {
  method: keyof MoneySource;
  businessId?: string;
  windows?: readonly MoneyWindow[];
  after?: MoneyAfter | null;
  ids?: readonly string[];
  limit?: number;
}

export class MemoryMoneySource implements MoneySource {
  readonly reads: ReadLog[] = [];

  constructor(
    private readonly ledger: Ledger,
    private readonly serverCap = Number.POSITIVE_INFINITY,
  ) {}

  private take<T>(rows: T[], limit: number): T[] {
    return rows.slice(0, Math.min(limit, this.serverCap));
  }

  async paidBills(businessId: string, windows: readonly MoneyWindow[], after: MoneyAfter | null, limit: number): Promise<PaidBillRow[]> {
    this.reads.push({ method: 'paidBills', businessId, windows, after, limit });
    const rows = this.ledger.bills
      .filter((b) => b.businessId === businessId && b.status === 'paid' && inWindows(b.at, b.locationId, windows) && afterKeyset(b.at, b.id, after))
      .sort(byInstantThenId);
    return this.take(rows, limit).map(({ businessId: _b, status: _s, ...row }) => row);
  }

  async billLines(billIds: readonly string[], afterId: string | null, limit: number): Promise<BillLineRow[]> {
    this.reads.push({ method: 'billLines', ids: billIds, limit });
    const rows = this.ledger.lines
      .filter((l) => billIds.includes(l.billId) && (afterId === null || l.id > afterId))
      .sort((a, b) => (a.id < b.id ? -1 : 1));
    return this.take(rows, limit);
  }

  async tillPaymentsForVisits(businessId: string, visitIds: readonly string[], afterId: string | null, limit: number): Promise<TillPaymentRow[]> {
    this.reads.push({ method: 'tillPaymentsForVisits', businessId, ids: visitIds, limit });
    const rows = this.ledger.payments
      .filter((p) => p.businessId === businessId && visitIds.includes(p.visitId) && (afterId === null || p.id > afterId))
      .sort((a, b) => (a.id < b.id ? -1 : 1));
    return this.take(rows, limit).map(({ id, visitId, method, amountCents, currencyCode }) => ({ id, visitId, method, amountCents, currencyCode }));
  }

  async tillPaymentsInWindows(businessId: string, windows: readonly MoneyWindow[], after: MoneyAfter | null, limit: number): Promise<WindowTillPaymentRow[]> {
    this.reads.push({ method: 'tillPaymentsInWindows', businessId, windows, after, limit });
    const rows = this.ledger.payments
      .filter((p) => p.businessId === businessId && inWindows(p.at, p.locationId, windows) && afterKeyset(p.at, p.id, after))
      .sort(byInstantThenId);
    return this.take(rows, limit).map(({ businessId: _b, ...row }) => row);
  }

  async visitsWithPaidBill(businessId: string, visitIds: readonly string[]): Promise<Set<string>> {
    this.reads.push({ method: 'visitsWithPaidBill', businessId, ids: visitIds });
    return new Set(
      this.ledger.bills.filter((b) => b.businessId === businessId && b.status === 'paid' && visitIds.includes(b.visitId)).map((b) => b.visitId),
    );
  }

  async retailSales(businessId: string, windows: readonly MoneyWindow[], after: MoneyAfter | null, limit: number): Promise<RetailSaleRow[]> {
    this.reads.push({ method: 'retailSales', businessId, windows, after, limit });
    const rows = this.ledger.retail
      .filter((r) => r.businessId === businessId && inWindows(r.at, r.locationId, windows) && afterKeyset(r.at, r.id, after))
      .sort(byInstantThenId);
    return this.take(rows, limit).map(({ businessId: _b, ...row }) => row);
  }

  async depositsCollected(businessId: string, windows: readonly MoneyWindow[], after: MoneyAfter | null, limit: number): Promise<DepositEventRow[]> {
    this.reads.push({ method: 'depositsCollected', businessId, windows, after, limit });
    return this.depositEvents('paidAt', ['paid', 'partially_refunded', 'refunded'], businessId, windows, after, limit);
  }

  async depositsRefunded(businessId: string, windows: readonly MoneyWindow[], after: MoneyAfter | null, limit: number): Promise<DepositEventRow[]> {
    this.reads.push({ method: 'depositsRefunded', businessId, windows, after, limit });
    return this.depositEvents('refundedAt', null, businessId, windows, after, limit);
  }

  async locationCurrencies(businessId: string, locationIds: readonly string[]): Promise<Map<string, string>> {
    this.reads.push({ method: 'locationCurrencies', businessId, ids: locationIds });
    const currencies = new Map<string, string>();
    for (const location of this.ledger.locations ?? []) {
      if (location.businessId === businessId && locationIds.includes(location.id) && location.currencyCode !== null) {
        currencies.set(location.id, location.currencyCode);
      }
    }
    return currencies;
  }

  private depositEvents(
    column: 'paidAt' | 'refundedAt',
    statuses: readonly string[] | null,
    businessId: string,
    windows: readonly MoneyWindow[],
    after: MoneyAfter | null,
    limit: number,
  ): DepositEventRow[] {
    const rows = this.ledger.deposits
      .filter((d): d is LedgerDeposit & Record<typeof column, string> => d[column] !== null)
      .filter((d) => d.businessId === businessId && (statuses === null || statuses.includes(d.status)))
      .map((d) => ({ id: d.id, locationId: d.locationId, at: d[column], amountCents: d.amountCents, status: d.status, currencyCode: d.currencyCode }))
      .filter((d) => inWindows(d.at, d.locationId, windows) && afterKeyset(d.at, d.id, after))
      .sort(byInstantThenId);
    return this.take(rows, limit);
  }
}
