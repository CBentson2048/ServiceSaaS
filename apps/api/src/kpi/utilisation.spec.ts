import { computeDailyUtilisation } from '@sheer/domain';

// Helper: build a ms interval from two hour-of-day numbers on a fixed UTC day.
function hours(startHour: number, endHour: number): { startMs: number; endMs: number } {
  return {
    startMs: Date.UTC(2026, 0, 1, startHour, 0, 0),
    endMs: Date.UTC(2026, 0, 1, endHour, 0, 0),
  };
}

const HOUR_MS = 3_600_000;

describe('computeDailyUtilisation', () => {
  it('measures booked time against available (shift − breaks − reducing book-outs)', () => {
    // 9–18 shift (9h), 30m lunch break, 1h staff meeting that reduces hours,
    // 6h of appointments → available 7.5h → 80%.
    const result = computeDailyUtilisation({
      shifts: [hours(9, 18)],
      breaks: [{ startMs: Date.UTC(2026, 0, 1, 13, 0, 0), endMs: Date.UTC(2026, 0, 1, 13, 30, 0) }],
      reducingBlocks: [hours(11, 12)],
      bookedMs: 6 * HOUR_MS,
    });
    expect(result.availableMs).toBe(7.5 * HOUR_MS);
    expect(result.bookedMs).toBe(6 * HOUR_MS);
    expect(result.utilisationPercent).toBe(80);
  });

  it('returns null utilisation when there is no available time', () => {
    const result = computeDailyUtilisation({ shifts: [], breaks: [], reducingBlocks: [], bookedMs: 0 });
    expect(result.availableMs).toBe(0);
    expect(result.utilisationPercent).toBeNull();
  });

  it('does not subtract a non-reducing block from available hours', () => {
    // A 2h admin block is NOT passed in reducingBlocks (its type has
    // reducesAvailableHours = false), so available stays 8h and 4h booked → 50%.
    const result = computeDailyUtilisation({
      shifts: [hours(9, 17)],
      breaks: [],
      reducingBlocks: [],
      bookedMs: 4 * HOUR_MS,
    });
    expect(result.availableMs).toBe(8 * HOUR_MS);
    expect(result.utilisationPercent).toBe(50);
  });

  it('handles overlapping breaks and blocks without double counting', () => {
    // Break and reducing block overlap (both 13–14); union removes 1h once.
    const result = computeDailyUtilisation({
      shifts: [hours(9, 18)],
      breaks: [hours(13, 14)],
      reducingBlocks: [hours(13, 14)],
      bookedMs: 4 * HOUR_MS,
    });
    expect(result.availableMs).toBe(8 * HOUR_MS);
    expect(result.utilisationPercent).toBe(50);
  });

  it('rounds the percentage', () => {
    const result = computeDailyUtilisation({
      shifts: [hours(9, 12)], // 3h available
      breaks: [],
      reducingBlocks: [],
      bookedMs: 1 * HOUR_MS, // 33.33%
    });
    expect(result.utilisationPercent).toBe(33);
  });
});
