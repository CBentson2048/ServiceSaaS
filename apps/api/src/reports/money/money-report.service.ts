/**
 * R1 Money report body (V1.1 Week 8, Ticket B).
 *
 * Built on a Ticket A ReportScope: the actor, the resolved locations and one
 * window per location. It never recomputes a date — each location's facts are
 * read inside that location's own window — and a window that has not started
 * contributes nothing and renders Not started.
 * docs/V1.1/week-8-ticket-b-r1-money.md.
 */
import { Inject, Injectable, InternalServerErrorException } from '@nestjs/common';
import {
  MONEY_DETAIL_PAGE_SIZE,
  MONEY_NOT_RECORDED_CATEGORIES,
  type MoneyAmount,
  type MoneyDetailPage,
  type MoneyDetailRow,
  type MoneyReportBody,
} from '@sheer/domain';
import { reportHttpError } from '../report-errors';
import type { ReportScope } from '../report-scope.service';
import {
  DETAIL_KIND_RANK,
  decodeDetailCursor,
  encodeDetailCursor,
  keysetAfter,
  mergeDetailPage,
  type DetailPosition,
} from './money-detail';
import {
  MONEY_SOURCE,
  type BillLineRow,
  type MoneyAfter,
  type MoneySource,
  type MoneyWindow,
  type PaidBillRow,
  type TillPaymentRow,
  type WindowTillPaymentRow,
} from './money-source';
import { EMPTY_FACTS, billFigures, combineFacts, currenciesOf, moneyTotals, type BillFacts, type MoneyFacts } from './money-totals';
import { localDateTime } from './money-values';

/** Rows per keyset read. Reads continue until a read returns no rows, so a lower server cap can never truncate. */
export const MONEY_READ_BATCH = 1000;
/** Ids per `in` filter. */
export const MONEY_ID_CHUNK = 150;
/**
 * Locations per windowed read. Each location adds its own window (and keyset)
 * clause to the request URL, so reads are split to keep URLs well inside common
 * request-line limits (about 3.7 KB at 10 locations with a keyset).
 */
export const MONEY_LOCATION_CHUNK = 10;

export interface MoneyBuildRequest {
  /** From `?cursor=`; only valid with the detail view. */
  cursor: string | null;
}

@Injectable()
export class MoneyReportService {
  constructor(@Inject(MONEY_SOURCE) private readonly source: MoneySource) {}

  async build(scope: ReportScope, request: MoneyBuildRequest): Promise<MoneyReportBody> {
    const detailView = scope.resolved.filter.view === 'detail';
    if (request.cursor !== null && !detailView) throw reportHttpError('report_cursor_invalid');
    const position = request.cursor === null ? null : decodeDetailCursor(request.cursor);

    const businessId = scope.actor.businessId;
    const started: MoneyWindow[] = scope.windows
      .filter((window) => window.status !== 'not_started')
      .map((window) => ({ locationId: window.locationId, fromUtc: window.fromUtc, toUtcExclusive: window.toUtcExclusive }));
    const timezoneByLocation = new Map(scope.windows.map((window) => [window.locationId, window.timezone]));

    // A continuation page carries only the next detail rows: the summary was
    // already delivered with the first page and is not recomputed per page.
    if (position !== null) {
      return {
        continuation: true,
        currencyCode: null,
        summary: null,
        locations: [],
        notRecorded: [...MONEY_NOT_RECORDED_CATEGORIES],
        coverage: null,
        detail: await this.detailPage(businessId, started, timezoneByLocation, position),
      };
    }

    const [facts, coverage, detail] = await Promise.all([
      started.length > 0 ? this.loadFacts(businessId, started) : Promise.resolve(null),
      this.coverage(businessId, started),
      detailView ? this.detailPage(businessId, started, timezoneByLocation, null) : Promise.resolve(null),
    ]);

    const factsByLocation = new Map<string, MoneyFacts>();
    if (facts !== null) {
      assertScoped(facts, started);
      for (const window of started) factsByLocation.set(window.locationId, splitByLocation(facts, window.locationId));
    }
    const summaryFacts = facts === null ? null : combineFacts([...factsByLocation.values()]);
    const currencies = summaryFacts === null ? new Set<string>() : currenciesOf(summaryFacts);

    return {
      continuation: false,
      currencyCode: singleCurrency(currencies),
      summary: moneyTotals(summaryFacts),
      locations: scope.windows.map((window) => {
        const locationFacts = window.status === 'not_started' ? null : (factsByLocation.get(window.locationId) ?? EMPTY_FACTS);
        return {
          locationId: window.locationId,
          currencyCode: locationFacts === null ? null : singleCurrency(currenciesOf(locationFacts)),
          totals: moneyTotals(locationFacts),
        };
      }),
      notRecorded: [...MONEY_NOT_RECORDED_CATEGORIES],
      coverage,
      detail,
    };
  }

