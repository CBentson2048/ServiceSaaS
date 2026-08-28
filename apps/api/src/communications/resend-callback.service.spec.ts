import type { ConfigService } from '@nestjs/config';
import { ResendCallbackService } from './resend-callback.service';
import type { NotificationEscalationService } from './notification-escalation.service';
import type { OptOutService } from './opt-out.service';

interface FakeState {
  log: Record<string, unknown> | null;
  updates: Array<{ table: string; payload: Record<string, unknown> }>;
  escalations: Array<{ eventId: string; failedChannel: string; reason: string }>;
  optOuts: Array<{ businessId: string; clientProfileId: string; channel: string; source: string }>;
}

function makeFakeClient(state: FakeState) {
  function from(table: string) {
    let mode: 'select' | 'update' = 'select';
    let payload: Record<string, unknown> | null = null;
    const chain: Record<string, unknown> = {
      select: () => chain,
      eq: () => chain,
      order: () => chain,
      limit: () => chain,
      update: (p: Record<string, unknown>) => {
        mode = 'update';
        payload = p;
        return chain;
      },
      maybeSingle: () => Promise.resolve({ data: state.log, error: null }),
      then: (onF: (v: { error: null }) => unknown, onR?: (e: unknown) => unknown) => {
        if (mode === 'update' && payload) state.updates.push({ table, payload });
        return Promise.resolve({ error: null }).then(onF, onR);
      },
    };
    return chain;
  }
  return { schema: () => ({ from }) };
}

function makeService(state: FakeState): ResendCallbackService {
  const config = {
    getOrThrow: () => 'https://example.supabase.co',
    get: () => 'whsec_test',
  } as unknown as ConfigService;
  const escalation = {
    escalateFromEventSafe: jest.fn(async (eventId: string, failedChannel: string, reason: string) => {
      state.escalations.push({ eventId, failedChannel, reason });
      return null;
    }),
  } as unknown as NotificationEscalationService;
  const optOuts = {
    recordOptOut: jest.fn(
      async (businessId: string, clientProfileId: string, channel: string, source: string) => {
        state.optOuts.push({ businessId, clientProfileId, channel, source });
      },
    ),
  } as unknown as OptOutService;
  const service = new ResendCallbackService(config, escalation, optOuts);
  (service as unknown as { admin: unknown }).admin = makeFakeClient(state);
  return service;
}

function emailLog(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'log1',
    channel: 'email',
    message_type: 'booking_confirmation',
    delivery_status: 'sent',
    notification_event_id: 'evt1',
    appointment_id: 'apt1',
    business_id: 'biz1',
    client_profile_id: 'client1',
    ...over,
  };
}

function state(log: Record<string, unknown> | null): FakeState {
  return { log, updates: [], escalations: [], optOuts: [] };
}

describe('ResendCallbackService.handleEvent', () => {
  it('advances a sent email log to delivered and mirrors the event (no escalation)', async () => {
    const s = state(emailLog());
    await makeService(s).handleEvent({ type: 'email.delivered', data: { email_id: 'resend-1' } });

    const logUpdate = s.updates.find((u) => u.table === 'message_logs');
    expect(logUpdate?.payload.delivery_status).toBe('delivered');
    expect(logUpdate?.payload.delivered_at).toBeDefined();
    const eventUpdate = s.updates.find((u) => u.table === 'notification_events');
    expect(eventUpdate?.payload.status).toBe('delivered');
    expect(s.escalations).toHaveLength(0);
  });

  it('marks a bounce failed and escalates email → next channel', async () => {
    const s = state(emailLog());
    await makeService(s).handleEvent({ type: 'email.bounced', data: { email_id: 'resend-1' } });

    const logUpdate = s.updates.find((u) => u.table === 'message_logs');
    expect(logUpdate?.payload.delivery_status).toBe('failed');
    expect(logUpdate?.payload.failed_at).toBeDefined();
    expect(s.escalations).toEqual([
      { eventId: 'evt1', failedChannel: 'email', reason: expect.stringContaining('bounced') },
    ]);
  });

  it('marks a spam complaint failed but does NOT escalate (the email arrived)', async () => {
    const s = state(emailLog());
    await makeService(s).handleEvent({ type: 'email.complained', data: { email_id: 'resend-1' } });

    expect(s.updates.find((u) => u.table === 'message_logs')?.payload.delivery_status).toBe('failed');
    expect(s.escalations).toHaveLength(0);
  });

  it('records an email opt-out on a spam complaint (the client asked us to stop)', async () => {
    const s = state(emailLog());
    await makeService(s).handleEvent({ type: 'email.complained', data: { email_id: 'rs1' } });

    expect(s.optOuts).toEqual([
      { businessId: 'biz1', clientProfileId: 'client1', channel: 'email', source: 'provider_error' },
    ]);
    // Complaining is not a delivery failure to route around — nothing escalates.
    expect(s.escalations).toHaveLength(0);
  });

  it('does not record an opt-out on a hard bounce (the address failed, the client did not object)', async () => {
    const s = state(emailLog());
    await makeService(s).handleEvent({ type: 'email.bounced', data: { email_id: 'rs1' } });

    expect(s.optOuts).toHaveLength(0);
    expect(s.escalations).toHaveLength(1);
  });

  it('ignores untracked event types and missing ids', async () => {
    const s1 = state(emailLog());
    await makeService(s1).handleEvent({ type: 'email.opened', data: { email_id: 'resend-1' } });
    expect(s1.updates).toHaveLength(0);

    const s2 = state(emailLog());
    await makeService(s2).handleEvent({ type: 'email.delivered', data: {} });
    expect(s2.updates).toHaveLength(0);
  });

  it('drops a webhook when no matching email log exists', async () => {
    const s = state(null);
    await makeService(s).handleEvent({ type: 'email.delivered', data: { email_id: 'unknown' } });
    expect(s.updates).toHaveLength(0);
    expect(s.escalations).toHaveLength(0);
  });

  it('does not downgrade an already-delivered log on a late "sent"-equivalent event', async () => {
    const s = state(emailLog({ delivery_status: 'delivered' }));
    await makeService(s).handleEvent({ type: 'email.sent', data: { email_id: 'resend-1' } });
    expect(s.updates).toHaveLength(0);
  });
});
