import { NotFoundException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import {
  createSupabaseFake,
  createSupabaseFakeState,
  type SupabaseFakeState,
} from '../../common/testing/supabase-fake';
import type { ZacActingContext } from '../context/zac-context.types';
import type { ZacCostTelemetryService } from '../measurement/zac-cost-telemetry.service';
import { ZacConversationStore } from '../persistence/zac-conversation.store';
import { ZacConversationService } from './zac-conversation.service';

jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(() => {
    return (globalThis as { __supabaseFake?: unknown }).__supabaseFake;
  }),
}));

function contextWith(overrides: Partial<ZacActingContext> = {}): ZacActingContext {
  return {
    actorUserId: 'owner-1',
    actorFirstName: 'Owner',
    businessId: 'biz-1',
    businessName: 'Shear Genius',
    locationId: null,
    accessibleLocationIds: ['loc-1'],
    accessibleLocations: [{ id: 'loc-1', name: 'Main' }],
    roleContext: 'owner',
    roles: ['owner'],
    permissions: ['zac.access'],
    staffProfileId: null,
    requestSource: 'web_dashboard',
    timezone: 'Europe/London',
    locale: 'en-GB',
    firstAssistantTurn: true,
    ...overrides,
  };
}

function makeConversationService(state: SupabaseFakeState = createSupabaseFakeState()): {
  service: ZacConversationService;
  telemetry: { recordCostEvent: jest.Mock; recordSpineEvent: jest.Mock };
  state: SupabaseFakeState;
} {
  (globalThis as { __supabaseFake?: unknown }).__supabaseFake = createSupabaseFake(state);
  const config = {
    get: jest.fn(),
    getOrThrow: jest.fn((key: string) => `fake-${key}`),
  } as unknown as ConfigService;
  const telemetry = { recordCostEvent: jest.fn(), recordSpineEvent: jest.fn() };
  const service = new ZacConversationService(
    new ZacConversationStore(config),
    telemetry as unknown as ZacCostTelemetryService,
  );
  return { service, telemetry, state };
}

describe('ZacConversationService', () => {
  it('creates a persisted conversation scoped to the acting user', async () => {
    const { service, telemetry, state } = makeConversationService();

    const conversation = await service.begin(contextWith(), undefined, 'trace-1');

    expect(conversation.conversationId).toBeTruthy();
    expect(conversation.firstAssistantTurn).toBe(true);
    expect(conversation.created).toBe(true);
    const rows = state.tables.get('zac.conversations') ?? [];
    expect(rows).toHaveLength(1);
    expect(rows[0]['business_id']).toBe('biz-1');
    expect(rows[0]['actor_user_id']).toBe('owner-1');
    expect(rows[0]['status']).toBe('active');
    expect(telemetry.recordSpineEvent).toHaveBeenCalledWith(
      'conversation_created',
      expect.objectContaining({ conversation_id: conversation.conversationId }),
    );
  });

  it('reuses an owned conversation and reports continuation state', async () => {
    const { service, telemetry } = makeConversationService();
    const first = await service.begin(contextWith(), undefined, 'trace-1');
    await service.persistTurn(contextWith(), {
      conversationId: first.conversationId,
      traceId: 'trace-1',
      userSummary: 'Asked a question routed to report.business_health.',
      assistantSummary: 'Insight via report.business_health',
      responseType: 'Insight',
      model: null,
      outputTokens: null,
    });

    const second = await service.begin(contextWith(), first.conversationId!, 'trace-2');

    expect(second.conversationId).toBe(first.conversationId);
    expect(second.firstAssistantTurn).toBe(false);
    expect(second.recentSummaries.length).toBeGreaterThan(0);
    expect(telemetry.recordSpineEvent).toHaveBeenCalledWith(
      'conversation_reused',
      expect.objectContaining({ conversation_id: first.conversationId }),
    );
  });

  it("rejects another user's conversation with an existence-hiding 404", async () => {
    const { service } = makeConversationService();
    const foreign = await service.begin(contextWith({ actorUserId: 'other-user' }), undefined, 't1');

    await expect(
      service.begin(contextWith(), foreign.conversationId!, 't2'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rejects a conversation from another business with the same 404', async () => {
    const { service } = makeConversationService();
    const otherBiz = await service.begin(contextWith({ businessId: 'biz-2' }), undefined, 't1');

    await expect(
      service.begin(contextWith(), otherBiz.conversationId!, 't2'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rejects an unknown conversation id without revealing anything', async () => {
    const { service } = makeConversationService();

    await expect(
      service.begin(contextWith(), '00000000-0000-0000-0000-000000000000', 't1'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('persists user and assistant safe summaries with the trace id', async () => {
    const { service, state } = makeConversationService();
    const conversation = await service.begin(contextWith(), undefined, 'trace-1');

    await service.persistTurn(contextWith(), {
      conversationId: conversation.conversationId,
      traceId: 'trace-1',
      userSummary: 'Asked ZAC to remember something.',
      assistantSummary: 'Explanation',
      responseType: 'Explanation',
      model: null,
      outputTokens: null,
    });

    const messages = state.tables.get('zac.messages') ?? [];
    expect(messages).toHaveLength(2);
    expect(messages.map((row) => row['role']).sort()).toEqual(['assistant', 'user']);
    expect(messages.every((row) => row['trace_id'] === 'trace-1')).toBe(true);
    // Assistant rows carry no human actor — ownership derives from the conversation.
    expect(messages.find((row) => row['role'] === 'assistant')!['actor_user_id']).toBeNull();
  });

  it('degrades to a stateless turn (null id + loud telemetry) when storage is down', async () => {
    const { service, telemetry } = makeConversationService();
    const fake = (globalThis as { __supabaseFake?: { schema: unknown } }).__supabaseFake!;
    fake.schema = () => {
      throw new Error('PGRST106 Invalid schema: zac');
    };

    const conversation = await service.begin(contextWith(), undefined, 'trace-1');

    expect(conversation.conversationId).toBeNull();
    expect(conversation.firstAssistantTurn).toBe(true);
    expect(telemetry.recordSpineEvent).toHaveBeenCalledWith(
      'persistence_failed',
      expect.objectContaining({ operation: 'conversation_create' }),
    );
  });

  it('never lets a message write failure break the answer path', async () => {
    const { service, telemetry } = makeConversationService();
    const conversation = await service.begin(contextWith(), undefined, 'trace-1');
    const fake = (globalThis as { __supabaseFake?: { schema: unknown } }).__supabaseFake!;
    fake.schema = () => {
      throw new Error('storage down');
    };

    await expect(
      service.persistTurn(contextWith(), {
        conversationId: conversation.conversationId,
        traceId: 'trace-1',
        userSummary: 'Asked a question.',
        assistantSummary: 'Explanation',
        responseType: 'Explanation',
        model: null,
        outputTokens: null,
      }),
    ).resolves.toBeUndefined();
    expect(telemetry.recordSpineEvent).toHaveBeenCalledWith(
      'persistence_failed',
      expect.objectContaining({ operation: 'append_turn' }),
    );
  });
});
