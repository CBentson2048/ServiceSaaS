/**
 * Per-location report windows — the time matrix from the approved Ticket A plan.
 *
 * Every expected value was computed independently (in-memory Node, ICU tzdata)
 * before this file was written. Week start is 2 (Tuesday), as configured for
 * every dev-test business and LOH; 2026-09-13 is a Sunday.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveLocalRange, resolveReportWindows, reportLocalStatus, utcInstantString } from './report-window';
import type { ReportFilter, WeekStartDay } from '@sheer/domain';

const LONDON = { id: 'london', timezone: 'Europe/London' };
const TOKYO = { id: 'tokyo', timezone: 'Asia/Tokyo' };
const NEW_YORK = { id: 'new-york', timezone: 'America/New_York' };
const THREE = [LONDON, TOKYO, NEW_YORK];

const short = (iso: string) => iso.replace(':00.000Z', 'Z');

/** "from..to [fromUtc, toUtcExclusive) status" per location id. */
function at(
  asOf: string,
  filter: Pick<ReportFilter, 'preset' | 'from' | 'to'>,
  weekStartDay: WeekStartDay | null = 2,
  locations = THREE,
): Record<string, string> {
  return Object.fromEntries(
    resolveReportWindows(locations, filter, new Date(asOf), weekStartDay).map((w) => [
      w.locationId,
      `${w.from}..${w.to} [${short(w.fromUtc)}, ${short(w.toUtcExclusive)}) ${w.status}`,
    ]),
  );
}

describe('relative presets resolve independently per location — 2026-09-13T15:30:00Z', () => {
  // London Sun 16:30 BST · Tokyo Mon 00:30 JST · New York Sun 11:30 EDT
  const asOf = '2026-09-13T15:30:00Z';

  it.each([
    ['today', {
      london: '2026-09-13..2026-09-13 [2026-09-12T23:00Z, 2026-09-13T23:00Z) in_progress',
      tokyo: '2026-09-14..2026-09-14 [2026-09-13T15:00Z, 2026-09-14T15:00Z) in_progress',
      'new-york': '2026-09-13..2026-09-13 [2026-09-13T04:00Z, 2026-09-14T04:00Z) in_progress',
    }],
    ['yesterday', {
      london: '2026-09-12..2026-09-12 [2026-09-11T23:00Z, 2026-09-12T23:00Z) complete',
      tokyo: '2026-09-13..2026-09-13 [2026-09-12T15:00Z, 2026-09-13T15:00Z) complete',
      'new-york': '2026-09-12..2026-09-12 [2026-09-12T04:00Z, 2026-09-13T04:00Z) complete',
    }],
    ['this_week', {
      london: '2026-09-08..2026-09-13 [2026-09-07T23:00Z, 2026-09-13T23:00Z) in_progress',
      tokyo: '2026-09-08..2026-09-14 [2026-09-07T15:00Z, 2026-09-14T15:00Z) in_progress',
      'new-york': '2026-09-08..2026-09-13 [2026-09-08T04:00Z, 2026-09-14T04:00Z) in_progress',
    }],
    ['last_week', {
      london: '2026-09-01..2026-09-07 [2026-08-31T23:00Z, 2026-09-07T23:00Z) complete',
      tokyo: '2026-09-01..2026-09-07 [2026-08-31T15:00Z, 2026-09-07T15:00Z) complete',
      'new-york': '2026-09-01..2026-09-07 [2026-09-01T04:00Z, 2026-09-08T04:00Z) complete',
    }],
    ['this_month', {
      london: '2026-09-01..2026-09-13 [2026-08-31T23:00Z, 2026-09-13T23:00Z) in_progress',
      tokyo: '2026-09-01..2026-09-14 [2026-08-31T15:00Z, 2026-09-14T15:00Z) in_progress',
      'new-york': '2026-09-01..2026-09-13 [2026-09-01T04:00Z, 2026-09-14T04:00Z) in_progress',
    }],
    ['last_month', {
      london: '2026-08-01..2026-08-31 [2026-07-31T23:00Z, 2026-08-31T23:00Z) complete',
      tokyo: '2026-08-01..2026-08-31 [2026-07-31T15:00Z, 2026-08-31T15:00Z) complete',
      'new-york': '2026-08-01..2026-08-31 [2026-08-01T04:00Z, 2026-09-01T04:00Z) complete',
    }],
  ] as const)('%s', (preset, expected) => {
    expect(at(asOf, { preset })).toEqual(expected);
  });

  it('reports each location’s own local today', () => {
    const windows = resolveReportWindows(THREE, { preset: 'today' }, new Date(asOf), 2);
    expect(windows.map((w) => [w.locationId, w.localToday])).toEqual([
      ['london', '2026-09-13'],
      ['tokyo', '2026-09-14'],
      ['new-york', '2026-09-13'],
    ]);
  });

  it('uses the configured week start (0 = Sunday, 1 = Monday, 6 = Saturday)', () => {
    const london = (wsd: WeekStartDay) => at(asOf, { preset: 'this_week' }, wsd, [LONDON]).london;
    expect(london(0)).toBe('2026-09-13..2026-09-13 [2026-09-12T23:00Z, 2026-09-13T23:00Z) in_progress');
    expect(london(1)).toBe('2026-09-07..2026-09-13 [2026-09-06T23:00Z, 2026-09-13T23:00Z) in_progress');
    expect(london(6)).toBe('2026-09-12..2026-09-13 [2026-09-11T23:00Z, 2026-09-13T23:00Z) in_progress');
  });
});

