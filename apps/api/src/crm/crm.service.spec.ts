/**
 * CRM service — tests.
 *
 * Most service-level coverage targets are still recorded with `it.todo` until a
 * full Supabase chain-mocking harness is in place. The `create client location
 * scoping` block below is a first real harness covering the create path, which
 * is authorization- and scoping-critical.
 */
import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { createClient } from '@supabase/supabase-js';
import type { AuthUser } from '@sheer/domain';
import { CrmService } from './crm.service';
import type { LabFormulaService } from '../lab-formula/lab-formula.service';

jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(),
}));

const mockedCreateClient = createClient as jest.MockedFunction<typeof createClient>;

// Minimal chainable stub covering both persistClient chains:
//  - duplicate lookup: schema.from.select.eq.eq.limit.maybeSingle()
//  - insert:           schema.from.insert.select.single()
// `existingByEmail` is what the duplicate lookup resolves to (null = none).
function createMockAdmin(existingByEmail: Record<string, unknown> | null = null) {
  const captured: { insertPayload?: Record<string, unknown> } = {};
  const query: Record<string, unknown> = {};
  Object.assign(query, {
    schema: () => query,
    from: () => query,
    select: () => query,
    eq: () => query,
    limit: () => query,
    insert: (payload: Record<string, unknown>) => {
      captured.insertPayload = payload;
      return query;
    },
    maybeSingle: async () => ({ data: existingByEmail, error: null }),
    single: async () => ({
      data: {
        id: 'client_1',
        business_id: 'business_1',
        client_code: 'ABCD1234',
        user_profile_id: null,
        primary_location_id: (captured.insertPayload?.primary_location_id as string) ?? null,
        first_name: (captured.insertPayload?.first_name as string) ?? 'Jane',
        last_name: (captured.insertPayload?.last_name as string) ?? 'Doe',
        email: (captured.insertPayload?.email as string) ?? null,
        phone: (captured.insertPayload?.phone as string) ?? null,
        date_of_birth: null,
        communication_preference:
          (captured.insertPayload?.communication_preference as string) ?? null,
        notes: null,
        marketing_opt_in: (captured.insertPayload?.marketing_opt_in as boolean) ?? false,
        source: (captured.insertPayload?.source as string) ?? 'crm_manual',
        tags: [],
        metadata: {},
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
      },
      error: null,
    }),
  });
  return { query, captured };
}

function createService(existingByEmail: Record<string, unknown> | null = null) {
  const mock = createMockAdmin(existingByEmail);
  mockedCreateClient.mockReturnValue(mock.query as never);
  const config = { getOrThrow: jest.fn(() => 'test') } as unknown as ConfigService;
  // CrmService reuses LabFormulaService only for the client-detail formula panel,
  // which none of these create-path tests exercise; a no-op stub keeps the
  // constructor satisfied without a second Supabase client.
  const labFormulas = {
    historyForClient: jest.fn(async () => []),
  } as unknown as LabFormulaService;
  return { service: new CrmService(config, labFormulas), captured: mock.captured };
}

// Search harness: captures every `schema('crm').rpc('search_clients', …)` call
// so tests can assert the tenancy/location scope actually sent to the database.
function createSearchService(rpcRows: Array<Record<string, unknown>> = []) {
  const rpcCalls: Array<{ name: string; params: Record<string, unknown> }> = [];
  const query: Record<string, unknown> = {};
  Object.assign(query, {
    schema: () => query,
    rpc: async (name: string, params: Record<string, unknown>) => {
      rpcCalls.push({ name, params });
      return { data: rpcRows, error: null };
    },
  });
  mockedCreateClient.mockReturnValue(query as never);
  const config = { getOrThrow: jest.fn(() => 'test') } as unknown as ConfigService;
  const labFormulas = {
    historyForClient: jest.fn(async () => []),
  } as unknown as LabFormulaService;
  return { service: new CrmService(config, labFormulas), rpcCalls };
}

