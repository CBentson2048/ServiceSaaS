import {
  addDays,
  addMonths,
  alignToWeekStart,
  dayOfWeek,
  isLocalDate,
  localDateStartUtc,
  periodUtcWindow,
  resolvePeriodWindow,
  utcToLocalDate,
} from './period-dates';

describe('calendar arithmetic', () => {
  it('validates local dates strictly', () => {
    expect(isLocalDate('2026-07-28')).toBe(true);
    expect(isLocalDate('2026-02-30')).toBe(false);
    expect(isLocalDate('2026-7-28')).toBe(false);
  });

  it('adds days across month boundaries', () => {
    expect(addDays('2026-07-28', 7)).toBe('2026-08-04');
    expect(addDays('2026-08-01', -1)).toBe('2026-07-31');
  });

  it('adds months with end-of-month clamping', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2026-07-01', 1)).toBe('2026-08-01');
  });

  it('aligns to the Tuesday week anchor (payroll_settings.week_start_day = 2)', () => {
    expect(dayOfWeek('2026-07-28')).toBe(2); // a Tuesday
    expect(alignToWeekStart('2026-07-28', 2)).toBe('2026-07-28');
    expect(alignToWeekStart('2026-08-03', 2)).toBe('2026-07-28'); // Monday -> prior Tuesday
    expect(alignToWeekStart('2026-07-29', 2)).toBe('2026-07-28');
  });

  it('resolves weekly and monthly windows', () => {
    expect(resolvePeriodWindow('weekly', 2, '2026-07-30')).toEqual({
      periodStart: '2026-07-28',
      periodEnd: '2026-08-04',
    });
    expect(resolvePeriodWindow('monthly', 2, '2026-07-30')).toEqual({
      periodStart: '2026-07-01',
      periodEnd: '2026-08-01',
    });
    expect(resolvePeriodWindow('fortnightly', 2, '2026-07-28').periodEnd).toBe('2026-08-11');
  });
});

describe('timezone conversion (Europe/London, BST/GMT)', () => {
  it('a London Tuesday midnight is 23:00 UTC Monday during BST', () => {
    // 2026-07-28 is in British Summer Time (UTC+1).
    expect(localDateStartUtc('Europe/London', '2026-07-28').toISOString()).toBe(
      '2026-07-27T23:00:00.000Z',
    );
  });

  it('a London Tuesday midnight is 00:00 UTC during GMT', () => {
    // 2026-01-06 is in GMT (UTC+0).
    expect(localDateStartUtc('Europe/London', '2026-01-06').toISOString()).toBe(
      '2026-01-06T00:00:00.000Z',
    );
  });

  it('handles the BST -> GMT transition week (clocks back 2026-10-25)', () => {
    const window = periodUtcWindow('Europe/London', '2026-10-20', '2026-10-27');
    // Start is inside BST (UTC+1), end is after the switch (UTC+0):
    expect(window.fromUtc).toBe('2026-10-19T23:00:00.000Z');
    expect(window.toUtc).toBe('2026-10-27T00:00:00.000Z');
  });

  it('attributes a late-evening UTC visit to the next London local date in BST', () => {
    // 23:30 UTC Monday is 00:30 BST Tuesday — belongs to the Tuesday-start week.
    expect(utcToLocalDate('Europe/London', '2026-07-27T23:30:00Z')).toBe('2026-07-28');
    // The same wall-clock instant in GMT stays Monday.
    expect(utcToLocalDate('Europe/London', '2026-01-05T23:30:00Z')).toBe('2026-01-05');
  });

  it('round-trips: the period UTC window contains exactly the local dates of the period', () => {
    const { fromUtc, toUtc } = periodUtcWindow('Europe/London', '2026-07-28', '2026-08-04');
    expect(utcToLocalDate('Europe/London', fromUtc)).toBe('2026-07-28');
    expect(utcToLocalDate('Europe/London', Date.parse(toUtc) - 1)).toBe('2026-08-03');
  });
});
