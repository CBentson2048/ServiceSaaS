import type { ConfigService } from '@nestjs/config';
import type { LocationCommunicationSettings } from '@sheer/domain';
import type { CommunicationSettingsService } from './communication-settings.service';
import { MessagingService } from './messaging.service';
import { NotificationEscalationService } from './notification-escalation.service';
import { NotificationSubjectRegistry } from './notification-subject.registry';
import type { NotificationEventRow } from './notification-subject';
import type { OptOutService } from './opt-out.service';
import { AppointmentSubjectResolver } from './subjects/appointment-subject.resolver';
import { ClientSubjectResolver } from './subjects/client-subject.resolver';
import type { WhatsAppTemplateConfig } from './whatsapp-template.config';

const DAY = 86_400_000;
const NOW = new Date('2026-06-02T09:00:00.000Z');
const FUTURE = new Date(NOW.getTime() + 3 * DAY).toISOString();

interface State {
  appointment: Record<string, unknown> | null;
  client: Record<string, unknown> | null;
  location: { name: string; timezone: string };
  /** Row returned when the escalation service loads an event by id. */
  storedEvent: NotificationEventRow | null;
  inserts: Array<Record<string, unknown>>;
  updates: Array<Record<string, unknown>>;
  insertError: { code?: string; message: string } | null;
}

function makeFakeClient(state: State) {
  function from(table: string) {
    let op: 'select' | 'insert' | 'update' = 'select';
    let payload: Record<string, unknown> | null = null;
    const chain: Record<string, unknown> = {};
    const self = () => chain;
    for (const m of ['select', 'eq', 'neq', 'gt', 'in', 'not', 'order', 'limit', 'returns']) chain[m] = self;
    chain.insert = (row: Record<string, unknown>) => {
      op = 'insert';
      payload = row;
      return chain;
    };
    chain.update = (row: Record<string, unknown>) => {
      op = 'update';
      payload = row;
      return chain;
    };
    const result = () => {
      if (op === 'insert') {
        if (state.insertError) return { data: null, error: state.insertError };
        state.inserts.push(payload!);
        return { data: { id: `evt-${state.inserts.length}` }, error: null };
      }
      if (table === 'appointments') return { data: state.appointment, error: null };
      if (table === 'client_profiles') return { data: state.client, error: null };
      if (table === 'locations') return { data: state.location, error: null };
      if (table === 'notification_events') return { data: state.storedEvent, error: null };
      return { data: null, error: null };
    };
    chain.maybeSingle = () => Promise.resolve(result());
    chain.single = () => Promise.resolve(result());
    chain.then = (resolve: (v: unknown) => unknown) => {
      if (op === 'update' && payload) state.updates.push(payload);
      return Promise.resolve({ data: [], error: null }).then(resolve);
    };
    return chain;
  }
  return { schema: () => ({ from }) };
}

function settings(overrides: Partial<LocationCommunicationSettings> = {}): LocationCommunicationSettings {
  return {
    locationId: 'loc1',
    enabled: true,
    enabledChannels: ['whatsapp'],
    sendBookingConfirmation: true,
    reminder2hEnabled: true,
    reminder24hEnabled: true,
    reminder48hEnabled: false,
    reminder1wEnabled: false,
    emailFallbackEnabled: false,
    smsFallbackEnabled: false,
    ...overrides,
  };
}

function baseState(over: Partial<State> = {}): State {
  return {
    appointment: {
      id: 'apt1',
      business_id: 'biz1',
      location_id: 'loc1',
      client_profile_id: 'cli1',
      status: 'confirmed',
      scheduled_start_at: FUTURE,
      communication_preference: 'whatsapp',
      metadata: { service_names: ['Cut'] },
    },
    client: {
      first_name: 'Sam',
      phone: '+447725485160',
      email: 'sam@example.com',
      communication_preference: 'whatsapp',
      marketing_opt_in: true,
    },
    location: { name: 'Sheer Soho', timezone: 'Europe/London' },
    storedEvent: null,
    inserts: [],
    updates: [],
    insertError: null,
    ...over,
  };
}