  /** Every fact in the started windows, read in location chunks. */
  private async loadFacts(businessId: string, windows: readonly MoneyWindow[]): Promise<MoneyFacts> {
    const everyChunk = async <T extends { at: string; id: string }>(
      read: (chunk: readonly MoneyWindow[], after: MoneyAfter | null, limit: number) => Promise<T[]>,
    ): Promise<T[]> => {
      const rows: T[] = [];
      for (const chunk of chunks(windows, MONEY_LOCATION_CHUNK)) rows.push(...(await readAll((after, limit) => read(chunk, after, limit))));
      return rows;
    };
    const [bills, retail, depositsCollected, depositsRefunded] = await Promise.all([
      everyChunk((chunk, after, limit) => this.source.paidBills(businessId, chunk, after, limit)),
      everyChunk((chunk, after, limit) => this.source.retailSales(businessId, chunk, after, limit)),
      everyChunk((chunk, after, limit) => this.source.depositsCollected(businessId, chunk, after, limit)),
      everyChunk((chunk, after, limit) => this.source.depositsRefunded(businessId, chunk, after, limit)),
    ]);
    return { bills: await this.withLinesAndPayments(businessId, bills), retail, depositsCollected, depositsRefunded };
  }

  private async withLinesAndPayments(businessId: string, bills: readonly PaidBillRow[]): Promise<BillFacts[]> {
    const [lines, payments] = await Promise.all([
      readAllByIds(bills.map((bill) => bill.id), (ids, afterId, limit) => this.source.billLines(ids, afterId, limit)),
      readAllByIds(bills.map((bill) => bill.visitId), (ids, afterId, limit) =>
        this.source.tillPaymentsForVisits(businessId, ids, afterId, limit),
      ),
    ]);
    const linesByBill = groupBy(lines, (line: BillLineRow) => line.billId);
    const paymentsByVisit = groupBy(payments, (payment: TillPaymentRow) => payment.visitId);
    return bills.map((bill) => ({
      bill,
      lines: linesByBill.get(bill.id) ?? [],
      payments: paymentsByVisit.get(bill.visitId) ?? [],
    }));
  }

  /** Till payments recorded in the windows whose visit has no paid bill at all. */
  private async coverage(businessId: string, windows: readonly MoneyWindow[]): Promise<MoneyReportBody['coverage']> {
    if (windows.length === 0) {
      return { tillPaymentsWithoutBill: { count: 0, amount: { availability: 'not_started' }, currencyCode: null } };
    }
    const payments: WindowTillPaymentRow[] = [];
    for (const chunk of chunks(windows, MONEY_LOCATION_CHUNK)) {
      payments.push(...(await readAll((after, limit) => this.source.tillPaymentsInWindows(businessId, chunk, after, limit))));
    }
    const visitIds = [...new Set(payments.map((payment) => payment.visitId))];
    const billed = new Set<string>();
    for (const chunk of chunks(visitIds, MONEY_ID_CHUNK)) {
      for (const visitId of await this.source.visitsWithPaidBill(businessId, chunk)) billed.add(visitId);
    }
    const unbilled = payments.filter((payment) => !billed.has(payment.visitId));
    const currencies = new Set(unbilled.map((payment) => payment.currencyCode));
    const amount: MoneyAmount =
      currencies.size > 1
        ? { availability: 'unavailable', reason: 'mixed_currencies' }
        : { availability: 'available', cents: unbilled.reduce((sum, payment) => sum + payment.amountCents, 0) };
    return { tillPaymentsWithoutBill: { count: unbilled.length, amount, currencyCode: singleCurrency(currencies) } };
  }

