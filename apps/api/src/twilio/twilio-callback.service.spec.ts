import type { ConfigService } from '@nestjs/config';
import { TwilioCallbackService } from './twilio-callback.service';
import type { NotificationEscalationService } from '../communications/notification-escalation.service';
import type { OptOutService } from '../communications/opt-out.service';
import type { WhatsAppService } from '../communications/whatsapp.service';

interface FakeState {
  /** Row returned by any `.maybeSingle()` select, keyed by table. */
  rows: Record<string, Record<string, unknown> | null>;
  updates: Array<{ table: string; payload: Record<string, unknown> }>;
  inserts: Array<{ table: string; row: Record<string, unknown> }>;
  fallbacks: Array<{ eventId: string; failedChannel: string; reason: string }>;
  optOuts: Array<{ businessId: string; clientProfileId: string; channel: string; source: string; cleared: boolean }>;
}

function makeFakeClient(state: FakeState) {
  function from(table: string) {
    let mode: 'select' | 'update' | 'insert' = 'select';
    let updatePayload: Record<string, unknown> | null = null;

    const chain: Record<string, unknown> = {
      select: () => chain,
      eq: () => chain,
      in: () => chain,
      order: () => chain,
      limit: () => chain,
      update: (p: Record<string, unknown>) => {
        mode = 'update';
        updatePayload = p;
        return chain;
      },
      insert: (row: Record<string, unknown>) => {
        mode = 'insert';
        state.inserts.push({ table, row });
        return Promise.resolve({ error: null });
      },
      maybeSingle: () => Promise.resolve({ data: state.rows[table] ?? null, error: null }),
      single: () => Promise.resolve({ data: state.rows[table] ?? null, error: null }),
      then: (onF: (v: { error: null }) => unknown, onR?: (e: unknown) => unknown) => {
        if (mode === 'update' && updatePayload) state.updates.push({ table, payload: updatePayload });
        return Promise.resolve({ error: null }).then(onF, onR);
      },
    };
    return chain;
  }
  return { schema: () => ({ from }) };
}

function makeService(state: FakeState): TwilioCallbackService {
  const config = { getOrThrow: () => 'https://example.supabase.co' } as unknown as ConfigService;
  const whatsapp = { provider: 'twilio', verifyWebhookSignature: () => true } as unknown as WhatsAppService;
  const escalation = {
    escalateFromEventSafe: jest.fn(async (eventId: string, failedChannel: string, reason: string) => {
      state.fallbacks.push({ eventId, failedChannel, reason });
      return null;
    }),
  } as unknown as NotificationEscalationService;
  const optOuts = {
    channelsFor: jest.fn().mockResolvedValue({ channels: [], degraded: false }),
    recordOptOut: jest.fn(async (businessId: string, clientProfileId: string, channel: string, source: string) => {
      state.optOuts.push({ businessId, clientProfileId, channel, source, cleared: false });
    }),
    clearOptOut: jest.fn(async (businessId: string, clientProfileId: string, channel: string) => {
      state.optOuts.push({ businessId, clientProfileId, channel, source: 'cleared', cleared: true });
    }),
  } as unknown as OptOutService;
  const service = new TwilioCallbackService(config, whatsapp, escalation, optOuts);
  (service as unknown as { admin: unknown }).admin = makeFakeClient(state);
  return service;
}

function emptyState(rows: FakeState['rows']): FakeState {
  return { rows, updates: [], inserts: [], fallbacks: [], optOuts: [] };
}