function makeService(state: State, set = settings(), optedOut: string[] = []) {
  const config = { getOrThrow: () => 'https://example.supabase.co', get: () => undefined } as unknown as ConfigService;
  const templates = { contentSidFor: () => 'HX1', statusCallbackUrl: undefined } as unknown as WhatsAppTemplateConfig;
  const admin = makeFakeClient(state);

  const appointmentResolver = new AppointmentSubjectResolver(config, templates);
  (appointmentResolver as unknown as { admin: unknown }).admin = admin;
  const clientResolver = new ClientSubjectResolver(config);
  (clientResolver as unknown as { admin: unknown }).admin = admin;
  const subjects = new NotificationSubjectRegistry(appointmentResolver, clientResolver);

  const settingsService = { getForLocation: jest.fn().mockResolvedValue(set) } as unknown as CommunicationSettingsService;
  const optOuts = {
    channelsFor: jest.fn().mockResolvedValue({ channels: optedOut, degraded: false }),
  } as unknown as OptOutService;
  const messaging = new MessagingService(config, subjects, settingsService, optOuts);
  (messaging as unknown as { admin: unknown }).admin = admin;

  return new NotificationEscalationService(subjects, messaging);
}

function event(over: Partial<NotificationEventRow> = {}): NotificationEventRow {
  return {
    id: 'evt1',
    business_id: 'biz1',
    location_id: 'loc1',
    client_profile_id: 'cli1',
    appointment_id: 'apt1',
    channel: 'whatsapp',
    event_key: 'booking_confirmation',
    status: 'failed',
    scheduled_for: NOW.toISOString(),
    attempts: 3,
    message_log_id: null,
    payload_json: { appointment_start: FUTURE },
    dedupe_key: null,
    ...over,
  };
}