  private async detailPage(
    businessId: string,
    windows: readonly MoneyWindow[],
    timezoneByLocation: ReadonlyMap<string, string>,
    position: DetailPosition | null,
  ): Promise<MoneyDetailPage> {
    if (windows.length === 0) return { notStarted: true, rows: [], nextCursor: null };
    // Each (kind, location chunk) stream contributes its first PAGE+1 rows after
    // the cursor — topped up read by read, so a low server row cap cannot hide a
    // row — which always contains the next page of the merged order.
    const need = MONEY_DETAIL_PAGE_SIZE + 1;
    const firstRows = async <T extends { at: string; id: string }>(
      rank: number,
      read: (chunk: readonly MoneyWindow[], after: MoneyAfter | null, limit: number) => Promise<T[]>,
    ): Promise<T[]> => {
      const rows: T[] = [];
      for (const chunk of chunks(windows, MONEY_LOCATION_CHUNK)) {
        rows.push(...(await readUpTo(need, keysetAfter(position, rank), (after, limit) => read(chunk, after, limit))));
      }
      return rows;
    };
    const [bills, retail, collected, refunded] = await Promise.all([
      firstRows(DETAIL_KIND_RANK.paid_bill, (chunk, after, limit) => this.source.paidBills(businessId, chunk, after, limit)),
      firstRows(DETAIL_KIND_RANK.retail_sale, (chunk, after, limit) => this.source.retailSales(businessId, chunk, after, limit)),
      firstRows(DETAIL_KIND_RANK.deposit_collected, (chunk, after, limit) => this.source.depositsCollected(businessId, chunk, after, limit)),
      firstRows(DETAIL_KIND_RANK.deposit_refunded, (chunk, after, limit) => this.source.depositsRefunded(businessId, chunk, after, limit)),
    ]);

    type Candidate = { position: DetailPosition; build: (billFacts: Map<string, BillFacts>) => MoneyDetailRow };
    const base = (locationId: string, key: string, currencyCode: string, cents: number) => ({
      locationId,
      ...localDateTime(requiredTimezone(timezoneByLocation, locationId), key),
      currencyCode,
      amount: { availability: 'available', cents } as MoneyAmount,
    });
    const available = (cents: number): MoneyAmount => ({ availability: 'available', cents });

    const candidates: Candidate[] = [
      ...bills.map((bill) => ({
        position: { key: bill.at, rank: DETAIL_KIND_RANK.paid_bill, id: bill.id },
        build: (billFacts: Map<string, BillFacts>): MoneyDetailRow => {
          const figures = billFigures(billFacts.get(bill.id) ?? { bill, lines: [], payments: [] });
          return {
            kind: 'paid_bill',
            rowKey: `paid_bill:${bill.id}`,
            ...base(bill.locationId, bill.at, bill.currencyCode, bill.grossCents),
            billNumber: bill.billNumber,
            netOfVat: available(bill.netCents),
            vat: available(bill.taxCents),
            colour: available(figures.colour.gross),
            cash: available(figures.cash),
            cardReader: available(figures.cardReader),
            depositApplied: available(bill.depositAppliedCents),
          };
        },
      })),
      ...retail.map((sale) => ({
        position: { key: sale.at, rank: DETAIL_KIND_RANK.retail_sale, id: sale.id },
        build: (): MoneyDetailRow => ({
          kind: 'retail_sale',
          rowKey: `retail_sale:${sale.id}`,
          ...base(sale.locationId, sale.at, sale.currencyCode, sale.totalCents),
          quantity: sale.quantity,
          method: sale.method,
        }),
      })),
      ...collected.map((deposit) => ({
        position: { key: deposit.at, rank: DETAIL_KIND_RANK.deposit_collected, id: deposit.id },
        build: (): MoneyDetailRow => ({
          kind: 'deposit_collected',
          rowKey: `deposit_collected:${deposit.id}`,
          ...base(deposit.locationId, deposit.at, deposit.currencyCode, deposit.amountCents),
        }),
      })),
      ...refunded.map((deposit) => ({
        position: { key: deposit.at, rank: DETAIL_KIND_RANK.deposit_refunded, id: deposit.id },
        build: (): MoneyDetailRow => ({
          kind: 'deposit_refunded',
          rowKey: `deposit_refunded:${deposit.id}`,
          ...base(deposit.locationId, deposit.at, deposit.currencyCode, deposit.amountCents),
          amount:
            deposit.status === 'partially_refunded'
              ? { availability: 'unavailable', reason: 'partial_refund_amount_not_recorded' }
              : { availability: 'available', cents: deposit.amountCents },
        }),
      })),
    ];

    const { page, next } = mergeDetailPage(candidates, MONEY_DETAIL_PAGE_SIZE);
    const pageBills = bills.filter((bill) => page.some((row) => row.position.rank === DETAIL_KIND_RANK.paid_bill && row.position.id === bill.id));
    const billFacts = new Map((await this.withLinesAndPayments(businessId, pageBills)).map((facts) => [facts.bill.id, facts]));
    return { notStarted: false, rows: page.map((row) => row.build(billFacts)), nextCursor: next === null ? null : encodeDetailCursor(next) };
  }
}