describe('Tokyo midnight and locations more than a day apart', () => {
  it('Tokyo turns over at 15:00Z while London stays on the 13th', () => {
    expect(at('2026-09-13T14:59:59Z', { preset: 'today' }, 2, [LONDON, TOKYO])).toEqual({
      london: '2026-09-13..2026-09-13 [2026-09-12T23:00Z, 2026-09-13T23:00Z) in_progress',
      tokyo: '2026-09-13..2026-09-13 [2026-09-12T15:00Z, 2026-09-13T15:00Z) in_progress',
    });
    expect(at('2026-09-13T15:00:00Z', { preset: 'today' }, 2, [LONDON, TOKYO])).toEqual({
      london: '2026-09-13..2026-09-13 [2026-09-12T23:00Z, 2026-09-13T23:00Z) in_progress',
      tokyo: '2026-09-14..2026-09-14 [2026-09-13T15:00Z, 2026-09-14T15:00Z) in_progress',
    });
  });

  it('"this week" covers different weeks for eight hours on 2026-09-14', () => {
    expect(at('2026-09-14T15:00:00Z', { preset: 'this_week' }, 2, [LONDON, TOKYO])).toEqual({
      london: '2026-09-08..2026-09-14 [2026-09-07T23:00Z, 2026-09-14T23:00Z) in_progress',
      tokyo: '2026-09-15..2026-09-15 [2026-09-14T15:00Z, 2026-09-15T15:00Z) in_progress',
    });
    expect(at('2026-09-14T15:00:00Z', { preset: 'last_week' }, 2, [LONDON, TOKYO])).toEqual({
      london: '2026-09-01..2026-09-07 [2026-08-31T23:00Z, 2026-09-07T23:00Z) complete',
      tokyo: '2026-09-08..2026-09-14 [2026-09-07T15:00Z, 2026-09-14T15:00Z) complete',
    });
  });

  it('"this month" and "last month" cover different months on 2026-09-30', () => {
    expect(at('2026-09-30T15:00:00Z', { preset: 'this_month' }, 2, [LONDON, TOKYO])).toEqual({
      london: '2026-09-01..2026-09-30 [2026-08-31T23:00Z, 2026-09-30T23:00Z) in_progress',
      tokyo: '2026-10-01..2026-10-01 [2026-09-30T15:00Z, 2026-10-01T15:00Z) in_progress',
    });
    expect(at('2026-09-30T15:00:00Z', { preset: 'last_month' }, 2, [LONDON, TOKYO])).toEqual({
      london: '2026-08-01..2026-08-31 [2026-07-31T23:00Z, 2026-08-31T23:00Z) complete',
      tokyo: '2026-09-01..2026-09-30 [2026-08-31T15:00Z, 2026-09-30T15:00Z) complete',
    });
  });
});

