import type { ConfigService } from '@nestjs/config';
import type { LocationCommunicationSettings } from '@sheer/domain';
import { BookingNotificationService } from './booking-notification.service';
import type { CommunicationSettingsService } from './communication-settings.service';
import type { EnqueueOnChannelRequest, MessagingService } from './messaging.service';
import type { OptOutService } from './opt-out.service';

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

function makeService(
  state: FakeState,
  settings: LocationCommunicationSettings,
  optedOut: string[] = [],
): BookingNotificationService {
  const config = {
    getOrThrow: () => 'https://example.supabase.co',
  } as unknown as ConfigService;
  const settingsService = {
    getForLocation: jest.fn().mockResolvedValue(settings),
  } as unknown as CommunicationSettingsService;
  // Queue writes now go through the single send API. The fake records them in the same shape the
  // raw insert used to take, so these assertions still describe what lands in the queue.
  const messaging = {
    enqueueOnChannel: jest.fn(async (req: EnqueueOnChannelRequest) => {
      state.inserts.push({
        business_id: req.businessId,
        location_id: req.locationId,
        client_profile_id: req.clientProfileId,
        appointment_id: req.appointmentId,
        channel: req.channel,
        event_key: req.eventKey,
        status: 'queued',
        scheduled_for: req.scheduledFor.toISOString(),
        payload_json: req.payload,
      });
      return { status: 'queued' as const, eventId: `evt-${state.inserts.length}` };
    }),
  } as unknown as MessagingService;
  const optOuts = {
    channelsFor: jest.fn().mockResolvedValue({ channels: optedOut, degraded: false }),
  } as unknown as OptOutService;

  const service = new BookingNotificationService(config, settingsService, messaging, optOuts);
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
    client: { first_name: 'Sam', phone: '+447725485160', email: 'sam@example.com', communication_preference: 'whatsapp' },
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
    reminder2hEnabled: false,
    reminder24hEnabled: false,
    reminder48hEnabled: false,
    reminder1wEnabled: false,
    emailFallbackEnabled: false,
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
      client: { first_name: 'Sam', phone: '+447725485160', email: null, communication_preference: 'email' },
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
      client: { first_name: 'Sam', phone: '+447725485160', email: 'sam@example.com', communication_preference: 'email' },
    });
    // emailFallbackEnabled is OFF — an explicit email preference still schedules on email.
    const service = makeService(state, settings({ sendBookingConfirmation: true, reminder24hEnabled: true }));

    await service.syncBookingNotifications('appt-1', NOW);

    expect(state.inserts.map((i) => i.channel)).toEqual(['email', 'email']);
    expect(state.inserts.map((i) => i.event_key)).toEqual(['booking_confirmation', 'appointment_reminder_24h']);
  });

  it('cancels a stale WhatsApp event and reschedules on email when preference switches to email', async () => {
    const state = baseState({
      appointment: { ...baseState().appointment!, communication_preference: 'email' },
      client: { first_name: 'Sam', phone: '+447725485160', email: 'sam@example.com', communication_preference: 'email' },
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

  it('does NOT re-queue an already-SENT confirmation when the channel changes (test F)', async () => {
    // THE BILLING DEFECT THIS FIXES. The confirmation was already delivered on
    // WhatsApp. The client then switches to email, and a later reschedule
    // re-runs this sync. The sent WhatsApp row is invisible to a match scoped to
    // email, so a second confirmation used to be inserted — the partial unique
    // index allows it because the channel differs — and the client received the
    // same message twice. Both attempts compute `ap:appt-1:booking_confirmation`,
    // so the ledger counted the second as zero and nothing could detect it.
    const state = baseState({
      appointment: { ...baseState().appointment!, communication_preference: 'email' },
      client: { first_name: 'Sam', phone: '+447725485160', email: 'sam@example.com', communication_preference: 'email' },
      existingEvents: [
        {
          id: 'e1',
          event_key: 'booking_confirmation',
          channel: 'whatsapp',
          status: 'sent',
          scheduled_for: NOW.toISOString(),
          payload_json: { appointment_start: baseState().appointment!.scheduled_start_at },
        },
      ],
    });
    const service = makeService(state, settings({ sendBookingConfirmation: true }));

    await service.syncBookingNotifications('appt-1', NOW);

    // No second confirmation on any channel, and no provider send to follow.
    expect(state.inserts.map((i) => i.event_key)).not.toContain('booking_confirmation');
    // The sent row is left exactly as it is: it is history, not a queue entry.
    expect(state.updates.every((u) => u.status !== 'cancelled')).toBe(true);
  });

  it('still re-routes an UNSENT confirmation when the channel changes', async () => {
    // The counterpart guarantee. A queued event has reached no provider, so it
    // is only a routing decision and must follow the client's new preference —
    // otherwise the fix above would silently stop legitimate messages.
    const state = baseState({
      appointment: { ...baseState().appointment!, communication_preference: 'email' },
      client: { first_name: 'Sam', phone: '+447725485160', email: 'sam@example.com', communication_preference: 'email' },
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

    expect(state.inserts.map((i) => i.channel)).toEqual(['email']);
    expect(state.updates.some((u) => u.status === 'cancelled')).toBe(true);
  });

  it('does not re-queue a message whose fallback is still in flight on another channel', async () => {
    // fallback_pending means the next channel is already carrying this message.
    // Inserting again would race the successor and deliver twice.
    const state = baseState({
      appointment: { ...baseState().appointment!, communication_preference: 'email' },
      client: { first_name: 'Sam', phone: '+447725485160', email: 'sam@example.com', communication_preference: 'email' },
      existingEvents: [
        {
          id: 'e1',
          event_key: 'booking_confirmation',
          channel: 'whatsapp',
          status: 'fallback_pending',
          scheduled_for: NOW.toISOString(),
          payload_json: { appointment_start: baseState().appointment!.scheduled_start_at },
        },
      ],
    });
    const service = makeService(state, settings({ sendBookingConfirmation: true }));

    await service.syncBookingNotifications('appt-1', NOW);

    expect(state.inserts.map((i) => i.event_key)).not.toContain('booking_confirmation');
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
      client: { first_name: 'Sam', phone: '+447725485160', communication_preference: 'sms' },
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

  it('schedules on SMS when the client has opted out of WhatsApp', async () => {
    const state = baseState();
    const service = makeService(
      state,
      settings({ sendBookingConfirmation: true, smsFallbackEnabled: true }),
      ['whatsapp'],
    );

    await service.syncBookingNotifications('appt-1', NOW);

    expect(state.inserts.map((i) => i.channel)).toEqual(['sms']);
  });

  it('cancels pending events when the client has opted out of every eligible channel', async () => {
    const state = baseState({
      existingEvents: [
        { id: 'e1', event_key: 'booking_confirmation', channel: 'whatsapp', status: 'queued', scheduled_for: NOW.toISOString() },
      ],
    });
    const service = makeService(
      state,
      settings({ sendBookingConfirmation: true, smsFallbackEnabled: true, emailFallbackEnabled: true }),
      ['whatsapp', 'sms', 'email'],
    );

    await service.syncBookingNotifications('appt-1', NOW);

    expect(state.inserts).toHaveLength(0);
    expect(state.updates.some((u) => u.status === 'cancelled')).toBe(true);
  });

  it('re-queues a rescheduled reminder whose earlier attempt had handed over to a fallback', async () => {
    // The WhatsApp attempt was ineligible at dispatch and handed over, leaving the source event
    // `fallback_pending`. That row is history, but the partial unique index still counts it, so it
    // has to be retired or the reminder for the NEW time is silently never queued.
    const state = baseState({
      existingEvents: [
        {
          id: 'e1',
          event_key: 'appointment_reminder_24h',
          channel: 'whatsapp',
          status: 'fallback_pending',
          scheduled_for: new Date(NOW.getTime() + 5 * DAY).toISOString(), // the pre-reschedule time
        },
      ],
    });
    const service = makeService(state, settings({ reminder24hEnabled: true }));

    await service.syncBookingNotifications('appt-1', NOW);

    expect(state.updates.some((u) => u.status === 'cancelled')).toBe(true);
    expect(state.inserts.map((i) => i.event_key)).toEqual(['appointment_reminder_24h']);
    expect(state.inserts[0]?.scheduled_for).toBe(new Date(NOW.getTime() + 2 * DAY).toISOString());
  });

  it('reschedules an UNSENT reminder in place, refreshing its occurrence anchor (test 4)', async () => {
    // The reminder has not been sent, so there is no second communication and no
    // second unit: the SAME row is updated to the new time. Its payload snapshot
    // is refreshed with it, which is what keeps the send-time staleness check
    // (and, now, the usage occurrence) correct for the reminder that goes out.
    const state = baseState({
      existingEvents: [
        {
          id: 'e1',
          event_key: 'appointment_reminder_24h',
          channel: 'whatsapp',
          status: 'queued',
          scheduled_for: new Date(NOW.getTime() + 5 * DAY).toISOString(), // pre-reschedule
          payload_json: { appointment_start: new Date(NOW.getTime() + 6 * DAY).toISOString() },
        },
      ],
    });
    const service = makeService(state, settings({ reminder24hEnabled: true }));

    await service.syncBookingNotifications('appt-1', NOW);

    // Updated in place — no new event, so nothing new to count.
    expect(state.inserts).toHaveLength(0);
    const rescheduled = state.updates.find((u) => u.scheduled_for);
    expect(rescheduled?.scheduled_for).toBe(new Date(NOW.getTime() + 2 * DAY).toISOString());
    expect((rescheduled?.payload_json as Record<string, unknown>)?.appointment_start).toBe(
      baseState().appointment!.scheduled_start_at,
    );
  });

  it('gives the re-queued reminder the NEW appointment time as its occurrence anchor (test 5)', async () => {
    // The prior attempt left the queue (it handed over to a fallback) and the
    // appointment has since moved, so this IS a genuine second communication.
    // The new event must carry the NEW appointment_start, because that anchor is
    // what makes its usage identity different from the first occurrence's.
    const state = baseState({
      existingEvents: [
        {
          id: 'e1',
          event_key: 'appointment_reminder_24h',
          channel: 'whatsapp',
          status: 'fallback_pending',
          scheduled_for: new Date(NOW.getTime() + 5 * DAY).toISOString(),
          payload_json: { appointment_start: new Date(NOW.getTime() + 6 * DAY).toISOString() },
        },
      ],
    });
    const service = makeService(state, settings({ reminder24hEnabled: true }));

    await service.syncBookingNotifications('appt-1', NOW);

    expect(state.inserts).toHaveLength(1);
    const inserted = state.inserts[0].payload_json as Record<string, unknown>;
    const previous = new Date(NOW.getTime() + 6 * DAY).toISOString();
    expect(inserted.appointment_start).toBe(baseState().appointment!.scheduled_start_at);
    expect(inserted.appointment_start).not.toBe(previous);
  });

  it('leaves a fallback_pending reminder alone when the appointment time has not moved', async () => {
    // Its fallback is legitimately still in flight; re-queueing the primary here would double-send.
    const state = baseState({
      existingEvents: [
        {
          id: 'e1',
          event_key: 'appointment_reminder_24h',
          channel: 'whatsapp',
          status: 'fallback_pending',
          scheduled_for: new Date(NOW.getTime() + 2 * DAY).toISOString(), // exactly the desired time
        },
      ],
    });
    const service = makeService(state, settings({ reminder24hEnabled: true }));

    await service.syncBookingNotifications('appt-1', NOW);

    expect(state.inserts).toHaveLength(0);
    expect(state.updates.some((u) => u.status === 'cancelled')).toBe(false);
  });
});
