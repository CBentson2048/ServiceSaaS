/**
 * ReportScopeService — location scope, timezone and week-start resolution.
 *
 * The Supabase fake records every query so each test can assert what reached
 * the database: the right tenant filter, no query at all for a refused filter,
 * no write of any kind, and `core.businesses` never read (there is no shared
 * business date).
 */
import { HttpException, InternalServerErrorException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { createClient } from '@supabase/supabase-js';
import {
  getReportDefinition,
  type MembershipGrant,
  type ReportDefinition,
} from '@sheer/domain';
import type { ReportActor } from './report-actor';
import { ReportScopeService } from './report-scope.service';
import type { ReportResultQueryDto } from './dto';

jest.mock('@supabase/supabase-js', () => ({ createClient: jest.fn() }));
const mockedCreateClient = createClient as jest.MockedFunction<typeof createClient>;

const BIZ = 'biz-1';
const LONDON = '11111111-1111-4111-8111-111111111111';
const TOKYO = '22222222-2222-4222-8222-222222222222';
const NEW_YORK = '33333333-3333-4333-8333-333333333333';
const CLOSED = '44444444-4444-4444-8444-444444444444';
const BROKEN = '55555555-5555-4555-8555-555555555555';
const FOREIGN = '99999999-9999-4999-8999-999999999999';

const LOCATION_ROWS = [
  { id: LONDON, name: 'London', timezone: 'Europe/London', is_active: true },
  { id: TOKYO, name: 'Tokyo', timezone: 'Asia/Tokyo', is_active: true },
  { id: NEW_YORK, name: 'New York', timezone: 'America/New_York', is_active: true },
  { id: CLOSED, name: 'Old Street', timezone: 'Europe/London', is_active: false },
];

type Result = { data: unknown; error: unknown };

interface RecordedQuery {
  schema: string;
  table: string;
  ops: Array<[string, unknown[]]>;
}

function fakeSupabase(results: { locations?: Result; payroll_settings?: Result }) {
  const queries: RecordedQuery[] = [];
  const writes: unknown[][] = [];
  const client = {
    schema: (schema: string) => ({
      from: (table: string) => {
        const query: RecordedQuery = { schema, table, ops: [] };
        queries.push(query);
        const result = (): Result =>
          (results as Record<string, Result | undefined>)[table] ?? { data: null, error: null };
        const builder: Record<string, unknown> = {};
        for (const op of ['select', 'eq', 'order', 'in', 'gte', 'lt', 'limit']) {
          builder[op] = (...args: unknown[]) => {
            query.ops.push([op, args]);
            return builder;
          };
        }
        for (const op of ['insert', 'update', 'upsert', 'delete']) {
          builder[op] = (...args: unknown[]) => {
            writes.push([op, table, ...args]);
            return builder;
          };
        }
        builder.returns = () => Promise.resolve(result());
        builder.maybeSingle = () => Promise.resolve(result());
        return builder;
      },
    }),
    rpc: (...args: unknown[]) => {
      writes.push(['rpc', ...args]);
      return Promise.resolve({ data: null, error: null });
    },
  };
  return { client, queries, writes };
}

const config = { getOrThrow: (key: string) => `placeholder-${key}` } as unknown as ConfigService;

function serviceWith(results: { locations?: Result; payroll_settings?: Result }) {
  const fake = fakeSupabase(results);
  mockedCreateClient.mockReturnValue(fake.client as unknown as ReturnType<typeof createClient>);
  return { service: new ReportScopeService(config), ...fake };
}

const ok = (data: unknown): Result => ({ data, error: null });
const money = getReportDefinition('money') as ReportDefinition;
const team = getReportDefinition('team') as ReportDefinition;

const owner: ReportActor = { id: 'u-owner', businessId: BIZ, roles: ['owner'] };
const grant = (locationId: string): MembershipGrant => ({
  locationId,
  permissions: ['report.financials.view', 'report.performance.view', 'report.lab_analytics.view'],
});
const managerAPlusStylistB: ReportActor = {
  id: 'u-1',
  businessId: BIZ,
  roles: ['manager', 'stylist'],
  membershipGrants: [grant(LONDON)],
};
const noGrants: ReportActor = { id: 'u-2', businessId: BIZ, roles: ['manager'], membershipGrants: [] };

const ASOF = new Date('2026-09-13T15:30:00Z');

async function failure(promise: Promise<unknown>): Promise<{ status: number; body: unknown }> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof HttpException) return { status: error.getStatus(), body: error.getResponse() };
    throw error;
  }
  throw new Error('expected a refusal');
}

