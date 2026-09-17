/**
 * R7 Cash Up arithmetic: records and takings in, day rows and totals out. Pure —
 * no I/O, no clock, no date resolution (days are enumerated between the local
 * dates Ticket A resolved; facts are placed on a day by the location's own zone).
 * docs/V1.1/week-8-r7-cash-up.md §3.
 */
import type {
  CashUpAmount,
  CashUpCount,
  CashUpDayRecord,
  CashUpDayRow,
  CashUpTakings,
  CashUpThresholdCheck,
  CashUpTotals,
  CashUpUnavailableReason,
  LocalDate,
} from '@sheer/domain';
import { inclusiveDayCount } from '@sheer/domain';
import { addDays, utcToLocalDate } from '../../payroll/period-dates';
import type { RetailSaleRow, WindowTillPaymentRow } from '../money/money-source';
import { localDateTime } from '../money/money-values';
import type { CashUpRecordRow } from './cash-up-source';

/** The zone End of Day computes every location's trading day in (defect D-1). */
export const END_OF_DAY_ZONE = 'Europe/London';

export interface CashUpWindow {
  locationId: string;
  timezone: string;
  localToday: LocalDate;
  from: LocalDate;
  to: LocalDate;
  /** Ticket A's UTC bounds for the whole window. */
  fromUtc: string;
  toUtcExclusive: string;
}

export interface CashUpLocationContext {
  window: CashUpWindow;
  /** The location's configured currency (R1 `locationCurrencies`); `null` when unknown. */
  configuredCurrency: string | null;
  /** Today's variance threshold in pence; `null` when the location has no setting. */
  thresholdCents: number | null;
}

/** Takings for one location-day, from sources. */
export interface DayTakings {
  tillCash: number;
  tillCard: number;
  retailCash: number;
  retailCard: number;
  retailOther: number;
  retailNotRecorded: number;
  currencies: Set<string>;
}

const available = (cents: number): CashUpAmount => ({ availability: 'available', cents });
const unavailable = (reason: CashUpUnavailableReason): CashUpAmount => ({ availability: 'unavailable', reason });
const NOT_STARTED: CashUpAmount = { availability: 'not_started' };
const isAvailable = (amount: CashUpAmount): amount is { availability: 'available'; cents: number } => amount.availability === 'available';

export const dayKey = (locationId: string, date: LocalDate): string => `${locationId}:${date}`;

/** Local dates from `from` to the earlier of `to` and today, newest first; and how many later dates are not started. */
export function locationDays(window: Pick<CashUpWindow, 'from' | 'to' | 'localToday'>): { started: LocalDate[]; notStarted: number } {
  const started: LocalDate[] = [];
  let notStarted = 0;
  // Count the days rather than compare date strings: the day after 9999-12-31 is
  // "10000-01-01", which sorts before it. Ticket A caps a range at 366 days.
  const days = inclusiveDayCount(window.from, window.to);
  for (let index = 0; index < days; index += 1) {
    const date = addDays(window.from, index);
    if (date <= window.localToday) started.push(date);
    else notStarted += 1;
  }
  return { started: started.reverse(), notStarted };
}

function emptyTakings(): DayTakings {
  return { tillCash: 0, tillCard: 0, retailCash: 0, retailCard: 0, retailOther: 0, retailNotRecorded: 0, currencies: new Set() };
}

