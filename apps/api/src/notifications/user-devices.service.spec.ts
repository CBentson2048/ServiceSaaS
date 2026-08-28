/**
 * UserDevicesService — the user/device targeting foundation.
 *
 * WHAT THESE SPECS PROVE. That the device owner is always taken from the
 * authenticated actor and never from the request body, that reads and writes are
 * scoped to that actor plus their business, that disabling clears the delivery
 * address, and that a push token never appears in an API response.
 *
 * WHAT THEY DO NOT PROVE: that the DATABASE prevents cross-business registration,
 * duplicate enabled tokens, or token takeover. Those live in
 * comms.register_user_device and the partial unique index, and are proved in
 * supabase/tests/in_app_notifications.sql (cases 28-33). The RPC is faked here, so
 * these specs test the call and the surrounding scoping, not the function's body.
 *
 * There is also no push DELIVERY to test: this ticket registers devices, it does
 * not send to them.
 */

import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { AuthUser } from '@sheer/domain';
import {
  createSupabaseFake,
  createSupabaseFakeState,
  type RpcHandler,
  type SupabaseFakeState,
} from '../common/testing/supabase-fake';
import { UserDevicesService } from './user-devices.service';

jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(() => (globalThis as { __supabaseFake?: unknown }).__supabaseFake),
}));

const BUSINESS_ID = 'b0000000-0000-0000-0000-000000000001';
const OTHER_BUSINESS_ID = 'b0000000-0000-0000-0000-000000000002';
const ME = 'u0000000-0000-0000-0000-000000000001';
const SOMEONE_ELSE = 'u0000000-0000-0000-0000-000000000002';
const DEVICE_ID = 'd0000000-0000-0000-0000-000000000001';

function actor(overrides: Partial<AuthUser> = {}): AuthUser {
  return {
    id: ME,
    roles: ['stylist'],
    primaryRole: 'stylist',
    businessId: BUSINESS_ID,
    allowedLocationIds: [],
    locationScope: 'assigned',
    locations: [],
    permissions: [],
    profile: { fullName: 'Sam Stylist', email: 'sam@example.com' },
    ...overrides,
  } as unknown as AuthUser;
}

function deviceRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: DEVICE_ID,
    business_id: BUSINESS_ID,
    user_profile_id: ME,
    device_identifier: 'installation-aaa',
    platform: 'ios',
    push_token: 'ExponentPushToken[SECRET]',
    enabled: true,
    last_seen_at: '2026-08-01T10:00:00.000Z',
    created_at: '2026-07-01T10:00:00.000Z',
    updated_at: '2026-08-01T10:00:00.000Z',
    ...overrides,
  };
}

function makeService(
  seed: Record<string, Array<Record<string, unknown>>> = {},
  rpcs: Record<string, RpcHandler> = {},
): { service: UserDevicesService; state: SupabaseFakeState } {
  const state = createSupabaseFakeState(seed, rpcs);
  (globalThis as { __supabaseFake?: unknown }).__supabaseFake = createSupabaseFake(state);
  const config = {
    get: jest.fn(),
    getOrThrow: jest.fn((key: string) => `fake-${key}`),
  } as unknown as ConfigService;
  return { service: new UserDevicesService(config), state };
}

describe('UserDevicesService.register', () => {
  it('registers the device against the AUTHENTICATED user, not a supplied id', async () => {
    const { service, state } = makeService(
      { 'comms.user_devices': [deviceRow()] },
      { register_user_device: () => ({ data: DEVICE_ID, error: null }) },
    );

    await service.register(actor(), {
      deviceIdentifier: 'installation-aaa',
      platform: 'ios',
      pushToken: 'ExponentPushToken[SECRET]',
    });

    const call = state.rpcLog.find((entry) => entry.name === 'register_user_device');
    expect(call?.args).toMatchObject({
      p_business_id: BUSINESS_ID,
      p_user_profile_id: ME,
      p_device_identifier: 'installation-aaa',
      p_platform: 'ios',
    });
  });

  it('does not return the push token it just stored', async () => {
    const { service } = makeService(
      { 'comms.user_devices': [deviceRow()] },
      { register_user_device: () => ({ data: DEVICE_ID, error: null }) },
    );

    const result = await service.register(actor(), {
      deviceIdentifier: 'installation-aaa',
      platform: 'ios',
      pushToken: 'ExponentPushToken[SECRET]',
    });

    expect(JSON.stringify(result)).not.toContain('SECRET');
    expect(result.device.hasPushToken).toBe(true);
  });

  it('passes a null token through when the app has not been granted one yet', async () => {
    const { service, state } = makeService(
      { 'comms.user_devices': [deviceRow({ push_token: null })] },
      { register_user_device: () => ({ data: DEVICE_ID, error: null }) },
    );

    const result = await service.register(actor(), {
      deviceIdentifier: 'installation-aaa',
      platform: 'ios',
    });

    const call = state.rpcLog.find((entry) => entry.name === 'register_user_device');
    expect(call?.args['p_push_token']).toBeNull();
    expect(result.device.hasPushToken).toBe(false);
  });

  it('surfaces a failure without echoing the database message (it can contain the token)', async () => {
    const { service } = makeService(
      {},
      {
        register_user_device: () => ({
          data: null,
          error: { message: "insert ... 'ExponentPushToken[SECRET]' ..." },
        }),
      },
    );

    await expect(
      service.register(actor(), {
        deviceIdentifier: 'installation-aaa',
        platform: 'ios',
        pushToken: 'ExponentPushToken[SECRET]',
      }),
    ).rejects.toThrow(/Unable to register device/);

    await expect(
      service.register(actor(), {
        deviceIdentifier: 'installation-aaa',
        platform: 'ios',
        pushToken: 'ExponentPushToken[SECRET]',
      }),
    ).rejects.not.toThrow(/SECRET/);
  });
});