const q = (query: ReportResultQueryDto) => query;

describe('location scope', () => {
  it('[] resolves to every permitted location for an owner, inactive included, in business order', async () => {
    const { service } = serviceWith({ locations: ok(LOCATION_ROWS) });
    const scope = await service.resolve(owner, money, q({}), ASOF);
    expect(scope.resolved.locations.map((l) => [l.id, l.isActive])).toEqual([
      [LONDON, true],
      [TOKYO, true],
      [NEW_YORK, true],
      [CLOSED, false],
    ]);
  });

  it('manager@A + stylist@B: [] is A only, and naming B is refused', async () => {
    const { service } = serviceWith({ locations: ok(LOCATION_ROWS) });
    const scope = await service.resolve(managerAPlusStylistB, money, q({}), ASOF);
    expect(scope.resolved.locations.map((l) => l.id)).toEqual([LONDON]);
    expect(await failure(service.resolve(managerAPlusStylistB, money, q({ locations: TOKYO }), ASOF))).toMatchObject({
      status: 403,
      body: { code: 'report_location_out_of_scope' },
    });
  });

  it('carries the whole grant apart from the selection — and nothing that says whether other locations exist', async () => {
    const { service } = serviceWith({ locations: ok(LOCATION_ROWS) });
    const ownerLondon = await service.resolve(owner, team, q({ locations: LONDON }), ASOF);
    expect([ownerLondon.windows.map((w) => w.locationId), ownerLondon.permittedLocationIds]).toEqual([[LONDON], [LONDON, TOKYO, NEW_YORK, CLOSED]]);
    const managerA = await service.resolve(managerAPlusStylistB, team, q({}), ASOF);
    expect(managerA.permittedLocationIds).toEqual([LONDON]);
    // manager@A's scope is the same whether the business has one location or four.
    const alone = serviceWith({ locations: ok([LOCATION_ROWS[0]]) });
    const { asOf: _a, ...withOthers } = managerA;
    const { asOf: _b, ...withoutOthers } = await alone.service.resolve(managerAPlusStylistB, team, q({}), ASOF);
    expect(withoutOthers).toEqual(withOthers);
  });

  it('refuses the whole request when one of several ids is out of scope', async () => {
    const { service } = serviceWith({ locations: ok(LOCATION_ROWS) });
    expect(
      await failure(service.resolve(managerAPlusStylistB, money, q({ locations: `${LONDON},${TOKYO}` }), ASOF)),
    ).toMatchObject({ status: 403, body: { code: 'report_location_out_of_scope' } });
  });

  it('gives identical refusals for a foreign id, an unknown id and a permitted-elsewhere id', async () => {
    const { service } = serviceWith({ locations: ok(LOCATION_ROWS) });
    const bodies = await Promise.all(
      [FOREIGN, '66666666-6666-4666-8666-666666666666', TOKYO].map((id) =>
        failure(service.resolve(managerAPlusStylistB, money, q({ locations: id }), ASOF)),
      ),
    );
    expect(bodies[1]).toEqual(bodies[0]);
    expect(bodies[2]).toEqual(bodies[0]);
    expect(JSON.stringify(bodies[0])).not.toContain(FOREIGN);
  });

  it('refuses an actor with no permitted location — on options too', async () => {
    const { service } = serviceWith({ locations: ok(LOCATION_ROWS), payroll_settings: ok({ week_start_day: 2 }) });
    const expected = { status: 403, body: { code: 'report_no_locations_in_scope' } };
    expect(await failure(service.resolve(noGrants, money, q({}), ASOF))).toMatchObject(expected);
    expect(await failure(service.options(noGrants, money))).toMatchObject(expected);
  });

  it('a grant whose permission does not match the report yields no locations', async () => {
    const { service } = serviceWith({ locations: ok(LOCATION_ROWS) });
    const labOnly: ReportActor = {
      id: 'u-3',
      businessId: BIZ,
      roles: ['manager'],
      membershipGrants: [{ locationId: LONDON, permissions: ['report.lab_analytics.view'] }],
    };
    expect(await failure(service.resolve(labOnly, money, q({}), ASOF))).toMatchObject({
      status: 403,
      body: { code: 'report_no_locations_in_scope' },
    });
  });

  it('never exposes merged permissions or allowedLocationIds on the scope actor', async () => {
    const { service } = serviceWith({ locations: ok(LOCATION_ROWS) });
    const scope = await service.resolve(managerAPlusStylistB, money, q({}), ASOF);
    expect(Object.keys(scope.actor).sort()).toEqual(['businessId', 'id', 'membershipGrants', 'roles']);
  });
});

