import { ZacEvidenceService } from './zac-evidence.service';
import { ZacPriorityService } from './zac-priority.service';
import type { ZacToolResult } from '../tools/zac-tool.types';

/**
 * Priority-quality evaluation (§29).
 *
 * Intent accuracy says nothing about whether the ANSWER was any good. The
 * reported defect scored perfectly on routing — right mode, right intent, right
 * tools — and still returned one problem three times for a request for two.
 * These are the numbers that would have caught it.
 */
const CASES: Array<{ question: string; expectedCount: number }> = [
  { question: 'tell me 2 most importnat things i should focus on', expectedCount: 2 },
  { question: 'tell me the single most important thing', expectedCount: 1 },
  { question: 'what is the one thing I should fix?', expectedCount: 1 },
  { question: 'give me my top 2 priorites', expectedCount: 2 },
  { question: 'whats the 2 biggest things to sort', expectedCount: 2 },
  { question: 'two main things i need to work on', expectedCount: 2 },
  { question: 'top three', expectedCount: 3 },
  { question: 'three biggest issues', expectedCount: 3 },
  { question: 'give me five priorities', expectedCount: 5 },
  { question: 'give me my top 20 priorities', expectedCount: 5 },
  { question: 'what should I focus on?', expectedCount: 3 },
  { question: 'use everything you have access to and tell me what matters most', expectedCount: 3 },
  { question: 'look across the business and tell me what needs my attention', expectedCount: 3 },
  { question: '3 most inportant areas plz', expectedCount: 3 },
  { question: 'if i only had an hour, what 2 things would you fix', expectedCount: 2 },
];

const RANGE = { range_start: '2026-07-27', range_end: '2026-08-26' };
const GOAL = [{ kind: 'business_goal', summary: 'Increase rebooking to 60%.' }];

const ok = (data: Record<string, unknown>): ZacToolResult => ({
  status: 'ok',
  data,
  explanation: '',
  rowCount: 1,
  presentation: {
    answer: 'x',
    evidence: [{ source_type: 'qlooqo.dashboard', source_ref: 'kpis', as_of: null, entities_used: [] }],
    confidence: 'medium',
    limitations: [],
    suggestedNextStep: null,
    responseType: 'Insight',
  },
});

describe('priority quality evaluation', () => {
  const evidence = new ZacEvidenceService();
  const priorities = new ZacPriorityService();

  /** The hosted evidence state: two tools on rebooking, plus the team view. */
  const signals = () => [
    ...evidence.normalise(
      'report.business_health',
      ok({
        ...RANGE,
        total_revenue_cents: 480000,
        currency_code: 'GBP',
        total_bookings: 120,
        completed_bookings: 110,
        cancelled_bookings: 22,
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
    ...evidence.normalise(
      'report.kpi_summary',
      ok({
        period_start: RANGE.range_start,
        period_end: RANGE.range_end,
        stylists: Array.from({ length: 6 }, (_, index) => ({
          stylist_name: `S${index}`,
          rebooking_met: false,
          all_kpis_met: false,
          rebooking_threshold_percent: 50,
        })),
      }),
      GOAL,
    ),
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

  it('reports the priority-quality metrics', () => {
    let countViolations = 0;
    let exactDuplicates = 0;
    let sameDomainDuplicates = 0;
    let distinctTotal = 0;
    let priorityTotal = 0;
    let unsupported = 0;
    let countCorrect = 0;

    for (const testCase of CASES) {
      const requested = priorities.requestedCount(testCase.question);
      if (requested === testCase.expectedCount) countCorrect += 1;

      const consolidation = priorities.consolidate(signals());
      const top = priorities.selectTop(consolidation.candidates, requested);

      if (top.length > requested) countViolations += 1;
      const ids = top.map((candidate) => candidate.id);
      exactDuplicates += ids.length - new Set(ids).size;
      const domains = top.map((candidate) => candidate.domain);
      sameDomainDuplicates += domains.length - new Set(domains).size;
      distinctTotal += new Set(domains).size;
      priorityTotal += top.length;
      // Every priority must be backed by a real signal with real evidence.
      unsupported += top.filter(
        (candidate) => candidate.evidenceRefs.length === 0 || !candidate.primarySignal,
      ).length;
    }

    const report = [
      '',
      '  PRIORITY QUALITY (deterministic)',
      `  requested-count accuracy        ${((countCorrect / CASES.length) * 100).toFixed(1)}%`,
      `  requested-count violations      ${countViolations}`,
      `  exact duplicate priorities      ${exactDuplicates}`,
      `  same-domain duplicate priorities ${sameDomainDuplicates}`,
      `  distinct-priority rate          ${((distinctTotal / priorityTotal) * 100).toFixed(1)}%`,
      `  unsupported priorities          ${unsupported}`,
    ].join('\n');
    // eslint-disable-next-line no-console
    console.log(report);

    // The three that must be zero: the user's instruction is respected, no
    // priority appears twice, and nothing is raised without evidence.
    expect(countViolations).toBe(0);
    expect(exactDuplicates).toBe(0);
    expect(unsupported).toBe(0);
    expect(countCorrect).toBe(CASES.length);
    // Measured and reported rather than asserted at zero: two genuinely
    // independent issues inside one domain would be legitimate.
    expect(sameDomainDuplicates).toBe(0);
    expect(distinctTotal / priorityTotal).toBe(1);
  });
});
