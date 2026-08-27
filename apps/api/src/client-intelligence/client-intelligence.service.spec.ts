/**
 * Client Intelligence service — tenancy, access, evidence loading and settings.
 *
 * The cadence arithmetic itself is pinned by lapse-rule.spec; these specs prove
 * what the SERVICE sends and refuses: that every read is scoped to the actor's
 * business and locations, that a failed upcoming-booking read fails the request
 * rather than falsely lapsing everyone, that the evidence load is a bounded
 * number of set-based calls rather than one per client, and that the configured
 * buffer reaches the calculation.
 *
 * What these specs do NOT prove: that the SQL in 0097 selects the right visit
 * rows (cancelled/no-show/future exclusion lives in the migration's predicates
 * and is asserted there), nor that PostgREST enforces anything — the API holds a
 * service-role key and RLS is dormant on this path, so application-layer
 * scoping IS the tenancy boundary and is what is tested here.
 */
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { createClient } from '@supabase/supabase-js';
import type { AuthUser } from '@sheer/domain';
import { ClientIntelligenceService } from './client-intelligence.service';

jest.mock('@supabase/supabase-js', () => ({ createClient: jest.fn() }));
const mockedCreateClient = createClient as jest.MockedFunction<typeof createClient>;

type Row = Record<string, unknown>;

interface RpcCall {
  name: string;
  args: Record<string, unknown>;
}

interface Captured {
  table: string;
  verb: string;
  payload?: unknown;
}

interface FakeOptions {
  /** Seed rows keyed by bare table name. */
  tables?: Record<string, Row[]>;
  /** RPC results keyed by function name; a function receives the call args. */
  rpc?: Record<string, Row[] | ((args: Record<string, unknown>) => Row[])>;
  /** RPC names that should resolve with an error instead of data. */
  rpcErrors?: string[];
}

/**
 * Filter-aware chain fake. eq/in/is genuinely filter the seeded rows, so a
 * missing `.eq('business_id', …)` shows up as a cross-tenant row in the result
 * rather than passing silently.
 */