/** Place each till payment and retail sale on its location's local day. */
export function bucketTakings(
  payments: readonly WindowTillPaymentRow[],
  retail: readonly RetailSaleRow[],
  timezoneOf: (locationId: string) => string,
): Map<string, DayTakings> {
  const days = new Map<string, DayTakings>();
  const day = (locationId: string, at: string): DayTakings => {
    // Instant keys carry microseconds; the local date needs only milliseconds.
    const key = dayKey(locationId, utcToLocalDate(timezoneOf(locationId), Date.parse(`${at.slice(0, 23)}Z`)));
    let takings = days.get(key);
    if (!takings) days.set(key, (takings = emptyTakings()));
    return takings;
  };
  for (const payment of payments) {
    const takings = day(payment.locationId, payment.at);
    if (payment.method === 'cash') takings.tillCash += payment.amountCents;
    else takings.tillCard += payment.amountCents;
    takings.currencies.add(payment.currencyCode);
  }
  for (const sale of retail) {
    const takings = day(sale.locationId, sale.at);
    if (sale.method === 'cash') takings.retailCash += sale.totalCents;
    else if (sale.method === 'card_reader') takings.retailCard += sale.totalCents;
    else if (sale.method === 'other') takings.retailOther += sale.totalCents;
    else takings.retailNotRecorded += sale.totalCents;
    takings.currencies.add(sale.currencyCode);
  }
  return days;
}

/** The location's currencies: its configured currency plus every currency its facts carry. */
export function locationCurrencies(ctx: CashUpLocationContext, takings: Iterable<DayTakings>): Set<string> {
  const currencies = new Set<string>();
  if (ctx.configuredCurrency !== null) currencies.add(ctx.configuredCurrency);
  for (const day of takings) for (const code of day.currencies) currencies.add(code);
  return currencies;
}

function singleCurrency(currencies: ReadonlySet<string>): string | null {
  return currencies.size === 1 ? [...currencies][0] : null;
}

/** Why money in these currencies can't be written, or `null` when it can. */
function currencyBlock(currencies: ReadonlySet<string>): CashUpUnavailableReason | null {
  if (currencies.size > 1) return 'mixed_currencies';
  if (currencies.size === 0) return 'currency_not_recorded';
  return null;
}

type RowSources = CashUpDayRow['sources'];

function sourcesFor(takings: DayTakings | undefined, block: CashUpUnavailableReason | null): RowSources {
  const t = takings ?? emptyTakings();
  const amount = (cents: number) => (block === null ? available(cents) : unavailable(block));
  return {
    expectedCash: amount(t.tillCash + t.retailCash),
    expectedCard: amount(t.tillCard + t.retailCard),
    retailOther: amount(t.retailOther),
    retailNotRecorded: amount(t.retailNotRecorded),
  };
}

/** Everything R7 knows about one started location-day. */
export interface DayFacts {
  row: CashUpDayRow;
  /** The signed-off record's figures are complete and comparable, so they enter the recorded totals. */
  includedInRecorded: boolean;
  /** Why a signed-off record is not included, when it is not. */
  excludedReason: CashUpUnavailableReason | null;
}

