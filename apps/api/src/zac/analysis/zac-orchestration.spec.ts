import type { AuthUser } from '@sheer/domain';
import type { ZacActingContext } from '../context/zac-context.types';
import type { ZacToolResult } from '../tools/zac-tool.types';
import { ZacAnalysisIntentService } from './zac-analysis-intent.service';
import { ZacEvidenceService } from './zac-evidence.service';
import { ZacToolPlannerService } from './zac-tool-planner.service';
import { MAX_MULTI_TOOL_CALLS, type ZacPlanningToolDescriptor } from './zac-analysis.types';

function makeContext(roleContext: ZacActingContext['roleContext'] = 'owner'): ZacActingContext {
  return {
    actorUserId: 'user-1',
    actorFirstName: 'Luke',
    businessId: 'biz-1',
    businessName: 'Main Salon',
    locationId: null,
    accessibleLocationIds: ['loc-1'],
    accessibleLocations: [{ id: 'loc-1', name: 'Main' }],
    roleContext,
    roles: [roleContext],
    permissions: ['zac.access'],
    staffProfileId: roleContext === 'stylist' ? 'staff-1' : null,
    requestSource: 'web_dashboard',
    timezone: 'Europe/London',
    locale: 'en-GB',
    firstAssistantTurn: true,
  } as ZacActingContext;
}

const OWNER_CATALOGUE: ZacPlanningToolDescriptor[] = [
  { name: 'report.business_health', purpose: 'Trading snapshot', domains: ['business_health'] },
  { name: 'report.kpi_summary', purpose: 'Stylists against targets', domains: ['kpi'] },
  { name: 'report.rebooking_summary', purpose: 'Rebooking', domains: ['rebooking'] },
  { name: 'report.utilisation_summary', purpose: 'Utilisation', domains: ['utilisation'] },
  { name: 'report.stylist_performance', purpose: 'Ranking', domains: ['team_performance'] },
];

describe('analysis intent — what kind of analysis is this?', () => {
  const intents = new ZacAnalysisIntentService();
  const intentOf = (question: string, role: ZacActingContext['roleContext'] = 'owner'): string =>
    (intents.classifyCertain(question, role) ?? intents.classifyHeuristic(question, role)).intent;

  /**
   * Section 7 / 51: the acceptance standard is that no trigger phrase exists.
   * None of these share a keyword with "what should I focus on", and every one
   * of them must still be recognised as a broad prioritisation request.
   */
  const BROAD = [
    'Use everything you have access to and tell me the 3 most important things I should focus on.',
    'What should I focus on first?',
    'If I only had one hour today, where should I spend it?',
    'Look across my business and tell me what needs my attention.',
    'What are my biggest opportunities right now?',
    'Taking everything you know about my business into account, what are my top three priorities?',
    'Use all the information you are allowed to see and tell me what matters most.',
    'Look across everything and tell me my biggest three priorities.',
    'What are the three things I should care about most today?',
    'If you were me, where would you focus first based on the business?',
    'Taking all my current figures into account, where are the biggest gaps?',
    "Don't just give me one KPI — tell me what actually needs attention.",
    'Based on everything you can see, what should I do first?',
    'Taking everything into account, what would you work on first?',
    'If you were running my salon today, where would you spend your attention?',
    'Looking across the business, what matters most?',
    'What are the three areas I should care about right now?',
  ];

  it.each(BROAD)('recognises "%s" as a broad priority question', (question) => {
    expect(intentOf(question)).toBe('business_priorities');
  });

  it('keeps a single named metric narrow — breadth is earned, not applied', () => {
    for (const question of [
      'What is my rebooking rate?',
      'What is my utilisation this week?',
      'How much revenue did we make?',
      'What is my average booking value?',
    ]) {
      expect(intentOf(question)).toBe('specific_metric');
    }
  });

  it('keeps the overview question on the overview answer', () => {
    for (const question of ['How is my business doing?', 'How healthy is my business?']) {
      expect(intentOf(question)).toBe('business_health');
    }
  });

  it('recognises team, diagnostic and comparison shapes', () => {
    expect(intentOf('Which team members need my attention this week?')).toBe('team_priorities');
    expect(intentOf('Where should I focus my coaching this week?')).toBe('team_priorities');
    expect(intentOf('Why is rebooking falling?')).toBe('diagnostic');
    expect(intentOf('Why are Tuesdays quiet?')).toBe('diagnostic');
    expect(intentOf('How does this month compare with last month?')).toBe('comparison');
  });

  it('a stylist never lands on a team-wide intent from their own phrasing', () => {
    expect(intentOf('Which team members need my attention this week?', 'stylist')).not.toBe(
      'team_priorities',
    );
  });
});

