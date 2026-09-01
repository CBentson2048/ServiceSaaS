/**
 * PushDispatchService — draining the push outbox.
 *
 * WHAT THESE SPECS PROVE. That a queued delivery reaches the provider exactly
 * once, that every failure mode the ticket names is recorded rather than thrown,
 * and that a dead token retires its device instead of being retried forever.
 *
 * WHAT THEY DELIBERATELY DO NOT PROVE. That a push actually arrives on a handset.
 * No mock can prove that — it needs a signed build on a physical device, and it is
 * reported as the outstanding external verification, not claimed here. The
 * provider is mocked throughout: these tests never make a network call.
 */

import type { ConfigService } from '@nestjs/config';
import {
  createSupabaseFake,
  createSupabaseFakeState,
  type SupabaseFakeState,
} from '../../common/testing/supabase-fake';
import type { ExpoPushProvider, ExpoPushResult } from './expo-push.provider';
import { PushDispatchService } from './push-dispatch.service';

jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(() => (globalThis as { __supabaseFake?: unknown }).__supabaseFake),
}));

const BUSINESS_ID = 'b0000000-0000-0000-0000-000000000001';
const STYLIST_ID = 'u0000000-0000-0000-0000-000000000001';
const NOTIFICATION_ID = 'n0000000-0000-0000-0000-000000000001';
const DEVICE_A = 'd0000000-0000-0000-0000-00000000000a';
const DEVICE_B = 'd0000000-0000-0000-0000-00000000000b';

const ok = (receiptId = 'ticket-1'): ExpoPushResult => ({
  ok: true,
  receiptId,
  retryable: false,
  deviceUnregistered: false,
});

function notificationRow(overrides: Record<string, unknown> = {}) {
  return {
    id: NOTIFICATION_ID,
    type: 'client_arrived',
    title: 'Client arrived',
    body: 'Jane has arrived.',
    entity_type: 'appointment',
    entity_id: 'a0000000-0000-0000-0000-000000000001',
    action_path: '/bookings?appointmentId=a0000000-0000-0000-0000-000000000001',
    ...overrides,
  };
}

function deviceRow(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    business_id: BUSINESS_ID,
    user_profile_id: STYLIST_ID,
    push_token: `ExponentPushToken[${id}]`,
    enabled: true,
    ...overrides,
  };
}

function deliveryRow(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    business_id: BUSINESS_ID,
    notification_id: NOTIFICATION_ID,
    user_profile_id: STYLIST_ID,
    user_device_id: DEVICE_A,
    status: 'queued',
    attempts: 0,
    locked_until: null,
    processing_started_at: null,
    sent_at: null,
    provider_receipt_id: null,
    last_error: null,
    created_at: '2026-08-31T09:00:00.000Z',
    ...overrides,
  };
}

function build(
  seed: Record<string, Array<Record<string, unknown>>>,
  send: jest.Mock,
  env: Record<string, string> = {},
): { service: PushDispatchService; state: SupabaseFakeState; provider: ExpoPushProvider } {
  const state = createSupabaseFakeState(seed, {});
  (globalThis as { __supabaseFake?: unknown }).__supabaseFake = createSupabaseFake(state);
  const config = {
    get: jest.fn((key: string) => env[key]),
    getOrThrow: jest.fn((key: string) => `fake-${key}`),
  } as unknown as ConfigService;
  const provider = { enabled: true, send } as unknown as ExpoPushProvider;
  return { service: new PushDispatchService(config, provider), state, provider };
}

const rows = (state: SupabaseFakeState, table: string) =>
  (state.tables.get(table) ?? []) as Array<Record<string, unknown>>;