export function dayFacts(
  ctx: CashUpLocationContext,
  date: LocalDate,
  record: CashUpRecordRow | undefined,
  takings: DayTakings | undefined,
  currencies: ReadonlySet<string>,
  names: ReadonlyMap<string, string>,
): DayFacts {
  const { window } = ctx;
  const sources = sourcesFor(takings, currencyBlock(currencies));
  const base = {
    rowKey: dayKey(window.locationId, date),
    locationId: window.locationId,
    localDate: date,
    isToday: date === window.localToday,
    currencyCode: singleCurrency(currencies),
    sources,
  };
  if (!record) {
    return { row: { ...base, status: 'none', record: null, changeSinceSignOff: null }, includedInRecorded: false, excludedReason: null };
  }

  const signed = record.status === 'signed_off';
  const moneyBlock: CashUpUnavailableReason | null =
    ctx.configuredCurrency === null
      ? 'currency_not_recorded'
      : record.currencyCode !== ctx.configuredCurrency
        ? 'currency_mismatch'
        : currencyBlock(currencies);
  const expectedBlock: CashUpUnavailableReason | null = moneyBlock ?? (window.timezone !== END_OF_DAY_ZONE ? 'london_trading_day' : null);

  const entered = (cents: number): CashUpAmount => (moneyBlock === null ? available(cents) : unavailable(moneyBlock));
  const stored = (cents: number | null, block: CashUpUnavailableReason | null): CashUpAmount =>
    block !== null ? unavailable(block) : cents === null ? unavailable('not_captured') : available(cents);
  const tender = (expectedCents: number | null, countedCents: number | null) => {
    const expected = stored(expectedCents, expectedBlock);
    const counted = stored(countedCents, moneyBlock);
    let variance: CashUpAmount;
    if (!signed) variance = unavailable('not_signed_off');
    else if (!isAvailable(expected)) variance = expected;
    else if (!isAvailable(counted)) variance = counted;
    else variance = available(counted.cents - expected.cents);
    return { expected, counted, variance };
  };

  const cash = tender(record.expectedCashCents, record.countedCashCents);
  const card = tender(record.expectedCardCents, record.countedCardCents);
  const variance = signed ? stored(record.varianceCents, expectedBlock) : unavailable('not_signed_off');
  let thresholdCheck: CashUpThresholdCheck;
  if (!signed) thresholdCheck = 'not_signed_off';
  else if (!isAvailable(variance)) thresholdCheck = 'not_comparable';
  else if (ctx.thresholdCents === null) thresholdCheck = 'no_threshold';
  else thresholdCheck = Math.abs(variance.cents) > ctx.thresholdCents ? 'outside' : 'within';

  const recordFigures: CashUpDayRecord = {
    openingFloat: entered(record.openingFloatCents),
    cash,
    card,
    variance,
    thresholdCheck,
    pettyCashOut: entered(record.pettyCashOutCents),
    refundsEntered: entered(record.refundsCents),
    voidsEntered: entered(record.voidsCents),
    signedOffBy: record.signedOffByUserProfileId === null ? null : (names.get(record.signedOffByUserProfileId) ?? null),
    signedOff: record.signedOffAt === null ? null : localDateTime(window.timezone, record.signedOffAt),
    notes: record.notes,
  };

  const complete = [cash.expected, cash.counted, cash.variance, card.expected, card.counted, card.variance, variance].every(isAvailable);
  const firstReason = (): CashUpUnavailableReason =>
    ([cash.expected, cash.counted, card.expected, card.counted, variance].find((a) => a.availability === 'unavailable') as
      | { reason: CashUpUnavailableReason }
      | undefined)?.reason ?? 'not_captured';

  let changeSinceSignOff: CashUpDayRow['changeSinceSignOff'] = null;
  if (signed) {
    const change = (sourceAmount: CashUpAmount, expected: CashUpAmount): CashUpAmount =>
      !isAvailable(expected) ? expected : !isAvailable(sourceAmount) ? sourceAmount : available(sourceAmount.cents - expected.cents);
    changeSinceSignOff = { cash: change(sources.expectedCash, cash.expected), card: change(sources.expectedCard, card.expected) };
  }

  return {
    row: { ...base, status: signed ? 'signed_off' : 'open', record: recordFigures, changeSinceSignOff },
    includedInRecorded: signed && complete,
    excludedReason: signed && !complete ? firstReason() : null,
  };
}

