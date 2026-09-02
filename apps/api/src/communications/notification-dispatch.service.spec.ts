import type { ConfigService } from '@nestjs/config';
import type { LocationCommunicationSettings } from '@sheer/domain';
import type { CommunicationSettingsService } from './communication-settings.service';
import { MessagingService } from './messaging.service';
import { NotificationDispatchService } from './notification-dispatch.service';
import type { MessageUsageService } from '../message-usage/message-usage.service';
import { NotificationEscalationService } from './notification-escalation.service';
import { NotificationSubjectRegistry } from './notification-subject.registry';
import type { OptOutService } from './opt-out.service';
import type { MessageProviderRegistry } from './providers/message-provider.registry';
import { AppointmentSubjectResolver } from './subjects/appointment-subject.resolver';
import { ClientSubjectResolver } from './subjects/client-subject.resolver';
import type { WhatsAppTemplateConfig } from './whatsapp-template.config';

const DAY = 86_400_000;
const FUTURE = new Date(Date.now() + 3 * DAY).toISOString();

interface State {
  appointment: Record<string, unknown> | null;
  location: { name: string; timezone: string };
  client: {
    first_name: string;
    phone: string | null;
    email: string | null;
    communication_preference: string | null;
    marketing_opt_in?: boolean | null;
  };
  /** Future active appointments returned by the "already rebooked?" probe. */
  futureAppointments: Array<{ id: string }>;
  events: Array<{ op: string; row: Record<string, unknown> }>;
  logs: Array<{ op: string; row: Record<string, unknown> }>;
  logSeq: number;
  eventSeq: number;
}

/**
 * Minimal thenable Supabase stub. `booking.appointments` is read two ways — `maybeSingle` for the
 * notification context, and a list terminal for the "has this client already rebooked?" probe — so
 * the two terminals return different shapes for the same table.
 */
function makeFakeClient(state: State) {
  function from(table: string) {
    let op: 'select' | 'insert' | 'update' | 'delete' = 'select';
    let payload: Record<string, unknown> | null = null;

    const chain: Record<string, unknown> = {};
    const self = () => chain;
    for (const m of ['select', 'eq', 'neq', 'gt', 'in', 'not', 'order', 'lte', 'or', 'limit', 'returns']) {
      chain[m] = self;
    }
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
    chain.delete = () => {
      op = 'delete';
      return chain;
    };

    const recordWrite = () => {
      const sink = table === 'message_logs' ? state.logs : table === 'notification_events' ? state.events : null;
      if (sink && payload) sink.push({ op, row: payload });
    };

    const singleResult = () => {
      if (op === 'insert' && table === 'message_logs') {
        recordWrite();
        return { data: { id: `log-${++state.logSeq}` }, error: null };
      }
      if (op === 'insert' && table === 'notification_events') {
        recordWrite();
        return { data: { id: `evt-${++state.eventSeq}` }, error: null };
      }
      if (table === 'appointments') return { data: state.appointment, error: null };
      if (table === 'locations') return { data: state.location, error: null };
      if (table === 'client_profiles') return { data: state.client, error: null };
      return { data: null, error: null };
    };

    chain.maybeSingle = () => Promise.resolve(singleResult());
    chain.single = () => Promise.resolve(singleResult());
    chain.then = (resolve: (v: { data: unknown; error: null }) => unknown, reject?: (e: unknown) => unknown) => {
      if (op !== 'select') {
        recordWrite();
        return Promise.resolve({ data: null, error: null }).then(resolve, reject);
      }
      // List reads.
      const data =
        table === 'appointments' ? state.futureAppointments : table === 'channel_opt_outs' ? [] : null;
      return Promise.resolve({ data, error: null }).then(resolve, reject);
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
    reminder2hEnabled: false,
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
      marketing_opt_in: true,
    },
    futureAppointments: [],
    events: [],
    logs: [],
    logSeq: 0,
    eventSeq: 0,
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
    smsResult?: Record<string, unknown>;
    emailResult?: Record<string, unknown>;
    optedOut?: string[];
    optOutReadFailed?: boolean;
    /** What the accounting stub returns. `null` reproduces a failed ledger write. */
    recordSendResult?: { counted: boolean } | null;
  } = {},
) {
  const config = { getOrThrow: () => 'https://example.supabase.co', get: () => undefined } as unknown as ConfigService;
  // Provider mocks sit behind the MessageProviderRegistry seam — the dispatcher only ever talks to
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
    send: jest.fn().mockResolvedValue(opts.smsResult ?? { accepted: true, providerMessageId: 'SMS1', providerStatus: 'queued' }),
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
  const optOuts = {
    channelsFor: jest.fn().mockResolvedValue({ channels: opts.optedOut ?? [], degraded: opts.optOutReadFailed ?? false }),
  } as unknown as OptOutService;

  const admin = makeFakeClient(state);
  const appointmentResolver = new AppointmentSubjectResolver(config, templates);
  (appointmentResolver as unknown as { admin: unknown }).admin = admin;
  const clientResolver = new ClientSubjectResolver(config);
  (clientResolver as unknown as { admin: unknown }).admin = admin;
  const subjects = new NotificationSubjectRegistry(appointmentResolver, clientResolver);

  const messaging = new MessagingService(config, subjects, settingsService, optOuts);
  (messaging as unknown as { admin: unknown }).admin = admin;
  const escalation = new NotificationEscalationService(subjects, messaging);

  // Usage accounting is asserted in its own suites. Here it is a permissive stub:
  // `checkCap` allowing everything reproduces the shipped `track_only` default,
  // so these dispatcher specs measure dispatcher behaviour and nothing else.
  const messageUsage = {
    checkCap: jest.fn(async () => ({ allow: true, warn: false })),
    // `recordSendResult` lets one spec make accounting FAIL the way the real
    // service does — by returning null, never by throwing into the send path.
    recordSend: jest.fn(async () => opts.recordSendResult ?? { counted: true }),
  } as unknown as MessageUsageService;

  const d = new NotificationDispatchService(
    config, providers, templates, subjects, messaging, escalation, messageUsage,
  );
  (d as unknown as { admin: unknown }).admin = admin;
  return { d, whatsapp, sms, email, messageUsage };
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
    dedupe_key: null,
    ...over,
  };
}