describe('UserDevicesService.list', () => {
  it('returns only the acting user’s devices', async () => {
    const { service } = makeService({
      'comms.user_devices': [
        deviceRow({ id: 'mine', device_identifier: 'mine' }),
        deviceRow({ id: 'theirs', user_profile_id: SOMEONE_ELSE, device_identifier: 'theirs' }),
      ],
    });

    const result = await service.list(actor());
    expect(result.devices.map((d) => d.id)).toEqual(['mine']);
  });

  it('does not cross business boundaries', async () => {
    const { service } = makeService({
      'comms.user_devices': [
        deviceRow({ id: 'here' }),
        deviceRow({ id: 'elsewhere', business_id: OTHER_BUSINESS_ID }),
      ],
    });

    const result = await service.list(actor());
    expect(result.devices.map((d) => d.id)).toEqual(['here']);
  });

  it('leaks no push tokens in the listing', async () => {
    const { service } = makeService({ 'comms.user_devices': [deviceRow()] });
    expect(JSON.stringify(await service.list(actor()))).not.toContain('SECRET');
  });
});

describe('UserDevicesService.disable', () => {
  it('disables the device AND clears its delivery address', async () => {
    const { service, state } = makeService({ 'comms.user_devices': [deviceRow()] });

    const result = await service.disable(actor(), DEVICE_ID);
    expect(result.device.enabled).toBe(false);
    expect(result.device.hasPushToken).toBe(false);

    // Clearing the token is what frees it for re-registration elsewhere without
    // colliding with the one-enabled-row-per-token index.
    const row = (state.tables.get('comms.user_devices') ?? [])[0];
    expect(row?.['push_token']).toBeNull();
    expect(row?.['enabled']).toBe(false);
  });

  it('cannot disable another user’s device, and does not modify it', async () => {
    const { service, state } = makeService({
      'comms.user_devices': [deviceRow({ user_profile_id: SOMEONE_ELSE })],
    });

    await expect(service.disable(actor(), DEVICE_ID)).rejects.toBeInstanceOf(NotFoundException);

    const row = (state.tables.get('comms.user_devices') ?? [])[0];
    expect(row?.['enabled']).toBe(true);
    expect(row?.['push_token']).toBe('ExponentPushToken[SECRET]');
  });

  it('cannot disable a device in another business', async () => {
    const { service } = makeService({
      'comms.user_devices': [deviceRow({ business_id: OTHER_BUSINESS_ID })],
    });
    await expect(service.disable(actor(), DEVICE_ID)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('404s on an unknown device id, indistinguishably from a foreign one', async () => {
    const { service } = makeService({ 'comms.user_devices': [] });
    await expect(service.disable(actor(), DEVICE_ID)).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('UserDevicesService — a customer who has not joined a salon', () => {
  const salonless = () => actor({ businessId: '', roles: ['client'], primaryRole: 'client' });

  it('cannot register a device, and is told why', async () => {
    const { service, state } = makeService(
      {},
      { register_user_device: () => ({ data: DEVICE_ID, error: null }) },
    );
    await expect(
      service.register(salonless(), { deviceIdentifier: 'installation-aaa', platform: 'ios' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    // Refused before the write, not after it.
    expect(state.rpcLog).toHaveLength(0);
  });

  it('lists no devices rather than erroring', async () => {
    const { service } = makeService({ 'comms.user_devices': [deviceRow()] });
    expect(await service.list(salonless())).toEqual({ devices: [] });
  });

  it('gets a 404 when disabling', async () => {
    const { service } = makeService({ 'comms.user_devices': [deviceRow()] });
    await expect(service.disable(salonless(), DEVICE_ID)).rejects.toBeInstanceOf(NotFoundException);
  });
});
