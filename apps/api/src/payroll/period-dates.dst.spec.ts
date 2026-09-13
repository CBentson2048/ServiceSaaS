/**
 * DST-safety of `localDateStartUtc` — the one day-boundary helper payroll and
 * reporting share.
 *
 * The previous two-pass implementation was correct in Europe/London but put the
 * start of the day an hour early in zones whose clocks skip midnight (Santiago,
 * Havana, the Azores) and picked the second midnight where the clock falls back
 * across it. Reporting resolves every location from its own zone, and custom
 * ranges reach back to 2000, so the helper must be right everywhere.
 *
 * Pinned instants use HISTORICAL transitions (2025 and earlier): future
 * transition dates depend on tzdata releases that governments still change.
 * Everything else asserts properties that hold for any tzdata.
 */
import { isLocalDate as domainIsLocalDate, inclusiveDayCount } from '@sheer/domain';
import {
  addDays,
  isLocalDate,
  isSupportedTimeZone,
  localDateStartUtc,
  periodUtcWindow,
  utcToLocalDate,
} from './period-dates';

const iso = (tz: string, date: string) => localDateStartUtc(tz, date).toISOString();

/** Hours from the start of `date` to the start of the next day. */
function dayLengthHours(tz: string, date: string): number {
  const start = localDateStartUtc(tz, date).getTime();
  const next = localDateStartUtc(tz, addDays(date, 1)).getTime();
  return (next - start) / 3_600_000;
}

/**
 * The properties every day window must have: it starts on its own date, the
 * second before it is an earlier date, the last second is still the date, and
 * a date the zone skipped is an empty window that starts on a later date.
 */
function dayWindowProblems(tz: string, date: string): string[] {
  const problems: string[] = [];
  const start = localDateStartUtc(tz, date).getTime();
  const next = localDateStartUtc(tz, addDays(date, 1)).getTime();
  if (next < start) problems.push(`${tz} ${date}: next day starts before this one`);
  if (next === start) {
    if (!(utcToLocalDate(tz, start) > date)) problems.push(`${tz} ${date}: empty day that exists`);
    return problems;
  }
  if (utcToLocalDate(tz, start) !== date) problems.push(`${tz} ${date}: start reads another date`);
  if (!(utcToLocalDate(tz, start - 1000) < date)) problems.push(`${tz} ${date}: second before start is not earlier`);
  if (utcToLocalDate(tz, next - 1000) !== date) problems.push(`${tz} ${date}: last second is not the date`);
  return problems;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string): Intl.DateTimeFormat {
  let dtf = formatters.get(tz);
  if (!dtf) {
    dtf = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
    formatters.set(tz, dtf);
  }
  return dtf;
}

/** The zone's UTC offset at `utcMs`, in ms, computed independently of the code under test. */
function offsetAt(tz: string, utcMs: number): number {
  const parts = formatter(tz).formatToParts(new Date(utcMs));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? '0');
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

/**
 * Dates in [fromYear, toYear] where the zone's offset changes within a day either
 * side. Samples weekly and scans day by day only inside a week whose offset
 * changed — no zone in tzdata changes offset and changes back within a week.
 */
function transitionDates(tz: string, fromYear: number, toYear: number): string[] {
  const offsetAtNoon = (date: string) => offsetAt(tz, Date.parse(`${date}T12:00:00Z`));
  const found = new Set<string>();
  const end = `${toYear}-12-31`;
  let weekStart = `${fromYear}-01-01`;
  let weekStartOffset = offsetAtNoon(weekStart);
  while (weekStart < end) {
    const weekEnd = addDays(weekStart, 7);
    const weekEndOffset = offsetAtNoon(weekEnd);
    if (weekEndOffset !== weekStartOffset) {
      let previous = weekStartOffset;
      for (let date = weekStart; date < weekEnd; date = addDays(date, 1)) {
        const next = addDays(date, 1);
        const current = offsetAtNoon(next);
        if (current !== previous) {
          for (const d of [addDays(date, -1), date, next, addDays(next, 1)]) found.add(d);
        }
        previous = current;
      }
    }
    weekStart = weekEnd;
    weekStartOffset = weekEndOffset;
  }
  return [...found].sort();
}

