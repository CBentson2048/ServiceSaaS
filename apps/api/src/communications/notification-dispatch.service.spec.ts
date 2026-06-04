import type { ConfigService } from '@nestjs/config';
import type { LocationCommunicationSettings } from '@sheer/domain';
import { NotificationDispatchService } from './notification-dispatch.service';
import type { BookingNotificationService } from './booking-notification.service';
import type { CommunicationSettingsService } from './communication-settings.service';
import type { SmsService } from './sms.service';
import type { WhatsAppService } from './whatsapp.service';
import type { WhatsAppTemplateConfig } from './whatsapp-template.config';

const DAY = 86_400_000;
const FUTURE = new Date(Date.now() + 3 * DAY).toISOString();

interface State {
  appointment: Record<string, unknown> | null;
  location: { name: string; timezone: string };
  client: { first_name: string; phone: string | null; communication_preference: string | null };
  events: Array<{ op: string; row: Record<string, unknown> }>;
  logs: Array<{ op: string; row: Record<string, unknown> }>;
  fallbacks: Array<[string, string, string]>;
  logSeq: number;
}

function makeFakeClient(state: State) {
  function from(table: string) {
    let op: 'select' | 'insert' | 'update' = 'select';
    let payload: Record<string, unknown> | null = null;
    const selectData = () =>
      table === 'appointments' ? state.appointment : table === 'locations' ? state.location : table === 'client_profiles' ? state.client : null;

    const chain: Record<string, unknown> = {};
    const self = () => chain;
    for (const m of ['select', 'eq', 'in', 'order', 'lte', 'or', 'limit', 'returns']) chain[m] = self;
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
    chain.maybeSingle = () => Promise.resolve({ data: selectData(), error: null });
    chain.single = () => {
      if (op === 'insert' && table === 'message_logs') {
        const id = `log-${++state.logSeq}`;
        state.logs.push({ op: 'insert', row: payload! });
        return Promise.resolve({ data: { id }, error: null });
      }
      return Promise.resolve({ data: selectData(), error: null });
    };
    chain.then = (resolve: (v: { data: unknown; error: null }) => unknown, reject?: (e: unknown) => unknown) => {
      if (op === 'insert' || op === 'update') {
        const sink = table === 'message_logs' ? state.logs : table === 'notification_events' ? state.events : null;
        if (sink) sink.push({ op, row: payload! });
        return Promise.resolve({ data: null, error: null }).then(resolve, reject);
      }
      return Promise.resolve({ data: selectData(), error: null }).then(resolve, reject);
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
    reminder24hEnabled: false,
    reminder48hEnabled: false,
    reminder1wEnabled: false,
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
      metadata: { service_names: ['Cut'], stylist_name: 'Alex' },
    },
    location: { name: 'Sheer Soho', timezone: 'Europe/London' },
    client: { first_name: 'Sam', phone: '+447700900123', communication_preference: 'whatsapp' },
    events: [],
    logs: [],
    fallbacks: [],
    logSeq: 0,
    ...over,
  };
}

function makeDispatcher(
  state: State,
  set: LocationCommunicationSettings,
  opts: { whatsappEnabled?: boolean; smsEnabled?: boolean; whatsappResult?: Record<string, unknown> } = {},
) {
  const config = { getOrThrow: () => 'https://example.supabase.co', get: () => undefined } as unknown as ConfigService;
  const whatsapp = {
    isEnabled: opts.whatsappEnabled ?? true,
    provider: 'twilio',
    send: jest.fn().mockResolvedValue(opts.whatsappResult ?? { accepted: true, providerMessageId: 'SM1', providerStatus: 'queued' }),
  } as unknown as WhatsAppService;
  const sms = {
    isEnabled: opts.smsEnabled ?? true,
    provider: 'twilio',
    send: jest.fn().mockResolvedValue({ accepted: true, providerMessageId: 'SMS1', providerStatus: 'queued' }),
  } as unknown as SmsService;
  const templates = { contentSidFor: () => 'HX1', statusCallbackUrl: 'https://cb' } as unknown as WhatsAppTemplateConfig;
  const settingsService = { getForLocation: jest.fn().mockResolvedValue(set) } as unknown as CommunicationSettingsService;
  const booking = {
    enqueueSmsFallbackSafe: jest.fn(async (a: string, e: string, r: string) => {
      state.fallbacks.push([a, e, r]);
    }),
  } as unknown as BookingNotificationService;

  const d = new NotificationDispatchService(config, whatsapp, sms, templates, settingsService, booking);
  (d as unknown as { admin: unknown }).admin = makeFakeClient(state);
  return { d, whatsapp, sms, booking };
}