/** Every fact must belong to a started, scoped location — the provider invariant. */
function assertScoped(facts: MoneyFacts, windows: readonly MoneyWindow[]): void {
  const scoped = new Set(windows.map((window) => window.locationId));
  const locations = [
    ...facts.bills.map((bill) => bill.bill.locationId),
    ...facts.retail.map((sale) => sale.locationId),
    ...facts.depositsCollected.map((deposit) => deposit.locationId),
    ...facts.depositsRefunded.map((deposit) => deposit.locationId),
  ];
  if (locations.some((locationId) => !scoped.has(locationId))) throw new InternalServerErrorException();
}

function requiredTimezone(timezoneByLocation: ReadonlyMap<string, string>, locationId: string): string {
  const timezone = timezoneByLocation.get(locationId);
  // A fact outside the scoped locations would break the provider invariant: refuse it.
  if (timezone === undefined) throw new InternalServerErrorException();
  return timezone;
}

function splitByLocation(facts: MoneyFacts, locationId: string): MoneyFacts {
  return {
    bills: facts.bills.filter((bill) => bill.bill.locationId === locationId),
    retail: facts.retail.filter((sale) => sale.locationId === locationId),
    depositsCollected: facts.depositsCollected.filter((deposit) => deposit.locationId === locationId),
    depositsRefunded: facts.depositsRefunded.filter((deposit) => deposit.locationId === locationId),
  };
}

function singleCurrency(currencies: ReadonlySet<string>): string | null {
  return currencies.size === 1 ? [...currencies][0] : null;
}

/**
 * Read up to `need` rows starting at `start`, continuing by keyset after each
 * read, until there are enough rows or a read returns none.
 */
export async function readUpTo<T extends { at: string; id: string }>(
  need: number,
  start: MoneyAfter | null,
  read: (after: MoneyAfter | null, limit: number) => Promise<T[]>,
): Promise<T[]> {
  const rows: T[] = [];
  let after = start;
  while (rows.length < need) {
    const batch = await read(after, need - rows.length);
    if (batch.length === 0) break;
    const last = batch[batch.length - 1];
    if (after !== null && 'id' in after && !(last.at > after.key || (last.at === after.key && last.id > after.id))) {
      throw new InternalServerErrorException();
    }
    rows.push(...batch);
    after = { key: last.at, id: last.id };
  }
  return rows;
}

/** Read every row after successive keysets until a read returns none. */
export async function readAll<T extends { at: string; id: string }>(
  read: (after: MoneyAfter | null, limit: number) => Promise<T[]>,
): Promise<T[]> {
  const rows: T[] = [];
  let after: { key: string; id: string } | null = null;
  for (;;) {
    const batch = await read(after, MONEY_READ_BATCH);
    if (batch.length === 0) return rows;
    const last = batch[batch.length - 1];
    if (after !== null && !(last.at > after.key || (last.at === after.key && last.id > after.id))) {
      // A keyset that does not advance would loop forever or repeat rows.
      throw new InternalServerErrorException();
    }
    rows.push(...batch);
    after = { key: last.at, id: last.id };
  }
}

/** Read every row for a list of ids, in chunks, each chunk by id keyset until empty. */
export async function readAllByIds<T extends { id: string }>(
  ids: readonly string[],
  read: (chunk: readonly string[], afterId: string | null, limit: number) => Promise<T[]>,
): Promise<T[]> {
  const rows: T[] = [];
  for (const chunk of chunks([...new Set(ids)], MONEY_ID_CHUNK)) {
    let afterId: string | null = null;
    for (;;) {
      const batch = await read(chunk, afterId, MONEY_READ_BATCH);
      if (batch.length === 0) break;
      const lastId: string = batch[batch.length - 1].id;
      if (afterId !== null && !(lastId > afterId)) throw new InternalServerErrorException();
      rows.push(...batch);
      afterId = lastId;
    }
  }
  return rows;
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += size) out.push(items.slice(index, index + size));
  return out;
}

function groupBy<T>(items: readonly T[], keyOf: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }
  return groups;
}
