import { calculateHours, type HoursCalcInput } from './hours.calc';

const T = (iso: string) => Date.parse(iso);

// A Tuesday-anchored week: 2026-07-28 00:00 UTC .. 2026-08-04 00:00 UTC.
const WINDOW = {
  periodStartMs: T('2026-07-28T00:00:00Z'),
  periodEndMs: T('2026-08-04T00:00:00Z'),
};

function input(partial: Partial<HoursCalcInput>): HoursCalcInput {
  return {
    ...WINDOW,
    shifts: [],
    breaks: [],
    absences: [],
    approvedLeave: [],
    ...partial,
  };
}

describe('calculateHours', () => {
  it('sums shift hours and subtracts unpaid (not paid) breaks', () => {
    const rows = calculateHours(
      input({
        shifts: [
          { startsAtMs: T('2026-07-28T09:00:00Z'), endsAtMs: T('2026-07-28T17:00:00Z') },
          { startsAtMs: T('2026-07-29T09:00:00Z'), endsAtMs: T('2026-07-29T17:00:00Z') },
        ],
        breaks: [
          {
            startsAtMs: T('2026-07-28T12:00:00Z'),
            endsAtMs: T('2026-07-28T12:30:00Z'),
            isPaid: false,
          },
          {
            startsAtMs: T('2026-07-29T12:00:00Z'),
            endsAtMs: T('2026-07-29T12:30:00Z'),
            isPaid: true, // paid break stays worked
          },
        ],
      }),
    );
    expect(rows.find((r) => r.category === 'worked')!.hours).toBe(15.5);
  });

  it('clamps a shift straddling the period boundary to the period', () => {
    const rows = calculateHours(
      input({
        shifts: [
          // Overnight shift crossing the period start.
          { startsAtMs: T('2026-07-27T20:00:00Z'), endsAtMs: T('2026-07-28T04:00:00Z') },
        ],
      }),
    );
    expect(rows.find((r) => r.category === 'worked')!.hours).toBe(4);
  });

  it('categorises book-outs and only credits hours that displaced a shift', () => {
    const rows = calculateHours(
      input({
        shifts: [{ startsAtMs: T('2026-07-28T09:00:00Z'), endsAtMs: T('2026-07-28T17:00:00Z') }],
        absences: [
          {
            startsAtMs: T('2026-07-28T14:00:00Z'),
            endsAtMs: T('2026-07-28T17:00:00Z'),
            bookOutKey: 'training',
            absenceType: null,
          },
          {
            // Sick book-out on a day with NO shift — earns nothing.
            startsAtMs: T('2026-07-30T09:00:00Z'),
            endsAtMs: T('2026-07-30T17:00:00Z'),
            bookOutKey: 'sick_leave',
            absenceType: null,
          },
        ],
      }),
    );
    expect(rows.find((r) => r.category === 'worked')!.hours).toBe(5);
    expect(rows.find((r) => r.category === 'training')!.hours).toBe(3);
    expect(rows.find((r) => r.category === 'sickness')!.hours).toBe(0);
  });

  it('annual_leave book-outs become paid_holiday; lunch reduces worked with no category', () => {
    const rows = calculateHours(
      input({
        shifts: [{ startsAtMs: T('2026-07-28T09:00:00Z'), endsAtMs: T('2026-07-28T17:00:00Z') }],
        absences: [
          {
            startsAtMs: T('2026-07-28T09:00:00Z'),
            endsAtMs: T('2026-07-28T13:00:00Z'),
            bookOutKey: 'annual_leave',
            absenceType: null,
          },
          {
            startsAtMs: T('2026-07-28T13:00:00Z'),
            endsAtMs: T('2026-07-28T14:00:00Z'),
            bookOutKey: 'lunch',
            absenceType: null,
          },
        ],
      }),
    );
    expect(rows.find((r) => r.category === 'paid_holiday')!.hours).toBe(4);
    expect(rows.find((r) => r.category === 'worked')!.hours).toBe(3);
  });

  it('legacy absences without a book-out type fall back to absence_type', () => {
    const rows = calculateHours(
      input({
        shifts: [{ startsAtMs: T('2026-07-28T09:00:00Z'), endsAtMs: T('2026-07-28T17:00:00Z') }],
        absences: [
          {
            startsAtMs: T('2026-07-28T09:00:00Z'),
            endsAtMs: T('2026-07-28T11:00:00Z'),
            bookOutKey: null,
            absenceType: 'sickness',
          },
        ],
      }),
    );
    expect(rows.find((r) => r.category === 'sickness')!.hours).toBe(2);
    expect(rows.find((r) => r.category === 'worked')!.hours).toBe(6);
  });

  it('approved leave subtracts from worked and lands in unpaid_leave with an honesty note', () => {
    const rows = calculateHours(
      input({
        shifts: [
          { startsAtMs: T('2026-07-28T09:00:00Z'), endsAtMs: T('2026-07-28T17:00:00Z') },
          { startsAtMs: T('2026-07-29T09:00:00Z'), endsAtMs: T('2026-07-29T17:00:00Z') },
        ],
        approvedLeave: [
          // Whole day 2026-07-29 (already expanded to [start, end+1d)).
          { startsAtMs: T('2026-07-29T00:00:00Z'), endsAtMs: T('2026-07-30T00:00:00Z') },
        ],
      }),
    );
    expect(rows.find((r) => r.category === 'worked')!.hours).toBe(8);
    const leave = rows.find((r) => r.category === 'unpaid_leave')!;
    expect(leave.hours).toBe(8);
    expect(leave.notes).toContain('no paid/unpaid flag');
  });

  it('emits all eight categories, with explanatory notes on sourceless ones', () => {
    const rows = calculateHours(input({}));
    expect(rows).toHaveLength(8);
    expect(rows.find((r) => r.category === 'additional')!.notes).toContain('not captured');
    expect(rows.find((r) => r.category === 'manual_adjustment')!.notes).toContain('not captured');
  });

  it('cross-category overlapping book-outs never inflate total hours (each moment counted once)', () => {
    const rows = calculateHours(
      input({
        shifts: [{ startsAtMs: T('2026-07-28T09:00:00Z'), endsAtMs: T('2026-07-28T17:00:00Z') }],
        absences: [
          {
            startsAtMs: T('2026-07-28T09:00:00Z'),
            endsAtMs: T('2026-07-28T13:00:00Z'),
            bookOutKey: 'annual_leave',
            absenceType: null,
          },
          {
            startsAtMs: T('2026-07-28T09:00:00Z'),
            endsAtMs: T('2026-07-28T13:00:00Z'),
            bookOutKey: 'training',
            absenceType: null,
          },
        ],
      }),
    );
    const total = rows.reduce((sum, r) => sum + r.hours, 0);
    expect(total).toBe(8); // an 8h shift can never yield more than 8 hours
    // Training wins the overlapped time (CATEGORY_PRECEDENCE), holiday gets 0.
    expect(rows.find((r) => r.category === 'training')!.hours).toBe(4);
    expect(rows.find((r) => r.category === 'paid_holiday')!.hours).toBe(0);
    expect(rows.find((r) => r.category === 'worked')!.hours).toBe(4);
  });

  it('unpaid breaks are not paid even when a paid book-out covers them', () => {
    const rows = calculateHours(
      input({
        shifts: [{ startsAtMs: T('2026-07-28T09:00:00Z'), endsAtMs: T('2026-07-28T17:00:00Z') }],
        breaks: [
          {
            startsAtMs: T('2026-07-28T12:00:00Z'),
            endsAtMs: T('2026-07-28T13:00:00Z'),
            isPaid: false,
          },
        ],
        absences: [
          {
            startsAtMs: T('2026-07-28T09:00:00Z'),
            endsAtMs: T('2026-07-28T17:00:00Z'),
            bookOutKey: 'annual_leave',
            absenceType: null,
          },
        ],
      }),
    );
    expect(rows.find((r) => r.category === 'paid_holiday')!.hours).toBe(7);
    expect(rows.find((r) => r.category === 'worked')!.hours).toBe(0);
  });

  it('merges overlapping shifts rather than double-counting', () => {
    const rows = calculateHours(
      input({
        shifts: [
          { startsAtMs: T('2026-07-28T09:00:00Z'), endsAtMs: T('2026-07-28T14:00:00Z') },
          { startsAtMs: T('2026-07-28T12:00:00Z'), endsAtMs: T('2026-07-28T17:00:00Z') },
        ],
      }),
    );
    expect(rows.find((r) => r.category === 'worked')!.hours).toBe(8);
  });
});
