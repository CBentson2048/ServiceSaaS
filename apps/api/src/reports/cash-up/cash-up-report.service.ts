/**
 * R7 Cash Up (QLOOQO V1.1 Week 8): builds the report body from a Ticket A scope.
 *
 * Days come only from the scope's per-location local dates; takings come from R1's
 * MoneySource inside each location's own window; cash-ups are read as recorded.
 * docs/V1.1/week-8-r7-cash-up.md.
 */
import { Inject, Injectable, InternalServerErrorException } from '@nestjs/common';
import { CASH_UP_DETAIL_PAGE_SIZE, type CashUpDetailPage, type CashUpReportBody, type CashUpTotals, type LocalDate } from '@sheer/domain';
import { reportHttpError } from '../report-errors';
import type { ReportScope } from '../report-scope.service';
import { MONEY_ID_CHUNK, MONEY_LOCATION_CHUNK, MONEY_READ_BATCH, readAll } from '../money/money-report.service';
import { MONEY_SOURCE, type MoneySource, type MoneyWindow, type RetailSaleRow, type WindowTillPaymentRow } from '../money/money-source';
import {
  bucketTakings,
  combineTotals,
  dayFacts,
  dayKey,
  locationCurrencies,
  locationDays,
  locationTotals,
  type CashUpLocationContext,
  type CashUpWindow,
  type DayFacts,
  type DayTakings,
} from './cash-up-days';
import { cashUpFingerprint, decodeCashUpCursor, encodeCashUpCursor, pageAfter, type CashUpPosition } from './cash-up-detail';
import { CASH_UP_SOURCE, type CashUpRecordRow, type CashUpSource } from './cash-up-source';

export interface CashUpBuildRequest {
  /** From `?cursor=`; only valid with the detail view. */
  cursor: string | null;
}

interface LocationData {
  ctx: CashUpLocationContext;
  started: LocalDate[];
  notStarted: number;
  records: Map<LocalDate, CashUpRecordRow>;
  takings: Map<string, DayTakings>;
  currencies: Set<string>;
}

@Injectable()
export class CashUpReportService {
  constructor(
    @Inject(MONEY_SOURCE) private readonly money: MoneySource,
    @Inject(CASH_UP_SOURCE) private readonly cashUp: CashUpSource,
  ) {}

  async build(scope: ReportScope, request: CashUpBuildRequest): Promise<CashUpReportBody> {
    const detailView = scope.resolved.filter.view === 'detail';
    if (request.cursor !== null && !detailView) throw reportHttpError('report_cursor_invalid');

    const windows: CashUpWindow[] = scope.windows.map((w) => ({
      locationId: w.locationId,
      timezone: w.timezone,
      localToday: w.localToday,
      from: w.from,
      to: w.to,
      fromUtc: w.fromUtc,
      toUtcExclusive: w.toUtcExclusive,
    }));
    const fingerprint = cashUpFingerprint(windows);
    const position = request.cursor === null ? null : decodeCashUpCursor(request.cursor, fingerprint);
    const businessId = scope.actor.businessId;
    const moneyWindows = new Map<string, MoneyWindow>(
      scope.windows
        .filter((w) => w.status !== 'not_started')
        .map((w) => [w.locationId, { locationId: w.locationId, fromUtc: w.fromUtc, toUtcExclusive: w.toUtcExclusive }]),
    );
    const positions: CashUpPosition[] = windows.flatMap((w) => locationDays(w).started.map((localDate) => ({ localDate, locationId: w.locationId })));

    if (position !== null) {
      const { page, next } = pageAfter(positions, position, CASH_UP_DETAIL_PAGE_SIZE);
      const pageLocations = windows.filter((w) => page.some((p) => p.locationId === w.locationId));
      const data = await this.load(businessId, pageLocations, moneyWindows, page);
      return {
        continuation: true,
        currencyCode: null,
        summary: null,
        locations: [],
        detail: await this.detail(data, page, next, fingerprint, positions.length === 0),
      };
    }

    const data = await this.load(businessId, windows, moneyWindows, null);
    const totals: CashUpTotals[] = [];
    const locations = windows.map((w) => {
      const location = data.get(w.locationId) as LocationData;
      const days = location.started.map((date) => this.facts(location, date, new Map()));
      const locationTotal = locationTotals(location.ctx, days, location.notStarted, location.currencies);
      totals.push(locationTotal);
      return {
        locationId: w.locationId,
        currencyCode: location.started.length === 0 ? null : location.currencies.size === 1 ? [...location.currencies][0] : null,
        threshold:
          location.ctx.thresholdCents === null
            ? ({ availability: 'unavailable', reason: 'threshold_not_set' } as const)
            : ({ availability: 'available', cents: location.ctx.thresholdCents } as const),
        thresholdCurrencyCode: location.ctx.configuredCurrency,
        totals: locationTotal,
      };
    });
    const startedLocations = [...data.values()].filter((l) => l.started.length > 0);
    const summaryCurrencies = new Set(startedLocations.flatMap((l) => [...l.currencies]));

    let detail: CashUpDetailPage | null = null;
    if (detailView) {
      const { page, next } = pageAfter(positions, null, CASH_UP_DETAIL_PAGE_SIZE);
      detail = await this.detail(data, page, next, fingerprint, positions.length === 0);
    }
    return {
      continuation: false,
      currencyCode: summaryCurrencies.size === 1 ? [...summaryCurrencies][0] : null,
      summary: combineTotals(totals, summaryCurrencies),
      locations,
      detail,
    };
  }

  private facts(location: LocationData, date: LocalDate, names: ReadonlyMap<string, string>): DayFacts {
    return dayFacts(
      location.ctx,
      date,
      location.records.get(date),
      location.takings.get(dayKey(location.ctx.window.locationId, date)),
      location.currencies,
      names,
    );
  }