describe('tool planner — bounded, validated, permission-shaped', () => {
  const planner = new ZacToolPlannerService({} as never);

  it('plans several complementary sources for a broad priority question', () => {
    const plan = planner.fallbackPlan('business_priorities', makeContext(), OWNER_CATALOGUE);

    expect(plan.tools.length).toBeGreaterThan(1);
    expect(plan.tools.length).toBeLessThanOrEqual(MAX_MULTI_TOOL_CALLS);
    expect(plan.synthesisStrategy).toBe('rank_business_priorities');
    // Complementary, not three views of the same thing.
    expect(new Set(plan.tools.map((tool) => tool.toolName)).size).toBe(plan.tools.length);
  });

  it('plans nothing for a specific metric — that path stays single-tool', () => {
    expect(planner.fallbackPlan('specific_metric', makeContext(), OWNER_CATALOGUE).tools).toEqual([]);
  });

  it('leads a diagnostic with the metric the question actually named', () => {
    const plan = planner.fallbackPlan(
      'diagnostic',
      makeContext(),
      OWNER_CATALOGUE,
      'report.utilisation_summary',
    );
    expect(plan.tools[0].toolName).toBe('report.utilisation_summary');
    expect(plan.tools[0].purpose).toBe('baseline');
  });

  it('plans only self-scoped sources for a stylist', () => {
    const stylistCatalogue: ZacPlanningToolDescriptor[] = [
      { name: 'kpi.personal_coaching', purpose: 'Own KPIs', domains: ['personal_performance'] },
      { name: 'schedule.my_appointments', purpose: 'Own diary', domains: ['appointments'] },
    ];
    const plan = planner.fallbackPlan('business_priorities', makeContext('stylist'), stylistCatalogue);

    for (const tool of plan.tools) {
      expect(['kpi.personal_coaching', 'schedule.my_appointments']).toContain(tool.toolName);
    }
  });

  it('plans only what a permission-restricted actor can actually run', () => {
    const restricted: ZacPlanningToolDescriptor[] = [
      { name: 'report.business_health', purpose: 'Trading snapshot', domains: ['business_health'] },
    ];
    const plan = planner.fallbackPlan('business_priorities', makeContext(), restricted);

    expect(plan.tools.map((tool) => tool.toolName)).toEqual(['report.business_health']);
  });

  describe('validation of an untrusted plan', () => {
    it('discards an invented tool name', () => {
      const { tools, rejected } = planner.validatePlan(
        [{ tool_name: 'report.everything', purpose: 'baseline' }],
        'business_priorities',
        OWNER_CATALOGUE,
      );
      expect(tools).toEqual([]);
      expect(rejected).toContain('report.everything');
    });

    it('discards a real tool that is not in THIS actor’s catalogue', () => {
      const { tools, rejected } = planner.validatePlan(
        [{ tool_name: 'kpi.personal_coaching', purpose: 'baseline' }],
        'business_priorities',
        OWNER_CATALOGUE,
      );
      // A real, registered tool — but not one this catalogue offered.
      expect(tools).toEqual([]);
      expect(rejected).toContain('kpi.personal_coaching');
    });

    it('discards malformed entries without taking the plan down', () => {
      const { tools } = planner.validatePlan(
        [null, 42, { purpose: 'baseline' }, { tool_name: 'report.business_health', purpose: 'x' }],
        'business_priorities',
        OWNER_CATALOGUE,
      );
      expect(tools).toEqual([{ toolName: 'report.business_health', purpose: 'supporting_evidence' }]);
    });

    it('enforces the tool cap and drops duplicates', () => {
      const { tools } = planner.validatePlan(
        [
          ...OWNER_CATALOGUE.map((entry) => ({ tool_name: entry.name, purpose: 'priority_signal' })),
          { tool_name: 'report.business_health', purpose: 'baseline' },
          { tool_name: 'report.kpi_summary', purpose: 'baseline' },
        ],
        'business_priorities',
        OWNER_CATALOGUE,
      );
      expect(tools.length).toBeLessThanOrEqual(MAX_MULTI_TOOL_CALLS);
      expect(new Set(tools.map((tool) => tool.toolName)).size).toBe(tools.length);
    });

    it('falls back to the deterministic plan when nothing survives validation', () => {
      const plan = planner.planFrom({
        intent: 'business_priorities',
        context: makeContext(),
        catalogue: OWNER_CATALOGUE,
        modelTools: [{ tool_name: 'report.invented', purpose: 'baseline' }],
      });

      // The turn still reads live data — a planning miss is not a data outage.
      expect(plan.tools.length).toBeGreaterThan(0);
      expect(plan.source).toBe('fallback_plan');
      expect(plan.rejectedTools).toContain('report.invented');
    });

    it('uses a valid model plan when it survives', () => {
      const plan = planner.planFrom({
        intent: 'business_priorities',
        context: makeContext(),
        catalogue: OWNER_CATALOGUE,
        modelTools: [
          { tool_name: 'report.rebooking_summary', purpose: 'priority_signal' },
          { tool_name: 'report.utilisation_summary', purpose: 'priority_signal' },
        ],
        confidence: 0.9,
      });

      expect(plan.source).toBe('semantic_model');
      expect(plan.tools.map((tool) => tool.toolName)).toEqual([
        'report.rebooking_summary',
        'report.utilisation_summary',
      ]);
    });
  });
});