/** The algorithm this file replaced, kept verbatim as a regression reference. */
function previousLocalDateStartUtc(timeZone: string, date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d);
  const offset1 = offsetAt(timeZone, guess);
  const offset2 = offsetAt(timeZone, guess - offset1);
  return guess - offset2;
}

describe('localDateStartUtc — zones whose results must not change', () => {
  it('London BST day starts at 23:00 UTC the previous evening', () => {
    expect(iso('Europe/London', '2026-09-13')).toBe('2026-09-12T23:00:00.000Z');
  });

  it('London spring-forward day is 23 hours, autumn fall-back day is 25 hours', () => {
    expect(iso('Europe/London', '2026-03-29')).toBe('2026-03-29T00:00:00.000Z');
    expect(dayLengthHours('Europe/London', '2026-03-29')).toBe(23);
    expect(iso('Europe/London', '2026-10-25')).toBe('2026-10-24T23:00:00.000Z');
    expect(dayLengthHours('Europe/London', '2026-10-25')).toBe(25);
  });

  it('New York spring-forward day is [05:00Z, next 04:00Z)', () => {
    expect(iso('America/New_York', '2026-03-08')).toBe('2026-03-08T05:00:00.000Z');
    expect(iso('America/New_York', '2026-03-09')).toBe('2026-03-09T04:00:00.000Z');
  });

  it('Sydney spring-forward day starts at the previous day 14:00Z and is 23 hours', () => {
    expect(iso('Australia/Sydney', '2026-10-04')).toBe('2026-10-03T14:00:00.000Z');
    expect(dayLengthHours('Australia/Sydney', '2026-10-04')).toBe(23);
  });

  it('is identical to the previous algorithm for every date 2000–2030 in London, New York and Los Angeles', () => {
    const mismatches: string[] = [];
    for (const tz of ['Europe/London', 'America/New_York', 'America/Los_Angeles']) {
      for (let date = '2000-01-01'; date <= '2030-12-31'; date = addDays(date, 1)) {
        if (localDateStartUtc(tz, date).getTime() !== previousLocalDateStartUtc(tz, date)) {
          mismatches.push(`${tz} ${date}`);
        }
      }
    }
    expect(mismatches).toEqual([]);
  }, 120_000);

  it('leaves payroll period windows unchanged for London weekly periods in 2026', () => {
    expect(periodUtcWindow('Europe/London', '2026-03-24', '2026-03-31')).toEqual({
      fromUtc: '2026-03-24T00:00:00.000Z',
      toUtc: '2026-03-30T23:00:00.000Z',
    });
    expect(periodUtcWindow('Europe/London', '2026-10-20', '2026-10-27')).toEqual({
      fromUtc: '2026-10-19T23:00:00.000Z',
      toUtc: '2026-10-27T00:00:00.000Z',
    });
  });
});

