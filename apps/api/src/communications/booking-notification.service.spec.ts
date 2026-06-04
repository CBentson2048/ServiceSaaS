import type { ConfigService } from '@nestjs/config';
import type { LocationCommunicationSettings } from '@sheer/domain';
import { BookingNotificationService } from './booking-notification.service';
import type { CommunicationSettingsService } from './communication-settings.service';

const DAY = 86_400_000;
const NOW = new Date('2026-06-02T09:00:00.000Z');

interface FakeState {
  appointment: Record<string, unknown> | null;
  location: { name: string; timezone: string };
  client: { first_name: string; phone: string | null; email?: string | null; communication_preference: string | null };
  existingEvents: Array<Record<string, unknown>>;
  inserts: Array<Record<string, unknown>>;
  updates: Array<Record<string, unknown>>;
}

/**
 * Minimal thenable Supabase-client stub covering only the chains the service uses.
 * Records inserts/updates so the test can assert idempotency and cancellation behaviour.
 */
function makeFakeClient(state: FakeState) {
  const builder = (schema: string, table: string) => {
    const b: Record<string, unknown> = {};
    let op: 'select' | 'insert' | 'update' = 'select';
    let payload: Record<string, unknown> | null = null;

    const chain = () => b;
    for (const m of ['select', 'eq', 'in', 'order', 'lte', 'or', 'limit', 'maybeSingle', 'single', 'returns']) {
      b[m] = chain;
    }
    b.insert = (rows: Record<string, unknown>) => {
      op = 'insert';
      payload = rows;
      return b;
    };
    b.update = (patch: Record<string, unknown>) => {
      op = 'update';
      payload = patch;
      return b;
    };
    b.then = (resolve: (value: { data: unknown; error: unknown }) => unknown) => {
      if (op === 'insert') {
        state.inserts.push(payload!);
        return Promise.resolve({ data: null, error: null }).then(resolve);
      }
      if (op === 'update') {
        state.updates.push(payload!);
        return Promise.resolve({ data: null, error: null }).then(resolve);
      }
      // select
      let data: unknown = null;
      if (table === 'appointments') data = state.appointment;
      else if (table === 'locations') data = state.location;
      else if (table === 'client_profiles') data = state.client;
      else if (table === 'notification_events') data = state.existingEvents;
      return Promise.resolve({ data, error: null }).then(resolve);
    };
    return b;
  };

  return { schema: (schema: string) => ({ from: (table: string) => builder(schema, table) }) };
}

function makeService(state: FakeState, settings: LocationCommunicationSettings): BookingNotificationService {
  const config = {
    getOrThrow: () => 'https://example.supabase.co',
  } as unknown as ConfigService;
  const settingsService = {
    getForLocation: jest.fn().mockResolvedValue(settings),
  } as unknown as CommunicationSettingsService;

  const service = new BookingNotificationService(config, settingsService);
  (service as unknown as { admin: unknown }).admin = makeFakeClient(state);
  return service;
}

function baseState(overrides: Partial<FakeState> = {}): FakeState {
  return {
    appointment: {
      id: 'appt-1',
      business_id: 'biz-1',
      location_id: 'loc-1',
      client_profile_id: 'client-1',
      status: 'confirmed',
      scheduled_start_at: new Date(NOW.getTime() + 3 * DAY).toISOString(),
      communication_preference: 'whatsapp',
      metadata: { service_names: ['Cut'], stylist_name: 'Alex' },
    },
    location: { name: 'Sheer Soho', timezone: 'Europe/London' },
    client: { first_name: 'Sam', phone: '+447700900123', email: 'sam@example.com', communication_preference: 'whatsapp' },
    existingEvents: [],
    inserts: [],
    updates: [],
    ...overrides,
  };
}