describe('evidence normalisation and ranking', () => {
  const evidence = new ZacEvidenceService();
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

  it('extracts comparable signals from business health', () => {
    const signals = evidence.normalise(
      'report.business_health',
      ok({
        total_revenue_cents: 125000,
        currency_code: 'GBP',
        total_bookings: 100,
        cancelled_bookings: 20,
        completed_bookings: 80,
        new_clients: 30,
        repeat_clients: 50,
        rebooking_rate_percent: 39,
      }),
    );

    const metrics = signals.map((signal) => signal.metric);
    expect(metrics).toContain('Revenue in the reporting period');
    expect(metrics).toContain('Rebooking rate');
    // 20 of 100 cancelled is a subtraction between two REPORTED counts.
    const cancellations = signals.find((signal) => signal.metric === 'Cancelled share of bookings');
    expect(cancellations?.currentValue).toBe(20);
    expect(cancellations?.severity).toBe('attention');
  });

  it('keeps a remembered goal separate from the live measurement', () => {
    const [signal] = evidence.normalise(
      'report.rebooking_summary',
      ok({ rebooking_rate_percent: 52 }),
      [{ kind: 'business_goal', summary: 'Increase rebooking to 60% this month.' }],
    );

    expect(signal.currentValue).toBe(52);
    expect(signal.targetValue).toBe(60);
    // The provenance is the point: 60% is the user's goal, not a QLOOQO figure.
    expect(signal.targetSource).toBe('user_memory_goal');
    expect(signal.severity).toBe('attention');
    expect(signal.headline).toContain('your stated goal');
  });

  it('reads utilisation against its configured threshold, with data-quality notes', () => {
    const [signal] = evidence.normalise(
      'report.utilisation_summary',
      ok({
        overall: { utilisationPercent: 48, availableMinutes: 100, bookedMinutes: 48, staffDayCount: 5 },
        previousPeriod: { utilisationPercent: 55, availableMinutes: 0, bookedMinutes: 0 },
        warningThresholdPercent: 60,
        quietestWeekday: 'Tuesday',
        dataQuality: ['Some shifts are missing.'],
      }),
    );

    expect(signal.currentValue).toBe(48);
    expect(signal.targetValue).toBe(60);
    expect(signal.targetSource).toBe('tool_threshold');
    expect(signal.direction).toBe('declining');
    expect(signal.severity).toBe('attention');
    // Incomplete data lowers confidence rather than being hidden.
    expect(signal.confidence).toBeLessThan(0.8);
    expect(signal.limitations).toContain('Some shifts are missing.');
  });

  it('normalises nothing from a failed or empty tool result', () => {
    expect(
      evidence.normalise('report.business_health', {
        status: 'unavailable',
        data: null,
        explanation: 'no data',
        rowCount: null,
      }),
    ).toEqual([]);
  });

  it('ranks what misses a target above what does not', () => {
    const signals = [
      ...evidence.normalise('report.business_health', ok({ total_revenue_cents: 500000, currency_code: 'GBP', total_bookings: 100, cancelled_bookings: 2, completed_bookings: 98, new_clients: 10, repeat_clients: 90 })),
      ...evidence.normalise('report.rebooking_summary', ok({ rebooking_rate_percent: 30 }), [
        { kind: 'business_goal', summary: 'Rebooking goal is 60%.' },
      ]),
    ];
    const ranked = evidence.rank(signals);

    expect(ranked[0].metric).toBe('Rebooking rate');
    expect(ranked[0].priorityScore).toBeGreaterThan(ranked[ranked.length - 1].priorityScore);
  });
});

describe('planner cannot widen access', () => {
  const planner = new ZacToolPlannerService({} as never);

  it('a plan naming every registered tool still yields only the permitted ones', () => {
    const permittedOnly: ZacPlanningToolDescriptor[] = [
      { name: 'report.business_health', purpose: 'Trading snapshot', domains: ['business_health'] },
    ];
    const { tools } = planner.validatePlan(
      [
        { tool_name: 'report.business_health', purpose: 'baseline' },
        { tool_name: 'report.kpi_summary', purpose: 'priority_signal' },
        { tool_name: 'report.stylist_performance', purpose: 'priority_signal' },
        { tool_name: 'kpi.personal_coaching', purpose: 'priority_signal' },
        { tool_name: 'qlab.colour_analytics', purpose: 'priority_signal' },
        { tool_name: 'inventory.stock_status', purpose: 'priority_signal' },
      ],
      'business_priorities',
      permittedOnly,
    );

    expect(tools.map((tool) => tool.toolName)).toEqual(['report.business_health']);
  });
});

/** The catalogue itself is the security boundary the planner sees. */
describe('catalogue construction', () => {
  it('never offers a disabled tool, whatever the actor holds', () => {
    const registry = {
      buildFor: (): unknown[] => [
        { name: 'report.business_health', enabled: true },
        { name: 'qlab.colour_analytics', enabled: false },
        { name: 'inventory.stock_status', enabled: false },
        { name: 'context.capabilities', enabled: true },
      ],
      allTools: (): unknown[] => [],
    };
    const planner = new ZacToolPlannerService(registry as never);

    const catalogue = planner.catalogueFor({} as AuthUser);

    expect(catalogue.map((entry) => entry.name)).toEqual(['report.business_health']);
  });
});