/** A campaign message: no appointment, content snapshotted onto the event at enqueue time. */
function campaignEvent(over: Record<string, unknown> = {}) {
  return event({
    id: 'evt-campaign',
    appointment_id: null,
    event_key: 'campaign:winback',
    dedupe_key: 'campaign:winback:cli1',
    payload_json: {
      message_class: 'marketing',
      content: { body: 'We miss you at Sheer Soho — book your next visit.', preview: 'We miss you' },
    },
    ...over,
  });
}

async function run(d: NotificationDispatchService, ev: Record<string, unknown>) {
  await (d as unknown as { process: (e: unknown) => Promise<void> }).process(ev);
}

const eventUpdates = (state: State) =>
  state.events.filter((e) => e.op === 'update').map((e) => e.row.status as string);
const queuedChannels = (state: State) =>
  state.events.filter((e) => e.op === 'insert').map((e) => e.row.channel as string);

describe('NotificationDispatchService channel + fallback behaviour', () => {
  it('sends WhatsApp first and does NOT enqueue an SMS fallback when accepted (pending is not failure)', async () => {
    const state = baseState();
    const { d, whatsapp } = makeDispatcher(state, settings());
    await run(d, event());

    expect(whatsapp.send).toHaveBeenCalledTimes(1);
    expect(queuedChannels(state)).toHaveLength(0);
    expect(eventUpdates(state)).toContain('sent');
  });

  it('escalates to SMS on a terminal WhatsApp failure and holds the event as fallback_pending', async () => {
    const state = baseState();
    const { d } = makeDispatcher(state, settings(), { whatsappResult: { accepted: false, error: 'boom' } });
    await run(d, event({ attempts: 3 })); // attempts >= maxAttempts (3) → terminal

    expect(queuedChannels(state)).toEqual(['sms']);
    const fallback = state.events.find((e) => e.op === 'insert')!.row;
    expect((fallback.payload_json as Record<string, unknown>).fallback).toBe(true);
    expect((fallback.payload_json as Record<string, unknown>).primary_channel).toBe('whatsapp');
    // The failed attempt's own log is `failed`; the event is still in flight one channel down.
    expect(state.logs.some((l) => l.op === 'update' && l.row.delivery_status === 'failed')).toBe(true);
    expect(eventUpdates(state)).toContain('fallback_pending');
    expect(eventUpdates(state)).not.toContain('failed');
  });

  it('escalates SMS → Email on a terminal SMS failure when email is enabled', async () => {
    const state = baseState();
    const { d } = makeDispatcher(state, settings({ emailFallbackEnabled: true }), {
      smsResult: { accepted: false, error: 'rejected' },
    });
    await run(d, event({ channel: 'sms', attempts: 3 }));

    expect(queuedChannels(state)).toEqual(['email']);
    expect(eventUpdates(state)).toContain('fallback_pending');
  });

  it('marks the event failed (not fallback_pending) when the chain is exhausted', async () => {
    const state = baseState();
    // WhatsApp-only chain: a terminal WhatsApp failure has nowhere to go.
    const { d } = makeDispatcher(state, settings({ smsFallbackEnabled: false }), {
      whatsappResult: { accepted: false, error: 'boom' },
    });
    await run(d, event({ attempts: 3 }));

    expect(queuedChannels(state)).toHaveLength(0);
    expect(eventUpdates(state)).toContain('failed');
    expect(eventUpdates(state)).not.toContain('fallback_pending');
  });

  it('requeues (no escalation) on a non-terminal WhatsApp failure', async () => {
    const state = baseState();
    const { d } = makeDispatcher(state, settings(), { whatsappResult: { accepted: false, error: 'temporary' } });
    await run(d, event({ attempts: 1 }));

    expect(queuedChannels(state)).toHaveLength(0);
    expect(eventUpdates(state)).toContain('queued');
  });

  it('escalates to the next channel when the WhatsApp sender is unavailable (sync ineligibility)', async () => {
    const state = baseState();
    const { d, whatsapp } = makeDispatcher(state, settings(), { whatsappEnabled: false });
    await run(d, event());

    expect(whatsapp.send).not.toHaveBeenCalled();
    expect(queuedChannels(state)).toEqual(['sms']);
    // A truthful skipped attempt is recorded for the channel that could not be used.
    expect(
      state.logs.some(
        (l) => l.op === 'insert' && l.row.delivery_status === 'skipped' && /falling back to sms/.test(String(l.row.error_message)),
      ),
    ).toBe(true);
    expect(eventUpdates(state)).toContain('fallback_pending');
  });

  it('routes a WhatsApp-opted-out client straight to SMS', async () => {
    const state = baseState();
    const { d, whatsapp, sms } = makeDispatcher(state, settings(), { optedOut: ['whatsapp'] });
    await run(d, event());

    expect(whatsapp.send).not.toHaveBeenCalled();
    expect(queuedChannels(state)).toEqual(['sms']);
    expect(sms.send).not.toHaveBeenCalled(); // queued, not sent inline
    expect(eventUpdates(state)).toContain('fallback_pending');
  });

  it('hands a stray WhatsApp event to the channel an SMS-preferring client actually uses', async () => {
    const state = baseState({
      appointment: { ...baseState().appointment!, communication_preference: 'sms' },
      client: {
        first_name: 'Sam',
        phone: '+447725485160',
        email: 'sam@example.com',
        communication_preference: 'sms',
        marketing_opt_in: true,
      },
    });
    const { d, whatsapp } = makeDispatcher(state, settings());
    await run(d, event()); // whatsapp-channel event, but WhatsApp is not in this client's chain

    expect(whatsapp.send).not.toHaveBeenCalled();
    // WhatsApp is not in this client's chain, but the message is still undelivered and SMS is where
    // this client is reachable. Nothing re-queues an event when a preference changes, so dropping it
    // here would lose the message outright.
    expect(queuedChannels(state)).toEqual(['sms']);
    expect(eventUpdates(state)).toContain('fallback_pending');
  });

  it('delivers an SMS-channel event via the SMS provider', async () => {
    const state = baseState();
    const { d, sms } = makeDispatcher(state, settings());
    await run(
      d,
      event({ channel: 'sms', payload_json: { appointment_start: FUTURE, fallback: true, primary_channel: 'whatsapp' } }),
    );

    expect(sms.send).toHaveBeenCalledTimes(1);
    expect(eventUpdates(state)).toContain('sent');
  });

  it('delivers via email (EmailService) when the client prefers email', async () => {
    const state = baseState({
      appointment: { ...baseState().appointment!, communication_preference: 'email' },
      client: {
        first_name: 'Sam',
        phone: '+447725485160',
        email: 'sam@example.com',
        communication_preference: 'email',
        marketing_opt_in: true,
      },
    });
    // emailFallbackEnabled is OFF — an explicit email preference still delivers over email.
    const { d, email, whatsapp, sms } = makeDispatcher(state, settings());
    await run(d, event({ channel: 'email' }));

    expect(email.send).toHaveBeenCalledTimes(1);
    expect((email.send as jest.Mock).mock.calls[0][0].to).toBe('sam@example.com');
    expect((email.send as jest.Mock).mock.calls[0][0].subject).toContain('confirmed');
    expect(whatsapp.send).not.toHaveBeenCalled();
    expect(sms.send).not.toHaveBeenCalled();
    expect(eventUpdates(state)).toContain('sent');
    expect(queuedChannels(state)).toHaveLength(0);
  });

  it('does NOT escalate when an email is merely accepted (pending is not failure)', async () => {
    const state = baseState();
    const { d } = makeDispatcher(
      state,
      settings({ emailFallbackEnabled: true }),
      { emailResult: { accepted: true, providerMessageId: 'resend-2' } },
    );
    await run(
      d,
      event({ channel: 'email', payload_json: { appointment_start: FUTURE, fallback: true, primary_channel: 'sms' } }),
    );

    expect(queuedChannels(state)).toHaveLength(0);
    expect(eventUpdates(state)).toContain('sent');
  });

  it('skips an email event truthfully when the client has no valid email', async () => {
    const state = baseState({
      appointment: { ...baseState().appointment!, communication_preference: 'email' },
      client: {
        first_name: 'Sam',
        phone: '+447725485160',
        email: null,
        communication_preference: 'email',
        marketing_opt_in: true,
      },
    });
    const { d, email } = makeDispatcher(state, settings());
    await run(d, event({ channel: 'email' }));

    expect(email.send).not.toHaveBeenCalled();
    expect(state.logs.some((l) => l.op === 'insert' && l.row.delivery_status === 'skipped')).toBe(true);
    expect(eventUpdates(state)).toContain('cancelled');
  });

  it('cancels (does not send) when the appointment is cancelled', async () => {
    const state = baseState({ appointment: { ...baseState().appointment!, status: 'cancelled' } });
    const { d, whatsapp } = makeDispatcher(state, settings());
    await run(d, event());

    expect(whatsapp.send).not.toHaveBeenCalled();
    expect(queuedChannels(state)).toHaveLength(0);
    expect(eventUpdates(state)).toContain('cancelled');
  });

  it('cancels a rebooking nudge when the client has already rebooked', async () => {
    const state = baseState({ futureAppointments: [{ id: 'apt2' }] });
    const { d, whatsapp } = makeDispatcher(state, settings());
    await run(d, event({ event_key: 'rebooking_nudge' }));

    expect(whatsapp.send).not.toHaveBeenCalled();
    expect(eventUpdates(state)).toContain('cancelled');
  });
});

