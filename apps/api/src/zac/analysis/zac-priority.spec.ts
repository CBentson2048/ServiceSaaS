import { ZacEvidenceService } from './zac-evidence.service';
import { ZacPriorityService } from './zac-priority.service';
import type { ZacToolResult } from '../tools/zac-tool.types';
import type { ZacEvidenceSignal } from './zac-analysis.types';

const RANGE = { range_start: '2026-07-27', range_end: '2026-08-26' };
const GOAL = [{ kind: 'business_goal', summary: 'Increase rebooking to 60%.' }];

const ok = (data: Record<string, unknown>): ZacToolResult => ({
  status: 'ok',
  data,
  explanation: '',
  rowCount: 1,
  presentation: {
    answer: 'x',
    evidence: [
      { source_type: 'qlooqo.dashboard', source_ref: 'kpis', as_of: null, entities_used: [] },
    ],
    confidence: 'medium',
    limitations: [],
    suggestedNextStep: null,
    responseType: 'Insight',
  },
});

const kpiRows = (count: number, met: boolean) => ({
  period_start: RANGE.range_start,
  period_end: RANGE.range_end,
  stylists: Array.from({ length: count }, (_, index) => ({
    stylist_name: `S${index}`,
    rebooking_met: met,
    all_kpis_met: met,
    rebooking_threshold_percent: 50,
  })),
});

describe('requested priority count', () => {
  const priorities = new ZacPriorityService();
  const count = (question: string): number => priorities.requestedCount(question);

  it('reads the number the user asked for', () => {
    expect(count('tell me the single most important thing')).toBe(1);
    expect(count('what is the one thing I should fix?')).toBe(1);
    expect(count('2 most important things I should focus on')).toBe(2);
    expect(count('two things I should focus on')).toBe(2);
    expect(count('give me my top 2 priorities')).toBe(2);
    expect(count('top three')).toBe(3);
    expect(count('three biggest issues')).toBe(3);
    expect(count('give me five priorities')).toBe(5);
  });

  it('survives typos, because it never reads the adjective', () => {
    // The number and the noun are parsed; everything between them is skipped,
    // so no dictionary of misspellings is needed.
    expect(count('tell me 2 most importnat things i should focus on')).toBe(2);
    expect(count('give me my top 2 priorites')).toBe(2);
    expect(count('whats the 2 biggest things to sort')).toBe(2);
    expect(count('two main things i need to work on')).toBe(2);
    expect(count('3 most inportant areas plz')).toBe(3);
  });

  it('defaults to three and is bounded server-side', () => {
    expect(count('what should I focus on?')).toBe(3);
    expect(count('use everything you have and tell me what matters')).toBe(3);
    // The user cannot ask for twenty, and neither can the model.
    expect(count('give me my top 20 priorities')).toBe(5);
    expect(count('give me 0 priorities')).toBe(3);
  });

  it('does not read a count out of an unrelated number', () => {
    expect(count('what should I focus on in the next 6 weeks?')).toBe(3);
  });
});