  private async detail(
    data: Map<string, LocationData>,
    page: readonly CashUpPosition[],
    next: CashUpPosition | null,
    fingerprint: string,
    notStarted: boolean,
  ): Promise<CashUpDetailPage> {
    if (notStarted) return { notStarted: true, rows: [], nextCursor: null };
    const signers = new Set<string>();
    for (const p of page) {
      const id = data.get(p.locationId)?.records.get(p.localDate)?.signedOffByUserProfileId;
      if (id) signers.add(id);
    }
    const names = new Map<string, string>();
    for (const chunk of chunks([...signers], MONEY_ID_CHUNK)) {
      for (const [id, name] of await this.cashUp.userNames(chunk)) names.set(id, name);
    }
    return {
      notStarted: false,
      rows: page.map((p) => this.facts(data.get(p.locationId) as LocationData, p.localDate, names).row),
      nextCursor: next === null ? null : encodeCashUpCursor(next, fingerprint),
    };
  }

  /**
   * Everything the given locations need. `onlyDates` narrows the cash-up records
   * to a detail page's days; takings always cover each location's whole window,
   * so a location's currencies are the same on every page.
   */
  private async load(
    businessId: string,
    windows: readonly CashUpWindow[],
    moneyWindows: ReadonlyMap<string, MoneyWindow>,
    onlyDates: readonly CashUpPosition[] | null,
  ): Promise<Map<string, LocationData>> {
    const data = new Map<string, LocationData>();
    for (const window of windows) {
      const days = locationDays(window);
      data.set(window.locationId, {
        ctx: { window, configuredCurrency: null, thresholdCents: null },
        started: onlyDates === null ? days.started : onlyDates.filter((p) => p.locationId === window.locationId).map((p) => p.localDate),
        notStarted: days.notStarted,
        records: new Map(),
        takings: new Map(),
        currencies: new Set(),
      });
    }
    const started = windows.filter((w) => locationDays(w).started.length > 0);

    // Every location's threshold is shown, started or not.
    for (const chunk of chunks(windows.map((w) => w.locationId), MONEY_ID_CHUNK)) {
      const [configured, thresholds] = await Promise.all([
        this.money.locationCurrencies(businessId, chunk),
        this.cashUp.thresholds(businessId, chunk),
      ]);
      for (const id of chunk) {
        const location = data.get(id) as LocationData;
        location.ctx = { ...location.ctx, configuredCurrency: configured.get(id) ?? null, thresholdCents: thresholds.get(id) ?? null };
      }
    }

    const timezoneOf = (locationId: string): string => {
      const location = data.get(locationId);
      if (!location) throw new InternalServerErrorException();
      return location.ctx.window.timezone;
    };
    for (const chunk of chunks(started, MONEY_LOCATION_CHUNK)) {
      const chunkWindows = chunk.map((w) => moneyWindows.get(w.locationId) as MoneyWindow);
      const [payments, retail, records] = await Promise.all([
        readAll<WindowTillPaymentRow>((after, limit) => this.money.tillPaymentsInWindows(businessId, chunkWindows, after, limit)),
        readAll<RetailSaleRow>((after, limit) => this.money.retailSales(businessId, chunkWindows, after, limit)),
        this.records(businessId, chunk, onlyDates),
      ]);
      const ids = new Set(chunk.map((w) => w.locationId));
      if ([...payments, ...retail].some((row) => !ids.has(row.locationId))) throw new InternalServerErrorException();
      for (const [key, takings] of bucketTakings(payments, retail, timezoneOf)) {
        const locationId = key.slice(0, key.indexOf(':'));
        (data.get(locationId) as LocationData).takings.set(key, takings);
      }
      for (const record of records) {
        const location = data.get(record.locationId);
        if (!location || !ids.has(record.locationId)) throw new InternalServerErrorException();
        const { window } = location.ctx;
        // A record dated outside the location's started days (e.g. opened for a future date) is ignored.
        if (record.businessDate < window.from || record.businessDate > window.to || record.businessDate > window.localToday) continue;
        if (location.records.has(record.businessDate)) throw new InternalServerErrorException();
        location.records.set(record.businessDate, record);
      }
    }
    for (const window of started) {
      const location = data.get(window.locationId) as LocationData;
      location.currencies = locationCurrencies(location.ctx, location.takings.values());
    }
    return data;
  }

  private async records(
    businessId: string,
    windows: readonly CashUpWindow[],
    onlyDates: readonly CashUpPosition[] | null,
  ): Promise<CashUpRecordRow[]> {
    const dates =
      onlyDates === null
        ? windows.flatMap((w) => [w.from, w.to < w.localToday ? w.to : w.localToday])
        : onlyDates.filter((p) => windows.some((w) => w.locationId === p.locationId)).map((p) => p.localDate);
    if (dates.length === 0) return [];
    const fromDate = dates.reduce((a, b) => (a < b ? a : b));
    const toDate = dates.reduce((a, b) => (a > b ? a : b));
    const ids = windows.map((w) => w.locationId);
    const rows: CashUpRecordRow[] = [];
    let afterId: string | null = null;
    for (;;) {
      const batch: CashUpRecordRow[] = await this.cashUp.records(businessId, ids, fromDate, toDate, afterId, MONEY_READ_BATCH);
      if (batch.length === 0) return rows;
      const last: string = batch[batch.length - 1].id;
      // An id keyset that does not advance would loop forever or repeat rows.
      if (afterId !== null && !(last > afterId)) throw new InternalServerErrorException();
      rows.push(...batch);
      afterId = last;
    }
  }
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += size) out.push(items.slice(index, index + size));
  return out;
}