describe('NotificationDispatchService — messages that are not appointments', () => {
  it('delivers a campaign message from its content snapshot (previously cancelled outright)', async () => {
    const state = baseState();
    const { d, whatsapp } = makeDispatcher(state, settings());
    await run(d, campaignEvent());

    expect(whatsapp.send).toHaveBeenCalledTimes(1);
    expect((whatsapp.send as jest.Mock).mock.calls[0][0].body).toContain('We miss you at Sheer Soho');
    expect(eventUpdates(state)).toContain('sent');
    const log = state.logs.find((l) => l.op === 'insert')!.row;
    expect(log.message_type).toBe('campaign:winback');
    expect((log.metadata as Record<string, unknown>).subject_kind).toBe('client');
  });

  it('does not send a marketing campaign to a client who has not opted in', async () => {
    const state = baseState({
      client: {
        first_name: 'Sam',
        phone: '+447725485160',
        email: 'sam@example.com',
        communication_preference: 'whatsapp',
        marketing_opt_in: false,
      },
    });
    const { d, whatsapp } = makeDispatcher(state, settings());
    await run(d, campaignEvent());

    expect(whatsapp.send).not.toHaveBeenCalled();
    expect(
      state.logs.some(
        (l) =>
          l.op === 'insert' &&
          l.row.delivery_status === 'skipped' &&
          /not opted in to marketing/.test(String(l.row.error_message)),
      ),
    ).toBe(true);
    expect(eventUpdates(state)).toContain('cancelled');
  });

  it('carries the content snapshot onto the SMS fallback so the same message is sent', async () => {
    const state = baseState();
    const { d } = makeDispatcher(state, settings(), { whatsappResult: { accepted: false, error: 'boom' } });
    await run(d, campaignEvent({ attempts: 3 }));

    const fallback = state.events.find((e) => e.op === 'insert')!.row;
    expect(fallback.channel).toBe('sms');
    expect(fallback.dedupe_key).toBe('campaign:winback:cli1');
    const content = (fallback.payload_json as Record<string, Record<string, unknown>>).content;
    expect(content.body).toContain('We miss you at Sheer Soho');
    expect(eventUpdates(state)).toContain('fallback_pending');
  });

  it('cancels a client message that has no content snapshot rather than sending an empty body', async () => {
    const state = baseState();
    const { d, whatsapp } = makeDispatcher(state, settings());
    await run(d, campaignEvent({ payload_json: { message_class: 'transactional' } }));

    expect(whatsapp.send).not.toHaveBeenCalled();
    expect(eventUpdates(state)).toContain('cancelled');
  });
});

