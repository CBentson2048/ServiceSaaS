/**
 * Colour Prep windows are calendar concepts resolved against the salon's own
 * timezone. These cases pin the boundaries that break silently when a window is
 * computed in server-local time: the BST/GMT transitions, a zone far from UTC,
 * and the first and last instant of each preset.
 */
import { BadRequestException } from '@nestjs/common';
import {
  resolveColourPrepWindow,
  zonedDateString,
  zonedStartOfDay,
} from './date-range';

const LONDON = 'Europe/London';
const NEW_YORK = 'America/New_York';

describe('zonedStartOfDay', () => {
  it('resolves midnight in a zone that is UTC in winter', () => {
    expect(zonedStartOfDay(2026, 1, 15, LONDON).toISOString()).toBe('2026-01-15T00:00:00.000Z');
  });

  it('resolves midnight during British Summer Time', () => {
    // BST is UTC+1, so local midnight is 23:00 the previous UTC day.
    expect(zonedStartOfDay(2026, 7, 15, LONDON).toISOString()).toBe('2026-07-14T23:00:00.000Z');
  });

  it('resolves midnight on the day the clocks go forward', () => {
    // 29 March 2026: 01:00 GMT -> 02:00 BST. Midnight is still GMT.
    expect(zonedStartOfDay(2026, 3, 29, LONDON).toISOString()).toBe('2026-03-29T00:00:00.000Z');
  });

  it('resolves midnight on the day the clocks go back', () => {
    // 25 October 2026: the day starts in BST.
    expect(zonedStartOfDay(2026, 10, 25, LONDON).toISOString()).toBe('2026-10-24T23:00:00.000Z');
  });

  it('resolves midnight west of UTC', () => {
    expect(zonedStartOfDay(2026, 8, 19, NEW_YORK).toISOString()).toBe('2026-08-19T04:00:00.000Z');
  });
});

describe('zonedDateString', () => {
  it('reports the salon-local date, not the UTC date', () => {
    // 23:30 UTC in July is 00:30 the NEXT day in London.
    expect(zonedDateString(new Date('2026-07-14T23:30:00.000Z'), LONDON)).toBe('2026-07-15');
  });

  it('reports the previous local date west of UTC', () => {
    expect(zonedDateString(new Date('2026-08-19T02:00:00.000Z'), NEW_YORK)).toBe('2026-08-18');
  });
});

describe('resolveColourPrepWindow', () => {
  // Wednesday 19 August 2026, mid-morning in London (BST).
  const now = new Date('2026-08-19T09:00:00.000Z');

  it('today covers exactly one salon day', () => {
    const window = resolveColourPrepWindow('today', LONDON, { now });
    expect(window.fromDate).toBe('2026-08-19');
    expect(window.toDate).toBe('2026-08-19');
    expect(window.from.toISOString()).toBe('2026-08-18T23:00:00.000Z');
    expect(window.to.toISOString()).toBe('2026-08-19T23:00:00.000Z');
  });

  it('today follows the salon timezone, not the server', () => {
    // Same instant, a salon in New York: still 19 August there (05:00 local).
    const window = resolveColourPrepWindow('today', NEW_YORK, { now });
    expect(window.fromDate).toBe('2026-08-19');
    expect(window.from.toISOString()).toBe('2026-08-19T04:00:00.000Z');
  });

  it('this week runs Monday to Sunday inclusive', () => {
    const window = resolveColourPrepWindow('this_week', LONDON, { now });
    expect(window.fromDate).toBe('2026-08-17'); // Monday
    expect(window.toDate).toBe('2026-08-23'); // Sunday
    expect(window.from.toISOString()).toBe('2026-08-16T23:00:00.000Z');
    expect(window.to.toISOString()).toBe('2026-08-23T23:00:00.000Z');
  });

  it('next week starts the Monday after this week ends', () => {
    const window = resolveColourPrepWindow('next_week', LONDON, { now });
    expect(window.fromDate).toBe('2026-08-24');
    expect(window.toDate).toBe('2026-08-30');
  });

  it('this week and next week abut without gap or overlap', () => {
    const thisWeek = resolveColourPrepWindow('this_week', LONDON, { now });
    const nextWeek = resolveColourPrepWindow('next_week', LONDON, { now });
    expect(thisWeek.to.toISOString()).toBe(nextWeek.from.toISOString());
  });

  it('treats Sunday as the last day of the current week, not the first of the next', () => {
    const sunday = new Date('2026-08-23T12:00:00.000Z');
    const window = resolveColourPrepWindow('this_week', LONDON, { now: sunday });
    expect(window.fromDate).toBe('2026-08-17');
    expect(window.toDate).toBe('2026-08-23');
  });

  it('treats Monday as the first day of the current week', () => {
    const monday = new Date('2026-08-17T06:00:00.000Z');
    const window = resolveColourPrepWindow('this_week', LONDON, { now: monday });
    expect(window.fromDate).toBe('2026-08-17');
  });

  it('spans the spring clock change without losing an hour', () => {
    // Week containing 29 March 2026 (clocks forward): Mon 23rd -> Sun 29th.
    const window = resolveColourPrepWindow('this_week', LONDON, {
      now: new Date('2026-03-25T12:00:00.000Z'),
    });
    expect(window.fromDate).toBe('2026-03-23');
    expect(window.toDate).toBe('2026-03-29');
    expect(window.from.toISOString()).toBe('2026-03-23T00:00:00.000Z'); // GMT
    expect(window.to.toISOString()).toBe('2026-03-29T23:00:00.000Z'); // BST
  });

  it('custom ranges are inclusive of both local dates', () => {
    const window = resolveColourPrepWindow('custom', LONDON, {
      now,
      from: '2026-08-01',
      to: '2026-08-03',
    });
    expect(window.from.toISOString()).toBe('2026-07-31T23:00:00.000Z');
    expect(window.to.toISOString()).toBe('2026-08-03T23:00:00.000Z');
  });

  it('accepts a single-day custom range', () => {
    const window = resolveColourPrepWindow('custom', LONDON, {
      now,
      from: '2026-08-19',
      to: '2026-08-19',
    });
    const today = resolveColourPrepWindow('today', LONDON, { now });
    expect(window.from.toISOString()).toBe(today.from.toISOString());
    expect(window.to.toISOString()).toBe(today.to.toISOString());
  });

  it('rejects a custom range without both bounds', () => {
    expect(() => resolveColourPrepWindow('custom', LONDON, { now, from: '2026-08-01' })).toThrow(
      BadRequestException,
    );
  });

  it('rejects a reversed custom range', () => {
    expect(() =>
      resolveColourPrepWindow('custom', LONDON, { now, from: '2026-08-05', to: '2026-08-01' }),
    ).toThrow(BadRequestException);
  });

  it('rejects a malformed date', () => {
    expect(() =>
      resolveColourPrepWindow('custom', LONDON, { now, from: '19-08-2026', to: '2026-08-20' }),
    ).toThrow(BadRequestException);
  });

  it('rejects a date that does not exist', () => {
    expect(() =>
      resolveColourPrepWindow('custom', LONDON, { now, from: '2026-02-30', to: '2026-03-01' }),
    ).toThrow(BadRequestException);
  });
});