describe('NotificationEscalationService (WhatsApp → SMS → Email)', () => {
  it('escalates a failed WhatsApp notification to SMS when SMS is the next enabled channel', async () => {
    const state = baseState();
    const service = makeService(state, settings({ smsFallbackEnabled: true }));

    const next = await service.escalateFromEvent(event(), 'whatsapp', 'WhatsApp failed', NOW);

    expect(next).toBe('sms');
    expect(state.inserts).toHaveLength(1);
    expect(state.inserts[0].channel).toBe('sms');
    expect(state.inserts[0].event_key).toBe('booking_confirmation');
    const payload = state.inserts[0].payload_json as Record<string, unknown>;
    expect(payload.fallback).toBe(true);
    expect(payload.primary_channel).toBe('whatsapp');
    expect(payload.fallback_reason).toBe('WhatsApp failed');
    // The source event is no longer "failed" — it is in flight one channel down.
    expect(state.updates).toEqual([
      { status: 'fallback_pending', last_error_message: expect.stringContaining('fell back to sms'), locked_until: null },
    ]);
  });

  it('does not mark the source event fallback_pending when there is nothing to fall back to', async () => {
    const state = baseState();
    const service = makeService(state, settings());

    await service.escalateFromEvent(event(), 'whatsapp', 'WhatsApp failed', NOW);

    expect(state.updates).toHaveLength(0);
  });

  it('escalates a failed WhatsApp notification to EMAIL when SMS is not enabled', async () => {
    const state = baseState();
    const service = makeService(state, settings({ emailFallbackEnabled: true }));

    const next = await service.escalateFromEvent(event(), 'whatsapp', 'WhatsApp failed', NOW);

    expect(next).toBe('email');
    expect(state.inserts[0].channel).toBe('email');
  });

  it('escalates a failed SMS notification to EMAIL (the last link in the chain)', async () => {
    const state = baseState();
    const service = makeService(state, settings({ smsFallbackEnabled: true, emailFallbackEnabled: true }));

    const next = await service.escalateFromEvent(event({ channel: 'sms' }), 'sms', 'sms undelivered', NOW);

    expect(next).toBe('email');
    expect((state.inserts[0].payload_json as Record<string, unknown>).primary_channel).toBe('sms');
  });

  it('does not escalate past the end of the chain', async () => {
    const state = baseState();
    const service = makeService(state, settings({ smsFallbackEnabled: true, emailFallbackEnabled: true }));

    const next = await service.escalateFromEvent(event({ channel: 'email' }), 'email', 'bounced', NOW);

    expect(next).toBeNull();
    expect(state.inserts).toHaveLength(0);
  });

  it('does not escalate when there is no next channel enabled', async () => {
    const state = baseState();
    const service = makeService(state, settings());

    const next = await service.escalateFromEvent(event(), 'whatsapp', 'WhatsApp failed', NOW);

    expect(next).toBeNull();
    expect(state.inserts).toHaveLength(0);
  });

  it('does not escalate a reminder once the appointment has passed (no longer time-valid)', async () => {
    const state = baseState({
      appointment: { ...baseState().appointment!, scheduled_start_at: new Date(NOW.getTime() - DAY).toISOString() },
    });
    const service = makeService(state, settings({ smsFallbackEnabled: true }));

    const next = await service.escalateFromEvent(
      event({ event_key: 'appointment_reminder_24h' }),
      'whatsapp',
      'WhatsApp failed',
      NOW,
    );

    expect(next).toBeNull();
    expect(state.inserts).toHaveLength(0);
  });

  it('does not escalate for a cancelled appointment', async () => {
    const state = baseState({ appointment: { ...baseState().appointment!, status: 'cancelled' } });
    const service = makeService(state, settings({ smsFallbackEnabled: true }));

    expect(await service.escalateFromEvent(event(), 'whatsapp', 'WhatsApp failed', NOW)).toBeNull();
    expect(state.inserts).toHaveLength(0);
  });

  it('escalates a message with NO appointment, loaded by event id', async () => {
    // Escalation used to be keyed on appointment_id, so a campaign message could never fall back at
    // all — the delivery callbacks passed a null appointment and silently did nothing.
    const campaign = event({
      id: 'evt-campaign',
      appointment_id: null,
      event_key: 'campaign:winback',
      dedupe_key: 'campaign:winback:cli1',
      payload_json: { message_class: 'marketing', content: { body: 'We miss you.' } },
    });
    const state = baseState({ appointment: null, storedEvent: campaign });
    const service = makeService(state, settings({ smsFallbackEnabled: true }));

    const next = await service.escalateFromEvent('evt-campaign', 'whatsapp', 'WhatsApp failed', NOW);

    expect(next).toBe('sms');
    expect(state.inserts[0].channel).toBe('sms');
    expect(state.inserts[0].dedupe_key).toBe('campaign:winback:cli1');
    const payload = state.inserts[0].payload_json as Record<string, Record<string, unknown>>;
    expect(payload.content.body).toBe('We miss you.');
  });

  it('does not escalate a marketing message once the client has withdrawn consent', async () => {
    const campaign = event({
      id: 'evt-campaign',
      appointment_id: null,
      event_key: 'campaign:winback',
      payload_json: { message_class: 'marketing', content: { body: 'We miss you.' } },
    });
    const state = baseState({
      appointment: null,
      storedEvent: campaign,
      client: { ...baseState().client!, marketing_opt_in: false },
    });
    const service = makeService(state, settings({ smsFallbackEnabled: true }));

    expect(await service.escalateFromEvent('evt-campaign', 'whatsapp', 'WhatsApp failed', NOW)).toBeNull();
    expect(state.inserts).toHaveLength(0);
  });

  it('treats a duplicate fallback as already done (idempotent under callback replay)', async () => {
    const state = baseState({
      insertError: { code: '23505', message: 'duplicate key value violates unique constraint' },
    });
    const service = makeService(state, settings({ smsFallbackEnabled: true }));

    expect(await service.escalateFromEvent(event(), 'whatsapp', 'WhatsApp failed', NOW)).toBe('sms');
    expect(state.inserts).toHaveLength(0);
    // A replayed callback still leaves the event truthfully in flight.
    expect(state.updates).toHaveLength(1);
  });

  it('hands an opted-out primary channel to the next available one rather than dropping the message', async () => {
    const state = baseState();
    const service = makeService(state, settings({ smsFallbackEnabled: true }), ['whatsapp']);

    const next = await service.escalateFromEvent(event(), 'whatsapp', 'client opted out of whatsapp', NOW);

    expect(next).toBe('sms');
    expect(state.inserts[0].channel).toBe('sms');
  });

  it('never throws from the Safe wrapper (delivery callbacks must not fail)', async () => {
    const state = baseState({ insertError: { message: 'connection reset' } });
    const service = makeService(state, settings({ smsFallbackEnabled: true }));

    await expect(service.escalateFromEventSafe(event(), 'whatsapp', 'boom')).resolves.toBeNull();
  });
});