/** Totals for one location's started days. */
export function locationTotals(
  ctx: CashUpLocationContext,
  days: readonly DayFacts[],
  notStarted: number,
  currencies: ReadonlySet<string>,
): CashUpTotals {
  const past = days.filter((d) => !d.row.isToday);
  const counts = {
    started: days.length,
    signedOff: days.filter((d) => d.row.status === 'signed_off').length,
    open: past.filter((d) => d.row.status === 'open').length,
    none: past.filter((d) => d.row.status === 'none').length,
    inProgress: days.filter((d) => d.row.isToday && d.row.status !== 'signed_off').length,
    notStarted,
  };
  if (days.length === 0) {
    const zeroCount: CashUpCount = { availability: 'available', count: 0 };
    const tender = { expected: NOT_STARTED, counted: NOT_STARTED, variance: NOT_STARTED };
    return {
      days: counts,
      recorded: {
        cash: tender,
        card: tender,
        variance: NOT_STARTED,
        pettyCashOut: NOT_STARTED,
        refundsEntered: NOT_STARTED,
        voidsEntered: NOT_STARTED,
        daysOutsideThreshold: zeroCount,
        daysUnavailable: 0,
        unavailableReasons: [],
      },
      sourceCheck: { daysChanged: zeroCount, cashChange: NOT_STARTED, cardChange: NOT_STARTED },
      withoutSignOff: { expectedCash: NOT_STARTED, expectedCard: NOT_STARTED },
      retailOutsideTill: { other: NOT_STARTED, notRecorded: NOT_STARTED },
    };
  }

  const block = currencyBlock(currencies);
  const included = days.filter((d) => d.includedInRecorded);
  const excluded = days.filter((d) => d.excludedReason !== null);
  // What the recorded totals read when no signed-off day can be summed.
  const recordedEmpty: CashUpUnavailableReason =
    counts.signedOff === 0 ? 'not_signed_off' : (excluded[0]?.excludedReason ?? 'not_signed_off');
  const recordedSum = (pick: (row: CashUpDayRow) => CashUpAmount): CashUpAmount => {
    if (block !== null) return unavailable(block);
    if (included.length === 0) return unavailable(recordedEmpty);
    return available(included.reduce((sum, d) => sum + (pick(d.row) as { cents: number }).cents, 0));
  };
  const record = (row: CashUpDayRow) => row.record as CashUpDayRecord;
  // Every recorded figure — tills, petty cash and manual entries — covers the same days.
  const countOver = (count: () => number, notCountable: CashUpUnavailableReason | null): CashUpCount =>
    notCountable !== null ? { availability: 'unavailable', reason: notCountable } : { availability: 'available', count: count() };
  const nothingJudged: CashUpUnavailableReason | null = block ?? (included.length === 0 ? recordedEmpty : null);

  const daysOutsideThreshold = countOver(
    () => included.filter((d) => record(d.row).thresholdCheck === 'outside').length,
    nothingJudged ?? (ctx.thresholdCents === null ? 'threshold_not_set' : null),
  );

  const changes = included.map((d) => d.row.changeSinceSignOff as { cash: CashUpAmount; card: CashUpAmount });
  const changeSum = (pick: (c: { cash: CashUpAmount; card: CashUpAmount }) => CashUpAmount): CashUpAmount => {
    if (block !== null) return unavailable(block);
    if (included.length === 0) return unavailable(recordedEmpty);
    return available(changes.reduce((sum, c) => sum + (pick(c) as { cents: number }).cents, 0));
  };
  const daysChanged = countOver(
    () => changes.filter((c) => (c.cash as { cents: number }).cents !== 0 || (c.card as { cents: number }).cents !== 0).length,
    nothingJudged,
  );

  const sourceSum = (rows: readonly DayFacts[], pick: (s: RowSources) => CashUpAmount): CashUpAmount =>
    block !== null ? unavailable(block) : available(rows.reduce((sum, d) => sum + (pick(d.row.sources) as { cents: number }).cents, 0));
  const unsigned = days.filter((d) => d.row.status !== 'signed_off');
  const unavailableReasons = [...new Set(excluded.map((d) => d.excludedReason as CashUpUnavailableReason))];

  return {
    days: counts,
    recorded: {
      cash: {
        expected: recordedSum((r) => record(r).cash.expected),
        counted: recordedSum((r) => record(r).cash.counted),
        variance: recordedSum((r) => record(r).cash.variance),
      },
      card: {
        expected: recordedSum((r) => record(r).card.expected),
        counted: recordedSum((r) => record(r).card.counted),
        variance: recordedSum((r) => record(r).card.variance),
      },
      variance: recordedSum((r) => record(r).variance),
      pettyCashOut: recordedSum((r) => record(r).pettyCashOut),
      refundsEntered: recordedSum((r) => record(r).refundsEntered),
      voidsEntered: recordedSum((r) => record(r).voidsEntered),
      daysOutsideThreshold,
      daysUnavailable: excluded.length,
      unavailableReasons,
    },
    sourceCheck: { daysChanged, cashChange: changeSum((c) => c.cash), cardChange: changeSum((c) => c.card) },
    withoutSignOff: {
      expectedCash: sourceSum(unsigned, (s) => s.expectedCash),
      expectedCard: sourceSum(unsigned, (s) => s.expectedCard),
    },
    retailOutsideTill: { other: sourceSum(days, (s) => s.retailOther), notRecorded: sourceSum(days, (s) => s.retailNotRecorded) },
  };
}

