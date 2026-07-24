/**
 * LabPinService.assign — PIN collision handling.
 *
 * A PIN hash may be active only once per (business, location)
 * (idx_stylist_pin_credentials_active_location_hash): on the shared Lab iPad
 * the PIN alone identifies who unlocked. Assigning a PIN that another team
 * member already uses must therefore fail with a clear 409 — and must RESTORE
 * the target's previous PIN, which assign() deactivates up front.
 */
import { ConflictException, InternalServerErrorException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { createClient } from '@supabase/supabase-js';
import type { AuthUser } from '@sheer/domain';
import { LabPinService } from './lab-pin.service';

jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(),
}));

const mockedCreateClient = createClient as jest.MockedFunction<typeof createClient>;

interface CapturedCall {
  table: string;
  method: string;
  args: unknown[];
}

// Chainable, thenable Supabase stub: every stage awaits to the table's rows,
// `maybeSingle` yields the first row, `insert` resolves with an injectable
// per-table error so unique-violation paths can be exercised.
function createMockAdmin(
  resultsByTable: Record<string, unknown[]>,
  insertErrorByTable: Record<string, { code?: string; message: string }> = {},
) {
  const captured: CapturedCall[] = [];
  const bindTable = (table: string) => {
    const rows = () => resultsByTable[table] ?? [];
    const record =
      (method: string) =>
      (...args: unknown[]) => {
        captured.push({ table, method, args });
        return chain;
      };
    const chain: Record<string, unknown> = {
      select: record('select'),
      eq: record('eq'),
      in: record('in'),
      order: record('order'),
      update: record('update'),
      insert: async (...args: unknown[]) => {
        captured.push({ table, method: 'insert', args });
        return { data: null, error: insertErrorByTable[table] ?? null };
      },
      returns: async () => ({ data: rows(), error: null }),
      maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
      then: (onFulfilled: (value: unknown) => unknown) =>
        Promise.resolve({ data: rows(), error: null }).then(onFulfilled),
    };
    return chain;
  };
  const root: Record<string, unknown> = {
    schema: () => root,
    from: (table: string) => bindTable(table),
  };
  return { root, captured };
}

function createService(
  resultsByTable: Record<string, unknown[]>,
  insertErrorByTable: Record<string, { code?: string; message: string }> = {},
) {
  const { root, captured } = createMockAdmin(resultsByTable, insertErrorByTable);
  mockedCreateClient.mockReturnValue(root as never);
  const config = {
    getOrThrow: jest.fn(() => 'test'),
    get: jest.fn(() => undefined),
  } as unknown as ConfigService;
  return { service: new LabPinService(config), captured };
}

function ownerActor(): AuthUser {
  return {
    id: 'user_actor',
    roles: ['owner'],
    primaryRole: 'owner',
    businessId: 'business_1',
    allowedLocationIds: ['location_1'],
    locationScope: { kind: 'all', locationIds: ['location_1'] },
    locations: [{ id: 'location_1', name: 'Kensington' }],
    profile: { id: 'user_actor', email: 'owner@example.com', fullName: 'Owner One' },
    permissions: [],
  };
}

const baseTables = {
  locations: [{ id: 'location_1', name: 'Kensington' }],
  user_memberships: [{ role: 'stylist', location_id: 'location_1', user_profile_id: 'user_1' }],
  staff_profiles: [{ id: 'staff_1', display_name: 'Alex Stylist' }],
  user_profiles: [{ id: 'user_1', email: 'alex@example.com', full_name: 'Alex Stylist' }],
  stylist_pin_credentials: [
    {
      id: 'cred_old',
      user_profile_id: 'user_1',
      location_id: 'location_1',
      status: 'active',
      is_active: true,
      failed_attempts: 0,
      locked_until: null,
      last_verified_at: null,
      last_rotated_at: null,
      updated_at: '2026-07-01T10:00:00.000Z',
    },
  ],
  lab_access_events: [],
};

const assignDto = { locationId: 'location_1', userProfileId: 'user_1', pin: '1234' };

const duplicateError = {
  code: '23505',
  message: 'duplicate key value violates unique constraint "idx_stylist_pin_credentials_active_location_hash"',
};

describe('LabPinService — assign PIN collisions', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('maps a duplicate active PIN at the location to a clear 409', async () => {
    const { service } = createService(baseTables, { stylist_pin_credentials: duplicateError });

    await expect(service.assign(ownerActor(), assignDto)).rejects.toBeInstanceOf(ConflictException);
    await expect(service.assign(ownerActor(), assignDto)).rejects.toThrow(/already in use/i);
  });

  it('restores the previously-deactivated credential when the insert is rejected', async () => {
    const { service, captured } = createService(baseTables, {
      stylist_pin_credentials: duplicateError,
    });

    await expect(service.assign(ownerActor(), assignDto)).rejects.toBeInstanceOf(ConflictException);

    // The rollback update re-activates exactly the rows assign() deactivated.
    const restore = captured.find(
      (call) =>
        call.table === 'stylist_pin_credentials' &&
        call.method === 'update' &&
        (call.args[0] as { is_active?: boolean }).is_active === true,
    );
    expect(restore).toBeDefined();
    const restoreScope = captured.find(
      (call) =>
        call.table === 'stylist_pin_credentials' && call.method === 'in' && call.args[0] === 'id',
    );
    expect(restoreScope?.args[1]).toEqual(['cred_old']);
  });

  it('still returns a 500 (after restoring) for non-duplicate insert failures', async () => {
    const { service, captured } = createService(baseTables, {
      stylist_pin_credentials: { message: 'connection reset' },
    });

    await expect(service.assign(ownerActor(), assignDto)).rejects.toBeInstanceOf(
      InternalServerErrorException,
    );
    const restore = captured.find(
      (call) =>
        call.table === 'stylist_pin_credentials' &&
        call.method === 'update' &&
        (call.args[0] as { is_active?: boolean }).is_active === true,
    );
    expect(restore).toBeDefined();
  });

  it('assigns successfully when the PIN is free (no rollback issued)', async () => {
    const { service, captured } = createService(baseTables);

    const result = await service.assign(ownerActor(), assignDto);

    expect(result.credential.status).toBe('active');
    expect(result.credential.isActive).toBe(true);
    const restore = captured.find(
      (call) =>
        call.table === 'stylist_pin_credentials' &&
        call.method === 'update' &&
        (call.args[0] as { is_active?: boolean }).is_active === true,
    );
    expect(restore).toBeUndefined();
  });
});
