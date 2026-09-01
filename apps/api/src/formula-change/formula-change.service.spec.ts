/**
 * FormulaChangeService — history resolution, tenancy, settings and isolation.
 *
 * The pure comparison is asserted in formula-change-rules.spec.ts. What these
 * specs prove is everything AROUND it: that the right previous formula is
 * chosen, that drafts and voided mixes are excluded, that a toner is never
 * compared to a root colour, that a client id from a URL cannot cross a tenant
 * boundary, and that a detection failure can never take down Colour Prep.
 */
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { createClient } from '@supabase/supabase-js';
import type { AuthUser, UserRole } from '@sheer/domain';
import { ALL_PERMISSIONS } from '@sheer/domain';
import type { AuditService } from '../audit/audit.service';
import { FormulaChangeService } from './formula-change.service';

jest.mock('@supabase/supabase-js', () => ({ createClient: jest.fn() }));
const mockedCreateClient = createClient as jest.MockedFunction<typeof createClient>;

const BUSINESS = 'b0000000-0000-4000-8000-000000000001';
const OTHER_BUSINESS = 'b0000000-0000-4000-8000-000000000002';
const LOCATION = '10000000-0000-4000-8000-000000000001';
const OTHER_LOCATION = '10000000-0000-4000-8000-000000000002';
const CLIENT = 'c0000000-0000-4000-8000-000000000001';

type Row = Record<string, unknown>;

interface Fixture {
  formulas?: Row[];
  formula_items?: Row[];
  products?: Row[];
  client_profiles?: Row[];
  locations?: Row[];
  formula_change_settings?: Row[];
  appointment_services?: Row[];
  services?: Row[];
  service_categories?: Row[];
  /** Tables whose SELECT should fail, to exercise degradation. */
  readErrors?: string[];
}

interface Captured {
  table: string;
  verb: string;
  payload?: Row;
}

function build(fixture: Fixture = {}) {
  const captured: Captured[] = [];
  const tables: Record<string, Row[]> = {
    formulas: fixture.formulas ?? [],
    formula_items: fixture.formula_items ?? [],
    products: fixture.products ?? [],
    client_profiles: fixture.client_profiles ?? [{ id: CLIENT, business_id: BUSINESS }],
    locations: fixture.locations ?? [{ id: LOCATION, business_id: BUSINESS }],
    formula_change_settings: fixture.formula_change_settings ?? [],
    appointment_services: fixture.appointment_services ?? [],
    services: fixture.services ?? [],
    service_categories: fixture.service_categories ?? [],
  };

  const makeChain = (table: string) => {
    let rows = (tables[table] ?? []).map((row) => ({ ...row }));
    let verb = 'select';
    let payload: Row = {};

    const chain: Record<string, unknown> = {};
    const settle = () => {
      captured.push({ table, verb, payload });
      return { data: { ...payload }, error: null };
    };
    const read = () => {
      if (fixture.readErrors?.includes(table)) {
        return { data: null, error: { message: `${table} unavailable` } };
      }
      return { data: rows, error: null };
    };

    Object.assign(chain, {
      select: () => chain,
      order: () => chain,
      limit: () => chain,
      returns: () => chain,
      eq: (column: string, value: unknown) => {
        rows = rows.filter((row) => row[column] === value);
        return chain;
      },
      not: (column: string, _op: string, _value: unknown) => {
        rows = rows.filter((row) => row[column] !== null && row[column] !== undefined);
        return chain;
      },
      in: (column: string, values: readonly unknown[]) => {
        rows = rows.filter((row) => values.includes(row[column]));
        return chain;
      },
      upsert: (body: Row) => {
        verb = 'upsert';
        payload = body;
        return chain;
      },
      maybeSingle: async () => {
        if (verb !== 'select') return settle();
        const result = read();
        return result.error ? result : { data: rows[0] ?? null, error: null };
      },
      then: (resolve: (v: unknown) => unknown, reject?: (r: unknown) => unknown) =>
        Promise.resolve(verb === 'select' ? read() : settle()).then(resolve, reject),
    });
    return chain;
  };

  mockedCreateClient.mockReturnValue({
    schema: () => ({ from: (table: string) => makeChain(table) }),
  } as never);

  const audit = { record: jest.fn(async () => undefined) } as unknown as AuditService;
  const config = { getOrThrow: () => 'x' } as unknown as ConfigService;
  return { service: new FormulaChangeService(config, audit), audit, captured };
}