describe('localDateStartUtc — zones where midnight is skipped, repeated or missing', () => {
  it('Santiago 2025-09-07 (clocks jump 00:00 → 01:00) starts at 04:00Z, and the previous day ends there', () => {
    expect(iso('America/Santiago', '2025-09-07')).toBe('2025-09-07T04:00:00.000Z');
    expect(utcToLocalDate('America/Santiago', Date.parse('2025-09-07T03:59:59Z'))).toBe('2025-09-06');
    expect(dayLengthHours('America/Santiago', '2025-09-07')).toBe(23);
  });

  it('Havana 2025-03-09 starts at 05:00Z', () => {
    expect(iso('America/Havana', '2025-03-09')).toBe('2025-03-09T05:00:00.000Z');
  });

  it('Azores 2025-03-30 starts at 01:00Z', () => {
    expect(iso('Atlantic/Azores', '2025-03-30')).toBe('2025-03-30T01:00:00.000Z');
  });

  it('Amman 2021-10-29 (clock falls back across midnight) starts at the FIRST midnight and is 25 hours', () => {
    expect(iso('Asia/Amman', '2021-10-29')).toBe('2021-10-28T21:00:00.000Z');
    expect(dayLengthHours('Asia/Amman', '2021-10-29')).toBe(25);
  });

  it('Apia 2011-12-30 never existed: an empty window', () => {
    expect(localDateStartUtc('Pacific/Apia', '2011-12-30').getTime()).toBe(
      localDateStartUtc('Pacific/Apia', '2011-12-31').getTime(),
    );
  });

  it('day windows have the tiling properties around every transition 2000–2030 in the curated midnight zones', () => {
    const zones = [
      'Asia/Amman',
      'Asia/Gaza',
      'Asia/Hebron',
      'Asia/Jerusalem',
      'Asia/Chita',
      'Asia/Magadan',
      'Asia/Colombo',
      'Antarctica/Casey',
      'Antarctica/Davis',
      'Antarctica/Vostok',
      'Pacific/Apia',
      'Pacific/Fakaofo',
      'America/Santiago',
      'America/Havana',
      'Atlantic/Azores',
      'America/Asuncion',
      'America/Scoresbysund',
    ].filter(isSupportedTimeZone);
    const problems: string[] = [];
    for (const tz of zones) {
      for (const date of transitionDates(tz, 2000, 2030)) {
        problems.push(...dayWindowProblems(tz, date));
      }
    }
    expect(problems).toEqual([]);
  }, 180_000);

  it('day windows have the tiling properties around every transition 2024–2027 in every supported zone', () => {
    const zones = Intl.supportedValuesOf('timeZone');
    const problems: string[] = [];
    for (const tz of zones) {
      for (const date of transitionDates(tz, 2024, 2027)) {
        problems.push(...dayWindowProblems(tz, date));
      }
    }
    expect(problems).toEqual([]);
  }, 300_000);

  it('does not depend on the server process timezone', () => {
    const cases: Array<[string, string]> = [
      ['Europe/London', '2026-10-25'],
      ['America/Santiago', '2025-09-07'],
      ['Asia/Tokyo', '2026-09-14'],
    ];
    const before = cases.map(([tz, date]) => iso(tz, date));
    const original = process.env.TZ;
    process.env.TZ = 'Pacific/Kiritimati';
    try {
      expect(cases.map(([tz, date]) => iso(tz, date))).toEqual(before);
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
  });
});

describe('isSupportedTimeZone', () => {
  it('accepts IANA zones, UTC and Etc aliases', () => {
    expect(isSupportedTimeZone('Europe/London')).toBe(true);
    expect(isSupportedTimeZone('UTC')).toBe(true);
    expect(isSupportedTimeZone('Etc/GMT+5')).toBe(true);
  });

  it('rejects typos and empty values without throwing', () => {
    expect(isSupportedTimeZone('Europe/Londn')).toBe(false);
    expect(isSupportedTimeZone('')).toBe(false);
    expect(isSupportedTimeZone('   ')).toBe(false);
  });
});

describe('shared calendar-date helpers', () => {
  it('period-dates re-exports the domain isLocalDate', () => {
    expect(isLocalDate).toBe(domainIsLocalDate);
  });

  it('isLocalDate matches the previous Date.UTC check on edge cases', () => {
    const previous = (value: string) => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
      const [y, m, d] = value.split('-').map(Number);
      const probe = new Date(Date.UTC(y, m - 1, d));
      return probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d;
    };
    const samples = [
      '2026-07-28', '2026-02-28', '2026-02-29', '2024-02-29', '2000-02-29', '1900-02-29',
      '2026-02-30', '2026-13-01', '2026-00-10', '2026-04-31', '2026-12-31', '0099-12-31',
      '0100-01-01', '9999-12-31', '2026-7-28', '2026-07-28T00:00:00Z', '', 'yesterday',
    ];
    for (const sample of samples) {
      expect([sample, isLocalDate(sample)]).toEqual([sample, previous(sample)]);
    }
  });

  it('inclusiveDayCount counts both ends', () => {
    expect(inclusiveDayCount('2026-09-01', '2026-09-01')).toBe(1);
    expect(inclusiveDayCount('2024-01-01', '2024-12-31')).toBe(366);
    expect(inclusiveDayCount('2025-01-01', '2025-12-31')).toBe(365);
    expect(inclusiveDayCount('2026-09-02', '2026-09-01')).toBe(0);
  });
});