function settings(overrides: Partial<LocationCommunicationSettings> = {}): LocationCommunicationSettings {
  return {
    locationId: 'loc-1',
    enabled: true,
    enabledChannels: ['whatsapp'],
    sendBookingConfirmation: false,
    reminder24hEnabled: false,
    reminder48hEnabled: false,
    reminder1wEnabled: false,
    smsFallbackEnabled: false,
    ...overrides,
  };
}

describe('BookingNotificationService.syncBookingNotifications', () => {
  it('schedules confirmation + enabled reminders for a fresh booking', async () => {
    const state = baseState();
    const service = makeService(state, settings({ sendBookingConfirmation: true, reminder24hEnabled: true }));

    await service.syncBookingNotifications('appt-1', NOW);

    const keys = state.inserts.map((i) => i.event_key);
    expect(keys).toEqual(['booking_confirmation', 'appointment_reminder_24h']);
    expect(state.inserts.every((i) => i.channel === 'whatsapp' && i.status === 'queued')).toBe(true);
  });

  it('is idempotent — does not re-insert an event that already exists (duplicate prevention)', async () => {
    const state = baseState({
      existingEvents: [
        { id: 'e1', event_key: 'booking_confirmation', channel: 'whatsapp', status: 'queued', scheduled_for: NOW.toISOString() },
      ],
    });
    const service = makeService(state, settings({ sendBookingConfirmation: true }));

    await service.syncBookingNotifications('appt-1', NOW);

    expect(state.inserts).toHaveLength(0);
  });

  it('cancels pending events when the appointment is cancelled (stale protection)', async () => {
    const start = new Date(NOW.getTime() + 3 * DAY).toISOString();
    const state = baseState({
      appointment: {
        id: 'appt-1',
        business_id: 'biz-1',
        location_id: 'loc-1',
        client_profile_id: 'client-1',
        status: 'cancelled',
        scheduled_start_at: start,
        communication_preference: 'whatsapp',
        metadata: {},
      },
      existingEvents: [
        { id: 'e1', event_key: 'appointment_reminder_24h', channel: 'whatsapp', status: 'queued', scheduled_for: start },
      ],
    });
    const service = makeService(state, settings({ reminder24hEnabled: true }));

    await service.syncBookingNotifications('appt-1', NOW);

    expect(state.inserts).toHaveLength(0);
    expect(state.updates).toHaveLength(1);
    expect(state.updates[0].status).toBe('cancelled');
  });

  it('cancels pending events when an email-preferring client has no email address', async () => {
    const state = baseState({
      appointment: { ...baseState().appointment!, communication_preference: 'email' },
      client: { first_name: 'Sam', phone: '+447700900123', email: null, communication_preference: 'email' },
      existingEvents: [
        { id: 'e1', event_key: 'appointment_reminder_24h', channel: 'whatsapp', status: 'queued', scheduled_for: NOW.toISOString() },
      ],
    });
    const service = makeService(state, settings({ reminder24hEnabled: true }));

    await service.syncBookingNotifications('appt-1', NOW);

    expect(state.inserts).toHaveLength(0);
    expect(state.updates[0].status).toBe('cancelled');
  });

  it('schedules on the EMAIL channel when the client prefers email and has an address', async () => {
    const state = baseState({
      appointment: { ...baseState().appointment!, communication_preference: 'email' },
      client: { first_name: 'Sam', phone: '+447700900123', email: 'sam@example.com', communication_preference: 'email' },
    });
    const service = makeService(state, settings({ sendBookingConfirmation: true, reminder24hEnabled: true }));

    await service.syncBookingNotifications('appt-1', NOW);

    expect(state.inserts.map((i) => i.channel)).toEqual(['email', 'email']);
    expect(state.inserts.map((i) => i.event_key)).toEqual(['booking_confirmation', 'appointment_reminder_24h']);
  });

  it('cancels a stale WhatsApp event and reschedules on email when preference switches to email', async () => {
    const state = baseState({
      appointment: { ...baseState().appointment!, communication_preference: 'email' },
      client: { first_name: 'Sam', phone: '+447700900123', email: 'sam@example.com', communication_preference: 'email' },
      existingEvents: [
        {
          id: 'e1',
          event_key: 'booking_confirmation',
          channel: 'whatsapp',
          status: 'queued',
          scheduled_for: NOW.toISOString(),
          payload_json: { appointment_start: baseState().appointment!.scheduled_start_at },
        },
      ],
    });
    const service = makeService(state, settings({ sendBookingConfirmation: true }));

    await service.syncBookingNotifications('appt-1', NOW);

    // The stale WhatsApp confirmation is cancelled; a fresh email confirmation is scheduled.
    expect(state.updates.some((u) => u.status === 'cancelled')).toBe(true);
    expect(state.inserts.map((i) => i.channel)).toEqual(['email']);
  });

  it('does not schedule when the master switch is off', async () => {
    const state = baseState();
    const service = makeService(state, settings({ enabled: false, sendBookingConfirmation: true, reminder24hEnabled: true }));

    await service.syncBookingNotifications('appt-1', NOW);

    expect(state.inserts).toHaveLength(0);
  });

  it('schedules on the SMS channel when the client prefers SMS and SMS is enabled', async () => {
    const state = baseState({
      appointment: { ...baseState().appointment!, communication_preference: 'sms' },
      client: { first_name: 'Sam', phone: '+447700900123', communication_preference: 'sms' },
    });
    const service = makeService(state, settings({ sendBookingConfirmation: true, smsFallbackEnabled: true }));

    await service.syncBookingNotifications('appt-1', NOW);

    expect(state.inserts.map((i) => i.channel)).toEqual(['sms']);
    expect(state.inserts[0].event_key).toBe('booking_confirmation');
  });

  it('keeps WhatsApp as the primary channel even when SMS fallback is enabled', async () => {
    const state = baseState();
    const service = makeService(state, settings({ sendBookingConfirmation: true, smsFallbackEnabled: true }));

    await service.syncBookingNotifications('appt-1', NOW);

    expect(state.inserts.every((i) => i.channel === 'whatsapp')).toBe(true);
  });
});