describe('London DST days', () => {
  it('spring forward 2026-03-29: today is 23 h, this month 695 h in London and New York', () => {
    expect(at('2026-03-29T12:00:00Z', { preset: 'today' })).toEqual({
      london: '2026-03-29..2026-03-29 [2026-03-29T00:00Z, 2026-03-29T23:00Z) in_progress',
      tokyo: '2026-03-29..2026-03-29 [2026-03-28T15:00Z, 2026-03-29T15:00Z) in_progress',
      'new-york': '2026-03-29..2026-03-29 [2026-03-29T04:00Z, 2026-03-30T04:00Z) in_progress',
    });
    expect(at('2026-03-29T12:00:00Z', { preset: 'this_week' }).london).toBe(
      '2026-03-24..2026-03-29 [2026-03-24T00:00Z, 2026-03-29T23:00Z) in_progress',
    );
    expect(at('2026-03-29T12:00:00Z', { preset: 'this_month' })['new-york']).toBe(
      '2026-03-01..2026-03-29 [2026-03-01T05:00Z, 2026-03-30T04:00Z) in_progress',
    );
    expect(at('2026-03-29T12:00:00Z', { preset: 'last_month' }).london).toBe(
      '2026-02-01..2026-02-28 [2026-02-01T00:00Z, 2026-03-01T00:00Z) complete',
    );
  });

  it('fall back 2026-10-25: today is 25 h, this week 145 h in London', () => {
    expect(at('2026-10-25T12:00:00Z', { preset: 'today' }).london).toBe(
      '2026-10-25..2026-10-25 [2026-10-24T23:00Z, 2026-10-26T00:00Z) in_progress',
    );
    expect(at('2026-10-25T12:00:00Z', { preset: 'this_week' }).london).toBe(
      '2026-10-20..2026-10-25 [2026-10-19T23:00Z, 2026-10-26T00:00Z) in_progress',
    );
    expect(at('2026-10-25T12:00:00Z', { preset: 'this_month' })).toEqual({
      london: '2026-10-01..2026-10-25 [2026-09-30T23:00Z, 2026-10-26T00:00Z) in_progress',
      tokyo: '2026-10-01..2026-10-25 [2026-09-30T15:00Z, 2026-10-25T15:00Z) in_progress',
      'new-york': '2026-10-01..2026-10-25 [2026-10-01T04:00Z, 2026-10-26T04:00Z) in_progress',
    });
  });

  it('a zone that skips midnight (Santiago 2025-09-07) tiles with the day before', () => {
    const santiago = { id: 'santiago', timezone: 'America/Santiago' };
    expect(at('2025-09-07T12:00:00Z', { preset: 'today' }, 2, [santiago]).santiago).toBe(
      '2025-09-07..2025-09-07 [2025-09-07T04:00Z, 2025-09-08T03:00Z) in_progress',
    );
    expect(at('2025-09-07T12:00:00Z', { preset: 'yesterday' }, 2, [santiago]).santiago).toBe(
      '2025-09-06..2025-09-06 [2025-09-06T04:00Z, 2025-09-07T04:00Z) complete',
    );
  });
});

describe('custom ranges apply as given at every location', () => {
  const asOf = '2026-09-13T15:30:00Z'; // local today: London 13, Tokyo 14, New York 13

  it('the same local dates give each location its own interval, with no clamping', () => {
    expect(at(asOf, { preset: 'custom', from: '2026-09-01', to: '2026-09-14' })).toEqual({
      london: '2026-09-01..2026-09-14 [2026-08-31T23:00Z, 2026-09-14T23:00Z) in_progress',
      tokyo: '2026-09-01..2026-09-14 [2026-08-31T15:00Z, 2026-09-14T15:00Z) in_progress',
      'new-york': '2026-09-01..2026-09-14 [2026-09-01T04:00Z, 2026-09-15T04:00Z) in_progress',
    });
  });

  it('a day that has started only in Tokyo is not_started in London and New York', () => {
    expect(at(asOf, { preset: 'custom', from: '2026-09-14', to: '2026-09-14' })).toEqual({
      london: '2026-09-14..2026-09-14 [2026-09-13T23:00Z, 2026-09-14T23:00Z) not_started',
      tokyo: '2026-09-14..2026-09-14 [2026-09-13T15:00Z, 2026-09-14T15:00Z) in_progress',
      'new-york': '2026-09-14..2026-09-14 [2026-09-14T04:00Z, 2026-09-15T04:00Z) not_started',
    });
  });

  it('a range entirely in the future resolves (not_started everywhere) rather than failing', () => {
    expect(at(asOf, { preset: 'custom', from: '2026-09-15', to: '2026-09-20' })).toEqual({
      london: '2026-09-15..2026-09-20 [2026-09-14T23:00Z, 2026-09-20T23:00Z) not_started',
      tokyo: '2026-09-15..2026-09-20 [2026-09-14T15:00Z, 2026-09-20T15:00Z) not_started',
      'new-york': '2026-09-15..2026-09-20 [2026-09-15T04:00Z, 2026-09-21T04:00Z) not_started',
    });
  });

  it('a 366-day range spans a leap day', () => {
    expect(at(asOf, { preset: 'custom', from: '2025-09-14', to: '2026-09-14' }, 2, [LONDON]).london).toBe(
      '2025-09-14..2026-09-14 [2025-09-13T23:00Z, 2026-09-14T23:00Z) in_progress',
    );
  });

  it('resolves the last YYYY-MM-DD date, 9999-12-31, in every zone with instants Postgres can parse', () => {
    const zones = [
      { id: 'westmost', timezone: 'Etc/GMT+12' },
      { id: 'london', timezone: 'Europe/London' },
      { id: 'eastmost', timezone: 'Pacific/Kiritimati' },
    ];
    const windows = resolveReportWindows(zones, { preset: 'custom', from: '9999-12-31', to: '9999-12-31' }, new Date(asOf), 2);
    expect(windows.map((w) => [w.locationId, w.fromUtc, w.toUtcExclusive, w.status])).toEqual([
      ['westmost', '9999-12-31T12:00:00.000Z', '10000-01-01T12:00:00.000Z', 'not_started'],
      ['london', '9999-12-31T00:00:00.000Z', '10000-01-01T00:00:00.000Z', 'not_started'],
      ['eastmost', '9999-12-30T10:00:00.000Z', '9999-12-31T10:00:00.000Z', 'not_started'],
    ]);
  });

  it('writes instants past year 9999 unsigned, and leaves every other instant exactly as toISOString', () => {
    expect(utcInstantString(new Date(Date.UTC(10000, 0, 1, 12)))).toBe('10000-01-01T12:00:00.000Z');
    expect(utcInstantString(new Date('2026-09-13T23:00:00.000Z'))).toBe('2026-09-13T23:00:00.000Z');
    expect(utcInstantString(new Date('9999-12-31T23:59:59.999Z'))).toBe('9999-12-31T23:59:59.999Z');
  });

  it('a past range is complete', () => {
    expect(at(asOf, { preset: 'custom', from: '2026-08-01', to: '2026-08-31' }, 2, [LONDON]).london).toBe(
      '2026-08-01..2026-08-31 [2026-07-31T23:00Z, 2026-08-31T23:00Z) complete',
    );
  });
});

