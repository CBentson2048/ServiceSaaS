import { BadRequestException } from '@nestjs/common';
import type { ColourPrepRange } from '@sheer/domain';

/**
 * Colour Prep windows are calendar concepts ("today", "next week") but the rows
 * they select are `timestamptz`. The boundary therefore has to be computed in
 * the SALON's timezone, not the server's — otherwise a 9am Monday appointment
 * disappears from "This Week" whenever the API host runs west of the salon, and
 * British Summer Time shifts every boundary by an hour twice a year.
 *
 * `core.locations.timezone` is `not null`, so every location has a zone to use.
 * The conversion uses Intl rather than a date library: the platform already
 * ships the IANA database and it handles DST transitions correctly.
 */

export interface ResolvedWindow {
  /** Inclusive start as a UTC instant. */
  from: Date;
  /** Exclusive end as a UTC instant. */
  to: Date;
  /** Local calendar dates the window covers, for display. */
  fromDate: string;
  /** Inclusive last local date (i.e. the day before `to`). */
  toDate: string;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Offset between the given instant and its representation in `timeZone`,
 * in milliseconds. Positive where local time is ahead of UTC.
 */
function zoneOffsetMs(instant: Date, timeZone: string): number {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = formatter.formatToParts(instant);
  const read = (type: string): number => Number(parts.find((part) => part.type === type)?.value ?? '0');
  const asIfUtc = Date.UTC(
    read('year'),
    read('month') - 1,
    read('day'),
    read('hour'),
    read('minute'),
    read('second'),
  );
  return asIfUtc - instant.getTime();
}

/** The instant at which the given local calendar date begins in `timeZone`. */
export function zonedStartOfDay(year: number, month: number, day: number, timeZone: string): Date {
  const naive = Date.UTC(year, month - 1, day, 0, 0, 0, 0);
  // First guess using the offset that applies around that instant, then correct
  // once — a DST transition can move the offset between guess and result.
  const firstOffset = zoneOffsetMs(new Date(naive), timeZone);
  const candidate = new Date(naive - firstOffset);
  const settledOffset = zoneOffsetMs(candidate, timeZone);
  return settledOffset === firstOffset ? candidate : new Date(naive - settledOffset);
}

/** The local calendar date (`YYYY-MM-DD`) an instant falls on in `timeZone`. */
export function zonedDateString(instant: Date, timeZone: string): string {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return formatter.format(instant);
}

function parseDateOnly(value: string, label: string): { year: number; month: number; day: number } {
  if (!DATE_ONLY.test(value)) {
    throw new BadRequestException(`${label} must be a calendar date in YYYY-MM-DD format`);
  }
  const [year, month, day] = value.split('-').map(Number);
  // Round-trip through UTC to reject 2026-02-30 and friends.
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    throw new BadRequestException(`${label} is not a real calendar date`);
  }
  return { year, month, day };
}

function addDays(value: string, days: number): string {
  const { year, month, day } = parseDateOnly(value, 'date');
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return shifted.toISOString().slice(0, 10);
}

/** Monday-based weekday index (Monday = 0) for a local calendar date. */
function weekdayIndex(value: string): number {
  const { year, month, day } = parseDateOnly(value, 'date');
  const utc = new Date(Date.UTC(year, month - 1, day));
  return (utc.getUTCDay() + 6) % 7;
}

function windowFromDates(fromDate: string, toDate: string, timeZone: string): ResolvedWindow {
  const from = parseDateOnly(fromDate, 'from');
  const exclusiveEnd = parseDateOnly(addDays(toDate, 1), 'to');
  return {
    from: zonedStartOfDay(from.year, from.month, from.day, timeZone),
    to: zonedStartOfDay(exclusiveEnd.year, exclusiveEnd.month, exclusiveEnd.day, timeZone),
    fromDate,
    toDate,
  };
}

/**
 * Resolve a Colour Prep window.
 *
 * The week presets are Monday-based, matching the rota and the existing
 * analytics week. `custom` takes inclusive local dates so "1st to the 3rd"
 * means three whole salon days regardless of the caller's own timezone.
 */
export function resolveColourPrepWindow(
  range: ColourPrepRange,
  timeZone: string,
  options: { from?: string; to?: string; now?: Date } = {},
): ResolvedWindow {
  const now = options.now ?? new Date();
  const today = zonedDateString(now, timeZone);

  if (range === 'today') {
    return windowFromDates(today, today, timeZone);
  }

  if (range === 'this_week' || range === 'next_week') {
    const monday = addDays(today, -weekdayIndex(today) + (range === 'next_week' ? 7 : 0));
    return windowFromDates(monday, addDays(monday, 6), timeZone);
  }

  const { from, to } = options;
  if (!from || !to) {
    throw new BadRequestException('from and to are required for a custom range');
  }
  parseDateOnly(from, 'from');
  parseDateOnly(to, 'to');
  if (from > to) {
    throw new BadRequestException('from must not be after to');
  }
  return windowFromDates(from, to, timeZone);
}