describe('BookingNotificationService.enqueueSmsFallback', () => {
  it('queues an SMS fallback event for a failed WhatsApp notification when SMS is allowed', async () => {
    const state = baseState();
    const service = makeService(state, settings({ sendBookingConfirmation: true, smsFallbackEnabled: true }));

    const result = await service.enqueueSmsFallback('appt-1', 'booking_confirmation', 'WhatsApp failed', NOW);

    expect(result).toBe('queued');
    expect(state.inserts).toHaveLength(1);
    expect(state.inserts[0].channel).toBe('sms');
    expect(state.inserts[0].event_key).toBe('booking_confirmation');
    expect((state.inserts[0].payload_json as Record<string, unknown>).fallback).toBe(true);
  });

  it('does not queue an SMS fallback when SMS fallback is disabled', async () => {
    const state = baseState();
    const service = makeService(state, settings({ sendBookingConfirmation: true, smsFallbackEnabled: false }));

    const result = await service.enqueueSmsFallback('appt-1', 'booking_confirmation', 'WhatsApp failed', NOW);

    expect(result).toBe('skipped');
    expect(state.inserts).toHaveLength(0);
  });

  it('does not queue an SMS fallback for a reminder once the appointment has passed', async () => {
    const state = baseState({
      appointment: {
        ...baseState().appointment!,
        scheduled_start_at: new Date(NOW.getTime() - DAY).toISOString(),
      },
    });
    const service = makeService(state, settings({ reminder24hEnabled: true, smsFallbackEnabled: true }));

    const result = await service.enqueueSmsFallback('appt-1', 'appointment_reminder_24h', 'WhatsApp failed', NOW);

    expect(result).toBe('skipped');
    expect(state.inserts).toHaveLength(0);
  });
});
