import { ForbiddenException, NotFoundException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { AuthUser, DashboardKpisResponse } from '@sheer/domain';
import type { DashboardService } from '../dashboard/dashboard.service';
import type { KpiService } from '../kpi/kpi.service';
import type { LabAppointmentsService } from '../lab-appointments/lab-appointments.service';
import { ZacContextService } from './context/zac-context.service';
import type { ZacCostTelemetryService } from './measurement/zac-cost-telemetry.service';
import { StubZacModelProvider } from './models/providers/stub-zac-provider';
import {
  ZacModelIncompleteError,
  ZacModelRefusedError,
} from './models/zac-model-provider.interface';
import type { ZacModelProvider } from './models/zac-model-provider.interface';
import { ZacResponseBuilderService } from './responses/zac-response-builder.service';
import { ZacRoleProfileService } from './roles/zac-role-profile.service';
import { ZacToolRegistryService } from './tools/zac-tool-registry.service';
import { ZacRolloutService } from './zac-rollout.service';
import { ZacService } from './zac.service';

const KPI_SUMMARY = {
  totalRevenueCents: 125000,
  totalBookings: 42,
  completedBookings: 38,
  cancelledBookings: 4,
  noShowBookings: 0,
  newClients: 6,
  repeatClients: 20,
  rebookedVisits: 15,
  rebookingRatePercent: 39,
  stylistRebookedVisits: 10,
  clientRebookedVisits: 5,
  completedPaidBookings: 36,
  averageBookingValueCents: 3472,
  lowStockProducts: 1,
  currencyCode: 'GBP',
};

const KPI_FIXTURE: DashboardKpisResponse = {
  rangeStart: '2026-07-21T00:00:00.000Z',
  rangeEnd: '2026-07-28T00:00:00.000Z',
  scope: 'owner',
  locations: [{ id: 'loc-1', name: 'Main' }],
  summary: KPI_SUMMARY,
  byLocation: [{ locationId: 'loc-1', locationName: 'Main', ...KPI_SUMMARY }],
};

const STYLIST_PERF_FIXTURE = {
  rangeStart: '2026-07-21T00:00:00.000Z',
  rangeEnd: '2026-07-28T00:00:00.000Z',
  scope: 'owner',
  stylists: [
    {
      stylistName: 'Maya Chen',
      locationId: 'loc-1',
      locationName: 'Main',
      hourlyRate: 1450,
      totalBookings: 24,
      completedBookings: 22,
      cancelledBookings: 2,
      noShowBookings: 0,
      rebookedVisits: 12,
      rebookingRatePercent: 55,
      revenueCents: 84000,
      averageBookingValueCents: 3818,
      currencyCode: 'GBP',
    },
  ],
} as unknown as Awaited<ReturnType<DashboardService['stylistPerformance']>>;

const STYLIST_LIST_FIXTURE = {
  periodStart: '2026-07-29T00:00:00.000Z',
  periodEnd: '2026-08-05T00:00:00.000Z',
  period: 'month',
  scope: 'owner',
  locations: [{ id: 'loc-1', name: 'Main' }],
  commissionReadyCount: 1,
  stylists: [
    {
      stylistName: 'Maya Chen',
      locationName: 'Main',
      currencyCode: 'GBP',
      hoursWorked: 32,
      serviceTargetProgressPercent: 104,
      retailTargetProgressPercent: 88,
      rebooking: { rebookingRatePercent: 55, thresholdPercent: 50 },
      rebookingKpiMet: true,
      retailKpiMet: true,
      averageBillKpiMet: true,
      allKpisMet: true,
      commission: { tier: 'tier_3_5x', ratePercent: 15 },
      notes: [],
    },
    {
      stylistName: 'Jordan Blake',
      locationName: 'Main',
      currencyCode: 'GBP',
      hoursWorked: 28,
      serviceTargetProgressPercent: 61,
      retailTargetProgressPercent: 22,
      rebooking: { rebookingRatePercent: 33, thresholdPercent: 50 },
      rebookingKpiMet: false,
      retailKpiMet: false,
      averageBillKpiMet: true,
      allKpisMet: false,
      commission: { tier: 'below_3x', ratePercent: 0 },
      notes: [],
    },
  ],
} as unknown as Awaited<ReturnType<KpiService['stylistList']>>;

function makeActor(overrides: Partial<AuthUser> = {}): AuthUser {
  return {
    id: 'user-1',
    roles: ['owner'],
    primaryRole: 'owner',
    businessId: 'biz-1',
    businessName: 'Shear Genius',
    allowedLocationIds: ['loc-1', 'loc-2'],
    locationScope: { kind: 'all', locationIds: ['loc-1', 'loc-2'] },
    locations: [
      { id: 'loc-1', name: 'Main' },
      { id: 'loc-2', name: 'Second' },
    ],
    profile: { id: 'profile-1', email: 'owner@example.com', fullName: 'Owner One' },
    permissions: ['zac.access', 'report.dashboard.view', 'report.performance.view'],
    ...overrides,
  } as AuthUser;
}

const MY_KPI_FIXTURE = {
  periodStart: '2026-07-29T00:00:00.000Z',
  periodEnd: '2026-08-05T00:00:00.000Z',
  period: 'week',
  scope: 'stylist',
  selectedLocationId: 'loc-1',
  stylist: {
    staffProfileId: 'staff-1',
    stylistName: 'Maya Chen',
    currencyCode: 'GBP',
    hoursWorked: 32,
    serviceTargetCents: 96000,
    actualServiceRevenueCents: 72000,
    serviceTargetProgressPercent: 75,
    retailTargetProgressPercent: 40,
    rebooking: { rebookingRatePercent: 35 },
    rebookingKpiMet: false,
    retailKpiMet: false,
    averageBillKpiMet: true,
  },
} as unknown as Awaited<ReturnType<KpiService['myKpi']>>;

const MY_SCHEDULE_FIXTURE = {
  bookings: [
    {
      id: 'b1',
      status: 'accepted',
      startsAt: '2026-08-05T09:00:00.000Z',
      clientDisplayName: 'Sarah Whitfield',
      serviceNames: ['Cut & finish'],
    },
  ],
  scope: 'stylist',
  rangeStart: '2026-08-05T00:00:00.000Z',
  rangeEnd: '2026-08-06T00:00:00.000Z',
} as unknown as Awaited<ReturnType<LabAppointmentsService['today']>>;

const MY_SCHEDULE_LIST_FIXTURE = {
  bookings: [
    ...MY_SCHEDULE_FIXTURE.bookings,
    {
      id: 'b3',
      status: 'pending',
      startsAt: '2026-08-06T10:00:00.000Z',
      clientDisplayName: 'Priya Patel',
      serviceNames: ['Balayage'],
    },
  ],
  scope: 'stylist',
  rangeStart: '2026-08-01T00:00:00.000Z',
  rangeEnd: '2026-08-20T00:00:00.000Z',
} as unknown as Awaited<ReturnType<LabAppointmentsService['list']>>;

function makeService(
  env: Record<string, string | undefined> = { ZAC_ENABLED: 'true' },
  dashboard: Partial<DashboardService> = { kpis: jest.fn().mockResolvedValue(KPI_FIXTURE) },
  kpi: Partial<KpiService> = { myKpi: jest.fn().mockResolvedValue(MY_KPI_FIXTURE) },
  labAppointments: Partial<LabAppointmentsService> = {
    today: jest.fn().mockResolvedValue(MY_SCHEDULE_FIXTURE),
    list: jest.fn().mockResolvedValue(MY_SCHEDULE_LIST_FIXTURE),
  },
  provider: ZacModelProvider = new StubZacModelProvider(),
): {
  service: ZacService;
  telemetry: { recordCostEvent: jest.Mock; recordSpineEvent: jest.Mock };
} {
  const config = { get: jest.fn((key: string) => env[key]) } as unknown as ConfigService;
  const telemetry = { recordCostEvent: jest.fn(), recordSpineEvent: jest.fn() };

  const service = new ZacService(
    new ZacRolloutService(config),
    new ZacContextService(),
    new ZacRoleProfileService(),
    new ZacToolRegistryService(
      dashboard as DashboardService,
      kpi as KpiService,
      labAppointments as LabAppointmentsService,
    ),
    new ZacResponseBuilderService(),
    telemetry as unknown as ZacCostTelemetryService,
    provider,
  );

  return { service, telemetry };
}

const NARRATED_ANSWER =
  'Your salon took £1250.00 this week — a solid result, with a 39% rebooking rate.';

/** A live-provider fake: narrates, reports cache activity, priced like a real call. */
function makeNarratingProvider(
  overrides: Partial<ZacModelProvider & { complete: jest.Mock }> = {},
): ZacModelProvider & { complete: jest.Mock } {
  return {
    name: 'anthropic',
    model: 'claude-opus-5',
    narrates: true,
    complete: jest.fn().mockResolvedValue({
      text: NARRATED_ANSWER,
      provider: 'anthropic',
      model: 'claude-opus-5',
      inputTokens: 900,
      outputTokens: 120,
      reasoningTokens: 0,
      cacheReadInputTokens: 600,
      cacheCreationInputTokens: 0,
      estimatedCostUsd: 0.0078,
    }),
    ...overrides,
  };
}

describe('ZacService', () => {
  it('returns a full contract-shaped, answer-first response', async () => {
    const { service, telemetry } = makeService();

    const response = await service.ask(makeActor(), { question: 'What can you help me with?' });

    expect(response.role_context).toBe('owner');
    expect(response.response_type).toBe('Explanation');
    expect(typeof response.answer).toBe('string');
    expect(response.answer.length).toBeGreaterThan(0);
    expect(response.evidence).toHaveLength(1);
    expect(response.evidence[0].source_type).toBe('zac.registry');
    expect(['high', 'medium', 'low']).toContain(response.confidence);
    expect(response.limitations.length).toBeGreaterThan(0);
    expect(typeof response.suggested_next_step).toBe('string');
    expect(response.measurement_hook).toBeNull();
    expect(response.attribution_seed).toBeNull();
    expect(response.memory_updates).toEqual([]);
    expect(response.tool_calls).toHaveLength(1);
    expect(response.tool_calls[0].tool).toBe('context.capabilities');
    expect(response.cost_metadata.provider).toBe('stub');
    expect(response.cost_metadata.estimated_cost_usd).toBe(0);
    expect(response.technical_details.foundation_mode).toBe(true);
    expect(response.trace_id).toMatch(/[0-9a-f-]{36}/);

    expect(telemetry.recordSpineEvent).toHaveBeenCalledWith(
      'question_asked',
      expect.objectContaining({ business_id: 'biz-1', role_context: 'owner' }),
    );
    expect(telemetry.recordSpineEvent).toHaveBeenCalledWith(
      'source_used',
      expect.objectContaining({ tool: 'context.capabilities', status: 'ok' }),
    );
    // No real model call happened (stub never narrates, context.* is never
    // narrated) — and cost events are one-per-model-call, so none fires.
    expect(telemetry.recordCostEvent).not.toHaveBeenCalled();
  });

  it('never leaks the question text into telemetry events', async () => {
    const { service, telemetry } = makeService();
    const question = 'Very-private-question about a named client';

    await service.ask(makeActor(), { question });

    const allTelemetryPayloads = [
      ...telemetry.recordSpineEvent.mock.calls.map((call) => JSON.stringify(call)),
      ...telemetry.recordCostEvent.mock.calls.map((call) => JSON.stringify(call)),
    ].join(' ');
    expect(allTelemetryPayloads).not.toContain(question);
  });

  it('hides ZAC entirely (404) when the kill-switch is thrown', async () => {
    const { service } = makeService({ ZAC_ENABLED: 'false' });

    await expect(service.ask(makeActor(), { question: 'hello' })).rejects.toThrow(NotFoundException);
    expect(() => service.health(makeActor())).toThrow(NotFoundException);
  });

  it('serves ZAC when the flag is unset — on by default since general availability', async () => {
    const { service } = makeService({});

    const response = await service.ask(makeActor(), { question: 'hello' });
    expect(response.trace_id).toBeTruthy();
  });

  it('hides ZAC (404) from businesses outside the rollout allowlist', async () => {
    const { service } = makeService({ ZAC_ENABLED: 'true', ZAC_ALLOWED_BUSINESS_IDS: 'biz-9' });

    await expect(service.ask(makeActor(), { question: 'hello' })).rejects.toThrow(NotFoundException);
  });

  it('serves businesses on the rollout allowlist', async () => {
    const { service } = makeService({ ZAC_ENABLED: 'true', ZAC_ALLOWED_BUSINESS_IDS: 'biz-1, biz-9' });

    const response = await service.ask(makeActor(), { question: 'hello' });
    expect(response.trace_id).toBeTruthy();
  });

  it('rejects a salon-less account before any model work', async () => {
    const { service } = makeService();

    await expect(
      service.ask(makeActor({ businessId: '' }), { question: 'hello' }),
    ).rejects.toThrow(ForbiddenException);
  });

  it('rejects a location outside the acting user scope', async () => {
    const { service } = makeService();
    const manager = makeActor({
      roles: ['manager'],
      primaryRole: 'manager',
      allowedLocationIds: ['loc-1'],
      permissions: ['zac.access', 'report.dashboard.view'],
    });

    await expect(
      service.ask(manager, { question: 'hello', locationId: 'loc-2' }),
    ).rejects.toThrow(ForbiddenException);
  });

  it('answers a manager through the manager lens', async () => {
    const { service } = makeService();
    const manager = makeActor({
      roles: ['manager'],
      primaryRole: 'manager',
      permissions: ['zac.access', 'report.dashboard.view'],
    });

    const response = await service.ask(manager, { question: 'hello' });
    expect(response.role_context).toBe('manager');
  });

  it('reports health without calling the model', () => {
    const { service } = makeService();

    expect(service.health(makeActor())).toEqual({
      enabled: true,
      provider: 'stub',
      model: 'zac-stub-1',
      ok: true,
    });
  });

  describe('intent routing to read-only tools', () => {
    it('routes a business health question to the dashboard-backed tool', async () => {
      const kpis = jest.fn().mockResolvedValue(KPI_FIXTURE);
      const { service } = makeService(undefined, { kpis } as Partial<DashboardService>);

      const response = await service.ask(makeActor(), { question: 'How is my business doing?' });

      expect(response.response_type).toBe('Insight');
      expect(response.answer).toContain('£1250.00');
      expect(response.answer).toContain('rebooking rate');
      expect(response.evidence[0].source_type).toBe('report.dashboard');
      expect(response.evidence[0].as_of).toBe(KPI_FIXTURE.rangeEnd);
      expect(response.confidence).toBe('medium');
      expect(response.limitations.join(' ')).toMatch(/not a profit view/);
      expect(response.tool_calls[0]).toMatchObject({ tool: 'report.business_health', status: 'ok' });
      expect(kpis).toHaveBeenCalledTimes(1);
    });

    it('refuses a health question safely when the underlying permission is missing', async () => {
      const kpis = jest.fn().mockResolvedValue(KPI_FIXTURE);
      const { service } = makeService(undefined, { kpis } as Partial<DashboardService>);
      const manager = makeActor({
        roles: ['manager'],
        primaryRole: 'manager',
        permissions: ['zac.access'],
      });

      const response = await service.ask(manager, { question: 'How is my business doing?' });

      expect(response.response_type).toBe('Refusal / Insufficient Data');
      expect(response.answer).toMatch(/not available to your role/i);
      expect(response.tool_calls[0].status).toBe('permission_denied');
      expect(kpis).not.toHaveBeenCalled();
    });

    it('turns a failing dashboard service into a safe insufficient-data answer', async () => {
      const { service } = makeService(undefined, {
        kpis: jest.fn().mockRejectedValue(new Error('boom')),
      } as Partial<DashboardService>);

      const response = await service.ask(makeActor(), { question: 'How is my business doing?' });

      expect(response.response_type).toBe('Refusal / Insufficient Data');
      expect(response.answer).not.toContain('boom');
      expect(response.tool_calls[0].status).toBe('unavailable');
    });

    it('routes location questions to the location context tool', async () => {
      const { service } = makeService();

      const response = await service.ask(makeActor(), { question: 'What locations can I see?' });

      expect(response.tool_calls[0].tool).toBe('context.location_summary');
      expect(response.answer).toContain('Main');
      expect(response.answer).toContain('Second');
    });

    it('routes business context questions to the business context tool', async () => {
      const { service } = makeService();

      const response = await service.ask(makeActor(), { question: 'Which business am I looking at?' });

      expect(response.tool_calls[0].tool).toBe('context.business_summary');
      expect(response.answer).toContain('Shear Genius');
      expect(response.answer).toContain('owner');
    });

    it('routes contractions and booking questions to business health, not location', async () => {
      const { service } = makeService();

      const contraction = await service.ask(makeActor(), { question: "How's my salon?" });
      expect(contraction.tool_calls[0].tool).toBe('report.business_health');

      const bookings = await service.ask(makeActor(), {
        question: 'How are bookings at my Soho location?',
      });
      expect(bookings.tool_calls[0].tool).toBe('report.business_health');
    });

    it('does not treat words containing "location" as location questions', async () => {
      const { service } = makeService();

      const response = await service.ask(makeActor(), {
        question: 'How should I handle stock allocation?',
      });
      expect(response.tool_calls[0].tool).toBe('context.capabilities');
    });

    it('falls back to the capability summary for unmatched questions', async () => {
      const { service } = makeService();

      const response = await service.ask(makeActor(), { question: 'Tell me a story' });

      expect(response.tool_calls[0].tool).toBe('context.capabilities');
      expect(response.response_type).toBe('Explanation');
    });

    it('routes "top rated member" questions to the stylist performance tool', async () => {
      const stylistPerformance = jest.fn().mockResolvedValue(STYLIST_PERF_FIXTURE);
      const { service } = makeService(undefined, {
        kpis: jest.fn().mockResolvedValue(KPI_FIXTURE),
        stylistPerformance,
      } as Partial<DashboardService>);

      const response = await service.ask(makeActor(), {
        question: 'Who is the top rated member of my business?',
      });

      expect(response.tool_calls[0]).toMatchObject({
        tool: 'report.stylist_performance',
        status: 'ok',
      });
      expect(response.answer).toContain('Maya Chen');
      expect(response.limitations.join(' ')).toMatch(/no client ratings/i);
      expect(stylistPerformance).toHaveBeenCalledTimes(1);
    });

    it('routes below-target staff questions to the KPI summary tool with the period', async () => {
      const stylistList = jest.fn().mockResolvedValue(STYLIST_LIST_FIXTURE);
      const { service } = makeService(undefined, undefined, {
        myKpi: jest.fn().mockResolvedValue(MY_KPI_FIXTURE),
        stylistList,
      } as Partial<KpiService>);

      const response = await service.ask(makeActor(), {
        question: 'Which stylists are below rebooking target this month?',
      });

      expect(response.tool_calls[0]).toMatchObject({ tool: 'report.kpi_summary', status: 'ok' });
      expect(stylistList).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ period: 'month' }));
      expect(response.answer).toContain('Jordan Blake (33%)');
      // makeActor holds no report.commission.view — commission must be stripped.
      expect(JSON.stringify(response)).not.toMatch(/commission_tier|tier_3_5x/);
    });

    it('routes plain rebooking questions to the rebooking summary tool', async () => {
      const { service } = makeService();

      const response = await service.ask(makeActor(), { question: "How's my rebooking rate?" });

      expect(response.tool_calls[0]).toMatchObject({
        tool: 'report.rebooking_summary',
        status: 'ok',
      });
      expect(response.answer).toContain('39%');
    });

    it('keeps business questions on business health, not the staff tools', async () => {
      const { service } = makeService();

      const response = await service.ask(makeActor(), {
        question: 'How is my business performing?',
      });

      expect(response.tool_calls[0].tool).toBe('report.business_health');
    });
  });

  describe('staff/team/member intent (unavailable-safe)', () => {
    const STAFF_QUESTIONS = [
      'members of my business?',
      'team members',
      'staff list',
      'who works here?',
      'stylists in my salon',
      'show my team',
      'employees',
      'users in my business',
      'Who is the members of Kensington?',
    ];

    it.each(STAFF_QUESTIONS)('answers "%s" with an honest staff-not-connected refusal', async (question) => {
      const { service } = makeService();

      const response = await service.ask(makeActor(), { question });

      expect(response.response_type).toBe('Refusal / Insufficient Data');
      expect(response.answer).toContain("asking about your business members or team");
      expect(response.answer).toMatch(/isn't connected to ZAC yet/i);
      expect(response.answer).not.toMatch(/what I can help with right now/i);
      expect(response.evidence[0].source_type).toBe('zac.intent');
      expect(response.limitations.join(' ')).toMatch(/staff and team member data is not connected/i);
      expect(typeof response.suggested_next_step).toBe('string');
      expect(response.technical_details.detected_intent).toBe('staff.members');
    });

    it('never dispatches any tool or service for staff questions', async () => {
      const kpis = jest.fn().mockResolvedValue(KPI_FIXTURE);
      const { service, telemetry } = makeService(undefined, { kpis } as Partial<DashboardService>);

      const response = await service.ask(makeActor(), { question: 'staff list' });

      expect(response.tool_calls).toEqual([]);
      expect(kpis).not.toHaveBeenCalled();
      expect(telemetry.recordSpineEvent).not.toHaveBeenCalledWith(
        'source_used',
        expect.anything(),
      );
      // Staff questions dispatch nothing and call no model — no cost event.
      expect(telemetry.recordCostEvent).not.toHaveBeenCalled();
    });

    it('contains no staff, pay or performance data anywhere in the response', async () => {
      const { service } = makeService();

      const response = await service.ask(makeActor(), { question: 'team members' });
      const serialized = JSON.stringify(response);

      expect(serialized).not.toMatch(/salary|payroll|commission|hourly|pay rate/i);
      expect(response.memory_updates).toEqual([]);
      expect(response.evidence[0].entities_used).toEqual([]);
    });

    it('does not hijack the existing routes', async () => {
      const { service } = makeService();

      const capabilities = await service.ask(makeActor(), { question: 'What can you help me with?' });
      expect(capabilities.tool_calls[0]?.tool).toBe('context.capabilities');

      const health = await service.ask(makeActor(), { question: 'How is my business doing?' });
      expect(health.tool_calls[0]?.tool).toBe('report.business_health');

      const locations = await service.ask(makeActor(), { question: 'What locations can I see?' });
      expect(locations.tool_calls[0]?.tool).toBe('context.location_summary');

      const business = await service.ask(makeActor(), { question: 'Which business am I looking at?' });
      expect(business.tool_calls[0]?.tool).toBe('context.business_summary');
    });
  });

  describe('stylist-safe access', () => {
    function makeStylist(overrides: Partial<AuthUser> = {}): AuthUser {
      return makeActor({
        roles: ['stylist'],
        primaryRole: 'stylist',
        allowedLocationIds: ['loc-1'],
        locations: [{ id: 'loc-1', name: 'Main' }],
        staffProfileId: 'staff-1',
        profile: { id: 'profile-2', email: 'stylist@example.com', fullName: 'Maya Chen', firstName: 'Maya' },
        // zac.access + the default stylist grant that unlocks their own diary.
        permissions: ['zac.access', 'bookings.manage'],
        ...overrides,
      });
    }

    const RESTRICTED_QUESTIONS = [
      'Show business revenue.',
      'Can you show business revenue?',
      'How is the whole business doing?',
      'Show payroll.',
      'Show team members.',
      'Which stylist is underperforming?',
      'Show all clients.',
      'Show manager reports.',
      'What is the salon profit?',
      'Show staff performance.',
    ];

    const COACHING_QUESTIONS = [
      'What should I focus on today?',
      'How can I improve this week?',
      'How am I performing?',
      'How can I improve my rebooking?',
    ];

    const SCHEDULE_QUESTIONS = [
      'Can you show my appointments today?',
      'What appointments do I have today?',
    ];

    it('serves a stylist holding zac.access through the normal gates', async () => {
      const { service } = makeService();

      const response = await service.ask(makeStylist(), { question: 'What can you help me with?' });
      expect(response.role_context).toBe('stylist');
      expect(response.trace_id).toBeTruthy();
    });

    it('gives a stylist the stylist capability answer, never the owner console copy', async () => {
      const { service } = makeService();

      const { answer } = await service.ask(makeStylist(), { question: 'What can you help me with?' });
      expect(answer.startsWith('Hi Maya 👋')).toBe(true);
      expect(answer).toContain("I'm ZAC, your AI assistant for QLOOQO.");
      expect(answer).toContain('For stylists');
      expect(answer).toMatch(/can't show owner-level business reports/i);
      // Owner/manager console wording must not leak through.
      expect(answer).not.toContain('AI business assistant');
      expect(answer).not.toContain('business health snapshot');
      expect(answer).not.toContain('Your business context');
    });

    it.each(RESTRICTED_QUESTIONS)('refuses "%s" at the access boundary without dispatching', async (question) => {
      const kpis = jest.fn().mockResolvedValue(KPI_FIXTURE);
      const { service } = makeService(undefined, { kpis } as Partial<DashboardService>);

      const response = await service.ask(makeStylist(), { question });

      expect(response.response_type).toBe('Refusal / Insufficient Data');
      expect(response.answer).toMatch(/not available at your access level/i);
      expect(response.evidence[0].source_type).toBe('zac.access_boundary');
      expect(response.tool_calls).toEqual([]);
      expect(response.technical_details.detected_intent).toBe('stylist.restricted');
      expect(kpis).not.toHaveBeenCalled();
    });

    it.each(COACHING_QUESTIONS)('answers "%s" with LIVE self-scoped coaching', async (question) => {
      const kpis = jest.fn().mockResolvedValue(KPI_FIXTURE);
      const myKpi = jest.fn().mockResolvedValue(MY_KPI_FIXTURE);
      const { service } = makeService(undefined, { kpis } as Partial<DashboardService>, { myKpi });

      const response = await service.ask(makeStylist(), { question });

      expect(response.response_type).toBe('Coaching Point');
      expect(response.answer).toContain('rebooking rate is 35%');
      expect(response.answer).toContain('£720.00'); // own service revenue
      expect(response.answer).toMatch(/a good focus: rebooking/i); // first unmet KPI
      expect(response.evidence[0].source_type).toBe('kpi.personal');
      expect(response.tool_calls[0]).toMatchObject({ tool: 'kpi.personal_coaching', status: 'ok' });
      expect(myKpi).toHaveBeenCalledTimes(1);
      expect(kpis).not.toHaveBeenCalled(); // never the business-wide service
      // Own coaching never carries pay figures.
      expect(JSON.stringify(response)).not.toMatch(/commission|hourly|salary|wage/i);
    });

    it('passes the question period through to the coaching tool', async () => {
      const myKpi = jest.fn().mockResolvedValue(MY_KPI_FIXTURE);
      const { service } = makeService(undefined, undefined, { myKpi });
      const stylist = makeStylist();

      await service.ask(stylist, { question: 'What should I focus on today?' });
      expect(myKpi).toHaveBeenLastCalledWith(stylist, { period: 'today' });

      await service.ask(stylist, { question: 'How can I improve this week?' });
      expect(myKpi).toHaveBeenLastCalledWith(stylist, { period: 'week' });
    });

    it.each(SCHEDULE_QUESTIONS)('answers "%s" from the LIVE self-scoped diary', async (question) => {
      const today = jest.fn().mockResolvedValue(MY_SCHEDULE_FIXTURE);
      const list = jest.fn().mockResolvedValue(MY_SCHEDULE_LIST_FIXTURE);
      const { service } = makeService(undefined, undefined, undefined, { today, list });

      const response = await service.ask(makeStylist(), { question });

      expect(response.response_type).toBe('Explanation');
      expect(response.answer).toContain('1 appointment scheduled for today');
      expect(response.answer).toContain('Cut & finish with Sarah');
      expect(response.answer).not.toContain('Whitfield'); // first name only
      expect(response.evidence[0].source_type).toBe('booking.schedule');
      expect(response.tool_calls[0]).toMatchObject({ tool: 'schedule.my_appointments', status: 'ok' });
      expect(today).toHaveBeenCalledTimes(1);
      expect(list).not.toHaveBeenCalled(); // today-only horizon
    });

    it('answers "Is there a scheduled appointment from today to tomorrow?" across both days', async () => {
      const today = jest.fn().mockResolvedValue(MY_SCHEDULE_FIXTURE);
      const list = jest.fn().mockResolvedValue(MY_SCHEDULE_LIST_FIXTURE);
      const { service } = makeService(undefined, undefined, undefined, { today, list });

      const response = await service.ask(makeStylist(), {
        question: 'Is there a scheduled appointment from today to tomorrow?',
      });

      expect(response.answer).toContain('2 appointments scheduled for today and tomorrow');
      expect(response.answer).toContain('Cut & finish with Sarah');
      expect(response.answer).toContain('Tomorrow');
      expect(response.answer).toContain('Balayage with Priya');
      expect(list).toHaveBeenCalledTimes(1);
    });

    it('degrades to the honest not-connected answer when a personal service fails', async () => {
      const { service } = makeService(
        undefined,
        undefined,
        { myKpi: jest.fn().mockRejectedValue(new Error('boom')) },
        {
          today: jest.fn().mockRejectedValue(new Error('boom')),
          list: jest.fn().mockRejectedValue(new Error('boom')),
        },
      );

      for (const question of ['What should I focus on today?', 'Can you show my appointments today?']) {
        const response = await service.ask(makeStylist(), { question });
        expect(response.response_type).toBe('Refusal / Insufficient Data');
        expect(response.evidence[0].source_ref).toBe('stylist-personal-intent:not-connected');
        expect(response.answer).not.toContain('boom');
      }
    });

    it('keeps personal tools honest for a stylist WITHOUT the diary permission', async () => {
      const today = jest.fn();
      const { service } = makeService(undefined, undefined, undefined, {
        today,
      } as Partial<LabAppointmentsService>);

      const response = await service.ask(
        makeStylist({ permissions: ['zac.access'] }), // no bookings.manage
        { question: 'Can you show my appointments today?' },
      );

      expect(response.response_type).toBe('Refusal / Insufficient Data');
      expect(response.evidence[0].source_ref).toBe('stylist-personal-intent:not-connected');
      expect(today).not.toHaveBeenCalled();
    });

    it('exposes no business figures or pay terms anywhere in restricted stylist responses', async () => {
      const { service } = makeService();

      for (const question of ['Show payroll.', 'Show business revenue.']) {
        const response = await service.ask(makeStylist(), { question });
        const serialized = JSON.stringify(response);
        expect(serialized).not.toMatch(/£|\bGBP\b|salary|wage|commission|hourly/i);
        expect(serialized).not.toContain('report.dashboard');
        expect(response.technical_details.connected_tools).not.toContain('report.business_health');
      }
    });

    it('personal answers carry ONLY self-scoped figures — own revenue yes, pay and business data never', async () => {
      const { service } = makeService();

      const response = await service.ask(makeStylist(), { question: 'What should I focus on today?' });
      const serialized = JSON.stringify(response);

      expect(response.answer).toContain('£720.00'); // the stylist's own revenue is allowed
      expect(serialized).not.toContain('£1250.00'); // the business-wide figure is not
      expect(serialized).not.toMatch(/salary|wage|commission|hourly/i);
      expect(serialized).not.toContain('report.dashboard');
      expect(response.technical_details.connected_tools).not.toContain('report.business_health');
    });

    it('keeps the kill-switch and allowlist gates intact for stylists', async () => {
      const off = makeService({ ZAC_ENABLED: 'false' });
      await expect(off.service.ask(makeStylist(), { question: 'hi' })).rejects.toThrow(NotFoundException);

      const excluded = makeService({ ZAC_ENABLED: 'true', ZAC_ALLOWED_BUSINESS_IDS: 'biz-9' });
      await expect(excluded.service.ask(makeStylist(), { question: 'hi' })).rejects.toThrow(NotFoundException);
    });
  });

  describe('foundation answer (user-facing product copy)', () => {
    const CAPABILITY_AREAS = [
      'revenue',
      'team productivity',
      'appointments',
      'utilisation',
      'retention',
      'rebooking',
      'retail performance',
      'QLAB colour',
      'stock',
      'inventory',
      'trends',
      'growth opportunities',
    ];

    it('greets the acting user by first name when available', async () => {
      const { service } = makeService();
      const actor = makeActor({
        profile: { id: 'profile-1', email: 'owner@example.com', fullName: 'Cosan Vural', firstName: 'Cosan' },
      });

      const response = await service.ask(actor, { question: 'What can you help me with?' });
      expect(response.answer.startsWith('Hi Cosan 👋')).toBe(true);
    });

    it('falls back to the full-name first word, then a neutral greeting', async () => {
      const { service } = makeService();

      const fromFullName = await service.ask(makeActor(), { question: 'What can you help me with?' });
      expect(fromFullName.answer.startsWith('Hi Owner 👋')).toBe(true);

      const neutral = await service.ask(
        makeActor({ profile: { id: 'profile-1', email: 'owner@example.com', fullName: '   ' } }),
        { question: 'What can you help me with?' },
      );
      expect(neutral.answer.startsWith('Hi 👋')).toBe(true);
    });

    it('answers the user question first and is honest about what is connected', async () => {
      const { service } = makeService();

      const { answer } = await service.ask(makeActor(), { question: 'What can you help me with?' });
      expect(answer).toContain("I'm ZAC, your AI business assistant for QLOOQO.");
      expect(answer).toMatch(/what I can help with right now/i);
      expect(answer).toContain('business health snapshot');
      expect(answer).toMatch(/foundation mode/i);
      expect(answer).toMatch(/don't yet have access to your live business data/i);
      expect(answer).toMatch(/tell you when an answer isn't based on your salon's information/i);
    });

    it('omits the health capability for users without the underlying permission', async () => {
      const { service } = makeService();
      const manager = makeActor({
        roles: ['manager'],
        primaryRole: 'manager',
        permissions: ['zac.access'],
      });

      const { answer } = await service.ask(manager, { question: 'What can you help me with?' });
      expect(answer).not.toContain('business health snapshot');
    });

    it('lists every future capability area', async () => {
      const { service } = makeService();

      const { answer } = await service.ask(makeActor(), { question: 'What can you help me with?' });
      for (const area of CAPABILITY_AREAS) {
        expect(answer).toContain(area);
      }
    });

    it('does not primarily describe backend architecture', async () => {
      const { service } = makeService();

      const { answer } = await service.ask(makeActor(), { question: 'What can you help me with?' });
      expect(answer).not.toMatch(
        /registry|skeleton|stub|backend|endpoint|architecture|controller|provider|DTO|schema/i,
      );
    });

    it('keeps technical details separated from the user-facing answer', async () => {
      const { service } = makeService();

      const response = await service.ask(makeActor(), { question: 'What can you help me with?' });
      expect(response.technical_details).toEqual({
        foundation_mode: true,
        feature_flag_state: 'enabled',
        connected_tools: expect.arrayContaining([
          'context.business_summary',
          'context.capabilities',
          'report.business_health',
        ]),
        disabled_tools: expect.arrayContaining(['report.utilisation_summary']),
        provider: 'stub',
        model: 'zac-stub-1',
      });
      expect(response.answer).not.toContain('zac-stub-1');
    });
  });

  describe('live narration (narrating provider)', () => {
    function narratingService(provider = makeNarratingProvider()) {
      const { service, telemetry } = makeService(undefined, undefined, undefined, undefined, provider);
      return { service, telemetry, provider };
    }

    it('narrates a tool-backed answer from the evidence, after dispatch', async () => {
      const { service, telemetry, provider } = narratingService();

      const response = await service.ask(makeActor(), { question: 'How is my business doing?' });

      // One call, made with the tool's verified figures as the evidence pack.
      expect(provider.complete).toHaveBeenCalledTimes(1);
      const modelRequest = provider.complete.mock.calls[0][0];
      expect(modelRequest.evidencePack.toolName).toBe('report.business_health');
      expect(modelRequest.evidencePack.toolAnswer).toContain('£1250.00');
      expect(modelRequest.question).toBe('How is my business doing?');

      // The model's prose becomes the answer; everything derived stays deterministic.
      expect(response.answer).toBe(NARRATED_ANSWER);
      expect(response.response_type).toBe('Insight');
      expect(response.evidence[0].source_type).toBe('report.dashboard');
      expect(response.confidence).toBe('medium');
      expect(response.technical_details.foundation_mode).toBe(false);
      expect(response.cost_metadata).toMatchObject({
        provider: 'anthropic',
        model: 'claude-opus-5',
        cache_hit: true,
      });

      expect(telemetry.recordCostEvent).toHaveBeenCalledTimes(1);
      expect(telemetry.recordCostEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: 'anthropic',
          model: 'claude-opus-5',
          input_tokens: 900,
          output_tokens: 120,
          cache_hit: true,
          tool_calls_used: 1,
        }),
      );
    });

    it('narrates stylist personal coaching the same way', async () => {
      // Coaching-grounded narration: every figure exists in the coaching evidence.
      const coachingAnswer = 'Your rebooking rate is 35% and you have taken £720.00 — a good focus.';
      const provider = makeNarratingProvider();
      provider.complete.mockResolvedValue({
        text: coachingAnswer,
        provider: 'anthropic',
        model: 'claude-opus-5',
        inputTokens: 700,
        outputTokens: 90,
        reasoningTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 700,
        estimatedCostUsd: 0.006,
      });
      const { service } = narratingService(provider);

      const stylist = makeActor({
        roles: ['stylist'],
        primaryRole: 'stylist',
        allowedLocationIds: ['loc-1'],
        locations: [{ id: 'loc-1', name: 'Main' }],
        staffProfileId: 'staff-1',
        permissions: ['zac.access', 'bookings.manage'],
      });
      const response = await service.ask(stylist, { question: 'What should I focus on today?' });

      expect(provider.complete).toHaveBeenCalledTimes(1);
      expect(provider.complete.mock.calls[0][0].evidencePack.toolName).toBe('kpi.personal_coaching');
      expect(response.answer).toBe(coachingAnswer);
      expect(response.technical_details.foundation_mode).toBe(false);
    });

    it('rejects an ungrounded narration — fabricated figures never ship under the evidence banner', async () => {
      const provider = makeNarratingProvider();
      provider.complete.mockResolvedValue({
        ...(await makeNarratingProvider().complete()),
        text: 'Your salon took £9999.00 this week — up 250% on last month!',
      });
      const { service, telemetry } = narratingService(provider);

      const response = await service.ask(makeActor(), { question: 'How is my business doing?' });

      // Deterministic answer served; the fabricated figure never reaches the user.
      expect(response.answer).toContain('£1250.00');
      expect(response.answer).not.toContain('9999');
      expect(response.technical_details.foundation_mode).toBe(true);
      expect(telemetry.recordSpineEvent).toHaveBeenCalledWith(
        'model_fallback',
        expect.objectContaining({ reason: 'ungrounded' }),
      );
      // The call happened and billed — the cost event still fires.
      expect(telemetry.recordCostEvent).toHaveBeenCalledTimes(1);
    });

    it('accepts reformatted-but-grounded figures (£1,250 matches £1250.00)', async () => {
      const provider = makeNarratingProvider();
      provider.complete.mockResolvedValue({
        ...(await makeNarratingProvider().complete()),
        text: 'Takings were £1,250 this week, with 39% of visits rebooked.',
      });
      const { service } = narratingService(provider);

      const response = await service.ask(makeActor(), { question: 'How is my business doing?' });

      expect(response.answer).toContain('£1,250');
      expect(response.technical_details.foundation_mode).toBe(false);
    });

    it('serves the deterministic answer for a truncated narration while still billing the call', async () => {
      const truncatedCompletion = {
        text: 'This week the salon took £1,2',
        provider: 'anthropic',
        model: 'claude-opus-5',
        inputTokens: 900,
        outputTokens: 8192,
        reasoningTokens: 0,
        cacheReadInputTokens: 600,
        cacheCreationInputTokens: 0,
        estimatedCostUsd: 0.21,
      };
      const provider = makeNarratingProvider({
        complete: jest
          .fn()
          .mockRejectedValue(new ZacModelIncompleteError('stop_reason max_tokens', truncatedCompletion)),
      });
      const { service, telemetry } = narratingService(provider);

      const response = await service.ask(makeActor(), { question: 'How is my business doing?' });

      expect(response.answer).toContain('£1250.00');
      expect(response.answer).not.toContain('£1,2 ');
      expect(response.technical_details.foundation_mode).toBe(true);
      expect(telemetry.recordSpineEvent).toHaveBeenCalledWith(
        'model_fallback',
        expect.objectContaining({ reason: 'truncated' }),
      );
      expect(telemetry.recordCostEvent).toHaveBeenCalledWith(
        expect.objectContaining({ output_tokens: 8192, estimated_cost_usd: 0.21 }),
      );
    });

    it('degrades to the deterministic answer when the provider fails, with a fallback event and no cost event', async () => {
      const provider = makeNarratingProvider({
        complete: jest.fn().mockRejectedValue(new Error('anthropic 529')),
      });
      const { service, telemetry } = narratingService(provider);

      const response = await service.ask(makeActor(), { question: 'How is my business doing?' });

      // Exactly the pre-provider deterministic answer.
      expect(response.answer).toContain('£1250.00');
      expect(response.technical_details.foundation_mode).toBe(true);
      expect(telemetry.recordSpineEvent).toHaveBeenCalledWith(
        'model_fallback',
        expect.objectContaining({ tool: 'report.business_health', reason: 'unavailable' }),
      );
      expect(telemetry.recordCostEvent).not.toHaveBeenCalled();
    });

    it('records a refusal fallback distinctly', async () => {
      const provider = makeNarratingProvider({
        complete: jest.fn().mockRejectedValue(new ZacModelRefusedError('declined')),
      });
      const { service, telemetry } = narratingService(provider);

      const response = await service.ask(makeActor(), { question: 'How is my business doing?' });

      expect(response.answer).toContain('£1250.00');
      expect(telemetry.recordSpineEvent).toHaveBeenCalledWith(
        'model_fallback',
        expect.objectContaining({ reason: 'refusal' }),
      );
    });

    it('falls back deterministically on an empty narration', async () => {
      const provider = makeNarratingProvider();
      provider.complete.mockResolvedValue({
        ...(await makeNarratingProvider().complete()),
        text: '   ',
      });
      const { service, telemetry } = narratingService(provider);

      const response = await service.ask(makeActor(), { question: 'How is my business doing?' });

      expect(response.answer).toContain('£1250.00');
      expect(response.technical_details.foundation_mode).toBe(true);
      // The call DID happen and returned usage — it is still a cost event.
      expect(telemetry.recordCostEvent).toHaveBeenCalledTimes(1);
    });

    it('never calls the model for capability, staff, or stylist-restricted turns', async () => {
      const { service, provider } = narratingService();
      const stylist = makeActor({
        roles: ['stylist'],
        primaryRole: 'stylist',
        staffProfileId: 'staff-1',
        permissions: ['zac.access', 'bookings.manage'],
      });

      await service.ask(makeActor(), { question: 'What can you help me with?' });
      await service.ask(makeActor(), { question: 'staff list' });
      await service.ask(stylist, { question: 'Show business revenue.' });

      expect(provider.complete).not.toHaveBeenCalled();
    });

    it('never calls the non-narrating stub provider at all', async () => {
      const stub = new StubZacModelProvider();
      const completeSpy = jest.spyOn(stub, 'complete');
      const { service } = makeService(undefined, undefined, undefined, undefined, stub);

      await service.ask(makeActor(), { question: 'How is my business doing?' });

      expect(completeSpy).not.toHaveBeenCalled();
    });

    it('keeps the question and narrated answer out of telemetry with a live provider', async () => {
      const { service, telemetry } = narratingService();
      const question = 'How is my business doing? Client Jane Smith mentioned something private.';

      await service.ask(makeActor(), { question });

      const payloads = [
        ...telemetry.recordSpineEvent.mock.calls.map((call) => JSON.stringify(call)),
        ...telemetry.recordCostEvent.mock.calls.map((call) => JSON.stringify(call)),
      ].join(' ');
      expect(payloads).not.toContain('Jane Smith');
      expect(payloads).not.toContain(NARRATED_ANSWER);
    });
  });
});
