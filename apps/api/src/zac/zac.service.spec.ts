import { ForbiddenException, NotFoundException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { AuthUser, DashboardKpisResponse } from '@sheer/domain';
import type { DashboardService } from '../dashboard/dashboard.service';
import { ZacContextService } from './context/zac-context.service';
import type { ZacCostTelemetryService } from './measurement/zac-cost-telemetry.service';
import { StubZacModelProvider } from './models/providers/stub-zac-provider';
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

function makeService(
  env: Record<string, string | undefined> = { ZAC_ENABLED: 'true' },
  dashboard: Partial<DashboardService> = { kpis: jest.fn().mockResolvedValue(KPI_FIXTURE) },
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
    new ZacToolRegistryService(dashboard as DashboardService),
    new ZacResponseBuilderService(),
    telemetry as unknown as ZacCostTelemetryService,
    new StubZacModelProvider(),
  );

  return { service, telemetry };
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
    expect(telemetry.recordCostEvent).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'stub', task_type: 'qa', tool_calls_used: 1 }),
    );
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

  it('hides ZAC entirely (404) when the global flag is off', async () => {
    const { service } = makeService({ ZAC_ENABLED: undefined });

    await expect(service.ask(makeActor(), { question: 'hello' })).rejects.toThrow(NotFoundException);
    expect(() => service.health(makeActor())).toThrow(NotFoundException);
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
      expect(telemetry.recordCostEvent).toHaveBeenCalledWith(
        expect.objectContaining({ tool_calls_used: 0 }),
      );
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
        disabled_tools: expect.arrayContaining(['report.kpi_summary']),
        provider: 'stub',
        model: 'zac-stub-1',
      });
      expect(response.answer).not.toContain('zac-stub-1');
    });
  });
});
