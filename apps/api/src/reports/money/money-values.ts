/**
 * Exact conversions for R1 Money facts. Pure; no clock read.
 *
 * Database instants keep microseconds and JavaScript dates do not, so ordering,
 * cursors and keyset filters use a fixed-width UTC text key instead of a Date.
 */
import { utcToLocalDate } from '../../payroll/period-dates';

/** Thrown when a database value does not have the shape R1 relies on. */
export class MoneySourceShapeError extends Error {
  constructor(what: string) {
    super(`Unexpected money source value: ${what}`);
    this.name = 'MoneySourceShapeError';
  }
}

const DB_INSTANT = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(?:Z|\+00(?::?00)?)$/;
const INSTANT_KEY = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const WINDOW_BOUND = /^\d{4,5}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * A UTC database instant as `YYYY-MM-DDTHH:MM:SS.ffffffZ`. Comparing keys as text
 * compares the instants exactly, microseconds included. Only UTC renderings are
 * accepted: anything else is a shape error, never a guess.
 */
export function instantKey(value: unknown): string {
  const match = typeof value === 'string' ? DB_INSTANT.exec(value.trim()) : null;
  if (!match) throw new MoneySourceShapeError('instant');
  return `${match[1]}T${match[2]}.${(match[3] ?? '').padEnd(6, '0')}Z`;
}

export function isInstantKey(value: string): boolean {
  return INSTANT_KEY.test(value);
}

/** A Ticket A window bound (`utcInstantString`), which may carry a five-digit year. */
export function isWindowBound(value: string): boolean {
  return WINDOW_BOUND.test(value);
}

export function isUuid(value: string): boolean {
  return UUID.test(value);
}

/** A safe integer from an integer column. */
export function integerValue(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new MoneySourceShapeError(what);
  return value;
}

/** Integer pence from an integer money column. */
export function integerCents(value: unknown, what: string): number {
  return integerValue(value, what);
}

/**
 * Exact pence from `booking.deposits.amount` (`numeric(12,2)`, pounds). PostgREST
 * may render it as a JSON number or a string; both are converted without float
 * drift, and anything with more than two decimals is refused.
 */
export function poundsToCents(value: unknown): number {
  if (typeof value === 'string') {
    const match = /^(\d{1,10})(?:\.(\d{1,2}))?$/.exec(value.trim());
    if (!match) throw new MoneySourceShapeError('deposit amount');
    return Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
  }
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    const cents = Math.round(value * 100);
    if (Math.abs(value * 100 - cents) > 1e-6 || !Number.isSafeInteger(cents)) {
      throw new MoneySourceShapeError('deposit amount');
    }
    return cents;
  }
  throw new MoneySourceShapeError('deposit amount');
}

const timeFormatters = new Map<string, Intl.DateTimeFormat>();

/** The location's local calendar date and `HH:MM` wall-clock time for an instant key. */
export function localDateTime(timeZone: string, key: string): { localDate: string; localTime: string } {
  const ms = Date.parse(`${key.slice(0, 23)}Z`);
  let formatter = timeFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    timeFormatters.set(timeZone, formatter);
  }
  const parts = formatter.formatToParts(ms);
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? '00';
  return { localDate: utcToLocalDate(timeZone, ms), localTime: `${part('hour')}:${part('minute')}` };
}