function build(options: FakeOptions = {}) {
  const rpcCalls: RpcCall[] = [];
  const captured: Captured[] = [];
  const tables = options.tables ?? {};

  const makeChain = (table: string) => {
    let rows: Row[] = (tables[table] ?? []).map((row) => ({ ...row }));
    let verb = 'select';
    let payload: unknown;

    const chain: Record<string, unknown> = {};
    const settle = () => {
      if (verb !== 'select') {
        captured.push({ table, verb, payload });
        return { data: null, error: null };
      }
      return { data: rows, error: null };
    };

    Object.assign(chain, {
      select: () => chain,
      order: () => chain,
      limit: () => chain,
      range: () => chain,
      returns: () => chain,
      eq: (column: string, value: unknown) => {
        rows = rows.filter((row) => row[column] === value);
        return chain;
      },
      in: (column: string, values: readonly unknown[]) => {
        rows = rows.filter((row) => values.includes(row[column]));
        return chain;
      },
      is: (column: string, value: unknown) => {
        rows = rows.filter((row) => (row[column] ?? null) === value);
        return chain;
      },
      upsert: (body: unknown) => {
        verb = 'upsert';
        payload = body;
        return chain;
      },
      maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
      single: async () => ({ data: rows[0] ?? null, error: null }),
      then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
        Promise.resolve(settle()).then(resolve, reject),
    });
    return chain;
  };

  const root = {
    schema: () => ({
      from: (table: string) => makeChain(table),
      rpc: async (name: string, args: Record<string, unknown>) => {
        rpcCalls.push({ name, args });
        if (options.rpcErrors?.includes(name)) {
          return { data: null, error: { message: `${name} exploded` } };
        }
        const configured = options.rpc?.[name] ?? [];
        try {
          // A thrown fixture becomes a PostgREST-shaped error, matching how a
          // failing RPC actually surfaces (resolved with `error`, not rejected).
          const data = typeof configured === 'function' ? configured(args) : configured;
          return { data, error: null };
        } catch (err) {
          return { data: null, error: { message: (err as Error).message } };
        }
      },
    }),
  };
  mockedCreateClient.mockReturnValue(root as never);

  const config = { getOrThrow: (key: string) => `test-${key}` } as unknown as ConfigService;
  return { service: new ClientIntelligenceService(config), rpcCalls, captured };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BUSINESS = 'biz-1';
const OTHER_BUSINESS = 'biz-2';
const LOC_1 = 'loc-1';
const LOC_2 = 'loc-2';
const CLIENT = 'client-1';

function authUser(overrides: Partial<AuthUser> = {}): AuthUser {
  return {
    id: 'user-1',
    roles: ['owner'],
    primaryRole: 'owner',
    businessId: BUSINESS,
    allowedLocationIds: [LOC_1, LOC_2],
    locationScope: { kind: 'all' },
    locations: [],
    profile: { id: 'user-1', email: 'owner@salon.test', fullName: 'Owner' },
    permissions: ['crm.view', 'crm.manage'],
    ...overrides,
  } as unknown as AuthUser;
}

const OWNER = authUser();
const MANAGER = authUser({
  id: 'user-2',
  roles: ['manager'],
  primaryRole: 'manager',
  allowedLocationIds: [LOC_1],
});
const STYLIST = authUser({ id: 'user-3', roles: ['stylist'], primaryRole: 'stylist' });

function clientRow(overrides: Row = {}): Row {
  return {
    id: CLIENT,
    business_id: BUSINESS,
    client_code: 'ABCD1234',
    primary_location_id: LOC_1,
    first_name: 'Jane',
    last_name: 'Smith',
    email: 'jane@example.test',
    phone: '+447700900000',
    marketing_opt_in: true,
    merged_into_id: null,
    ...overrides,
  };
}

const BUSINESS_ROW = { id: BUSINESS, timezone: 'Europe/London' };

/** N days before today, so status assertions do not depend on the wall clock. */
function daysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

function historyRow(dayOffsets: number[], overrides: Row = {}): Row {
  return {
    client_profile_id: CLIENT,
    // 0097 returns the client's display fields on the same row, so the list
    // needs no follow-up profile query (and no 1000-id `in.(...)` URL).
    client_code: 'ABCD1234',
    first_name: 'Jane',
    last_name: 'Smith',
    email: 'jane@example.test',
    phone: '+447700900000',
    marketing_opt_in: true,
    primary_location_id: LOC_1,
    visits: dayOffsets.map((offset) => {
      const at = daysAgo(offset);
      return {
        visitDate: at.slice(0, 10),
        visitAt: at,
        locationId: LOC_1,
        services: [
          { serviceId: 'svc-colour', serviceName: 'Full Head Colour', serviceCategoryId: 'cat-hair' },
        ],
      };
    }),
    service_rebooking_interval_days: null,
    ...overrides,
  };
}

const BASE_TABLES = {
  client_profiles: [clientRow()],
  businesses: [BUSINESS_ROW],
  retention_settings: [] as Row[],
  locations: [{ id: LOC_1, business_id: BUSINESS }, { id: LOC_2, business_id: BUSINESS }],
};

// ---------------------------------------------------------------------------
// Access control
// ---------------------------------------------------------------------------

describe('access control', () => {
  it('refuses a stylist the business-wide lapsed list', () => {
    // Intelligence must not widen staff access: this exposes every client's
    // cadence across the whole business at once.
    const { service } = build({ tables: BASE_TABLES });
    return expect(service.listLapsedClients(STYLIST, {})).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('refuses a stylist a single client lapse lookup', () => {
    const { service } = build({ tables: BASE_TABLES });
    return expect(service.getClientLapseStatus(STYLIST, CLIENT)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('refuses a client-role user', () => {
    const clientUser = authUser({ roles: ['client'], primaryRole: 'client', permissions: [] });
    const { service } = build({ tables: BASE_TABLES });
    return expect(service.listLapsedClients(clientUser, {})).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('refuses a manager a location outside their scope', () => {
    const { service } = build({ tables: BASE_TABLES });
    return expect(
      service.listLapsedClients(MANAGER, { locationId: LOC_2 }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('lets an owner scope to any location in their business', async () => {
    const { service, rpcCalls } = build({ tables: BASE_TABLES });
    await service.listLapsedClients(OWNER, { locationId: LOC_2 });

    expect(rpcCalls[0].args.p_location_ids).toEqual([LOC_2]);
  });

  it('refuses a manager the retention-settings write for another location', () => {
    const { service } = build({ tables: BASE_TABLES });
    return expect(
      service.upsertRetentionSettings(MANAGER, {
        locationId: LOC_2,
        lapsedBufferDays: 7,
        minCompletedVisits: 3,
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

// ---------------------------------------------------------------------------
// Tenancy
// ---------------------------------------------------------------------------

describe('tenancy', () => {
  it('scopes every evidence read to the actor business', async () => {
    const { service, rpcCalls } = build({ tables: BASE_TABLES, rpc: { client_service_history: [historyRow([120, 78, 36])] } });
    await service.listLapsedClients(OWNER, {});

    expect(rpcCalls.map((call) => call.name)).toEqual(['client_service_history', 'client_next_bookings']);
    for (const call of rpcCalls) expect(call.args.p_business_id).toBe(BUSINESS);
  });

  it('will not read another business client', async () => {
    const { service } = build({
      tables: { ...BASE_TABLES, client_profiles: [clientRow({ business_id: OTHER_BUSINESS })] },
    });
    await expect(service.getClientLapseStatus(OWNER, CLIENT)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('does not distinguish "another tenant\'s client" from "no such client"', async () => {
    // A 403 here would confirm the id exists somewhere on the platform.
    const { service } = build({ tables: { ...BASE_TABLES, client_profiles: [] } });
    await expect(service.getClientLapseStatus(OWNER, CLIENT)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('refuses a manager a client outside their locations', async () => {
    const { service } = build({
      tables: { ...BASE_TABLES, client_profiles: [clientRow({ primary_location_id: LOC_2 })] },
    });
    await expect(service.getClientLapseStatus(MANAGER, CLIENT)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('narrows a manager to their own locations without an explicit filter', async () => {
    const { service, rpcCalls } = build({ tables: BASE_TABLES });
    await service.listLapsedClients(MANAGER, {});

    expect(rpcCalls[0].args.p_location_ids).toEqual([LOC_1]);
  });

  it('leaves an owner unfiltered by location', async () => {
    const { service, rpcCalls } = build({ tables: BASE_TABLES });
    await service.listLapsedClients(OWNER, {});

    expect(rpcCalls[0].args.p_location_ids).toBeNull();
  });

  it('returns the empty shape for an actor with no locations at all', async () => {
    const scopeless = authUser({ roles: ['manager'], primaryRole: 'manager', allowedLocationIds: [] });
    const { service, rpcCalls } = build({ tables: BASE_TABLES });
    const result = await service.listLapsedClients(scopeless, {});

    expect(result.clients).toEqual([]);
    expect(result.pagination.total).toBe(0);
    // No query is issued with an empty IN list.
    expect(rpcCalls).toHaveLength(0);
  });

  it('never issues a second, id-listing client query for the list', async () => {
    // The client fields ride along on the history row. That is not just an
    // optimisation: sending 1000 ids back through a PostgREST `in.(...)` filter
    // would build a ~40KB URL. Tenancy and the 0087 tombstone filter are applied
    // once, in SQL, on the same read that produced the visits.
    const { service, captured } = build({
      tables: { ...BASE_TABLES, client_profiles: [] },
      rpc: { client_service_history: [historyRow([210, 168, 126])] },
    });
    const result = await service.listLapsedClients(OWNER, {});

    expect(result.clients).toHaveLength(1);
    expect(result.clients[0].displayName).toBe('Jane Smith');
    expect(captured).toEqual([]);
  });

  it('refuses a client lookup for a merged tombstone', async () => {
    const { service } = build({
      tables: { ...BASE_TABLES, client_profiles: [clientRow({ merged_into_id: 'client-9' })] },
    });
    await expect(service.getClientLapseStatus(OWNER, CLIENT)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

// ---------------------------------------------------------------------------
// Evidence loading
// ---------------------------------------------------------------------------

describe('evidence loading', () => {
  it('asks for history and upcoming bookings set-based, not per client', async () => {
    const many = Array.from({ length: 50 }, (_, i) => ({
      ...historyRow([120, 78, 36]),
      client_profile_id: `client-${i}`,
    }));

    const { service, rpcCalls } = build({
      tables: BASE_TABLES,
      rpc: { client_service_history: many },
    });
    const result = await service.listLapsedClients(OWNER, { pageSize: 10 });

    // 50 clients, still exactly two RPC calls and one profile query.
    expect(rpcCalls).toHaveLength(2);
    expect(result.evaluatedClientCount).toBe(50);
    expect(result.clients).toHaveLength(10);
  });

  it('passes the salon timezone and history window to the history query', async () => {
    const { service, rpcCalls } = build({ tables: BASE_TABLES });
    await service.listLapsedClients(OWNER, { lookbackDays: 90 });

    expect(rpcCalls[0].args.p_timezone).toBe('Europe/London');
    expect(rpcCalls[0].args.p_max_visits).toBe(10);
    const since = Date.parse(rpcCalls[0].args.p_since as string);
    expect(Math.round((Date.now() - since) / 86_400_000)).toBe(90);
  });

  it('applies no lookback window for a single client lookup', async () => {
    const { service, rpcCalls } = build({
      tables: BASE_TABLES,
      rpc: { client_service_history: [historyRow([120, 78, 36])] },
    });
    await service.getClientLapseStatus(OWNER, CLIENT);

    expect(rpcCalls[0].args.p_since).toBeNull();
    expect(rpcCalls[0].args.p_client_ids).toEqual([CLIENT]);
  });

  it('reports truncation instead of silently answering from a partial set', async () => {
    const { service, rpcCalls } = build({
      tables: BASE_TABLES,
      rpc: {
        client_service_history: (args) =>
          Array.from({ length: args.p_limit as number }, (_, i) => ({
            ...historyRow([120, 78, 36]),
            client_profile_id: `client-${(args.p_offset as number) + i}`,
          })),
      },
    });
    const result = await service.listLapsedClients(OWNER, {});

    expect(result.truncated).toBe(true);
    expect(result.evaluatedClientCount).toBe(5000);
    // Five full pages, then a single 1-row probe — a bounded loop, never
    // unbounded paging.
    const historyCalls = rpcCalls.filter((call) => call.name === 'client_service_history');
    expect(historyCalls).toHaveLength(6);
    expect(historyCalls[5].args).toMatchObject({ p_limit: 1, p_offset: 5000 });
  });

  it('does not claim truncation when the business has exactly the cap', async () => {
    const { service } = build({
      tables: BASE_TABLES,
      rpc: {
        client_service_history: (args) =>
          // Full pages up to the cap, then genuinely nothing left.
          (args.p_offset as number) >= 5000
            ? []
            : Array.from({ length: args.p_limit as number }, (_, i) => ({
                ...historyRow([120, 78, 36]),
                client_profile_id: `client-${(args.p_offset as number) + i}`,
              })),
      },
    });
    const result = await service.listLapsedClients(OWNER, {});

    expect(result.evaluatedClientCount).toBe(5000);
    expect(result.truncated).toBe(false);
  });

  it('reports truncation when the probe itself fails', async () => {
    // Unknown is not the same as complete: never claim completeness a failed
    // read could not establish.
    let calls = 0;
    const { service } = build({
      tables: BASE_TABLES,
      rpc: {
        client_service_history: (args) => {
          calls += 1;
          if (calls > 5) throw new Error('probe exploded');
          return Array.from({ length: args.p_limit as number }, (_, i) => ({
            ...historyRow([120, 78, 36]),
            client_profile_id: `client-${(args.p_offset as number) + i}`,
          }));
        },
      },
    });
    const result = await service.listLapsedClients(OWNER, {});
    expect(result.truncated).toBe(true);
  });

  it('fails the request when upcoming bookings cannot be read', async () => {
    // Deliberately NOT fail-open. Treating an error as "no booking" would mark
    // every already-rebooked client lapsed and feed them to a win-back campaign.
    const { service } = build({
      tables: BASE_TABLES,
      rpc: { client_service_history: [historyRow([120, 78, 36])] },
      rpcErrors: ['client_next_bookings'],
    });
    await expect(service.listLapsedClients(OWNER, {})).rejects.toThrow(
      'Unable to load upcoming appointments',
    );
  });

  it('fails the request when service history cannot be read', async () => {
    const { service } = build({ tables: BASE_TABLES, rpcErrors: ['client_service_history'] });
    await expect(service.listLapsedClients(OWNER, {})).rejects.toThrow(
      'Unable to load client service history',
    );
  });

  it('falls back to Europe/London when the business has no timezone', async () => {
    const { service, rpcCalls } = build({
      tables: { ...BASE_TABLES, businesses: [{ id: BUSINESS, timezone: null }] },
    });
    await service.listLapsedClients(OWNER, {});

    expect(rpcCalls[0].args.p_timezone).toBe('Europe/London');
  });
});

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

describe('lapse results', () => {
  it('leaves a client who is still on cadence active', async () => {
    // Visits 120 / 78 / 36 days ago -> 42-day cadence anchored on the most
    // recent visit, so the expected return is 6 days away: not yet due.
    const { service } = build({
      tables: BASE_TABLES,
      rpc: { client_service_history: [historyRow([120, 78, 36])] },
    });
    const result = await service.listLapsedClients(OWNER, {});

    expect(result.clients).toHaveLength(1);
    expect(result.clients[0].usualIntervalDays).toBe(42);
    expect(result.clients[0].status).toBe('active');
    expect(result.counts).toMatchObject({ active: 1, lapsed: 0 });
  });

  it('classifies a long-absent client as lapsed and carries campaign fields', async () => {
    const { service } = build({
      tables: BASE_TABLES,
      rpc: { client_service_history: [historyRow([210, 168, 126])] },
    });
    const result = await service.listLapsedClients(OWNER, {});
    const [client] = result.clients;

    // Cadence 42, anchored 126 days ago -> expected return 84 days ago.
    expect(client.status).toBe('lapsed');
    expect(client.overdueDays).toBe(84);
    expect(client.hasFutureBooking).toBe(false);
    // Everything a retention campaign needs without recomputing cadence.
    expect(client).toMatchObject({
      clientId: CLIENT,
      clientCode: 'ABCD1234',
      displayName: 'Jane Smith',
      marketingOptIn: true,
      representativeServiceName: 'Full Head Colour',
      serviceCategoryId: 'cat-hair',
    });
  });

  it('reports insufficient_history rather than guessing for a one-visit client', async () => {
    const { service } = build({
      tables: BASE_TABLES,
      rpc: { client_service_history: [historyRow([300])] },
    });
    const result = await service.getClientLapseStatus(OWNER, CLIENT);

    expect(result.intelligence.status).toBe('insufficient_history');
    expect(result.intelligence.usualIntervalDays).toBeNull();
  });

  it('reports insufficient_history for a client with no completed visits at all', async () => {
    const { service } = build({ tables: BASE_TABLES, rpc: { client_service_history: [] } });
    const result = await service.getClientLapseStatus(OWNER, CLIENT);

    expect(result.intelligence.status).toBe('insufficient_history');
    expect(result.intelligence.evidence.insufficientReason).toBe('no_completed_visits');
    expect(result.intelligence.clientId).toBe(CLIENT);
  });

  it('reads the per-service rebooking interval as the fallback', async () => {
    const { service } = build({
      tables: BASE_TABLES,
      // Postgres returns integers through PostgREST as strings in some shapes.
      rpc: { client_service_history: [historyRow([100], { service_rebooking_interval_days: '35' })] },
    });
    const result = await service.getClientLapseStatus(OWNER, CLIENT);

    expect(result.intelligence.usualIntervalDays).toBe(35);
    expect(result.intelligence.evidence.intervalBasis).toBe('service_rebooking_interval');
    expect(result.intelligence.status).toBe('lapsed');
  });

  it('filters by status and still counts the whole scope', async () => {
    const { service } = build({
      tables: BASE_TABLES,
      rpc: {
        client_service_history: [
          historyRow([210, 168, 126]), // lapsed
          { ...historyRow([84, 42, 0]), client_profile_id: 'client-2', first_name: 'Amy' }, // active
        ],
      },
    });
    const result = await service.listLapsedClients(OWNER, { status: ['lapsed'] });

    expect(result.clients.map((client) => client.clientId)).toEqual([CLIENT]);
    expect(result.counts).toMatchObject({ lapsed: 1, active: 1 });
    expect(result.pagination.total).toBe(1);
    expect(result.evaluatedClientCount).toBe(2);
  });

  it('orders the most actionable clients first', async () => {
    const { service } = build({
      tables: BASE_TABLES,
      rpc: {
        client_service_history: [
          { ...historyRow([84, 42, 0]), client_profile_id: 'client-2', first_name: 'Amy' }, // active
          historyRow([210, 168, 126]), // lapsed, 84 days overdue
          { ...historyRow([400, 358, 316]), client_profile_id: 'client-3', first_name: 'Zoe' }, // lapsed, more overdue
        ],
      },
    });
    const result = await service.listLapsedClients(OWNER, {});

    expect(result.clients.map((client) => client.clientId)).toEqual([
      'client-3',
      CLIENT,
      'client-2',
    ]);
  });

  it('filters by representative service', async () => {
    const { service } = build({
      tables: BASE_TABLES,
      rpc: { client_service_history: [historyRow([210, 168, 126])] },
    });

    const matching = await service.listLapsedClients(OWNER, { serviceId: 'svc-colour' });
    const other = await service.listLapsedClients(OWNER, { serviceId: 'svc-nails' });

    expect(matching.clients).toHaveLength(1);
    expect(other.clients).toHaveLength(0);
  });

  it('paginates without an unrestricted all-client dump', async () => {
    const history = Array.from({ length: 30 }, (_, i) => ({
      ...historyRow([210, 168, 126]),
      client_profile_id: `client-${i}`,
      first_name: `Client${String(i).padStart(2, '0')}`,
    }));
    const { service } = build({ tables: BASE_TABLES, rpc: { client_service_history: history } });

    const first = await service.listLapsedClients(OWNER, { pageSize: 10, page: 1 });
    const third = await service.listLapsedClients(OWNER, { pageSize: 10, page: 3 });

    expect(first.clients).toHaveLength(10);
    expect(first.pagination).toEqual({ page: 1, pageSize: 10, total: 30, totalPages: 3 });
    expect(third.clients).toHaveLength(10);
    expect(new Set([...first.clients, ...third.clients].map((c) => c.clientId)).size).toBe(20);
  });
});

// ---------------------------------------------------------------------------
// Recomputation — the Wrike acceptance point
// ---------------------------------------------------------------------------

describe('recomputation', () => {
  const LAPSED_HISTORY = [historyRow([210, 168, 126])];

  it('flips lapsed -> booked when a future appointment appears', async () => {
    const lapsed = build({ tables: BASE_TABLES, rpc: { client_service_history: LAPSED_HISTORY } });
    const before = await lapsed.service.getClientLapseStatus(OWNER, CLIENT);
    expect(before.intelligence.status).toBe('lapsed');

    const booked = build({
      tables: BASE_TABLES,
      rpc: {
        client_service_history: LAPSED_HISTORY,
        client_next_bookings: [
          {
            client_profile_id: CLIENT,
            appointment_id: 'appt-1',
            scheduled_start_at: new Date(Date.now() + 86_400_000).toISOString(),
            location_id: LOC_1,
          },
        ],
      },
    });
    const after = await booked.service.getClientLapseStatus(OWNER, CLIENT);

    expect(after.intelligence.status).toBe('booked');
    expect(after.intelligence.hasFutureBooking).toBe(true);
    expect(after.intelligence.evidence.statusIgnoringFutureBooking).toBe('lapsed');
  });

  it('flips booked -> lapsed when the future appointment is cancelled', async () => {
    // A cancelled appointment is excluded by the SQL predicate, so it simply
    // stops appearing — and the client lapses again on the very next read.
    const cancelled = build({
      tables: BASE_TABLES,
      rpc: { client_service_history: LAPSED_HISTORY, client_next_bookings: [] },
    });
    const result = await cancelled.service.getClientLapseStatus(OWNER, CLIENT);

    expect(result.intelligence.status).toBe('lapsed');
    expect(result.intelligence.nextBookedAppointmentAt).toBeNull();
  });

  it('recomputes the cadence when a new visit completes', async () => {
    const afterVisit = build({
      tables: BASE_TABLES,
      rpc: { client_service_history: [historyRow([210, 168, 126, 0])] },
    });
    const result = await afterVisit.service.getClientLapseStatus(OWNER, CLIENT);

    expect(result.intelligence.status).toBe('active');
    expect(result.intelligence.overdueDays).toBe(0);
    expect(result.intelligence.evidence.intervalDaysSamples).toEqual([42, 42, 126]);
    expect(result.intelligence.usualIntervalDays).toBe(42);
  });

  it('stores nothing — the status is derived on every read', async () => {
    const { service, captured } = build({
      tables: BASE_TABLES,
      rpc: { client_service_history: LAPSED_HISTORY },
    });
    await service.listLapsedClients(OWNER, {});
    await service.getClientLapseStatus(OWNER, CLIENT);

    expect(captured).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

describe('retention settings', () => {
  it('reports the platform defaults when nothing is configured', async () => {
    const { service } = build({ tables: BASE_TABLES });
    const result = await service.getRetentionSettings(OWNER);

    expect(result.scopes).toEqual([
      { locationId: null, lapsedBufferDays: 14, minCompletedVisits: 3, configured: false },
    ]);
    expect(result.defaults).toEqual({
      lapsedBufferDays: 14,
      minCompletedVisits: 3,
      historyVisitLimit: 10,
    });
  });

  it('applies the configured business buffer to the calculation', async () => {
    const { service } = build({
      tables: {
        ...BASE_TABLES,
        retention_settings: [
          { id: 'rs-1', business_id: BUSINESS, location_id: null, lapsed_buffer_days: 90, min_completed_visits: 3 },
        ],
      },
      rpc: { client_service_history: [historyRow([210, 168, 126])] },
    });
    const result = await service.listLapsedClients(OWNER, {});

    // 84 days overdue, but the buffer is now 90 — at risk rather than lapsed.
    expect(result.settings.lapsedBufferDays).toBe(90);
    expect(result.clients[0].status).toBe('at_risk');
    expect(result.clients[0].lapsedBufferDays).toBe(90);
  });

  it('applies a location override when the scope is that single location', async () => {
    const { service } = build({
      tables: {
        ...BASE_TABLES,
        retention_settings: [
          { id: 'rs-1', business_id: BUSINESS, location_id: null, lapsed_buffer_days: 90, min_completed_visits: 3 },
          { id: 'rs-2', business_id: BUSINESS, location_id: LOC_1, lapsed_buffer_days: 0, min_completed_visits: 3 },
        ],
      },
      rpc: { client_service_history: [historyRow([210, 168, 126])] },
    });
    const result = await service.listLapsedClients(OWNER, { locationId: LOC_1 });

    // A stored 0 is an intentional "no grace period", not missing config.
    expect(result.settings.lapsedBufferDays).toBe(0);
    expect(result.clients[0].status).toBe('lapsed');
  });

  it('honours a configured minimum visit count', async () => {
    const { service } = build({
      tables: {
        ...BASE_TABLES,
        retention_settings: [
          { id: 'rs-1', business_id: BUSINESS, location_id: null, lapsed_buffer_days: 14, min_completed_visits: 2 },
        ],
      },
      rpc: { client_service_history: [historyRow([84, 42])] },
    });
    const result = await service.getClientLapseStatus(OWNER, CLIENT);

    expect(result.settings.minCompletedVisits).toBe(2);
    expect(result.intelligence.usualIntervalDays).toBe(42);
  });

  it('parses numeric settings that arrive as strings', async () => {
    const { service } = build({
      tables: {
        ...BASE_TABLES,
        retention_settings: [
          { id: 'rs-1', business_id: BUSINESS, location_id: null, lapsed_buffer_days: '21', min_completed_visits: '3' },
        ],
      },
    });
    const result = await service.getRetentionSettings(OWNER);

    expect(result.scopes[0]).toMatchObject({ lapsedBufferDays: 21, configured: true });
  });

  it('writes the business-wide default with a null location', async () => {
    const { service, captured } = build({ tables: BASE_TABLES });
    await service.upsertRetentionSettings(OWNER, { lapsedBufferDays: 0, minCompletedVisits: 4 });

    expect(captured).toEqual([
      {
        table: 'retention_settings',
        verb: 'upsert',
        payload: {
          business_id: BUSINESS,
          location_id: null,
          lapsed_buffer_days: 0,
          min_completed_visits: 4,
        },
      },
    ]);
  });

  it('rejects a location that belongs to another business', async () => {
    const { service } = build({ tables: { ...BASE_TABLES, locations: [] } });
    await expect(
      service.upsertRetentionSettings(OWNER, {
        locationId: LOC_1,
        lapsedBufferDays: 7,
        minCompletedVisits: 3,
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rejects an out-of-range buffer', async () => {
    const { service } = build({ tables: BASE_TABLES });
    await expect(
      service.upsertRetentionSettings(OWNER, { lapsedBufferDays: 400, minCompletedVisits: 3 }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a minimum visit count below one measurable interval', async () => {
    const { service } = build({ tables: BASE_TABLES });
    await expect(
      service.upsertRetentionSettings(OWNER, { lapsedBufferDays: 7, minCompletedVisits: 1 }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses the write to a stylist', async () => {
    const { service } = build({ tables: BASE_TABLES });
    await expect(
      service.upsertRetentionSettings(STYLIST, { lapsedBufferDays: 7, minCompletedVisits: 3 }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
