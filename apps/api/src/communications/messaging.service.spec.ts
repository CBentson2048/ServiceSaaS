import type { ConfigService } from '@nestjs/config';
import type { LocationCommunicationSettings } from '@sheer/domain';
import type { CommunicationSettingsService } from './communication-settings.service';
import { MessagingService } from './messaging.service';
import { NotificationSubjectRegistry } from './notification-subject.registry';
import type { OptOutService } from './opt-out.service';
import { AppointmentSubjectResolver } from './subjects/appointment-subject.resolver';
import { ClientSubjectResolver } from './subjects/client-subject.resolver';
import type { WhatsAppTemplateConfig } from './whatsapp-template.config';

const FUTURE = new Date(Date.now() + 3 * 86_400_000).toISOString();

interface State {
  appointment: Record<string, unknown> | null;
  client: Record<string, unknown> | null;
  location: { name: string; timezone: string };
  inserts: Array<Record<string, unknown>>;
  /** When set, the next notification_events insert fails with this Postgres error. */
  insertError: { code?: string; message: string } | null;
}

function makeFakeClient(state: State) {
  function from(table: string) {
    let op: 'select' | 'insert' = 'select';
    let payload: Record<string, unknown> | null = null;
    const chain: Record<string, unknown> = {};
    const self = () => chain;
    for (const m of ['select', 'eq', 'neq', 'gt', 'in', 'not', 'order', 'limit', 'returns']) chain[m] = self;
    chain.insert = (row: Record<string, unknown>) => {
      op = 'insert';
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
      return { data: null, error: null };
    };
    chain.maybeSingle = () => Promise.resolve(result());
    chain.single = () => Promise.resolve(result());
    chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(resolve);
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
    reminder2hEnabled: false,
    reminder24hEnabled: false,
    reminder48hEnabled: false,
    reminder1wEnabled: false,
    emailFallbackEnabled: true,
    smsFallbackEnabled: true,
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
    inserts: [],
    insertError: null,
    ...over,
  };
}

function makeService(state: State, set = settings(), optedOut: string[] = [], degraded = false) {
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
    channelsFor: jest.fn().mockResolvedValue({ channels: optedOut, degraded }),
  } as unknown as OptOutService;

  const service = new MessagingService(config, subjects, settingsService, optOuts);
  (service as unknown as { admin: unknown }).admin = admin;
  return service;
}

const campaign = {
  businessId: 'biz1',
  locationId: 'loc1',
  clientProfileId: 'cli1',
  eventKey: 'campaign:winback',
  content: { body: 'We miss you — book your next visit.' },
  messageClass: 'marketing' as const,
  dedupeKey: 'campaign:winback:cli1',
};

describe('MessagingService.send — the single send API', () => {
  it('queues a campaign on WhatsApp (the primary channel) with its content snapshot', async () => {
    const state = baseState({ appointment: null });
    const result = await makeService(state).send(campaign);

    expect(result).toEqual({ status: 'queued', eventId: 'evt-1', channel: 'whatsapp' });
    const row = state.inserts[0];
    expect(row.channel).toBe('whatsapp');
    expect(row.event_key).toBe('campaign:winback');
    expect(row.status).toBe('queued');
    expect(row.appointment_id).toBeNull();
    expect(row.dedupe_key).toBe('campaign:winback:cli1');
    const payload = row.payload_json as Record<string, Record<string, unknown>>;
    expect(payload.content.body).toContain('We miss you');
    expect(payload.message_class).toBe('marketing');
  });

  it('starts at SMS when the client has opted out of WhatsApp', async () => {
    const state = baseState({ appointment: null });
    const result = await makeService(state, settings(), ['whatsapp']).send(campaign);

    expect(result).toEqual({ status: 'queued', eventId: 'evt-1', channel: 'sms' });
  });

  it('does not queue a marketing message for a client who has not opted in', async () => {
    const state = baseState({
      appointment: null,
      client: { ...baseState().client!, marketing_opt_in: false },
    });
    const result = await makeService(state).send(campaign);

    expect(result).toEqual({ status: 'skipped', reason: 'client has not opted in to marketing' });
    expect(state.inserts).toHaveLength(0);
  });

  it('still queues a TRANSACTIONAL message for a client who has not opted in to marketing', async () => {
    const state = baseState({
      appointment: null,
      client: { ...baseState().client!, marketing_opt_in: false },
    });
    const result = await makeService(state).send({ ...campaign, messageClass: 'transactional' });

    expect(result.status).toBe('queued');
  });

  it('skips truthfully when no channel is deliverable', async () => {
    const state = baseState({
      appointment: null,
      client: { ...baseState().client!, phone: null, email: null },
    });
    const result = await makeService(state).send(campaign);

    expect(result).toEqual({ status: 'skipped', reason: 'client has no valid phone or email address' });
    expect(state.inserts).toHaveLength(0);
  });

  it('is idempotent — a duplicate dedupe key is reported, not queued twice', async () => {
    const state = baseState({
      appointment: null,
      insertError: { code: '23505', message: 'duplicate key value violates unique constraint' },
    });
    const result = await makeService(state).send(campaign);

    expect(result).toEqual({ status: 'duplicate', channel: 'whatsapp' });
    expect(state.inserts).toHaveLength(0);
  });

  it('queues an appointment-anchored message without content (it renders from the approved template)', async () => {
    const state = baseState();
    const result = await makeService(state).send({
      businessId: 'biz1',
      locationId: 'loc1',
      clientProfileId: 'cli1',
      appointmentId: 'apt1',
      eventKey: 'rebooking_nudge',
      metadata: { interval_days: 42 },
    });

    expect(result.status).toBe('queued');
    const row = state.inserts[0];
    expect(row.appointment_id).toBe('apt1');
    expect((row.payload_json as Record<string, unknown>).interval_days).toBe(42);
    // The appointment subject stamps the start time every generated event compares staleness against.
    expect((row.payload_json as Record<string, unknown>).appointment_start).toBe(FUTURE);
  });

  it('does not schedule an appointment message for a cancelled appointment', async () => {
    const state = baseState({ appointment: { ...baseState().appointment!, status: 'cancelled' } });
    const result = await makeService(state).send({
      businessId: 'biz1',
      locationId: 'loc1',
      clientProfileId: 'cli1',
      appointmentId: 'apt1',
      eventKey: 'rebooking_nudge',
    });

    expect(result).toEqual({ status: 'skipped', reason: 'appointment is cancelled' });
  });

  it('withholds a MARKETING message when the opt-out record could not be read', async () => {
    // Consent is not something to assume when it could not be checked.
    const state = baseState({ appointment: null });
    const result = await makeService(state, settings(), [], true).send(campaign);

    expect(result).toEqual({
      status: 'skipped',
      reason: 'could not confirm messaging opt-outs; marketing message withheld',
    });
    expect(state.inserts).toHaveLength(0);
  });

  it('still sends a TRANSACTIONAL message when the opt-out record could not be read', async () => {
    // Silently suppressing an appointment reminder because a table was briefly unreachable would be
    // worse than the message reaching someone the provider itself will block.
    const state = baseState({ appointment: null });
    const result = await makeService(state, settings(), [], true).send({
      ...campaign,
      messageClass: 'transactional',
    });

    expect(result.status).toBe('queued');
  });

  it('refuses a client message with no body rather than queueing an empty send', async () => {
    const state = baseState({ appointment: null });
    await expect(
      makeService(state).send({ ...campaign, content: { body: '   ' } }),
    ).rejects.toThrow(/requires content\.body/);
  });
});