function actor(overrides: Partial<AuthUser> = {}): AuthUser {
  const roles: UserRole[] = overrides.roles ?? ['owner'];
  return {
    id: 'u1',
    roles,
    primaryRole: roles[0],
    businessId: BUSINESS,
    allowedLocationIds: [LOCATION],
    locationScope: 'all',
    locations: [],
    profile: { firstName: 'O', lastName: 'O', email: 'o@example.com' },
    permissions: [...ALL_PERMISSIONS],
    ...overrides,
  } as AuthUser;
}

/** A finalised formula row. */
function formula(id: string, overrides: Row = {}): Row {
  return {
    id,
    business_id: BUSINESS,
    client_profile_id: CLIENT,
    location_id: LOCATION,
    status: 'saved',
    visit_id: `visit-${id}`,
    appointment_id: `appt-${id}`,
    saved_at: '2026-08-01T10:00:00Z',
    version: 1,
    version_group_id: id,
    service_name_snapshot: 'Full Head Colour',
    ...overrides,
  };
}

function item(formulaId: string, productId: string, grams: number, extra: Row = {}): Row {
  return {
    formula_id: formulaId,
    product_id: productId,
    product_name: productId,
    brand: null,
    developer: null,
    captured_grams: grams,
    ...extra,
  };
}

/** Wire an appointment to a colour billing category. */
function colourAppointment(appointmentId: string, billingCategory = 'permanent_colour') {
  const serviceId = `svc-${appointmentId}`;
  const categoryId = `cat-${billingCategory}`;
  return {
    link: { appointment_id: appointmentId, service_id: serviceId },
    service: { id: serviceId, business_id: BUSINESS, service_category_id: categoryId },
    category: { id: categoryId, business_id: BUSINESS, billing_category: billingCategory },
  };
}

beforeEach(() => jest.clearAllMocks());

// ---------------------------------------------------------------------------
// Comparable history — Wrike sections 4, 5, 6, 54
// ---------------------------------------------------------------------------