describe('TwilioCallbackService.handleStatusCallback', () => {
  it('advances a sent message log to delivered and mirrors the notification event', async () => {
    const state = emptyState({
      message_logs: {
        id: 'log1',
        channel: 'whatsapp',
        message_type: 'booking_confirmation',
        delivery_status: 'sent',
        notification_event_id: 'evt1',
        appointment_id: 'apt1',
      },
    });
    const service = makeService(state);
    await service.handleStatusCallback({ MessageSid: 'SM1', MessageStatus: 'delivered' });

    const logUpdate = state.updates.find((u) => u.table === 'message_logs');
    expect(logUpdate?.payload.delivery_status).toBe('delivered');
    expect(logUpdate?.payload.delivered_at).toBeDefined();
    expect(logUpdate?.payload.provider_status).toBe('delivered');

    const eventUpdate = state.updates.find((u) => u.table === 'notification_events');
    expect(eventUpdate?.payload.status).toBe('delivered');

    // A delivered WhatsApp message must NOT trigger an SMS fallback.
    expect(state.fallbacks).toHaveLength(0);
  });

  it('records the failure reason and escalates to the next channel on a failed WhatsApp callback', async () => {
    const state = emptyState({
      message_logs: {
        id: 'log1',
        channel: 'whatsapp',
        message_type: 'booking_confirmation',
        delivery_status: 'sent',
        notification_event_id: 'evt1',
        business_id: 'biz1',
        client_profile_id: 'cli1',
        appointment_id: 'apt1',
      },
    });
    const service = makeService(state);
    await service.handleStatusCallback({
      MessageSid: 'SM1',
      MessageStatus: 'failed',
      ErrorCode: '63016',
      ErrorMessage: 'Failed to send freeform message',
    });

    const logUpdate = state.updates.find((u) => u.table === 'message_logs');
    expect(logUpdate?.payload.delivery_status).toBe('failed');
    expect(logUpdate?.payload.failed_at).toBeDefined();
    expect(String(logUpdate?.payload.error_message)).toContain('63016');

    // Async real failure of WhatsApp → escalate to the next channel in the chain for this notification.
    expect(state.fallbacks).toEqual([
      { eventId: 'evt1', failedChannel: 'whatsapp', reason: expect.stringContaining('whatsapp failed') },
    ]);
    // 63016 is a freeform-window error, not an unsubscribe — it must not record an opt-out.
    expect(state.optOuts).toHaveLength(0);
  });

  it('records a per-channel opt-out when Twilio reports the recipient as unsubscribed (21610)', async () => {
    const state = emptyState({
      message_logs: {
        id: 'log1',
        channel: 'sms',
        message_type: 'booking_confirmation',
        delivery_status: 'sent',
        notification_event_id: 'evt1',
        business_id: 'biz1',
        client_profile_id: 'cli1',
        appointment_id: 'apt1',
      },
    });
    const service = makeService(state);
    await service.handleStatusCallback({
      MessageSid: 'SM1',
      MessageStatus: 'failed',
      ErrorCode: '21610',
      ErrorMessage: 'Attempt to send to unsubscribed recipient',
    });

    expect(state.optOuts).toEqual([
      { businessId: 'biz1', clientProfileId: 'cli1', channel: 'sms', source: 'provider_error', cleared: false },
    ]);
    // The opt-out is recorded AND the message still escalates to the next channel.
    expect(state.fallbacks).toEqual([
      { eventId: 'evt1', failedChannel: 'sms', reason: expect.any(String) },
    ]);
  });

  it('delegates from an SMS failure by notification event, whatever it is attached to', async () => {
    const state = emptyState({
      message_logs: {
        id: 'log2',
        channel: 'sms',
        message_type: 'campaign:winback',
        delivery_status: 'sent',
        notification_event_id: 'evt2',
        business_id: 'biz1',
        client_profile_id: 'cli1',
        // A campaign message has no appointment. Escalation used to be keyed on this column and
        // silently did nothing when it was null.
        appointment_id: null,
      },
    });
    const service = makeService(state);
    await service.handleStatusCallback({ MessageSid: 'SM2', MessageStatus: 'failed', ErrorCode: '30006' });
    expect(state.fallbacks).toEqual([
      { eventId: 'evt2', failedChannel: 'sms', reason: expect.any(String) },
    ]);
  });

  it('does not downgrade a delivered log when a late "sent" callback arrives', async () => {
    const state = emptyState({
      message_logs: {
        id: 'log1',
        channel: 'whatsapp',
        message_type: 'booking_confirmation',
        delivery_status: 'delivered',
        notification_event_id: 'evt1',
        appointment_id: 'apt1',
      },
    });
    const service = makeService(state);
    await service.handleStatusCallback({ MessageSid: 'SM1', MessageStatus: 'sent' });
    expect(state.updates).toHaveLength(0);
    expect(state.fallbacks).toHaveLength(0);
  });

  it('ignores callbacks with no MessageSid or an untracked status', async () => {
    const state = emptyState({ message_logs: null });
    const service = makeService(state);
    await service.handleStatusCallback({ MessageStatus: 'delivered' });
    await service.handleStatusCallback({ MessageSid: 'SM1', MessageStatus: 'receiving' });
    expect(state.updates).toHaveLength(0);
  });

  it('drops a status callback when no matching message log exists', async () => {
    const state = emptyState({ message_logs: null });
    const service = makeService(state);
    await service.handleStatusCallback({ MessageSid: 'SM-unknown', MessageStatus: 'delivered' });
    expect(state.updates).toHaveLength(0);
  });
});

