import { capitalise, defaultPeriod, parseZacPeriod, periodFromInput } from './zac-period';

/**
 * Wednesday 8 September 2026, mid-morning UTC. Chosen deliberately: mid-week
 * and mid-month, so a week or month boundary computed wrongly cannot coincide
 * with the right answer by luck.
 */
const NOW = Date.parse('2026-09-08T10:30:00.000Z');

const at = (question: string, defaultDays = 30) => parseZacPeriod(question, defaultDays, NOW);

describe('ZAC period resolution', () => {
  describe('boundaries match the canonical KPI window', () => {
    // resolveKpiWindow in kpi.calc.ts is the source of truth: UTC days, weeks
    // starting MONDAY, calendar months, EXCLUSIVE end. A drift here means ZAC
    // and the dashboard cover different seconds and quietly disagree.
    it('anchors "this week" to Monday, not to a rolling seven days', () => {
      const p = at('how did we do this week?');
      expect(p.fromIso).toBe('2026-09-07T00:00:00.000Z'); // Monday
      expect(p.kind).toBe('this_week');
    });

    it('makes "last week" the whole previous Monday-to-Monday block', () => {
      const p = at('how many appointments last week?');
      expect(p.fromIso).toBe('2026-08-31T00:00:00.000Z');
      expect(p.toIso).toBe('2026-09-07T00:00:00.000Z'); // exclusive
    });

    it('makes "last month" a calendar month, not thirty days', () => {
      const p = at('what were my top services last month?');
      expect(p.fromIso).toBe('2026-08-01T00:00:00.000Z');
      expect(p.toIso).toBe('2026-09-01T00:00:00.000Z');
      expect(p.label).toBe('last month');
    });

    it('starts "this month" on the first, ending now', () => {
      const p = at('how is retail doing this month?');
      expect(p.fromIso).toBe('2026-09-01T00:00:00.000Z');
      expect(p.toIso).toBe(new Date(NOW).toISOString());
    });

    it('resolves today and yesterday as whole UTC days', () => {
      expect(at('how many appointments today?').fromIso).toBe('2026-09-08T00:00:00.000Z');
      const y = at('what about yesterday?');
      expect(y.fromIso).toBe('2026-09-07T00:00:00.000Z');
      expect(y.toIso).toBe('2026-09-08T00:00:00.000Z');
    });

    it('handles quarters and years', () => {
      expect(at('how did we do last quarter?').fromIso).toBe('2026-04-01T00:00:00.000Z');
      expect(at('how did we do last quarter?').toIso).toBe('2026-07-01T00:00:00.000Z');
      expect(at('revenue last year?').fromIso).toBe('2025-01-01T00:00:00.000Z');
      expect(at('year to date?').fromIso).toBe('2026-01-01T00:00:00.000Z');
    });
  });

  describe('explicit counted windows', () => {
    it('reads "last 90 days" rather than matching the bare word "last"', () => {
      const p = at('cancellation rate over the last 90 days?');
      expect(p.kind).toBe('last_n_days');
      expect(p.fromIso).toBe('2026-06-10T10:30:00.000Z');
      expect(p.label).toBe('the last 90 days');
    });

    it('does not read "last 3 months" as "last month"', () => {
      const p = at('top services over the last 3 months?');
      expect(p.fromIso).toBe('2026-06-01T00:00:00.000Z');
      expect(p.label).toBe('the last 3 months');
    });

    it('supports weeks and singular units', () => {
      expect(at('the last 2 weeks').fromIso).toBe('2026-08-25T10:30:00.000Z');
      expect(at('the last 1 day').label).toBe('the last 1 day');
    });
  });

  describe('named months', () => {
    it('reads a bare month as the most recent one that has already happened', () => {
      const p = at('how many appointments in August?');
      expect(p.fromIso).toBe('2026-08-01T00:00:00.000Z');
      expect(p.label).toBe('August 2026');
    });

    it('rolls a not-yet-reached month back to last year', () => {
      // Asking about November in September means last November.
      const p = at('what did we take in November?');
      expect(p.fromIso).toBe('2025-11-01T00:00:00.000Z');
      expect(p.label).toBe('November 2025');
    });

    it('honours an explicit year', () => {
      expect(at('retail in March 2025').fromIso).toBe('2025-03-01T00:00:00.000Z');
    });

    it('never runs a named month past now', () => {
      // September 2026 is in progress: the window must stop at now, not at the
      // 1st of October, or the answer covers days that have not happened.
      expect(at('appointments in September').toIso).toBe(new Date(NOW).toISOString());
    });
  });

  describe('all time', () => {
    it('answers "all time" with a bounded window and says it is bounded', () => {
      const p = at('how many appointments have we ever taken?');
      expect(p.kind).toBe('all_time');
      expect(p.fromIso).toBe('2021-01-01T00:00:00.000Z');
      // The cap is stated: a bounded window must never read as "everything".
      expect(p.label).toContain('2021');
    });

    it('is not triggered by the word "every"', () => {
      expect(at('what happens every week?').kind).not.toBe('all_time');
    });
  });

  describe('honesty when a window cannot be served', () => {
    it('falls back and EXPLAINS when the range exceeds the cap', () => {
      const p = at('appointments over the last 40 years?');
      expect(p.kind).toBe('default');
      expect(p.unsupportedReason).toContain('at most 5 years');
      // The fallback is still usable — the tool answers, it just says which
      // window it actually used.
      expect(p.explicit).toBe(false);
    });

    it('refuses a future month rather than returning an empty window', () => {
      const p = at('how many appointments in December 2027?');
      expect(p.unsupportedReason).toContain('in the future');
      expect(p.kind).toBe('default');
    });
  });

  describe('defaults', () => {
    it('returns the tool default, marked non-explicit, when no period is named', () => {
      const p = at('how many appointments did we take?', 7);
      expect(p.kind).toBe('default');
      expect(p.explicit).toBe(false);
      expect(p.label).toBe('the last 7 days');
    });

    it('keeps each tool on its own default window', () => {
      expect(at('how is retail doing?', 30).label).toBe('the last 30 days');
      expect(at('how is retail doing?', 7).label).toBe('the last 7 days');
    });
  });

  describe('periodFromInput', () => {
    it('uses a supplied window', () => {
      const supplied = defaultPeriod(14, NOW);
      expect(periodFromInput({ period: supplied }, 30, NOW).label).toBe('the last 14 days');
    });

    it('falls back to the default for a missing or malformed input', () => {
      // A tool called directly — by a test or the planner — still behaves.
      expect(periodFromInput({}, 30, NOW).label).toBe('the last 30 days');
      expect(periodFromInput({ period: 'last month' }, 30, NOW).kind).toBe('default');
      expect(periodFromInput({ period: { fromIso: 1 } }, 30, NOW).kind).toBe('default');
    });
  });

  it('capitalises a label for the start of a sentence', () => {
    expect(capitalise('last month')).toBe('Last month');
    expect(capitalise('the last 7 days')).toBe('The last 7 days');
  });
});
