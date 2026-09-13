import type { ResolvedReportLocation } from '@sheer/domain';
import {
  formatReportDate,
  formatReportDateRange,
  groupReportScope,
  sharedLocalRange,
} from './reportScopeLine';

const location = (
  name: string,
  from: string,
  to: string,
  status: ResolvedReportLocation['status'],
  localToday = to,
): ResolvedReportLocation => ({
  id: name.toLowerCase(),
  name,
  timezone: 'Europe/London',
  isActive: true,
  timezoneValid: true,
  localToday,
  from,
  to,
  status,
});

describe('report date wording', () => {
  it('formats single dates, same-month, cross-month and cross-year ranges', () => {
    expect(formatReportDate('2026-09-28')).toBe('28 Sept 2026');
    expect(formatReportDateRange('2026-09-28', '2026-09-28')).toBe('28 Sept 2026');
    expect(formatReportDateRange('2026-09-22', '2026-09-28')).toBe('22–28 Sept 2026');
    expect(formatReportDateRange('2026-09-29', '2026-10-01')).toBe('29 Sept – 1 Oct 2026');
    expect(formatReportDateRange('2025-12-30', '2026-01-02')).toBe('30 Dec 2025 – 2 Jan 2026');
  });

  it('does not depend on the browser timezone or locale', () => {
    // Pure string handling: the same output whatever TZ the test runs under.
    expect(formatReportDateRange('2026-03-29', '2026-03-29')).toBe('29 Mar 2026');
  });
});

describe('groupReportScope', () => {
  it('groups locations sharing a local range and status, in first-seen order', () => {
    const groups = groupReportScope([
      location('London', '2026-09-28', '2026-09-28', 'in_progress'),
      location('Tokyo', '2026-09-29', '2026-09-29', 'in_progress'),
      location('New York', '2026-09-28', '2026-09-28', 'in_progress'),
    ]);
    expect(groups.map((g) => [g.label, g.locationNames])).toEqual([
      ['28 Sept 2026 (in progress)', ['London', 'New York']],
      ['29 Sept 2026 (in progress)', ['Tokyo']],
    ]);
  });

  it('says "not started" for an unstarted range — never a zero', () => {
    const [group] = groupReportScope([location('London', '2026-09-29', '2026-09-29', 'not_started', '2026-09-28')]);
    expect(group.label).toBe('29 Sept 2026 (not started)');
  });

  it('adds nothing for a completed range', () => {
    const [group] = groupReportScope([location('London', '2026-08-01', '2026-08-31', 'complete', '2026-09-28')]);
    expect(group.label).toBe('1–31 Aug 2026');
  });

  it('keeps the same dates apart when their status differs', () => {
    const groups = groupReportScope([
      location('London', '2026-09-29', '2026-09-29', 'not_started', '2026-09-28'),
      location('Tokyo', '2026-09-29', '2026-09-29', 'in_progress', '2026-09-29'),
    ]);
    expect(groups).toHaveLength(2);
  });
});

describe('sharedLocalRange', () => {
  it('returns the range only when every location shares it', () => {
    expect(sharedLocalRange(null)).toBeNull();
    expect(sharedLocalRange([])).toBeNull();
    expect(
      sharedLocalRange([location('A', '2026-09-22', '2026-09-28', 'in_progress'), location('B', '2026-09-22', '2026-09-28', 'complete')]),
    ).toEqual({ from: '2026-09-22', to: '2026-09-28' });
    expect(
      sharedLocalRange([location('A', '2026-09-22', '2026-09-28', 'in_progress'), location('B', '2026-09-29', '2026-09-29', 'in_progress')]),
    ).toBeNull();
  });
});
