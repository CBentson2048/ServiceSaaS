import {
  occupiedOffsets,
  occupiedIntervalsFrom,
  toMultirangeLiteral,
  parseMultirange,
  type OccupancyService,
} from './occupied-ranges';

const MIN = 60_000;

describe('occupiedOffsets', () => {
  it('treats a segment-less service as wholly occupied', () => {
    const services: OccupancyService[] = [{ durationMinutes: 45, segments: [] }];
    expect(occupiedOffsets(services)).toEqual([{ startMs: 0, endMs: 45 * MIN }]);
  });

  it('skips stylist-free segments but keeps advancing the cursor', () => {
    // Application 15 (occupied) → Development 45 (free) → Toner 15 (occupied).
    const services: OccupancyService[] = [
      {
        durationMinutes: 75,
        segments: [
          { durationMinutes: 15, isStylistFree: false },
          { durationMinutes: 45, isStylistFree: true },
          { durationMinutes: 15, isStylistFree: false },
        ],
      },
    ];
    expect(occupiedOffsets(services)).toEqual([
      { startMs: 0, endMs: 15 * MIN },
      { startMs: 60 * MIN, endMs: 75 * MIN },
    ]);
  });

  it('returns nothing for an all-free service (never blocks)', () => {
    const services: OccupancyService[] = [
      { durationMinutes: 30, segments: [{ durationMinutes: 30, isStylistFree: true }] },
    ];
    expect(occupiedOffsets(services)).toEqual([]);
  });

  it('sequences multiple services back-to-back by full duration', () => {
    const services: OccupancyService[] = [
      { durationMinutes: 30, segments: [{ durationMinutes: 30, isStylistFree: true }] }, // fully free
      { durationMinutes: 20, segments: [] }, // occupied, starts at 30m
    ];
    expect(occupiedOffsets(services)).toEqual([{ startMs: 30 * MIN, endMs: 50 * MIN }]);
  });
});

describe('multirange literal <-> parse round trip', () => {
  it('formats absolute intervals and parses them back', () => {
    const start = new Date('2026-07-03T09:00:00.000Z');
    const services: OccupancyService[] = [
      {
        durationMinutes: 75,
        segments: [
          { durationMinutes: 15, isStylistFree: false },
          { durationMinutes: 45, isStylistFree: true },
          { durationMinutes: 15, isStylistFree: false },
        ],
      },
    ];
    const literal = toMultirangeLiteral(occupiedIntervalsFrom(services, start));
    expect(literal).toBe(
      '{["2026-07-03T09:00:00.000Z","2026-07-03T09:15:00.000Z"),["2026-07-03T10:00:00.000Z","2026-07-03T10:15:00.000Z")}',
    );
    const parsed = parseMultirange(literal);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].start.toISOString()).toBe('2026-07-03T09:00:00.000Z');
    expect(parsed[0].end.toISOString()).toBe('2026-07-03T09:15:00.000Z');
    expect(parsed[1].start.toISOString()).toBe('2026-07-03T10:00:00.000Z');
  });

  it('formats an empty interval set as {}', () => {
    expect(toMultirangeLiteral([])).toBe('{}');
  });
});

describe('parseMultirange (Postgres text output)', () => {
  it('parses Postgres space-separated timestamps with a bare hour offset', () => {
    const pg = '{["2026-07-03 09:00:00+00","2026-07-03 09:45:00+00")}';
    const parsed = parseMultirange(pg);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].start.toISOString()).toBe('2026-07-03T09:00:00.000Z');
    expect(parsed[0].end.toISOString()).toBe('2026-07-03T09:45:00.000Z');
  });

  it('parses a non-UTC offset to the correct instant', () => {
    const pg = '{["2026-07-03 11:00:00+02","2026-07-03 11:30:00+02")}';
    const parsed = parseMultirange(pg);
    expect(parsed[0].start.toISOString()).toBe('2026-07-03T09:00:00.000Z');
    expect(parsed[0].end.toISOString()).toBe('2026-07-03T09:30:00.000Z');
  });

  it('returns [] for an empty multirange or nullish input', () => {
    expect(parseMultirange('{}')).toEqual([]);
    expect(parseMultirange('')).toEqual([]);
    expect(parseMultirange(null)).toEqual([]);
    expect(parseMultirange(undefined)).toEqual([]);
  });

  it('parses multiple ranges', () => {
    const pg = '{["2026-07-03 09:00:00+00","2026-07-03 09:15:00+00"),["2026-07-03 10:00:00+00","2026-07-03 10:15:00+00")}';
    expect(parseMultirange(pg)).toHaveLength(2);
  });
});