describe('TwilioCallbackService.handleInboundMessage', () => {
  it('logs an inbound reply attributed to the latest outbound recipient context', async () => {
    const state = emptyState({
      message_logs: {
        id: 'log1',
        channel: 'whatsapp',
        message_type: 'booking_confirmation',
        delivery_status: 'delivered',
        notification_event_id: null,
        business_id: 'biz1',
        location_id: 'loc1',
        client_profile_id: 'cli1',
        appointment_id: 'apt1',
      },
    });
    const service = makeService(state);
    await service.handleInboundMessage({
      MessageSid: 'SM-in',
      From: 'whatsapp:+447700900123',
      To: 'whatsapp:+14155238886',
      Body: 'Can I move my appointment?',
    });

    const insert = state.inserts.find((i) => i.table === 'message_logs');
    expect(insert?.row.direction).toBe('inbound');
    expect(insert?.row.channel).toBe('whatsapp');
    expect(insert?.row.business_id).toBe('biz1');
    expect(insert?.row.client_profile_id).toBe('cli1');
    expect(insert?.row.content_preview).toContain('move my appointment');
    // An ordinary reply is conversation, not an unsubscribe.
    expect(state.optOuts).toHaveLength(0);
  });

  it('records a WhatsApp opt-out when the client replies STOP, and still logs the reply', async () => {
    const state = emptyState({
      message_logs: {
        id: 'log1',
        channel: 'whatsapp',
        message_type: 'booking_confirmation',
        delivery_status: 'delivered',
        notification_event_id: null,
        business_id: 'biz1',
        location_id: 'loc1',
        client_profile_id: 'cli1',
        appointment_id: 'apt1',
      },
    });
    const service = makeService(state);
    await service.handleInboundMessage({ MessageSid: 'SM-in', From: 'whatsapp:+447700900123', Body: 'STOP' });

    expect(state.inserts.some((i) => i.table === 'message_logs' && i.row.direction === 'inbound')).toBe(true);
    expect(state.optOuts).toEqual([
      { businessId: 'biz1', clientProfileId: 'cli1', channel: 'whatsapp', source: 'inbound_keyword', cleared: false },
    ]);
  });

  it('clears the opt-out when the client replies START', async () => {
    const state = emptyState({
      message_logs: {
        id: 'log1',
        channel: 'sms',
        message_type: 'booking_confirmation',
        delivery_status: 'delivered',
        notification_event_id: null,
        business_id: 'biz1',
        location_id: 'loc1',
        client_profile_id: 'cli1',
        appointment_id: 'apt1',
      },
    });
    const service = makeService(state);
    await service.handleInboundMessage({ MessageSid: 'SM-in', From: '+447700900123', Body: 'start' });

    expect(state.optOuts).toEqual([
      { businessId: 'biz1', clientProfileId: 'cli1', channel: 'sms', source: 'cleared', cleared: true },
    ]);
  });

  it('does not persist an inbound reply it cannot attribute to a client', async () => {
    const state = emptyState({ message_logs: null });
    const service = makeService(state);
    await service.handleInboundMessage({ MessageSid: 'SM-in', From: 'whatsapp:+999', Body: 'hi' });
    expect(state.inserts).toHaveLength(0);
  });
});