describe('calendar edges', () => {
  it('yesterday of 1 March in a leap year is 29 February', () => {
    expect(resolveLocalRange({ preset: 'yesterday' }, '2028-03-01', 2)).toEqual({ from: '2028-02-29', to: '2028-02-29' });
  });

  it('last month from January is the previous December, and from 31 March is all of February', () => {
    expect(resolveLocalRange({ preset: 'last_month' }, '2027-01-05', 2)).toEqual({ from: '2026-12-01', to: '2026-12-31' });
    expect(resolveLocalRange({ preset: 'last_month' }, '2026-03-31', 2)).toEqual({ from: '2026-02-01', to: '2026-02-28' });
  });

  it('this month on the 1st and this week on the week-start day are one day', () => {
    expect(resolveLocalRange({ preset: 'this_month' }, '2026-10-01', 2)).toEqual({ from: '2026-10-01', to: '2026-10-01' });
    expect(resolveLocalRange({ preset: 'this_week' }, '2026-09-15', 2)).toEqual({ from: '2026-09-15', to: '2026-09-15' });
  });

  it('last week is always seven days, for every week start', () => {
    for (const wsd of [0, 1, 2, 6] as WeekStartDay[]) {
      const range = resolveLocalRange({ preset: 'last_week' }, '2026-09-13', wsd);
      const days = (Date.parse(range.to) - Date.parse(range.from)) / 86_400_000 + 1;
      expect([wsd, days]).toEqual([wsd, 7]);
    }
  });

  it('week presets refuse to run without a week start; other presets ignore it', () => {
    expect(() => resolveLocalRange({ preset: 'this_week' }, '2026-09-13', null)).toThrow(/week start/);
    expect(() => resolveLocalRange({ preset: 'last_week' }, '2026-09-13', null)).toThrow(/week start/);
    for (const preset of ['today', 'yesterday', 'this_month', 'last_month'] as const) {
      expect(resolveLocalRange({ preset }, '2026-09-13', null)).toEqual(resolveLocalRange({ preset }, '2026-09-13', 3));
    }
  });

  it('a custom preset without dates is a programming error, never a default range', () => {
    expect(() => resolveLocalRange({ preset: 'custom', from: '2026-09-01' }, '2026-09-13', 2)).toThrow();
  });

  it('classifies ranges against today', () => {
    expect(reportLocalStatus({ from: '2026-09-01', to: '2026-09-12' }, '2026-09-13')).toBe('complete');
    expect(reportLocalStatus({ from: '2026-09-13', to: '2026-09-13' }, '2026-09-13')).toBe('in_progress');
    expect(reportLocalStatus({ from: '2026-09-14', to: '2026-09-20' }, '2026-09-13')).toBe('not_started');
  });
});

describe('independence from the server clock and zone', () => {
  it('uses no local-time Date API and reads no clock (the instant is passed in)', () => {
    // Reassigning process.env.TZ inside Jest does not change the zone Date uses,
    // so this is enforced on the source.
    const source = readFileSync(join(__dirname, 'report-window.ts'), 'utf8');
    expect(source).not.toMatch(
      /\.(get|set)(FullYear|Month|Date|Day|Hours|Minutes|Seconds|Milliseconds)\s*\(|getTimezoneOffset|toLocale\w*\(|new Date\(|Date\.now/,
    );
  });
});
