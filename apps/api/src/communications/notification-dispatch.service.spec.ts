import type { ConfigService } from '@nestjs/config';
import type { LocationCommunicationSettings } from '@sheer/domain';
import { NotificationDispatchService } from './notification-dispatch.service';
import type { BookingNotificationService } from './booking-notification.service';
import type { CommunicationSettingsService } from './communication-settings.service';
import type { MessageProviderRegistry } from './providers/message-provider.registry';
import type { WhatsAppTemplateConfig } from './whatsapp-template.config';

const DAY = 86_400_000;
const FUTURE = new Date(Date.now() + 3 * DAY).toISOString();

interface State {
  appointment: Record<string, unknown> | null;
  location: { name: string; timezone: string };
  client: { first_name: string; phone: string | null; email: string | null; communication_preference: string | null };
  events: Array<{ op: string; row: Record<string, unknown> }>;
  logs: Array<{ op: string; row: Record<string, unknown> }>;
  /** Delegated escalations: [appointmentId, eventKey, failedChannel, reason]. */
  fallbacks: Array<[string, string, string, string]>;
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
    emailFallbackEnabled: false,
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
    client: {
      first_name: 'Sam',
      phone: '+447725485160',
      email: 'sam@example.com',
      communication_preference: 'whatsapp',
    },
    events: [],
    logs: [],
    fallbacks: [],
    logSeq: 0,
    ...over,
  };
}

interface ProviderMock {
  channel: string;
  providerName: string;
  isEnabled: boolean;
  send: jest.Mock;
}