function combineAmounts(amounts: readonly CashUpAmount[], currencies: ReadonlySet<string>): CashUpAmount {
  if (amounts.every((a) => a.availability === 'not_started')) return NOT_STARTED;
  if (currencies.size > 1) return unavailable('mixed_currencies');
  const values = amounts.filter(isAvailable);
  if (values.length > 0) return available(values.reduce((sum, a) => sum + a.cents, 0));
  const reason = amounts.find((a) => a.availability === 'unavailable') as { reason: CashUpUnavailableReason } | undefined;
  return reason ? unavailable(reason.reason) : NOT_STARTED;
}

/** Like money: the locations that can be counted are added; the others are disclosed by their own figures. */
function combineCounts(counts: readonly CashUpCount[]): CashUpCount {
  const values = counts.filter((c): c is { availability: 'available'; count: number } => c.availability === 'available');
  if (values.length > 0) return { availability: 'available', count: values.reduce((sum, c) => sum + c.count, 0) };
  return counts[0] ?? { availability: 'available', count: 0 };
}

/** The summary across locations. Money in more than one currency is not totalled. */
export function combineTotals(all: readonly CashUpTotals[], currencies: ReadonlySet<string>): CashUpTotals {
  const pick = <T>(f: (t: CashUpTotals) => T) => all.map(f);
  const money = (f: (t: CashUpTotals) => CashUpAmount) => combineAmounts(pick(f), currencies);
  const takings = (f: (t: CashUpTotals) => CashUpTakings): CashUpTakings => ({
    expectedCash: combineAmounts(pick((t) => f(t).expectedCash), currencies),
    expectedCard: combineAmounts(pick((t) => f(t).expectedCard), currencies),
  });
  const sum = (f: (t: CashUpTotals) => number) => pick(f).reduce((s, n) => s + n, 0);
  return {
    days: {
      started: sum((t) => t.days.started),
      signedOff: sum((t) => t.days.signedOff),
      open: sum((t) => t.days.open),
      none: sum((t) => t.days.none),
      inProgress: sum((t) => t.days.inProgress),
      notStarted: sum((t) => t.days.notStarted),
    },
    recorded: {
      cash: {
        expected: money((t) => t.recorded.cash.expected),
        counted: money((t) => t.recorded.cash.counted),
        variance: money((t) => t.recorded.cash.variance),
      },
      card: {
        expected: money((t) => t.recorded.card.expected),
        counted: money((t) => t.recorded.card.counted),
        variance: money((t) => t.recorded.card.variance),
      },
      variance: money((t) => t.recorded.variance),
      pettyCashOut: money((t) => t.recorded.pettyCashOut),
      refundsEntered: money((t) => t.recorded.refundsEntered),
      voidsEntered: money((t) => t.recorded.voidsEntered),
      daysOutsideThreshold: combineCounts(pick((t) => t.recorded.daysOutsideThreshold)),
      daysUnavailable: sum((t) => t.recorded.daysUnavailable),
      unavailableReasons: [...new Set(all.flatMap((t) => t.recorded.unavailableReasons))],
    },
    sourceCheck: {
      daysChanged: combineCounts(pick((t) => t.sourceCheck.daysChanged)),
      cashChange: money((t) => t.sourceCheck.cashChange),
      cardChange: money((t) => t.sourceCheck.cardChange),
    },
    withoutSignOff: takings((t) => t.withoutSignOff),
    retailOutsideTill: {
      other: money((t) => t.retailOutsideTill.other),
      notRecorded: money((t) => t.retailOutsideTill.notRecorded),
    },
  };
}