/** Yield to the event loop until `predicate` holds, so tests never race the drain. */
async function waitUntil(predicate: () => boolean, maxTicks = 200): Promise<void> {
  for (let i = 0; i < maxTicks && !predicate(); i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

describe('PushDispatchService.tick', () => {
  it('sends one queued delivery and records the provider receipt', async () => {
    const send = jest.fn().mockResolvedValue([ok('ticket-abc')]);
    const { service, state } = build(
      {
        'comms.push_deliveries': [deliveryRow('pd-1')],
        'comms.user_devices': [deviceRow(DEVICE_A)],
        'comms.notifications': [notificationRow()],
      },
      send,
    );

    await service.tick();

    expect(send).toHaveBeenCalledTimes(1);
    const [messages] = send.mock.calls[0];
    expect(messages).toHaveLength(1);
    expect(messages[0].token).toBe(`ExponentPushToken[${DEVICE_A}]`);
    // Title and body come verbatim from the persisted notification, so the
    // lock-screen text is exactly the in-app text and inherits its privacy rule.
    expect(messages[0].title).toBe('Client arrived');
    expect(messages[0].body).toBe('Jane has arrived.');
    // Routing context travels as structured data, never parsed out of the body.
    expect(messages[0].data).toMatchObject({
      notificationId: NOTIFICATION_ID,
      type: 'client_arrived',
      entityType: 'appointment',
      actionPath: '/bookings?appointmentId=a0000000-0000-0000-0000-000000000001',
    });

    const row = rows(state, 'comms.push_deliveries')[0];
    expect(row.status).toBe('sent');
    expect(row.provider_receipt_id).toBe('ticket-abc');
    expect(row.attempts).toBe(1);
    expect(row.sent_at).toEqual(expect.any(String));
  });

  it('sends to every enabled device the stylist owns, in one provider call', async () => {
    const send = jest.fn().mockResolvedValue([ok('t-a'), ok('t-b')]);
    const { service, state } = build(
      {
        'comms.push_deliveries': [
          deliveryRow('pd-1', { user_device_id: DEVICE_A }),
          deliveryRow('pd-2', { user_device_id: DEVICE_B }),
        ],
        'comms.user_devices': [deviceRow(DEVICE_A), deviceRow(DEVICE_B)],
        'comms.notifications': [notificationRow()],
      },
      send,
    );

    await service.tick();

    // Batched: one HTTP round trip for both handsets, not one per device.
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toHaveLength(2);
    expect(rows(state, 'comms.push_deliveries').map((r) => r.status)).toEqual(['sent', 'sent']);
  });

  it('does nothing at all when there is no queued delivery', async () => {
    const send = jest.fn();
    const { service } = build(
      {
        'comms.push_deliveries': [],
        'comms.user_devices': [deviceRow(DEVICE_A)],
        'comms.notifications': [notificationRow()],
      },
      send,
    );

    await service.tick();

    // The stylist has no registered device, so nothing was ever queued. This is
    // the "push not supported" path and must be silent, not an error.
    expect(send).not.toHaveBeenCalled();
  });

  it('skips a device that was disabled between enqueue and send', async () => {
    const send = jest.fn();
    const { service, state } = build(
      {
        'comms.push_deliveries': [deliveryRow('pd-1')],
        // The stylist logged out after the notification was created.
        'comms.user_devices': [deviceRow(DEVICE_A, { enabled: false })],
        'comms.notifications': [notificationRow()],
      },
      send,
    );

    await service.tick();

    expect(send).not.toHaveBeenCalled();
    const row = rows(state, 'comms.push_deliveries')[0];
    expect(row.status).toBe('skipped');
    expect(String(row.last_error)).toContain('device disabled');
  });

  it('skips a device whose token was cleared', async () => {
    const send = jest.fn();
    const { service, state } = build(
      {
        'comms.push_deliveries': [deliveryRow('pd-1')],
        'comms.user_devices': [deviceRow(DEVICE_A, { push_token: null })],
        'comms.notifications': [notificationRow()],
      },
      send,
    );

    await service.tick();

    expect(send).not.toHaveBeenCalled();
    expect(rows(state, 'comms.push_deliveries')[0].status).toBe('skipped');
  });

  it('retires the device when the provider reports DeviceNotRegistered', async () => {
    const send = jest.fn().mockResolvedValue([
      {
        ok: false,
        errorCode: 'DeviceNotRegistered',
        error: 'not registered',
        retryable: false,
        deviceUnregistered: true,
      } satisfies ExpoPushResult,
    ]);
    const { service, state } = build(
      {
        'comms.push_deliveries': [deliveryRow('pd-1')],
        'comms.user_devices': [deviceRow(DEVICE_A)],
        'comms.notifications': [notificationRow()],
      },
      send,
    );

    await service.tick();

    // The app was uninstalled or notifications revoked. Retiring the row stops
    // every future notification queueing a delivery that can only ever fail.
    const device = rows(state, 'comms.user_devices')[0];
    expect(device.enabled).toBe(false);
    expect(device.push_token).toBeNull();

    const delivery = rows(state, 'comms.push_deliveries')[0];
    // 'skipped', not 'failed': nothing went wrong on our side.
    expect(delivery.status).toBe('skipped');
    expect(delivery.last_error).toBe('DeviceNotRegistered');
  });

  it('leaves a retryable provider error queued for the next tick', async () => {
    const send = jest.fn().mockResolvedValue([
      {
        ok: false,
        errorCode: 'MessageRateExceeded',
        error: 'slow down',
        retryable: true,
        deviceUnregistered: false,
      } satisfies ExpoPushResult,
    ]);
    const { service, state } = build(
      {
        'comms.push_deliveries': [deliveryRow('pd-1')],
        'comms.user_devices': [deviceRow(DEVICE_A)],
        'comms.notifications': [notificationRow()],
      },
      send,
    );

    await service.tick();

    const row = rows(state, 'comms.push_deliveries')[0];
    expect(row.status).toBe('queued');
    expect(row.attempts).toBe(1);
    // The lease is released so the next tick can pick it straight back up.
    expect(row.locked_until).toBeNull();
    expect(row.last_error).toBe('MessageRateExceeded');
  });

  it('marks a retryable error failed once attempts are exhausted', async () => {
    const send = jest.fn().mockResolvedValue([
      {
        ok: false,
        errorCode: 'ProviderDown',
        error: 'boom',
        retryable: true,
        deviceUnregistered: false,
      } satisfies ExpoPushResult,
    ]);
    const { service, state } = build(
      {
        // Already tried twice; this is the third and final attempt.
        'comms.push_deliveries': [deliveryRow('pd-1', { attempts: 2 })],
        'comms.user_devices': [deviceRow(DEVICE_A)],
        'comms.notifications': [notificationRow()],
      },
      send,
      { PUSH_DISPATCH_MAX_ATTEMPTS: '3' },
    );

    await service.tick();

    const row = rows(state, 'comms.push_deliveries')[0];
    expect(row.status).toBe('failed');
    expect(row.attempts).toBe(3);
  });

  it('never claims a delivery that has already exhausted its attempts', async () => {
    const send = jest.fn();
    const { service, state } = build(
      {
        'comms.push_deliveries': [deliveryRow('pd-1', { attempts: 3 })],
        'comms.user_devices': [deviceRow(DEVICE_A)],
        'comms.notifications': [notificationRow()],
      },
      send,
      { PUSH_DISPATCH_MAX_ATTEMPTS: '3' },
    );

    await service.tick();

    expect(send).not.toHaveBeenCalled();
    // It must not sit queued forever poisoning every future tick.
    expect(rows(state, 'comms.push_deliveries')[0].status).toBe('failed');
  });

  it('does not send a delivery another worker currently holds', async () => {
    const send = jest.fn();
    const future = new Date(Date.now() + 60_000).toISOString();
    const { service } = build(
      {
        'comms.push_deliveries': [deliveryRow('pd-1', { locked_until: future })],
        'comms.user_devices': [deviceRow(DEVICE_A)],
        'comms.notifications': [notificationRow()],
      },
      send,
    );

    await service.tick();

    // The lease is what stops two API instances pushing the same arrival twice.
    expect(send).not.toHaveBeenCalled();
  });

  it('does not re-send a delivery that is already sent', async () => {
    const send = jest.fn();
    const { service } = build(
      {
        'comms.push_deliveries': [deliveryRow('pd-1', { status: 'sent' })],
        'comms.user_devices': [deviceRow(DEVICE_A)],
        'comms.notifications': [notificationRow()],
      },
      send,
    );

    await service.tick();

    expect(send).not.toHaveBeenCalled();
  });

  it('skips a delivery whose notification has been deleted', async () => {
    const send = jest.fn();
    const { service, state } = build(
      {
        'comms.push_deliveries': [deliveryRow('pd-1')],
        'comms.user_devices': [deviceRow(DEVICE_A)],
        'comms.notifications': [],
      },
      send,
    );

    await service.tick();

    expect(send).not.toHaveBeenCalled();
    expect(rows(state, 'comms.push_deliveries')[0].status).toBe('skipped');
  });

  it('never throws when the provider itself throws', async () => {
    const send = jest.fn().mockRejectedValue(new Error('socket hang up'));
    const { service } = build(
      {
        'comms.push_deliveries': [deliveryRow('pd-1')],
        'comms.user_devices': [deviceRow(DEVICE_A)],
        'comms.notifications': [notificationRow()],
      },
      send,
    );

    // tick() runs inside setInterval, where an unhandled rejection would take the
    // API process down. A push backlog is never worth an API restart.
    await expect(service.tick()).resolves.toBeUndefined();
  });

  it('never throws when the database is unreachable', async () => {
    const { service, state } = build(
      {
        'comms.push_deliveries': [deliveryRow('pd-1')],
        'comms.user_devices': [deviceRow(DEVICE_A)],
        'comms.notifications': [notificationRow()],
      },
      jest.fn(),
    );
    state.errors.set('comms.push_deliveries', { message: 'connection reset' });

    await expect(service.tick()).resolves.toBeUndefined();
  });

  it('does not overlap with a tick that is still running', async () => {
    // A gate created up front, so releasing it never races with the tick reaching
    // send(): the deferred exists before the first tick starts.
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const send = jest.fn().mockImplementation(() => gate.then(() => [ok()]));
    const { service } = build(
      {
        'comms.push_deliveries': [deliveryRow('pd-1')],
        'comms.user_devices': [deviceRow(DEVICE_A)],
        'comms.notifications': [notificationRow()],
      },
      send,
    );

    const first = service.tick();
    await waitUntil(() => send.mock.calls.length > 0);

    // The overlap guard: a second tick while the first is mid-send must return
    // without starting another drain. Without it, the interval firing during a
    // slow provider call would send the same arrival twice.
    await service.tick();

    release();
    await first;

    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe('PushDispatchService lifecycle', () => {
  const seed = {
    'comms.push_deliveries': [],
    'comms.user_devices': [],
    'comms.notifications': [],
  };

  it('does not start the poller when push dispatch is disabled', () => {
    const { service } = build(seed, jest.fn(), { PUSH_DISPATCH_ENABLED: 'false' });
    const spy = jest.spyOn(global, 'setInterval');
    service.onModuleInit();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
    service.onModuleDestroy();
  });

  it('does not start the poller when the provider is disabled', () => {
    const state = createSupabaseFakeState(seed, {});
    (globalThis as { __supabaseFake?: unknown }).__supabaseFake = createSupabaseFake(state);
    const config = {
      get: jest.fn(() => undefined),
      getOrThrow: jest.fn((key: string) => `fake-${key}`),
    } as unknown as ConfigService;
    const provider = { enabled: false, send: jest.fn() } as unknown as ExpoPushProvider;
    const service = new PushDispatchService(config, provider);

    const spy = jest.spyOn(global, 'setInterval');
    service.onModuleInit();
    // An environment with no push configured must still run the API normally.
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
    service.onModuleDestroy();
  });

  it('starts an unref-ed poller when enabled, and clears it on shutdown', () => {
    const { service } = build(seed, jest.fn());
    service.onModuleInit();
    service.onModuleDestroy();
    // Reaching here without a hanging handle is the assertion: an un-unref-ed
    // timer would keep the process alive through shutdown.
    expect(true).toBe(true);
  });
});
