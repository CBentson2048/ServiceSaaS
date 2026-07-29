import { ForbiddenException, NotFoundException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { AuthUser } from '@sheer/domain';
import { ZacContextService } from './context/zac-context.service';
import type { ZacCostTelemetryService } from './measurement/zac-cost-telemetry.service';
import { StubZacModelProvider } from './models/providers/stub-zac-provider';
import { ZacResponseBuilderService } from './responses/zac-response-builder.service';
import { ZacRoleProfileService } from './roles/zac-role-profile.service';
import { ZacToolRegistryService } from './tools/zac-tool-registry.service';
import { ZacRolloutService } from './zac-rollout.service';
import { ZacService } from './zac.service';

function makeActor(overrides: Partial<AuthUser> = {}): AuthUser {
  return {
    id: 'user-1',
    roles: ['owner'],
    primaryRole: 'owner',
    businessId: 'biz-1',
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

function makeService(env: Record<string, string | undefined> = { ZAC_ENABLED: 'true' }): {
  service: ZacService;
  telemetry: { recordCostEvent: jest.Mock; recordSpineEvent: jest.Mock };
} {
  const config = { get: jest.fn((key: string) => env[key]) } as unknown as ConfigService;
  const telemetry = { recordCostEvent: jest.fn(), recordSpineEvent: jest.fn() };

  const service = new ZacService(
    new ZacRolloutService(config),
    new ZacContextService(),
    new ZacRoleProfileService(),
    new ZacToolRegistryService(),
    new ZacResponseBuilderService(),
    telemetry as unknown as ZacCostTelemetryService,
    new StubZacModelProvider(),
  );

  return { service, telemetry };
}

describe('ZacService', () => {
  it('returns the full contract-shaped controlled test response from the stub provider', async () => {
    const { service, telemetry } = makeService();

    const response = await service.ask(makeActor(), { question: 'How is my salon doing?' });

    expect(response.role_context).toBe('owner');
    expect(response.response_type).toBe('Explanation');
    expect(typeof response.answer).toBe('string');
    expect(response.answer.length).toBeGreaterThan(0);
    expect(response.evidence).toHaveLength(1);
    expect(response.evidence[0].source_type).toBe('zac.foundation');
    expect(['high', 'medium', 'low']).toContain(response.confidence);
    expect(response.limitations.length).toBeGreaterThan(0);
    expect(typeof response.suggested_next_step).toBe('string');
    expect((response.suggested_next_step as string).length).toBeGreaterThan(0);
    expect(response.measurement_hook).toBeNull();
    expect(response.attribution_seed).toBeNull();
    expect(response.memory_updates).toEqual([]);
    expect(response.tool_calls).toEqual([]);
    expect(response.cost_metadata.provider).toBe('stub');
    expect(response.cost_metadata.estimated_cost_usd).toBe(0);
    expect(response.technical_details.foundation_mode).toBe(true);
    expect(response.trace_id).toMatch(/[0-9a-f-]{36}/);

    expect(telemetry.recordSpineEvent).toHaveBeenCalledWith(
      'question_asked',
      expect.objectContaining({ business_id: 'biz-1', role_context: 'owner' }),
    );
    expect(telemetry.recordSpineEvent).toHaveBeenCalledWith(
      'answer_delivered',
      expect.objectContaining({ response_type: 'Explanation' }),
    );
    expect(telemetry.recordCostEvent).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'stub', task_type: 'qa', tool_calls_used: 0 }),
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

      const fromFullName = await service.ask(makeActor(), { question: 'hi' });
      expect(fromFullName.answer.startsWith('Hi Owner 👋')).toBe(true);

      const neutral = await service.ask(
        makeActor({ profile: { id: 'profile-1', email: 'owner@example.com', fullName: '   ' } }),
        { question: 'hi' },
      );
      expect(neutral.answer.startsWith('Hi 👋')).toBe(true);
    });

    it('answers the user question first and is honest about foundation mode', async () => {
      const { service } = makeService();

      const { answer } = await service.ask(makeActor(), { question: 'What can you help me with?' });
      expect(answer).toContain("I'm ZAC, your AI business assistant for QLOOQO.");
      expect(answer).toMatch(/foundation mode/i);
      expect(answer).toMatch(/don't yet have access to your live business data/i);
      expect(answer).toMatch(/can't yet answer questions using your salon's information/i);
      expect(answer).toMatch(/increasingly personalised and evidence-based/);
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
        connected_tools: [],
        disabled_tools: expect.arrayContaining(['report.business_health', 'report.kpi_summary']),
        provider: 'stub',
        model: 'zac-stub-1',
      });
      expect(response.answer).not.toContain('zac-stub-1');
      expect(response.tool_calls).toEqual([]);
    });
  });
});