function makeDispatcher(
  state: State,
  set: LocationCommunicationSettings,
  opts: {
    whatsappEnabled?: boolean;
    smsEnabled?: boolean;
    emailEnabled?: boolean;
    whatsappResult?: Record<string, unknown>;
    emailResult?: Record<string, unknown>;
  } = {},
) {
  const config = { getOrThrow: () => 'https://example.supabase.co', get: () => undefined } as unknown as ConfigService;
  // Provider mocks now sit behind the MessageProviderRegistry seam — the dispatcher only ever talks to
  // the registry, so swapping a provider is invisible to it. Each mock implements the normalised
  // MessageProvider contract ({ channel, providerName, isEnabled, send → ProviderSendResult }).
  const whatsapp: ProviderMock = {
    channel: 'whatsapp',
    providerName: 'twilio',
    isEnabled: opts.whatsappEnabled ?? true,
    send: jest.fn().mockResolvedValue(opts.whatsappResult ?? { accepted: true, providerMessageId: 'SM1', providerStatus: 'queued' }),
  };
  const sms: ProviderMock = {
    channel: 'sms',
    providerName: 'twilio',
    isEnabled: opts.smsEnabled ?? true,
    send: jest.fn().mockResolvedValue({ accepted: true, providerMessageId: 'SMS1', providerStatus: 'queued' }),
  };
  const email: ProviderMock = {
    channel: 'email',
    providerName: 'resend',
    isEnabled: opts.emailEnabled ?? true,
    send: jest.fn().mockResolvedValue(opts.emailResult ?? { accepted: true, providerMessageId: 'resend-1' }),
  };
  const byChannel: Record<string, ProviderMock> = { whatsapp, sms, email };
  const providers = {
    forChannel: (ch: string) => byChannel[ch],
    isChannelEnabled: (ch: string) => byChannel[ch]?.isEnabled ?? false,
    providerName: (ch: string) => byChannel[ch]?.providerName,
    get anyEnabled() {
      return Object.values(byChannel).some((p) => p.isEnabled);
    },
  } as unknown as MessageProviderRegistry;
  const templates = { contentSidFor: () => 'HX1', statusCallbackUrl: 'https://cb' } as unknown as WhatsAppTemplateConfig;
  const settingsService = { getForLocation: jest.fn().mockResolvedValue(set) } as unknown as CommunicationSettingsService;
  const booking = {
    // The dispatcher delegates "what is the next channel?" to the booking service; here we just
    // record the delegation. Whether a fallback event is actually created is covered by the
    // BookingNotificationService spec (escalateToNextChannel).
    escalateToNextChannelSafe: jest.fn(async (a: string, e: string, ch: string, r: string) => {
      state.fallbacks.push([a, e, ch, r]);
    }),
  } as unknown as BookingNotificationService;

  const d = new NotificationDispatchService(config, providers, templates, settingsService, booking);
  (d as unknown as { admin: unknown }).admin = makeFakeClient(state);
  return { d, whatsapp, sms, email, booking };
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

  it('delegates escalation to the next channel on a terminal WhatsApp send failure', async () => {
    const state = baseState();
    const { d } = makeDispatcher(state, settings(), { whatsappResult: { accepted: false, error: 'boom' } });
    await run(d, event({ attempts: 3 })); // attempts >= maxAttempts (3) → terminal

    // Dispatcher delegates with the FAILED channel; the booking service decides the actual next channel.
    expect(state.fallbacks).toEqual([
      ['apt1', 'booking_confirmation', 'whatsapp', expect.stringContaining('whatsapp delivery failed')],
    ]);
    expect(state.events.some((e) => e.op === 'update' && e.row.status === 'failed')).toBe(true);
  });

  it('delegates escalation on a terminal EMAIL send failure (email → SMS)', async () => {
    const state = baseState();
    const { d } = makeDispatcher(state, settings({ emailFallbackEnabled: true }), {
      emailResult: { accepted: false, error: 'rejected' },
    });
    await run(d, event({ channel: 'email', attempts: 3 }));

    expect(state.fallbacks).toEqual([
      ['apt1', 'booking_confirmation', 'email', expect.stringContaining('email delivery failed')],
    ]);
    expect(state.events.some((e) => e.op === 'update' && e.row.status === 'failed')).toBe(true);
  });

  it('requeues (no escalation) on a non-terminal WhatsApp failure', async () => {
    const state = baseState();
    const { d } = makeDispatcher(state, settings(), { whatsappResult: { accepted: false, error: 'temporary' } });
    await run(d, event({ attempts: 1 }));

    expect(state.fallbacks).toHaveLength(0);
    expect(state.events.some((e) => e.op === 'update' && e.row.status === 'queued')).toBe(true);
  });

  it('escalates to the next channel when the WhatsApp sender is unavailable (sync ineligibility)', async () => {
    const state = baseState();
    const { d, whatsapp } = makeDispatcher(state, settings(), { whatsappEnabled: false });
    await run(d, event());

    expect(whatsapp.send).not.toHaveBeenCalled();
    expect(state.fallbacks).toEqual([
      ['apt1', 'booking_confirmation', 'whatsapp', expect.stringContaining('whatsapp sender not configured')],
    ]);
    expect(state.events.some((e) => e.op === 'update' && e.row.status === 'cancelled')).toBe(true);
  });

  it('skips (does not escalate) a stray WhatsApp event for an SMS-preferring client', async () => {
    const state = baseState({
      appointment: { ...baseState().appointment!, communication_preference: 'sms' },
      client: { first_name: 'Sam', phone: '+447725485160', email: 'sam@example.com', communication_preference: 'sms' },
    });
    const { d, whatsapp } = makeDispatcher(state, settings());
    await run(d, event()); // whatsapp-channel event, but WhatsApp is not in this client's chain

    expect(whatsapp.send).not.toHaveBeenCalled();
    // WhatsApp is not part of an SMS-preferring client's chain → nothing to escalate to; skip truthfully.
    expect(state.fallbacks).toHaveLength(0);
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

  it('delivers via email (EmailService) when the client prefers email', async () => {
    const state = baseState({
      appointment: { ...baseState().appointment!, communication_preference: 'email' },
      client: { first_name: 'Sam', phone: '+447725485160', email: 'sam@example.com', communication_preference: 'email' },
    });
    // emailFallbackEnabled is OFF — an explicit email preference still delivers over email.
    const { d, email, whatsapp, sms } = makeDispatcher(state, settings());
    await run(d, event({ channel: 'email' }));

    expect(email.send).toHaveBeenCalledTimes(1);
    expect((email.send as jest.Mock).mock.calls[0][0].to).toBe('sam@example.com');
    expect(whatsapp.send).not.toHaveBeenCalled();
    expect(sms.send).not.toHaveBeenCalled();
    expect(state.events.some((e) => e.op === 'update' && e.row.status === 'sent')).toBe(true);
    expect(state.fallbacks).toHaveLength(0);
  });

  it('does NOT escalate to SMS when an email is merely accepted (pending is not failure)', async () => {
    // WhatsApp-first client whose email fallback event was accepted by Resend → stays "sent", no SMS.
    const state = baseState();
    const { d, sms } = makeDispatcher(
      state,
      settings({ emailFallbackEnabled: true, smsFallbackEnabled: true }),
      { emailResult: { accepted: true, providerMessageId: 'resend-2' } },
    );
    await run(d, event({ channel: 'email', payload_json: { appointment_start: FUTURE, fallback: true, primary_channel: 'whatsapp' } }));

    expect(sms.send).not.toHaveBeenCalled();
    expect(state.fallbacks).toHaveLength(0);
    expect(state.events.some((e) => e.op === 'update' && e.row.status === 'sent')).toBe(true);
  });

  it('skips an email event truthfully when the client has no valid email', async () => {
    const state = baseState({
      appointment: { ...baseState().appointment!, communication_preference: 'email' },
      client: { first_name: 'Sam', phone: '+447725485160', email: null, communication_preference: 'email' },
    });
    const { d, email } = makeDispatcher(state, settings());
    await run(d, event({ channel: 'email' }));

    expect(email.send).not.toHaveBeenCalled();
    expect(state.logs.some((l) => l.op === 'insert' && l.row.delivery_status === 'skipped')).toBe(true);
    expect(state.events.some((e) => e.op === 'update' && e.row.status === 'cancelled')).toBe(true);
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