// ===========================================================================
// Accounting failure at the send path — Wrike 4507284256, test A
// ===========================================================================

describe('accounting failure never reaches the client', () => {
  it('does not re-send when the ledger write fails after a durable sent state', async () => {
    const state = baseState();
    const { d, whatsapp } = makeDispatcher(state, settings(), { recordSendResult: null });

    await run(d, event());

    // The provider was called exactly once, and the event is terminally `sent`.
    // The accounting failure is invisible to the send path by construction:
    // recordSend returns null rather than throwing, and markAccepted ignores it.
    expect(whatsapp.send).toHaveBeenCalledTimes(1);
    // (the undefined entry is the message_log_id back-link, not a status change)
    expect(eventUpdates(state).filter(Boolean)).toEqual(['sent']);
    // No fallback was queued either — a lost unit must never look like a
    // delivery failure.
    expect(queuedChannels(state)).toEqual([]);
  });

  it('stamps sent_at, which is what makes the lost unit recoverable later', async () => {
    const state = baseState();
    const { d } = makeDispatcher(state, settings(), { recordSendResult: null });

    await run(d, event());

    const sent = state.events.find((e) => e.op === 'update' && e.row.status === 'sent');
    // MessageUsageRecoveryService finds the gap from exactly this column.
    expect(sent?.row.sent_at).toEqual(expect.any(String));
  });

  it('passes a reminder OCCURRENCE anchor to the recorder, so a re-send after a reschedule counts', async () => {
    const state = baseState();
    const { d, messageUsage } = makeDispatcher(state, settings({ reminder24hEnabled: true }));

    await run(
      d,
      event({
        event_key: 'appointment_reminder_24h',
        payload_json: { appointment_start: FUTURE },
      }),
    );

    const call = (messageUsage.recordSend as jest.Mock).mock.calls[0][0];
    expect(call.occurrenceKey).toBe(FUTURE);
  });

  it('passes NO occurrence for a booking confirmation — its identity is unchanged', async () => {
    const state = baseState();
    const { d, messageUsage } = makeDispatcher(state, settings());

    await run(d, event());

    const call = (messageUsage.recordSend as jest.Mock).mock.calls[0][0];
    // A confirmation is one-shot, and its precheck does not pin the snapshot, so
    // an occurrence would risk splitting one fallback chain into two units.
    expect(call.occurrenceKey).toBeNull();
  });

  it('accounts the send against the moment the provider accepted it', async () => {
    const state = baseState();
    const { d, messageUsage } = makeDispatcher(state, settings());

    await run(d, event());

    const call = (messageUsage.recordSend as jest.Mock).mock.calls[0][0];
    const sent = state.events.find((e) => e.op === 'update' && e.row.status === 'sent');
    // occurredAt IS sent_at, so the period is derived from when the message went
    // out rather than from when the accounting happened to run.
    expect(call.occurredAt).toBe(sent?.row.sent_at);
  });
});