describe('CrmService — permissions and search', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  function actor(overrides: Partial<AuthUser> = {}): AuthUser {
    return {
      id: 'user_1',
      roles: ['manager'],
      primaryRole: 'manager',
      businessId: 'business_1',
      allowedLocationIds: ['location_1'],
      ...overrides,
    } as unknown as AuthUser;
  }

  const rpcRow = {
    id: 'client_1',
    client_code: 'ABCD1234',
    first_name: 'Jane',
    last_name: 'Doe',
    email: 'jane@example.com',
    phone: '+447700900123',
    primary_location_id: 'location_1',
    rank: 0.9,
    total_count: 1,
  };

  it('owner can search clients across the business by name, phone, and email', async () => {
    const { service, rpcCalls } = createSearchService([rpcRow]);

    const result = await service.searchClients(
      actor({ roles: ['owner'], primaryRole: 'owner' }),
      { q: 'jane' },
    );

    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0].name).toBe('search_clients');
    // Owner scope is business-wide: no location filter reaches the database.
    expect(rpcCalls[0].params).toMatchObject({
      p_business_id: 'business_1',
      p_location_ids: null,
      p_term: 'jane',
    });
    expect(result.results).toEqual([
      expect.objectContaining({
        id: 'client_1',
        displayName: 'Jane Doe',
        clientCode: 'ABCD1234',
        email: 'jane@example.com',
        phone: '+447700900123',
      }),
    ]);
    expect(result.pagination).toMatchObject({ total: 1, page: 1 });
  });

  it('manager searches only clients in assigned locations', async () => {
    const { service, rpcCalls } = createSearchService([rpcRow]);

    await service.searchClients(actor({ allowedLocationIds: ['location_1', 'location_2'] }), {
      q: 'jane',
    });

    expect(rpcCalls[0].params).toMatchObject({
      p_location_ids: ['location_1', 'location_2'],
    });
  });

  it('rejects a search scoped to a location outside the manager scope', async () => {
    const { service, rpcCalls } = createSearchService([rpcRow]);

    await expect(
      service.searchClients(actor({ allowedLocationIds: ['location_1'] }), {
        q: 'jane',
        locationId: 'location_9',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(rpcCalls).toHaveLength(0);
  });

  it('returns empty without querying when the actor has no permitted locations', async () => {
    const { service, rpcCalls } = createSearchService([rpcRow]);

    const result = await service.searchClients(actor({ allowedLocationIds: [] }), { q: 'jane' });

    expect(rpcCalls).toHaveLength(0);
    expect(result.results).toEqual([]);
    expect(result.pagination.total).toBe(0);
  });

  it.todo('manager cannot read another location client detail');
  it.todo('stylist can only read clients from assigned scope or own appointment history');
  it.todo('client role is rejected from every CRM staff endpoint');
});

describe('CrmService — client records', () => {
  it.todo('client profile update persists editable contact and communication fields');
  it.todo('notes persist with author and optional visit linkage');
  it.todo('allergy records persist active severity data for alerting');
  it.todo('patch tests expose expired status from status and expires_at');
  it.todo('message logs are read from comms.message_logs instead of a duplicate table');
  it.todo('visit photos require visit and client linkage');
  it.todo('client-visible visit summaries do not expose formula ingredients or product costs');
});

describe('CrmService — create client location scoping', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  function actor(overrides: Partial<AuthUser>): AuthUser {
    return {
      id: 'user_1',
      roles: ['manager'],
      primaryRole: 'manager',
      businessId: 'business_1',
      allowedLocationIds: ['location_1'],
      ...overrides,
    } as unknown as AuthUser;
  }

  it('auto-scopes a single-location manager to their only location', async () => {
    const { service, captured } = createService();

    await service.createClient(actor({ allowedLocationIds: ['location_1'] }), {
      firstName: 'Jane',
      lastName: 'Doe',
    });

    expect(captured.insertPayload?.primary_location_id).toBe('location_1');
  });

  it('rejects a multi-location manager who did not choose a location (no orphan row)', async () => {
    const { service, captured } = createService();

    await expect(
      service.createClient(actor({ allowedLocationIds: ['location_1', 'location_2'] }), {
        firstName: 'Jane',
        lastName: 'Doe',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    // The guard fires before any insert, so nothing is written.
    expect(captured.insertPayload).toBeUndefined();
  });

  it('persists the chosen location for a multi-location manager who selected one', async () => {
    const { service, captured } = createService();

    await service.createClient(actor({ allowedLocationIds: ['location_1', 'location_2'] }), {
      firstName: 'Jane',
      lastName: 'Doe',
      primaryLocationId: 'location_2',
    });

    expect(captured.insertPayload?.primary_location_id).toBe('location_2');
  });

  it('allows an owner to create an unscoped (null-location) client', async () => {
    const { service, captured } = createService();

    await service.createClient(
      actor({
        roles: ['owner'],
        primaryRole: 'owner',
        allowedLocationIds: ['location_1', 'location_2'],
      }),
      { firstName: 'Jane', lastName: 'Doe' },
    );

    expect(captured.insertPayload?.primary_location_id).toBeNull();
  });
});

describe('CrmService — create client dedup and preference guards', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  function actor(overrides: Partial<AuthUser> = {}): AuthUser {
    return {
      id: 'user_1',
      roles: ['manager'],
      primaryRole: 'manager',
      businessId: 'business_1',
      allowedLocationIds: ['location_1'],
      ...overrides,
    } as unknown as AuthUser;
  }

  it('rejects a create whose email already exists in the business', async () => {
    const { service, captured } = createService({
      id: 'existing_1',
      client_code: 'ZZZZ9999',
      first_name: 'Existing',
      last_name: 'Client',
    });

    await expect(
      service.createClient(actor(), {
        firstName: 'Jane',
        lastName: 'Doe',
        email: 'jane@example.com',
      }),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(captured.insertPayload).toBeUndefined();
  });

  it('creates anyway when allowDuplicate is set despite an existing email', async () => {
    const { service, captured } = createService({
      id: 'existing_1',
      client_code: 'ZZZZ9999',
      first_name: 'Existing',
      last_name: 'Client',
    });

    await service.createClient(actor(), {
      firstName: 'Jane',
      lastName: 'Doe',
      email: 'jane@example.com',
      allowDuplicate: true,
    });

    expect(captured.insertPayload?.email).toBe('jane@example.com');
  });

  it('rejects an SMS preference when no phone is provided', async () => {
    const { service, captured } = createService();

    await expect(
      service.createClient(actor(), {
        firstName: 'Jane',
        lastName: 'Doe',
        communicationPreference: 'sms',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(captured.insertPayload).toBeUndefined();
  });

  it('rejects an email preference when no email is provided', async () => {
    const { service, captured } = createService();

    await expect(
      service.createClient(actor(), {
        firstName: 'Jane',
        lastName: 'Doe',
        communicationPreference: 'email',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(captured.insertPayload).toBeUndefined();
  });
});
