import { MoneySourceShapeError, instantKey, localDateTime, poundsToCents } from './money-values';

describe('instantKey', () => {
  it('keeps microseconds and sorts exactly as text', () => {
    expect(instantKey('2026-09-14T10:00:00.123456+00:00')).toBe('2026-09-14T10:00:00.123456Z');
    expect(instantKey('2026-09-14 10:00:00+00')).toBe('2026-09-14T10:00:00.000000Z');
    expect(instantKey('2026-09-14T10:00:00.5Z')).toBe('2026-09-14T10:00:00.500000Z');
    const keys = ['2026-09-14T10:00:00.000002Z', '2026-09-14T10:00:00.000010Z', '2026-09-14T09:59:59.999999Z'].sort();
    expect(keys).toEqual(['2026-09-14T09:59:59.999999Z', '2026-09-14T10:00:00.000002Z', '2026-09-14T10:00:00.000010Z']);
  });

  it('refuses non-UTC renderings and non-instants rather than guessing', () => {
    for (const value of ['2026-09-14T10:00:00+01:00', '2026-09-14', 'yesterday', 1_000, null, '2026-09-14T10:00:00.1234567Z']) {
      expect(() => instantKey(value)).toThrow(MoneySourceShapeError);
    }
  });
});

describe('poundsToCents', () => {
  it('converts numeric(12,2) pounds exactly', () => {
    expect(poundsToCents('15.00')).toBe(1500);
    expect(poundsToCents('0.1')).toBe(10);
    expect(poundsToCents(15.5)).toBe(1550);
    expect(poundsToCents(0.29)).toBe(29);
    expect(poundsToCents(1234567.89)).toBe(123456789);
    expect(poundsToCents('1234567.89')).toBe(123456789);
  });

  it('refuses more than two decimals, negatives and non-numbers', () => {
    for (const value of ['1.005', 1.005, -1, '-1.00', 'abc', null, Number.NaN]) {
      expect(() => poundsToCents(value)).toThrow(MoneySourceShapeError);
    }
  });
});

describe('localDateTime', () => {
  it('uses each location’s own calendar and clock, never UTC', () => {
    expect(localDateTime('Europe/London', '2026-09-14T23:30:00.000000Z')).toEqual({ localDate: '2026-09-15', localTime: '00:30' });
    expect(localDateTime('Asia/Tokyo', '2026-09-14T15:00:00.000000Z')).toEqual({ localDate: '2026-09-15', localTime: '00:00' });
    expect(localDateTime('America/New_York', '2026-09-14T03:59:59.999999Z')).toEqual({ localDate: '2026-09-13', localTime: '23:59' });
  });

  it('follows DST: the repeated autumn hour and the missing spring hour', () => {
    expect(localDateTime('Europe/London', '2026-10-25T00:30:00.000000Z')).toEqual({ localDate: '2026-10-25', localTime: '01:30' });
    expect(localDateTime('Europe/London', '2026-10-25T01:30:00.000000Z')).toEqual({ localDate: '2026-10-25', localTime: '01:30' });
    expect(localDateTime('Europe/London', '2026-03-29T01:00:00.000000Z')).toEqual({ localDate: '2026-03-29', localTime: '02:00' });
  });
});
