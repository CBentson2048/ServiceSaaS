import type { ConfigService } from '@nestjs/config';
import { TwilioCallbackService } from './twilio-callback.service';
import type { BookingNotificationService } from '../communications/booking-notification.service';
import type { WhatsAppService } from '../communications/whatsapp.service';

interface FakeState {
  /** Row returned by any `.maybeSingle()` select, keyed by table. */
  rows: Record<string, Record<string, unknown> | null>;
  updates: Array<{ table: string; payload: Record<string, unknown> }>;
  inserts: Array<{ table: string; row: Record<string, unknown> }>;
  fallbacks: Array<{ appointmentId: string; eventKey: string; reason: string }>;
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
  const booking = {
    enqueueSmsFallbackSafe: jest.fn(async (appointmentId: string, eventKey: string, reason: string) => {
      state.fallbacks.push({ appointmentId, eventKey, reason });
    }),
  } as unknown as BookingNotificationService;
  const service = new TwilioCallbackService(config, whatsapp, booking);
  (service as unknown as { admin: unknown }).admin = makeFakeClient(state);
  return service;
}

function emptyState(rows: FakeState['rows']): FakeState {
  return { rows, updates: [], inserts: [], fallbacks: [] };
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

  it('records the failure reason and triggers an SMS fallback on a failed WhatsApp callback', async () => {
    const state = emptyState({
      message_logs: {
        id: 'log1',
        channel: 'whatsapp',
        message_type: 'booking_confirmation',
        delivery_status: 'sent',
        notification_event_id: null,
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

    // Async real failure of WhatsApp → fall back to SMS for the same notification.
    expect(state.fallbacks).toEqual([
      { appointmentId: 'apt1', eventKey: 'booking_confirmation', reason: expect.stringContaining('WhatsApp failed') },
    ]);
  });

  it('does not re-trigger a fallback when an SMS message itself fails', async () => {
    const state = emptyState({
      message_logs: {
        id: 'log2',
        channel: 'sms',
        message_type: 'booking_confirmation',
        delivery_status: 'sent',
        notification_event_id: null,
        appointment_id: 'apt1',
      },
    });
    const service = makeService(state);
    await service.handleStatusCallback({ MessageSid: 'SM2', MessageStatus: 'failed', ErrorCode: '30006' });
    expect(state.fallbacks).toHaveLength(0);
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
  });

  it('does not persist an inbound reply it cannot attribute to a client', async () => {
    const state = emptyState({ message_logs: null });
    const service = makeService(state);
    await service.handleInboundMessage({ MessageSid: 'SM-in', From: 'whatsapp:+999', Body: 'hi' });
    expect(state.inserts).toHaveLength(0);
  });
});