describe('the Team staff control (R2)', () => {
  it('passes staff ids through without reading staff, and never widens the locations', async () => {
    const { service, queries } = serviceWith({ locations: ok(LOCATION_ROWS) });
    const staffId = '70000000-0000-4000-8000-000000000001';
    const scope = await service.resolve(owner, team, q({ staff: staffId, locations: LONDON }), ASOF);
    expect(scope.resolved.filter.staffProfileIds).toEqual([staffId]);
    expect(scope.resolved.locations.map((location) => location.id)).toEqual([LONDON]);
    // Resolving the scope reads locations only: staff are the Team body's business.
    expect(queries.map((query) => query.table)).toEqual(['locations']);
  });
});

describe('refused filters never reach the database', () => {
  it.each([
    ['staff on a report without a staff control', q({ staff: LONDON }), money, 'report_control_not_supported'],
    ['detail on a report without detail', q({ view: 'detail' }), team, 'report_control_not_supported'],
    ['an ISO instant as a date', q({ preset: 'custom', from: '2026-07-01T00:00:00Z', to: '2026-07-02' }), money, 'report_filter_invalid'],
    ['dates on a non-custom preset', q({ preset: 'today', from: '2026-09-01' }), money, 'report_filter_invalid'],
    ['a non-uuid location id', q({ locations: 'london' }), money, 'report_filter_invalid'],
    ['51 location ids', q({ locations: Array.from({ length: 51 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`).join(',') }), money, 'report_filter_invalid'],
    ['a 367-day range', q({ preset: 'custom', from: '2025-09-13', to: '2026-09-14' }), money, 'report_filter_invalid'],
  ] as const)('%s → 400', async (_label, query, definition, code) => {
    const { service, queries } = serviceWith({ locations: ok(LOCATION_ROWS) });
    const outcome = await failure(service.resolve(owner, definition, query, ASOF));
    expect(outcome).toMatchObject({ status: 400, body: { code } });
    expect((outcome.body as { issues?: unknown[] }).issues?.length).toBeGreaterThan(0);
    expect(queries).toEqual([]);
  });
});

describe('per-location time resolution', () => {
  it('resolves London, Tokyo and New York independently from one instant', async () => {
    const { service } = serviceWith({ locations: ok(LOCATION_ROWS.slice(0, 3)) });
    const scope = await service.resolve(owner, money, q({ preset: 'today' }), ASOF);
    expect(scope.resolved.locations.map((l) => [l.name, l.localToday, l.from, l.to, l.status])).toEqual([
      ['London', '2026-09-13', '2026-09-13', '2026-09-13', 'in_progress'],
      ['Tokyo', '2026-09-14', '2026-09-14', '2026-09-14', 'in_progress'],
      ['New York', '2026-09-13', '2026-09-13', '2026-09-13', 'in_progress'],
    ]);
    expect(scope.windows.map((w) => [w.locationId, w.fromUtc, w.toUtcExclusive])).toEqual([
      [LONDON, '2026-09-12T23:00:00.000Z', '2026-09-13T23:00:00.000Z'],
      [TOKYO, '2026-09-13T15:00:00.000Z', '2026-09-14T15:00:00.000Z'],
      [NEW_YORK, '2026-09-13T04:00:00.000Z', '2026-09-14T04:00:00.000Z'],
    ]);
    expect(scope.windows.map((w) => w.locationId)).toEqual(scope.resolved.locations.map((l) => l.id));
    expect(scope.asOf).toBe(ASOF);
  });

  it('never reads core.businesses: there is no shared business date', async () => {
    const { service, queries } = serviceWith({ locations: ok(LOCATION_ROWS), payroll_settings: ok({ week_start_day: 2 }) });
    await service.resolve(owner, money, q({ preset: 'this_week' }), ASOF);
    await service.options(owner, money);
    expect(queries.map((query) => `${query.schema}.${query.table}`).sort()).toEqual([
      'core.locations',
      'core.locations',
      'payroll.payroll_settings',
      'payroll.payroll_settings',
    ]);
  });

  it('accepts a custom range in the future and marks it not started', async () => {
    const { service } = serviceWith({ locations: ok(LOCATION_ROWS.slice(0, 1)) });
    const scope = await service.resolve(owner, money, q({ preset: 'custom', from: '2026-09-15', to: '2026-09-20' }), ASOF);
    expect(scope.resolved.locations[0]).toMatchObject({ from: '2026-09-15', to: '2026-09-20', status: 'not_started' });
    expect(scope.resolved.filter).toMatchObject({ preset: 'custom', from: '2026-09-15', to: '2026-09-20' });
  });

  it('refuses a selection containing a location with an invalid timezone, naming only that location', async () => {
    const rows = [...LOCATION_ROWS, { id: BROKEN, name: 'Broken', timezone: 'Europe/Londn', is_active: true }];
    const { service, queries } = serviceWith({ locations: ok(rows) });
    const outcome = await failure(service.resolve(owner, money, q({ locations: `${LONDON},${BROKEN}` }), ASOF));
    expect(outcome).toEqual({
      status: 422,
      body: expect.objectContaining({ code: 'report_timezone_invalid', locationIds: [BROKEN] }),
    });
    expect(queries.map((query) => query.table)).toEqual(['locations']);
  });

  it('refuses "all locations" when any permitted location has an invalid timezone', async () => {
    const rows = [...LOCATION_ROWS, { id: BROKEN, name: 'Broken', timezone: '', is_active: true }];
    const { service } = serviceWith({ locations: ok(rows) });
    expect(await failure(service.resolve(owner, money, q({}), ASOF))).toMatchObject({
      status: 422,
      body: { code: 'report_timezone_invalid', locationIds: [BROKEN] },
    });
  });

  it('checks timezones on the selection only: a broken location that is not selected blocks nothing', async () => {
    const rows = [...LOCATION_ROWS, { id: BROKEN, name: 'Broken', timezone: 'Europe/Londn', is_active: true }];
    const { service } = serviceWith({ locations: ok(rows) });
    const scope = await service.resolve(owner, money, q({ locations: LONDON }), ASOF);
    expect(scope.resolved.locations.map((l) => l.id)).toEqual([LONDON]);
  });

  it('refuses an out-of-scope id before checking timezones (403, not 422)', async () => {
    const rows = [...LOCATION_ROWS, { id: BROKEN, name: 'Broken', timezone: 'Europe/Londn', is_active: true }];
    const { service } = serviceWith({ locations: ok(rows) });
    const managerWithBroken: ReportActor = { ...managerAPlusStylistB, membershipGrants: [grant(LONDON), grant(BROKEN)] };
    expect(await failure(service.resolve(managerWithBroken, money, q({ locations: `${BROKEN},${FOREIGN}` }), ASOF))).toMatchObject({
      status: 403,
      body: { code: 'report_location_out_of_scope' },
    });
  });

  it('reports an invalid timezone before a missing week start, without reading the week start', async () => {
    const { service, queries } = serviceWith({
      locations: ok([{ id: BROKEN, name: 'Broken', timezone: 'Europe/Londn', is_active: true }]),
      payroll_settings: ok(null),
    });
    expect(await failure(service.resolve(owner, money, q({ preset: 'this_week' }), ASOF))).toMatchObject({
      status: 422,
      body: { code: 'report_timezone_invalid' },
    });
    expect(queries.map((query) => query.table)).toEqual(['locations']);
  });

  it('refuses an actor with no permitted locations as such, even when they name a location', async () => {
    const { service } = serviceWith({ locations: ok(LOCATION_ROWS) });
    expect(await failure(service.resolve(noGrants, money, q({ locations: LONDON }), ASOF))).toMatchObject({
      status: 403,
      body: { code: 'report_no_locations_in_scope' },
    });
  });

  it('does not name an invalid-timezone location the actor may not see', async () => {
    const rows = [...LOCATION_ROWS, { id: BROKEN, name: 'Broken', timezone: 'nope', is_active: true }];
    const { service } = serviceWith({ locations: ok(rows) });
    const scope = await service.resolve(managerAPlusStylistB, money, q({}), ASOF);
    expect(scope.resolved.locations.map((l) => l.id)).toEqual([LONDON]);
  });

  it('options list an invalid-timezone location as not reportable instead of failing', async () => {
    const rows = [...LOCATION_ROWS.slice(0, 1), { id: BROKEN, name: 'Broken', timezone: 'Europe/Londn', is_active: true }];
    const { service } = serviceWith({ locations: ok(rows), payroll_settings: ok({ week_start_day: 2 }) });
    const options = await service.options(owner, money);
    expect(options.locations.map((l) => [l.id, l.timezoneValid])).toEqual([
      [LONDON, true],
      [BROKEN, false],
    ]);
  });
});

describe('week start', () => {
  it('week presets read payroll_settings with a SELECT and never write', async () => {
    const { service, queries, writes } = serviceWith({ locations: ok(LOCATION_ROWS.slice(0, 1)), payroll_settings: ok({ week_start_day: 2 }) });
    const scope = await service.resolve(owner, money, q({ preset: 'last_week' }), ASOF);
    expect(scope.resolved.weekStartDay).toBe(2);
    expect(scope.resolved.locations[0]).toMatchObject({ from: '2026-09-01', to: '2026-09-07', status: 'complete' });
    const settings = queries.find((query) => query.table === 'payroll_settings');
    expect(settings?.ops).toEqual([
      ['select', ['week_start_day']],
      ['eq', ['business_id', BIZ]],
    ]);
    expect(writes).toEqual([]);
  });

  it.each([
    ['no settings row', null],
    ['a null value', { week_start_day: null }],
    ['an out-of-range value', { week_start_day: 7 }],
    ['a non-integer value', { week_start_day: 2.5 }],
  ])('refuses a week preset when the business has %s — never assumes Monday', async (_label, data) => {
    const { service } = serviceWith({ locations: ok(LOCATION_ROWS.slice(0, 1)), payroll_settings: ok(data) });
    expect(await failure(service.resolve(owner, money, q({ preset: 'this_week' }), ASOF))).toMatchObject({
      status: 409,
      body: { code: 'report_week_start_unconfigured' },
    });
  });

  it('never reads the week start for other presets, even when it is missing', async () => {
    for (const preset of ['today', 'yesterday', 'this_month', 'last_month'] as const) {
      const { service, queries } = serviceWith({ locations: ok(LOCATION_ROWS.slice(0, 1)), payroll_settings: ok(null) });
      const scope = await service.resolve(owner, money, q({ preset }), ASOF);
      expect(scope.resolved.weekStartDay).toBeNull();
      expect(queries.some((query) => query.table === 'payroll_settings')).toBe(false);
    }
  });

  it('options report a missing week start as null rather than failing', async () => {
    const { service } = serviceWith({ locations: ok(LOCATION_ROWS.slice(0, 1)), payroll_settings: ok(null) });
    expect((await service.options(owner, money)).weekStartDay).toBeNull();
  });

  it('treats a database error as a failure, never as a missing week start', async () => {
    const { service } = serviceWith({ locations: ok(LOCATION_ROWS.slice(0, 1)), payroll_settings: { data: null, error: { message: 'down' } } });
    await expect(service.resolve(owner, money, q({ preset: 'this_week' }), ASOF)).rejects.toBeInstanceOf(InternalServerErrorException);
    await expect(service.options(owner, money)).rejects.toBeInstanceOf(InternalServerErrorException);
  });
});

describe('query hygiene and payload shape', () => {
  it('filters locations by the actor’s business and orders them as the business does', async () => {
    const { service, queries } = serviceWith({ locations: ok(LOCATION_ROWS) });
    await service.resolve(owner, money, q({}), ASOF);
    expect(queries[0]).toEqual({
      schema: 'core',
      table: 'locations',
      ops: [
        ['select', ['id,name,timezone,is_active']],
        ['eq', ['business_id', BIZ]],
        ['order', ['sort_order', { ascending: true }]],
        ['order', ['name', { ascending: true }]],
      ],
    });
  });

  it('treats a locations read failure as a 500, never as "no locations"', async () => {
    const { service } = serviceWith({ locations: { data: null, error: { message: 'down' } } });
    await expect(service.resolve(owner, money, q({}), ASOF)).rejects.toBeInstanceOf(InternalServerErrorException);
  });

  it('options and the resolved filter carry local dates and zone names only — no time of day', async () => {
    const { service } = serviceWith({ locations: ok(LOCATION_ROWS), payroll_settings: ok({ week_start_day: 2 }) });
    const scope = await service.resolve(owner, money, q({ preset: 'this_week', view: 'detail' }), ASOF);
    const options = await service.options(owner, money);
    for (const payload of [scope.resolved, options]) {
      const json = JSON.stringify(payload);
      expect(json).not.toMatch(/T\d{2}:\d{2}/);
      expect(json).not.toMatch(/\b\d{2}:\d{2}\b/);
    }
    expect(scope.resolved.filter.view).toBe('detail');
  });
});