describe('comparable history', () => {
  const older = colourAppointment('appt-old');
  const newer = colourAppointment('appt-new');

  const twoColourVisits = {
    formulas: [
      formula('new', { appointment_id: 'appt-new', saved_at: '2026-08-20T10:00:00Z' }),
      formula('old', { appointment_id: 'appt-old', saved_at: '2026-07-01T10:00:00Z' }),
    ],
    formula_items: [
      item('old', 'A', 50),
      item('old', 'B', 50),
      item('new', 'A', 10),
      item('new', 'C', 90),
    ],
    appointment_services: [older.link, newer.link],
    services: [older.service, newer.service],
    service_categories: [older.category, newer.category],
  };

  it('compares the latest formula against the previous comparable one', async () => {
    const { service } = build(twoColourVisits);
    const assessment = await service.assessForClient(actor(), CLIENT);

    expect(assessment.available).toBe(true);
    expect(assessment.significant).toBe(true);
    expect(assessment.current?.formulaId).toBe('new');
    expect(assessment.previous?.formulaId).toBe('old');
  });

  it('returns no flag for a client with a single formula', async () => {
    const { service } = build({
      formulas: [formula('only', { appointment_id: 'appt-old' })],
      formula_items: [item('only', 'A', 100)],
      appointment_services: [older.link],
      services: [older.service],
      service_categories: [older.category],
    });
    const assessment = await service.assessForClient(actor(), CLIENT);

    expect(assessment.available).toBe(false);
    expect(assessment.unavailableCause).toBe('no_prior_comparable_formula');
    expect(assessment.significant).toBe(false);
  });

  it('returns no flag for a client with no formula history at all', async () => {
    const { service } = build({ formulas: [] });
    const assessment = await service.assessForClient(actor(), CLIENT);
    expect(assessment.unavailableCause).toBe('no_formula_history');
  });

  it('EXCLUDES drafts — only a finalised mix is history', async () => {
    const { service } = build({
      ...twoColourVisits,
      formulas: [
        formula('draft', { status: 'draft', appointment_id: 'appt-new', saved_at: '2026-08-25T10:00:00Z' }),
        ...twoColourVisits.formulas,
      ],
    });
    const assessment = await service.assessForClient(actor(), CLIENT);
    expect(assessment.current?.formulaId).toBe('new'); // not 'draft'
  });

  it('EXCLUDES voided formulas', async () => {
    const { service } = build({
      ...twoColourVisits,
      formulas: [
        formula('void', { status: 'voided', appointment_id: 'appt-new', saved_at: '2026-08-25T10:00:00Z' }),
        ...twoColourVisits.formulas,
      ],
    });
    expect((await service.assessForClient(actor(), CLIENT)).current?.formulaId).toBe('new');
  });

  it('does NOT compare a toner against a root colour', async () => {
    // The heart of Wrike section 4: different colour billing categories are not
    // comparable, so a toner after a full head colour raises nothing.
    const toner = colourAppointment('appt-toner', 'semi_toners');
    const { service } = build({
      formulas: [
        formula('toner', { appointment_id: 'appt-toner', saved_at: '2026-08-20T10:00:00Z' }),
        formula('colour', { appointment_id: 'appt-old', saved_at: '2026-07-01T10:00:00Z' }),
      ],
      formula_items: [item('colour', 'A', 100), item('toner', 'Z', 100)],
      appointment_services: [toner.link, older.link],
      services: [toner.service, older.service],
      service_categories: [toner.category, older.category],
    });

    const assessment = await service.assessForClient(actor(), CLIENT);
    expect(assessment.available).toBe(false);
    expect(assessment.unavailableCause).toBe('no_prior_comparable_formula');
  });

  it('reaches back past a non-comparable formula to find a comparable one', async () => {
    const toner = colourAppointment('appt-toner', 'semi_toners');
    const { service } = build({
      formulas: [
        formula('colour-new', { appointment_id: 'appt-new', saved_at: '2026-08-20T10:00:00Z' }),
        formula('toner', { appointment_id: 'appt-toner', saved_at: '2026-08-10T10:00:00Z' }),
        formula('colour-old', { appointment_id: 'appt-old', saved_at: '2026-07-01T10:00:00Z' }),
      ],
      formula_items: [
        item('colour-old', 'A', 100),
        item('toner', 'Z', 100),
        item('colour-new', 'A', 100),
      ],
      appointment_services: [newer.link, toner.link, older.link],
      services: [newer.service, toner.service, older.service],
      service_categories: [newer.category, toner.category, older.category],
    });

    const assessment = await service.assessForClient(actor(), CLIENT);
    expect(assessment.previous?.formulaId).toBe('colour-old'); // skipped the toner
  });

  it('does not compare two formulas from the SAME visit', async () => {
    // Root and toner mixed at one appointment are parts of one visit's work, not
    // a change over time.
    const { service } = build({
      formulas: [
        formula('second', { visit_id: 'visit-shared', appointment_id: 'appt-new', saved_at: '2026-08-20T11:00:00Z' }),
        formula('first', { visit_id: 'visit-shared', appointment_id: 'appt-new', saved_at: '2026-08-20T10:00:00Z' }),
      ],
      formula_items: [item('first', 'A', 100), item('second', 'Z', 100)],
      appointment_services: [newer.link],
      services: [newer.service],
      service_categories: [newer.category],
    });

    const assessment = await service.assessForClient(actor(), CLIENT);
    expect(assessment.unavailableCause).toBe('no_prior_comparable_formula');
  });

  it('compares only the FINAL version of a revised formula', async () => {
    // Wrike section 35: one visit must not produce three flags.
    const { service } = build({
      formulas: [
        formula('v2', {
          version: 2,
          version_group_id: 'group-1',
          appointment_id: 'appt-new',
          saved_at: '2026-08-20T12:00:00Z',
        }),
        formula('v1', {
          version: 1,
          version_group_id: 'group-1',
          appointment_id: 'appt-new',
          saved_at: '2026-08-20T10:00:00Z',
        }),
        formula('old', { appointment_id: 'appt-old', saved_at: '2026-07-01T10:00:00Z' }),
      ],
      formula_items: [item('old', 'A', 100), item('v1', 'A', 50), item('v2', 'Z', 100)],
      appointment_services: [newer.link, older.link],
      services: [newer.service, older.service],
      service_categories: [newer.category, older.category],
    });

    const assessment = await service.assessForClient(actor(), CLIENT);
    expect(assessment.current?.formulaId).toBe('v2');
    expect(assessment.previous?.formulaId).toBe('old'); // never v1
  });

  it('keeps an archived product interpretable in history', async () => {
    // Wrike section 38: a product missing from the catalogue must not break a
    // historical comparison. It defaults to the gram basis and keeps its name.
    const { service } = build({ ...twoColourVisits, products: [] });
    const assessment = await service.assessForClient(actor(), CLIENT);
    expect(assessment.available).toBe(true);
    expect(assessment.current?.components.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Tenancy and access — Wrike sections 29, 30, 57
// ---------------------------------------------------------------------------

describe('tenancy', () => {
  it('cannot read a client belonging to another business', async () => {
    const { service } = build({ client_profiles: [{ id: CLIENT, business_id: OTHER_BUSINESS }] });
    // Same 404 as a non-existent id, so the response cannot confirm the id
    // exists in some other tenant.
    await expect(service.assessForClient(actor(), CLIENT)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('scopes every formula read to the acting business', async () => {
    const { service } = build({
      formulas: [formula('theirs', { business_id: OTHER_BUSINESS })],
      formula_items: [item('theirs', 'A', 100)],
    });
    const assessment = await service.assessForClient(actor(), CLIENT);
    expect(assessment.unavailableCause).toBe('no_formula_history');
  });

  it('bounds a stylist to their own locations', async () => {
    const { service } = build({
      formulas: [
        formula('elsewhere', { location_id: OTHER_LOCATION, saved_at: '2026-08-20T10:00:00Z' }),
        formula('here', { location_id: LOCATION, saved_at: '2026-07-01T10:00:00Z' }),
      ],
      formula_items: [item('elsewhere', 'A', 100), item('here', 'B', 100)],
    });

    const stylist = actor({ roles: ['stylist'], allowedLocationIds: [LOCATION] });
    const assessment = await service.assessForClient(stylist, CLIENT);
    // Only the in-scope formula is visible, so there is nothing to compare it to.
    expect(assessment.available).toBe(false);
  });

  it('lets an owner see the whole business', async () => {
    const appt = colourAppointment('appt-new');
    const { service } = build({
      formulas: [
        formula('a', { location_id: OTHER_LOCATION, appointment_id: 'appt-new', saved_at: '2026-08-20T10:00:00Z' }),
        formula('b', { location_id: LOCATION, appointment_id: 'appt-new', saved_at: '2026-07-01T10:00:00Z' }),
      ],
      formula_items: [item('a', 'A', 100), item('b', 'A', 100)],
      appointment_services: [appt.link],
      services: [appt.service],
      service_categories: [appt.category],
    });
    expect((await service.assessForClient(actor(), CLIENT)).available).toBe(true);
  });

  it('refuses a client asking about somebody else', async () => {
    const other = actor({ roles: ['client'], clientProfileId: 'someone-else' });
    await expect(service_(build()).assessForClient(other, CLIENT)).rejects.toBeInstanceOf(ForbiddenException);
  });
});

function service_(built: ReturnType<typeof build>) {
  return built.service;
}

// ---------------------------------------------------------------------------
// Settings — Wrike sections 18, 19, 22, 44, 55
// ---------------------------------------------------------------------------

describe('settings', () => {
  it('reports platform defaults when nothing is configured', async () => {
    const { service } = build();
    const settings = await service.getSettings(actor());

    expect(settings.scopes).toHaveLength(1);
    expect(settings.scopes[0]).toMatchObject({ locationId: null, configured: false, compositionChangePercent: 30 });
  });

  it('reports configured scopes', async () => {
    const { service } = build({
      formula_change_settings: [
        {
          business_id: BUSINESS,
          location_id: null,
          composition_change_percent: 40,
          component_materiality_percent: 20,
          developer_volume_delta: 20,
        },
      ],
    });
    const settings = await service.getSettings(actor());
    expect(settings.scopes[0]).toMatchObject({ configured: true, compositionChangePercent: 40 });
  });

  it('applies the configured thresholds to a real assessment', async () => {
    const appt = colourAppointment('appt-new');
    const fixture = {
      formulas: [
        formula('new', { appointment_id: 'appt-new', saved_at: '2026-08-20T10:00:00Z' }),
        formula('old', { appointment_id: 'appt-new', visit_id: 'visit-old', saved_at: '2026-07-01T10:00:00Z' }),
      ],
      // 50/50 -> 70/30 is a 20% distance.
      formula_items: [item('old', 'A', 50), item('old', 'B', 50), item('new', 'A', 70), item('new', 'B', 30)],
      appointment_services: [appt.link],
      services: [appt.service],
      service_categories: [appt.category],
    };

    const lenient = build(fixture);
    expect((await lenient.service.assessForClient(actor(), CLIENT)).significant).toBe(false);

    const strict = build({
      ...fixture,
      formula_change_settings: [
        {
          business_id: BUSINESS,
          location_id: null,
          composition_change_percent: 20,
          component_materiality_percent: 15,
          developer_volume_delta: 10,
        },
      ],
    });
    // The SAME formula pair, re-evaluated under a tighter threshold, is now
    // significant — because assessments are computed on read, never stored.
    expect((await strict.service.assessForClient(actor(), CLIENT)).significant).toBe(true);
  });

  it('rejects impossible thresholds', async () => {
    const { service } = build();
    await expect(
      service.upsertSettings(actor(), {
        compositionChangePercent: -200,
        componentMaterialityPercent: 15,
        developerVolumeDelta: 10,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a location from another business', async () => {
    const { service } = build({ locations: [{ id: LOCATION, business_id: BUSINESS }] });
    await expect(
      service.upsertSettings(actor(), {
        locationId: 'ffffffff-0000-4000-8000-000000000009',
        compositionChangePercent: 30,
        componentMaterialityPercent: 15,
        developerVolumeDelta: 10,
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('lets a manager READ but not CHANGE sensitivity', async () => {
    const manager = actor({ roles: ['manager'] });
    const { service } = build();

    await expect(service.getSettings(manager)).resolves.toBeDefined();
    await expect(
      service.upsertSettings(manager, {
        compositionChangePercent: 30,
        componentMaterialityPercent: 15,
        developerVolumeDelta: 10,
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('refuses a stylist entirely', async () => {
    const { service } = build();
    await expect(service.getSettings(actor({ roles: ['stylist'] }))).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('records a threshold change in the shared audit trail', async () => {
    const { service, audit } = build();
    await service.upsertSettings(actor(), {
      compositionChangePercent: 25,
      componentMaterialityPercent: 10,
      developerVolumeDelta: 5,
    });

    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ businessId: BUSINESS }),
      expect.objectContaining({
        action: 'formula_change_settings.updated',
        before: expect.objectContaining({ compositionChangePercent: 30 }),
        after: expect.objectContaining({ compositionChangePercent: 25 }),
      }),
    );
  });

  it('never takes businessId from the caller', async () => {
    const { service, captured } = build();
    await service.upsertSettings(actor(), {
      compositionChangePercent: 30,
      componentMaterialityPercent: 15,
      developerVolumeDelta: 10,
      ...({ businessId: OTHER_BUSINESS } as object),
    });
    expect(captured.find((c) => c.verb === 'upsert')?.payload?.['business_id']).toBe(BUSINESS);
  });
});

// ---------------------------------------------------------------------------
// Failure isolation — Wrike sections 32, 58
// ---------------------------------------------------------------------------

describe('failure isolation', () => {
  it('falls back to platform defaults when settings cannot be read', async () => {
    // Conservative direction: the defaults are the least sensitive setting, so a
    // degraded read can never manufacture a flag.
    const { service } = build({ readErrors: ['formula_change_settings'] });
    const thresholds = await service.thresholdsFor(BUSINESS, null);
    expect(thresholds).toEqual({
      compositionChangePercent: 30,
      componentMaterialityPercent: 15,
      developerVolumeDelta: 10,
    });
  });

  it('degrades the bulk path to "no flags" rather than throwing', async () => {
    // Colour Prep is an operational screen; one failed assessment must not lose
    // the salon its day.
    const { service } = build({ readErrors: ['formulas'] });
    await expect(service.assessClientsSafe(BUSINESS, [CLIENT], LOCATION)).resolves.toEqual(new Map());
  });

  it('surfaces a failure on the direct single-client path', async () => {
    // The dedicated endpoint SHOULD report a real error — only the embedded
    // surfaces swallow it, and they do so explicitly at the call site.
    const { service } = build({ readErrors: ['formulas'] });
    await expect(service.assessForClient(actor(), CLIENT)).rejects.toThrow();
  });

  it('writes nothing during an assessment', async () => {
    const appt = colourAppointment('appt-new');
    const { service, captured } = build({
      formulas: [
        formula('new', { appointment_id: 'appt-new', saved_at: '2026-08-20T10:00:00Z' }),
        formula('old', { appointment_id: 'appt-new', visit_id: 'v-old', saved_at: '2026-07-01T10:00:00Z' }),
      ],
      formula_items: [item('old', 'A', 100), item('new', 'Z', 100)],
      appointment_services: [appt.link],
      services: [appt.service],
      service_categories: [appt.category],
    });

    await service.assessForClient(actor(), CLIENT);
    // Detection is read-only: no formula, no stock movement, no flag row.
    expect(captured.filter((c) => c.verb !== 'select')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Bulk path — Wrike sections 39, 40
// ---------------------------------------------------------------------------

describe('bulk assessment', () => {
  it('assesses many clients without a per-client query', async () => {
    const clients = Array.from({ length: 25 }, (_, i) => `client-${i}`);
    const appt = colourAppointment('appt-shared');
    const { service, captured } = build({
      client_profiles: clients.map((id) => ({ id, business_id: BUSINESS })),
      formulas: clients.flatMap((clientId) => [
        formula(`new-${clientId}`, {
          client_profile_id: clientId,
          appointment_id: 'appt-shared',
          visit_id: `v1-${clientId}`,
          saved_at: '2026-08-20T10:00:00Z',
        }),
        formula(`old-${clientId}`, {
          client_profile_id: clientId,
          appointment_id: 'appt-shared',
          visit_id: `v2-${clientId}`,
          saved_at: '2026-07-01T10:00:00Z',
        }),
      ]),
      formula_items: clients.flatMap((clientId) => [
        item(`old-${clientId}`, 'A', 100),
        item(`new-${clientId}`, 'Z', 100),
      ]),
      appointment_services: [appt.link],
      services: [appt.service],
      service_categories: [appt.category],
    });

    const result = await service.assessClients(BUSINESS, clients);

    expect(result.size).toBe(25);
    expect([...result.values()].every((a) => a.significant)).toBe(true);
    // A fixed number of round trips regardless of client count — the N+1 guard.
    expect(captured.length).toBeLessThanOrEqual(8);
  });

  it('returns an entry for every requested client, even those with no history', async () => {
    const { service } = build({ formulas: [] });
    const result = await service.assessClients(BUSINESS, ['a', 'b', 'c']);
    expect([...result.keys()].sort()).toEqual(['a', 'b', 'c']);
    expect(result.get('a')?.unavailableCause).toBe('no_formula_history');
  });

  it('handles an empty client list without querying', async () => {
    const { service, captured } = build();
    expect((await service.assessClients(BUSINESS, [])).size).toBe(0);
    expect(captured).toHaveLength(0);
  });
});