function event(over: Record<string, unknown> = {}) {
  return {
    id: 'evt1',
    business_id: 'biz1',
    location_id: 'loc1',
    client_profile_id: 'cli1',
    appointment_id: 'apt1',
    channel: 'whatsapp',
    event_key: 'booking_confirmation',
    status: 'queued',
    scheduled_for: new Date().toISOString(),
    attempts: 1,
    message_log_id: null,
    payload_json: { appointment_start: FUTURE },
    ...over,
  };
}

async function run(d: NotificationDispatchService, ev: Record<string, unknown>) {
  await (d as unknown as { process: (e: unknown) => Promise<void> }).process(ev);
}

describe('NotificationDispatchService channel + fallback behaviour', () => {
  it('sends WhatsApp first and does NOT enqueue an SMS fallback when accepted (pending is not failure)', async () => {
    const state = baseState();
    const { d, whatsapp } = makeDispatcher(state, settings());
    await run(d, event());

    expect(whatsapp.send).toHaveBeenCalledTimes(1);
    expect(state.fallbacks).toHaveLength(0);
    expect(state.events.some((e) => e.op === 'update' && e.row.status === 'sent')).toBe(true);
  });

  it('enqueues an SMS fallback on a terminal WhatsApp send failure', async () => {
    const state = baseState();
    const { d } = makeDispatcher(state, settings(), { whatsappResult: { accepted: false, error: 'boom' } });
    await run(d, event({ attempts: 3 })); // attempts >= maxAttempts (3) → terminal

    expect(state.fallbacks).toEqual([['apt1', 'booking_confirmation', expect.stringContaining('WhatsApp delivery failed')]]);
    expect(state.events.some((e) => e.op === 'update' && e.row.status === 'failed')).toBe(true);
  });

  it('requeues (no fallback) on a non-terminal WhatsApp failure', async () => {
    const state = baseState();
    const { d } = makeDispatcher(state, settings(), { whatsappResult: { accepted: false, error: 'temporary' } });
    await run(d, event({ attempts: 1 }));

    expect(state.fallbacks).toHaveLength(0);
    expect(state.events.some((e) => e.op === 'update' && e.row.status === 'queued')).toBe(true);
  });

  it('does not enqueue a fallback on terminal failure when SMS fallback is disabled', async () => {
    const state = baseState();
    const { d } = makeDispatcher(state, settings({ smsFallbackEnabled: false }), {
      whatsappResult: { accepted: false, error: 'boom' },
    });
    await run(d, event({ attempts: 3 }));
    expect(state.fallbacks).toHaveLength(0);
  });

  it('falls back to SMS immediately when WhatsApp is ineligible (client prefers SMS) and SMS is allowed', async () => {
    const state = baseState({
      appointment: { ...baseState().appointment!, communication_preference: 'sms' },
      client: { first_name: 'Sam', phone: '+447700900123', communication_preference: 'sms' },
    });
    const { d, whatsapp } = makeDispatcher(state, settings());
    await run(d, event()); // whatsapp-channel event, but plan primary is now SMS

    expect(whatsapp.send).not.toHaveBeenCalled();
    expect(state.fallbacks).toHaveLength(1);
    expect(state.events.some((e) => e.op === 'update' && e.row.status === 'cancelled')).toBe(true);
  });

  it('delivers an SMS-channel event via the SmsService', async () => {
    const state = baseState({
      appointment: { ...baseState().appointment!, communication_preference: 'whatsapp' },
    });
    const { d, sms } = makeDispatcher(state, settings());
    await run(d, event({ channel: 'sms', payload_json: { appointment_start: FUTURE, fallback: true, primary_channel: 'whatsapp' } }));

    expect(sms.send).toHaveBeenCalledTimes(1);
    expect(state.events.some((e) => e.op === 'update' && e.row.status === 'sent')).toBe(true);
  });

  it('cancels (does not send) when the appointment is cancelled', async () => {
    const state = baseState({ appointment: { ...baseState().appointment!, status: 'cancelled' } });
    const { d, whatsapp } = makeDispatcher(state, settings());
    await run(d, event());

    expect(whatsapp.send).not.toHaveBeenCalled();
    expect(state.fallbacks).toHaveLength(0);
    expect(state.events.some((e) => e.op === 'update' && e.row.status === 'cancelled')).toBe(true);
  });
});
