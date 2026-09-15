/**
 * R7 Cash Up report body (QLOOQO V1.1 Week 8).
 *
 * The till cash-ups recorded on the End of Day screen, per location and per local
 * trading day in that location's own report window, next to the till takings from
 * R1's sources. Every figure is computed by the API; the web only formats. A day
 * that was never cashed up, or a figure R7 cannot state honestly, is an explicit
 * status or unavailable amount — never zero.
 * Decision record: docs/V1.1/week-8-r7-cash-up.md.
 *
 * Browser-safe: types only, no clock, no Intl.
 */
import type { LocalDate } from './local-date';
import type { MoneyUnavailableReason } from './money-report';

export type CashUpUnavailableReason =
  | MoneyUnavailableReason
  /** The day has a draft cash-up that was never signed off. */
  | 'not_signed_off'
  /**
   * End of Day computed this location's expected snapshot on a Europe/London day,
   * not the location's own, so it cannot be compared with the location's day.
   */
  | 'london_trading_day'
  /** The cash-up record's currency is not the location's configured currency. */
  | 'currency_mismatch'
  /** The location has no variance threshold setting. */
  | 'threshold_not_set';

export type CashUpAmount =
  | { availability: 'available'; cents: number }
  | { availability: 'unavailable'; reason: CashUpUnavailableReason }
  /** No scoped day has started yet. */
  | { availability: 'not_started' };

/** A count that may be unknowable (e.g. days outside an unset threshold). */
export type CashUpCount =
  | { availability: 'available'; count: number }
  | { availability: 'unavailable'; reason: CashUpUnavailableReason };

/**
 * - `signed_off`: a cash-up signed off on End of Day.
 * - `open`: a draft cash-up, not signed off.
 * - `none`: no cash-up recorded for the day.
 * - `not_started`: the day is after the location's local today.
 */
export type CashUpDayStatus = 'signed_off' | 'open' | 'none' | 'not_started';

export interface CashUpDayCounts {
  /** Days on or before the location's local today. */
  started: number;
  signedOff: number;
  open: number;
  none: number;
  notStarted: number;
}

export interface CashUpTenderFigures {
  expected: CashUpAmount;
  counted: CashUpAmount;
  /** counted − expected, from the stored figures. */
  variance: CashUpAmount;
}

/** Signed-off days, as recorded at sign-off. */
export interface CashUpRecordedTotals {
  cash: CashUpTenderFigures;
  card: CashUpTenderFigures;
  /** The stored combined variance: (counted cash + card) − (expected cash + card). */
  variance: CashUpAmount;
  pettyCashOut: CashUpAmount;
  /** Manual entries on End of Day. A zero cannot be told apart from "not entered". */
  refundsEntered: CashUpAmount;
  voidsEntered: CashUpAmount;
  /** Signed-off days whose |variance| exceeds today's threshold for the location. */
  daysOutsideThreshold: CashUpCount;
  /** Signed-off days whose recorded figures are unavailable (London trading day, currency mismatch). */
  daysUnavailable: number;
}

/** Signed-off days whose money sources changed after sign-off. */
export interface CashUpSourceCheck {
  daysChanged: CashUpCount;
  /** Expected from sources now − recorded expected, summed over signed-off days. */
  cashChange: CashUpAmount;
  cardChange: CashUpAmount;
}

export interface CashUpTakings {
  /** Till cash tenders + retail cash sales. */
  expectedCash: CashUpAmount;
  /** Till card-reader tenders + retail card-reader sales. */
  expectedCard: CashUpAmount;
}

export interface CashUpTotals {
  days: CashUpDayCounts;
  recorded: CashUpRecordedTotals;
  sourceCheck: CashUpSourceCheck;
  /** Takings from sources on started days that are `open` or `none`. */
  withoutSignOff: CashUpTakings;
  /** Retail takings that never reach the till count. */
  retailOutsideTill: { other: CashUpAmount; notRecorded: CashUpAmount };
}

export interface CashUpLocationTotals {
  locationId: string;
  /** The location's single currency; `null` when mixed, not started or unknown. */
  currencyCode: string | null;
  /** Today's variance threshold for the location. */
  threshold: CashUpAmount;
  totals: CashUpTotals;
}

export interface CashUpDayRecord {
  openingFloat: CashUpAmount;
  cash: CashUpTenderFigures;
  card: CashUpTenderFigures;
  variance: CashUpAmount;
  /** `null` when unknowable (not signed off, unavailable figures or no threshold). */
  outsideThreshold: boolean | null;
  pettyCashOut: CashUpAmount;
  refundsEntered: CashUpAmount;
  voidsEntered: CashUpAmount;
  signedOffBy: string | null;
  /** The sign-off instant in the location's local calendar and clock. */
  signedOff: { localDate: LocalDate; localTime: string } | null;
  notes: string | null;
}

export interface CashUpDayRow {
  /** `${locationId}:${localDate}` — stable and unique. */
  rowKey: string;
  locationId: string;
  localDate: LocalDate;
  isToday: boolean;
  status: Exclude<CashUpDayStatus, 'not_started'>;
  /** The row's currency; `null` when mixed or unknown. */
  currencyCode: string | null;
  /** `null` when no cash-up was recorded. */
  record: CashUpDayRecord | null;
  /** Takings for the day from sources, recomputed now. */
  sources: CashUpTakings & { retailOther: CashUpAmount; retailNotRecorded: CashUpAmount };
  /** Signed-off days only: sources − recorded expected, per tender. */
  changeSinceSignOff: { cash: CashUpAmount; card: CashUpAmount } | null;
}

export interface CashUpDetailPage {
  /** No scoped day has started. */
  notStarted: boolean;
  rows: CashUpDayRow[];
  /** Opaque. Pass back as `cursor` with the same filter; `null` at the end. */
  nextCursor: string | null;
}

export interface CashUpFirstPageBody {
  continuation: false;
  /** The single currency of the scope; `null` when mixed or unknown. */
  currencyCode: string | null;
  summary: CashUpTotals;
  /** One per resolved location, in the same order. */
  locations: CashUpLocationTotals[];
  detail: CashUpDetailPage | null;
}

export interface CashUpContinuationBody {
  continuation: true;
  currencyCode: null;
  summary: null;
  locations: [];
  detail: CashUpDetailPage;
}

export type CashUpReportBody = CashUpFirstPageBody | CashUpContinuationBody;

/** Detail rows per page. */
export const CASH_UP_DETAIL_PAGE_SIZE = 50;