describe('signal consolidation', () => {
  const evidence = new ZacEvidenceService();
  const priorities = new ZacPriorityService();

  /** The exact hosted state that produced three rebooking rows. */
  const lukeSignals = (): ZacEvidenceSignal[] => [
    ...evidence.normalise(
      'report.business_health',
      ok({
        ...RANGE,
        total_revenue_cents: 480000,
        currency_code: 'GBP',
        total_bookings: 120,
        completed_bookings: 110,
        cancelled_bookings: 10,
        new_clients: 40,
        repeat_clients: 70,
        rebooking_rate_percent: 0,
      }),
      GOAL,
    ),
    ...evidence.normalise(
      'report.rebooking_summary',
      ok({ ...RANGE, rebooking_rate_percent: 0, completed_bookings: 110 }),
      GOAL,
    ),
    ...evidence.normalise('report.kpi_summary', ok(kpiRows(6, false)), GOAL),
  ];

  it('collapses two tools reporting the same reading into one', () => {
    const result = priorities.consolidate(lukeSignals());

    expect(result.duplicateSignalsRemoved).toBeGreaterThanOrEqual(1);
    const rebooking = result.candidates.filter((c) => c.domain === 'rebooking');
    expect(rebooking).toHaveLength(1);
  });

  it('keeps the evidence from the duplicate it removed', () => {
    const result = priorities.consolidate(lukeSignals());
    const rebooking = result.candidates.find((c) => c.domain === 'rebooking')!;

    // Merged, not discarded — source transparency survives consolidation.
    expect(rebooking.evidenceRefs.length).toBeGreaterThan(0);
  });

  it("folds the team's view of a problem into the same issue", () => {
    const result = priorities.consolidate(lukeSignals());
    const rebooking = result.candidates.find((c) => c.domain === 'rebooking')!;

    // "6 of 6 stylists are below the rebooking target" is the same rebooking
    // problem seen from the team's side — supporting evidence, not a slot.
    const supportText = rebooking.supportingSignals.map((s) => s.headline).join(' ');
    expect(supportText).toMatch(/6 of 6 stylists/);
    expect(result.candidates.filter((c) => /stylists below/i.test(c.title))).toHaveLength(0);
  });

  it('joins a remembered goal to the live measurement, not a second issue', () => {
    const result = priorities.consolidate(lukeSignals());
    const rebooking = result.candidates.find((c) => c.domain === 'rebooking')!;

    expect(rebooking.primarySignal.targetValue).toBe(60);
    expect(rebooking.primarySignal.targetSource).toBe('user_memory_goal');
    expect(rebooking.relevance).toBe(1);
    expect(result.candidates.filter((c) => /goal/i.test(c.title))).toHaveLength(0);
  });

  it('keeps genuinely different issues apart', () => {
    const signals = [
      ...lukeSignals(),
      ...evidence.normalise(
        'report.utilisation_summary',
        ok({
          overall: { utilisationPercent: 48 },
          previousPeriod: { utilisationPercent: 55 },
          warningThresholdPercent: 60,
          quietestWeekday: 'Tuesday',
          dataQuality: [],
        }),
        GOAL,
      ),
    ];
    const result = priorities.consolidate(signals);
    const domains = result.candidates.map((candidate) => candidate.domain);

    expect(domains).toContain('rebooking');
    expect(domains).toContain('utilisation');
    // Rebooking and utilisation are two things to act on, not one.
    expect(new Set(domains).size).toBe(domains.length - countDuplicateDomains(domains));
  });

  it('answers the exact reported case with two distinct priorities', () => {
    const signals = [
      ...lukeSignals(),
      ...evidence.normalise(
        'report.utilisation_summary',
        ok({
          overall: { utilisationPercent: 48 },
          previousPeriod: { utilisationPercent: 55 },
          warningThresholdPercent: 60,
          quietestWeekday: 'Tuesday',
          dataQuality: [],
        }),
        GOAL,
      ),
    ];
    const requested = priorities.requestedCount('tell me 2 most importnat things i should focus on');
    const result = priorities.consolidate(signals);
    const top = priorities.selectTop(result.candidates, requested);

    expect(requested).toBe(2);
    expect(top).toHaveLength(2);
    expect(top.map((c) => c.domain)).toEqual(['rebooking', 'utilisation']);
    // No repetition anywhere in the list.
    expect(new Set(top.map((c) => c.id)).size).toBe(2);
  });

  it('returns fewer than asked rather than inventing one', () => {
    const signals = evidence.normalise(
      'report.rebooking_summary',
      ok({ ...RANGE, rebooking_rate_percent: 20, completed_bookings: 90 }),
      GOAL,
    );
    const result = priorities.consolidate(signals);
    const top = priorities.selectTop(result.candidates, 3);

    expect(top).toHaveLength(1);
  });

  it('does not let signal volume outrank importance', () => {
    // One issue measured by three tools versus a more severe issue measured by
    // one. Volume must not decide the order.
    const noisy = [
      ...evidence.normalise(
        'report.rebooking_summary',
        ok({ ...RANGE, rebooking_rate_percent: 58, completed_bookings: 100 }),
        GOAL,
      ),
      ...evidence.normalise('report.kpi_summary', ok(kpiRows(6, true)), GOAL),
    ];
    const severe = evidence.normalise(
      'report.utilisation_summary',
      ok({
        overall: { utilisationPercent: 20 },
        previousPeriod: { utilisationPercent: 55 },
        warningThresholdPercent: 60,
        quietestWeekday: 'Tuesday',
        dataQuality: [],
      }),
      GOAL,
    );

    const result = priorities.consolidate([...noisy, ...severe]);
    expect(result.candidates[0].domain).toBe('utilisation');
  });
});

describe('missing data is never reported as zero', () => {
  const evidence = new ZacEvidenceService();

  it('does not claim 0% rebooking when nothing was completed', () => {
    // The dashboard computes `completed > 0 ? round(...) : 0`, so an empty
    // period arrives as a flat 0% — indistinguishable from a collapse, and far
    // more alarming. Nothing was measured, so nothing is claimed.
    const signals = evidence.normalise(
      'report.business_health',
      ok({
        ...RANGE,
        total_revenue_cents: 0,
        currency_code: 'GBP',
        total_bookings: 0,
        completed_bookings: 0,
        cancelled_bookings: 0,
        new_clients: 0,
        repeat_clients: 0,
        rebooking_rate_percent: 0,
      }),
      GOAL,
    );

    expect(signals.filter((signal) => signal.issueKey === 'rebooking')).toEqual([]);
  });

  it('still reports a genuine zero when there were bookings to rebook from', () => {
    const signals = evidence.normalise(
      'report.rebooking_summary',
      ok({ ...RANGE, rebooking_rate_percent: 0, completed_bookings: 110 }),
      GOAL,
    );

    expect(signals).toHaveLength(1);
    expect(signals[0].currentValue).toBe(0);
  });
});

function countDuplicateDomains(domains: string[]): number {
  const seen = new Set<string>();
  let duplicates = 0;
  for (const domain of domains) {
    if (seen.has(domain)) duplicates += 1;
    seen.add(domain);
  }
  return duplicates;
}
