/**
 * Colour Prep — the Week 6 acceptance surface.
 *
 * The Supabase client is stubbed with a schema+table keyed chain, the pattern
 * the rest of this codebase uses: the assertions are about the prep rules the
 * service applies to the rows it reads, and about which filters it sends, not
 * about the network. Stock arithmetic, the shortfall states, the "no formula on
 * file" case and tenancy are all exercised here.
 */
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { createClient } from '@supabase/supabase-js';
import type { AuthUser, FormulaChangeAssessment } from '@sheer/domain';
import type { FormulaChangeService } from '../formula-change/formula-change.service';
import { ColourPrepService } from './colour-prep.service';

jest.mock('@supabase/supabase-js', () => ({ createClient: jest.fn() }));
const mockedCreateClient = createClient as jest.MockedFunction<typeof createClient>;

interface CapturedCall {
  key: string;
  method: string;
  args: unknown[];
}

function createMockAdmin(rowsByKey: Record<string, unknown[]>) {
  const captured: CapturedCall[] = [];

  const makeChain = (key: string) => {
    const rows = () => rowsByKey[key] ?? [];
    const chain: Record<string, unknown> = {};
    for (const method of ['select', 'eq', 'in', 'gte', 'lt', 'order', 'not', 'neq', 'returns']) {
      chain[method] = (...args: unknown[]) => {
        captured.push({ key, method, args });
        return chain;
      };
    }
    chain.maybeSingle = async () => ({ data: rows()[0] ?? null, error: null });
    chain.then = (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
      Promise.resolve({ data: rows(), error: null }).then(resolve, reject);
    return chain;
  };

  const root = {
    schema: (schema: string) => ({ from: (table: string) => makeChain(`${schema}.${table}`) }),
  };
  return { root, captured };
}

const OWNER: AuthUser = {
  id: 'user-1',
  roles: ['owner'],
  primaryRole: 'owner',
  businessId: 'biz-1',
  allowedLocationIds: ['loc-1'],
  locationScope: { kind: 'all' },
  locations: [],
  profile: { id: 'user-1', email: 'owner@salon.test', fullName: 'Owner' },
  permissions: ['inventory.manage'],
} as unknown as AuthUser;

const MANAGER_OTHER_LOCATION: AuthUser = {
  ...OWNER,
  id: 'user-2',
  roles: ['manager'],
  primaryRole: 'manager',
  allowedLocationIds: ['loc-9'],
  locationScope: { kind: 'locations', locationIds: ['loc-9'] },
} as unknown as AuthUser;

const NO_PERMISSION: AuthUser = { ...OWNER, id: 'user-3', permissions: [] } as unknown as AuthUser;

/** Wednesday 19 August 2026, London. */
const NOW = new Date('2026-08-19T09:00:00.000Z');

function baseRows(overrides: Record<string, unknown[]> = {}): Record<string, unknown[]> {
  return {
    'core.locations': [
      { id: 'loc-1', name: 'Islington', timezone: 'Europe/London', business_id: 'biz-1' },
    ],
    'core.location_settings': [{ location_id: 'loc-1', waste_allowance_percent: 10 }],
    'booking.appointments': [
      {
        id: 'appt-1',
        client_profile_id: 'client-1',
        assigned_staff_profile_id: 'staff-1',
        scheduled_start_at: '2026-08-19T10:00:00.000Z',
        status: 'accepted',
      },
    ],
    'booking.appointment_services': [
      { appointment_id: 'appt-1', service_id: 'svc-1', service_name_snapshot: 'Full head colour' },
    ],
    'booking.services': [{ id: 'svc-1', service_category_id: 'cat-1' }],
    'booking.service_categories': [{ id: 'cat-1', billing_category: 'permanent_colour' }],
    'core.client_profiles': [{ id: 'client-1', first_name: 'Ada', last_name: 'Lovelace' }],
    'core.staff_profiles': [{ id: 'staff-1', display_name: 'Sam Stylist' }],
    'lab.formulas': [
      { id: 'formula-1', client_profile_id: 'client-1', saved_at: '2026-07-01T10:00:00.000Z', status: 'saved' },
    ],
    'lab.formula_items': [
      { formula_id: 'formula-1', product_id: 'prod-1', product_name: 'Colour 6.0', captured_grams: 100 },
    ],
    'inventory.products': [
      {
        id: 'prod-1',
        name: 'Colour 6.0',
        brand: 'Wella',
        stock_unit: 'gram',
        pack_size: 100,
        size_value: 100,
        low_stock_threshold_grams: 50,
        is_active: true,
      },
    ],
    'inventory.location_stock': [
      { product_id: 'prod-1', quantity_on_hand_grams: 500, low_stock_threshold_grams: 50 },
    ],
    ...overrides,
  };
}

function buildService(rows: Record<string, unknown[]>) {
  const { root, captured } = createMockAdmin(rows);
  mockedCreateClient.mockReturnValue(root as never);
  const config = { getOrThrow: (key: string) => `test-${key}` } as unknown as ConfigService;
  return { service: new ColourPrepService(config, formulaChangeStub()), captured };
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers().setSystemTime(NOW);
});

afterEach(() => {
  jest.useRealTimers();
});

/**
 * Detection is asserted in its own suites; here it is stubbed so Colour Prep's
 * own behaviour is what these tests measure. `assessClientsSafe` never throws in
 * production either, which is exactly the contract this stub reproduces.
 */
function formulaChangeStub(overrides: Map<string, FormulaChangeAssessment> = new Map()) {
  return {
    assessClientsSafe: jest.fn(async () => overrides),
  } as unknown as FormulaChangeService;
}

describe('permissions and tenancy', () => {
  it('refuses a caller without inventory.manage', async () => {
    const { service } = buildService(baseRows());
    await expect(service.getPlan(NO_PERMISSION, { locationId: 'loc-1' })).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('refuses a location outside the caller scope', async () => {
    const { service } = buildService(baseRows());
    await expect(
      service.getPlan(MANAGER_OTHER_LOCATION, { locationId: 'loc-1' }),
    ).rejects.toThrow(ForbiddenException);
  });

  it('rejects a location id that is not in the caller business', async () => {
    const { service } = buildService(baseRows({ 'core.locations': [] }));
    await expect(service.getPlan(OWNER, { locationId: 'loc-1' })).rejects.toThrow(NotFoundException);
  });

  it('scopes every tenant-owned read to the caller business and location', async () => {
    const { service, captured } = buildService(baseRows());
    await service.getPlan(OWNER, { locationId: 'loc-1' });

    const eqArgs = (key: string) =>
      captured.filter((call) => call.key === key && call.method === 'eq').map((call) => call.args);

    expect(eqArgs('core.locations')).toEqual(
      expect.arrayContaining([['id', 'loc-1'], ['business_id', 'biz-1']]),
    );
    expect(eqArgs('booking.appointments')).toEqual(
      expect.arrayContaining([['business_id', 'biz-1'], ['location_id', 'loc-1']]),
    );
    expect(eqArgs('lab.formulas')).toEqual(expect.arrayContaining([['business_id', 'biz-1']]));
    expect(eqArgs('inventory.location_stock')).toEqual(
      expect.arrayContaining([['location_id', 'loc-1']]),
    );
  });

  it('hides the stylist name from a caller who is neither owner nor manager', async () => {
    const stylist = {
      ...OWNER,
      roles: ['stylist'],
      primaryRole: 'stylist',
    } as unknown as AuthUser;
    const { service } = buildService(baseRows());
    const plan = await service.getPlan(stylist, { locationId: 'loc-1' });
    expect(plan.appointments[0].stylistName).toBeUndefined();
  });
});

describe('window selection', () => {
  it('sends the salon-local day boundaries for today', async () => {
    const { service, captured } = buildService(baseRows());
    const plan = await service.getPlan(OWNER, { locationId: 'loc-1', range: 'today' });

    // London is on BST, so the salon day starts at 23:00 UTC the day before.
    expect(plan.from).toBe('2026-08-18T23:00:00.000Z');
    expect(plan.to).toBe('2026-08-19T23:00:00.000Z');
    expect(plan.timezone).toBe('Europe/London');

    const gte = captured.find((c) => c.key === 'booking.appointments' && c.method === 'gte');
    const lt = captured.find((c) => c.key === 'booking.appointments' && c.method === 'lt');
    expect(gte?.args).toEqual(['scheduled_start_at', '2026-08-18T23:00:00.000Z']);
    expect(lt?.args).toEqual(['scheduled_start_at', '2026-08-19T23:00:00.000Z']);
  });

  it('defaults to today when no range is supplied', async () => {
    const { service } = buildService(baseRows());
    const plan = await service.getPlan(OWNER, { locationId: 'loc-1' });
    expect(plan.range).toBe('today');
    expect(plan.fromDate).toBe('2026-08-19');
  });

  it('covers Monday to Sunday for this week', async () => {
    const { service } = buildService(baseRows());
    const plan = await service.getPlan(OWNER, { locationId: 'loc-1', range: 'this_week' });
    expect(plan.fromDate).toBe('2026-08-17');
    expect(plan.toDate).toBe('2026-08-23');
  });

  it('covers the following Monday to Sunday for next week', async () => {
    const { service } = buildService(baseRows());
    const plan = await service.getPlan(OWNER, { locationId: 'loc-1', range: 'next_week' });
    expect(plan.fromDate).toBe('2026-08-24');
    expect(plan.toDate).toBe('2026-08-30');
  });

  it('honours an explicit custom range', async () => {
    const { service } = buildService(baseRows());
    const plan = await service.getPlan(OWNER, {
      locationId: 'loc-1',
      range: 'custom',
      from: '2026-09-01',
      to: '2026-09-03',
    });
    expect(plan.fromDate).toBe('2026-09-01');
    expect(plan.toDate).toBe('2026-09-03');
  });

  it('asks only for appointments still worth preparing', async () => {
    const { service, captured } = buildService(baseRows());
    await service.getPlan(OWNER, { locationId: 'loc-1' });
    const statusFilter = captured.find(
      (call) => call.key === 'booking.appointments' && call.method === 'in' && call.args[0] === 'status',
    );
    expect(statusFilter?.args[1]).toEqual(['pending', 'accepted', 'checked_in']);
  });
});

describe('colour identification', () => {
  it('includes an appointment whose service category is mapped to colour', async () => {
    const { service } = buildService(baseRows());
    const plan = await service.getPlan(OWNER, { locationId: 'loc-1' });
    expect(plan.appointments).toHaveLength(1);
    expect(plan.appointments[0].billingCategories).toEqual(['permanent_colour']);
    expect(plan.appointments[0].serviceNames).toEqual(['Full head colour']);
  });

  it('excludes an appointment whose category carries no colour mapping', async () => {
    const { service } = buildService(baseRows({ 'booking.service_categories': [] }));
    const plan = await service.getPlan(OWNER, { locationId: 'loc-1' });
    expect(plan.appointments).toHaveLength(0);
    expect(plan.products).toHaveLength(0);
    expect(plan.summary.appointmentCount).toBe(0);
  });

  it('returns an empty plan when nothing is booked', async () => {
    const { service } = buildService(baseRows({ 'booking.appointments': [] }));
    const plan = await service.getPlan(OWNER, { locationId: 'loc-1' });
    expect(plan.appointments).toEqual([]);
    expect(plan.products).toEqual([]);
    expect(plan.locationName).toBe('Islington');
  });
});

describe('requirement calculation', () => {
  it('applies the location waste allowance to required grams', async () => {
    const { service } = buildService(baseRows());
    const plan = await service.getPlan(OWNER, { locationId: 'loc-1' });
    // 100g captured + 10% allowance
    expect(plan.wasteAllowancePercent).toBe(10);
    expect(plan.products[0].requiredGrams).toBe(110);
  });

  it('defaults the waste allowance to 10 when the location has no settings row', async () => {
    const { service } = buildService(baseRows({ 'core.location_settings': [] }));
    const plan = await service.getPlan(OWNER, { locationId: 'loc-1' });
    expect(plan.wasteAllowancePercent).toBe(10);
  });

  it('sums a product across several appointments', async () => {
    const rows = baseRows({
      'booking.appointments': [
        {
          id: 'appt-1',
          client_profile_id: 'client-1',
          assigned_staff_profile_id: null,
          scheduled_start_at: '2026-08-19T10:00:00.000Z',
          status: 'accepted',
        },
        {
          id: 'appt-2',
          client_profile_id: 'client-2',
          assigned_staff_profile_id: null,
          scheduled_start_at: '2026-08-19T14:00:00.000Z',
          status: 'pending',
        },
      ],
      'booking.appointment_services': [
        { appointment_id: 'appt-1', service_id: 'svc-1', service_name_snapshot: 'Full head colour' },
        { appointment_id: 'appt-2', service_id: 'svc-1', service_name_snapshot: 'Root touch up' },
      ],
      'core.client_profiles': [
        { id: 'client-1', first_name: 'Ada', last_name: 'Lovelace' },
        { id: 'client-2', first_name: 'Grace', last_name: 'Hopper' },
      ],
      'lab.formulas': [
        { id: 'formula-1', client_profile_id: 'client-1', saved_at: '2026-07-01T10:00:00.000Z', status: 'saved' },
        { id: 'formula-2', client_profile_id: 'client-2', saved_at: '2026-07-05T10:00:00.000Z', status: 'saved' },
      ],
      'lab.formula_items': [
        { formula_id: 'formula-1', product_id: 'prod-1', product_name: 'Colour 6.0', captured_grams: 100 },
        { formula_id: 'formula-2', product_id: 'prod-1', product_name: 'Colour 6.0', captured_grams: 50 },
      ],
    });
    const { service } = buildService(rows);
    const plan = await service.getPlan(OWNER, { locationId: 'loc-1' });

    expect(plan.appointments).toHaveLength(2);
    expect(plan.products).toHaveLength(1);
    expect(plan.products[0].requiredGrams).toBe(165); // (100 + 50) * 1.1
    expect(plan.products[0].appointmentCount).toBe(2);
  });

  it('keeps several products in one formula separate', async () => {
    const rows = baseRows({
      'lab.formula_items': [
        { formula_id: 'formula-1', product_id: 'prod-1', product_name: 'Colour 6.0', captured_grams: 60 },
        { formula_id: 'formula-1', product_id: 'prod-2', product_name: 'Developer 20vol', captured_grams: 120 },
      ],
      'inventory.products': [
        { id: 'prod-1', name: 'Colour 6.0', brand: 'Wella', stock_unit: 'gram', pack_size: 100, size_value: 100, low_stock_threshold_grams: 0, is_active: true },
        { id: 'prod-2', name: 'Developer 20vol', brand: 'Wella', stock_unit: 'millilitre', pack_size: 1000, size_value: 1000, low_stock_threshold_grams: 0, is_active: true },
      ],
      'inventory.location_stock': [
        { product_id: 'prod-1', quantity_on_hand_grams: 500, low_stock_threshold_grams: 0 },
        { product_id: 'prod-2', quantity_on_hand_grams: 500, low_stock_threshold_grams: 0 },
      ],
    });
    const { service } = buildService(rows);
    const plan = await service.getPlan(OWNER, { locationId: 'loc-1' });

    expect(plan.products).toHaveLength(2);
    const developer = plan.products.find((p) => p.productId === 'prod-2');
    expect(developer?.requiredGrams).toBe(132);
    expect(developer?.stockUnit).toBe('millilitre');
    expect(plan.appointments[0].items).toHaveLength(2);
  });

  it('ignores formula lines with no captured quantity', async () => {
    const { service } = buildService(
      baseRows({
        'lab.formula_items': [
          { formula_id: 'formula-1', product_id: 'prod-1', product_name: 'Colour 6.0', captured_grams: 0 },
        ],
      }),
    );
    const plan = await service.getPlan(OWNER, { locationId: 'loc-1' });
    expect(plan.products).toHaveLength(0);
    expect(plan.appointments[0].state).toBe('no_formula_on_file');
  });
});

describe('shortfall and stock states', () => {
  const withStock = (quantity: number, threshold: number | null = 0) =>
    baseRows({
      'inventory.location_stock': [
        { product_id: 'prod-1', quantity_on_hand_grams: quantity, low_stock_threshold_grams: threshold },
      ],
    });

  it('reports sufficient when stock comfortably covers the requirement', async () => {
    const { service } = buildService(withStock(500));
    const plan = await service.getPlan(OWNER, { locationId: 'loc-1' });
    expect(plan.products[0].state).toBe('sufficient');
    expect(plan.products[0].shortfallGrams).toBe(0);
    expect(plan.summary.shortfallProductCount).toBe(0);
  });

  it('reports a true shortfall with the exact deficit', async () => {
    // Required 110g (100 + 10% allowance), 75g on hand.
    const { service } = buildService(withStock(75));
    const plan = await service.getPlan(OWNER, { locationId: 'loc-1' });
    const product = plan.products[0];
    expect(product.state).toBe('shortfall');
    expect(product.requiredGrams).toBe(110);
    expect(product.onHandGrams).toBe(75);
    expect(product.shortfallGrams).toBe(35);
    expect(plan.summary.shortfallProductCount).toBe(1);
  });

  it('reports low stock when the requirement leaves the balance at or under the threshold', async () => {
    // 150 on hand - 110 required = 40 left, threshold 50.
    const { service } = buildService(withStock(150, 50));
    const plan = await service.getPlan(OWNER, { locationId: 'loc-1' });
    expect(plan.products[0].state).toBe('low_stock');
    expect(plan.products[0].shortfallGrams).toBe(0);
    expect(plan.summary.lowStockProductCount).toBe(1);
  });

  it('distinguishes a product never stocked at this location from an empty shelf', async () => {
    const { service } = buildService(baseRows({ 'inventory.location_stock': [] }));
    const plan = await service.getPlan(OWNER, { locationId: 'loc-1' });
    expect(plan.products[0].state).toBe('not_stocked');
    expect(plan.products[0].onHandGrams).toBe(0);
  });

  it('shows zero stock as a shortfall, not as sufficient', async () => {
    const { service } = buildService(withStock(0));
    const plan = await service.getPlan(OWNER, { locationId: 'loc-1' });
    expect(plan.products[0].state).toBe('shortfall');
    expect(plan.products[0].shortfallGrams).toBe(110);
  });

  it('sorts the most urgent product first', async () => {
    const rows = baseRows({
      'lab.formula_items': [
        { formula_id: 'formula-1', product_id: 'prod-1', product_name: 'Colour 6.0', captured_grams: 100 },
        { formula_id: 'formula-1', product_id: 'prod-2', product_name: 'Developer 20vol', captured_grams: 100 },
      ],
      'inventory.products': [
        { id: 'prod-1', name: 'Colour 6.0', brand: null, stock_unit: 'gram', pack_size: null, size_value: null, low_stock_threshold_grams: 0, is_active: true },
        { id: 'prod-2', name: 'Developer 20vol', brand: null, stock_unit: 'gram', pack_size: null, size_value: null, low_stock_threshold_grams: 0, is_active: true },
      ],
      'inventory.location_stock': [
        { product_id: 'prod-1', quantity_on_hand_grams: 5000, low_stock_threshold_grams: 0 },
        { product_id: 'prod-2', quantity_on_hand_grams: 10, low_stock_threshold_grams: 0 },
      ],
    });
    const { service } = buildService(rows);
    const plan = await service.getPlan(OWNER, { locationId: 'loc-1' });
    expect(plan.products[0].productId).toBe('prod-2');
    expect(plan.products[0].state).toBe('shortfall');
  });
});

describe('missing data is never hidden', () => {
  it('keeps a colour appointment with no formula and flags it for consultation', async () => {
    const { service } = buildService(baseRows({ 'lab.formulas': [], 'lab.formula_items': [] }));
    const plan = await service.getPlan(OWNER, { locationId: 'loc-1' });

    expect(plan.appointments).toHaveLength(1);
    expect(plan.appointments[0].state).toBe('no_formula_on_file');
    expect(plan.appointments[0].clientName).toBe('Ada Lovelace');
    expect(plan.appointments[0].items).toEqual([]);
    expect(plan.summary.appointmentsWithoutFormula).toBe(1);
  });

  it('surfaces a formula line that was never linked to a catalogue product', async () => {
    const { service } = buildService(
      baseRows({
        'lab.formula_items': [
          { formula_id: 'formula-1', product_id: null, product_name: 'Bond builder', captured_grams: 40 },
        ],
        'inventory.location_stock': [],
      }),
    );
    const plan = await service.getPlan(OWNER, { locationId: 'loc-1' });

    const unmapped = plan.products.find((product) => product.productName === 'Bond builder');
    expect(unmapped?.state).toBe('unmapped_product');
    expect(unmapped?.productId).toBeUndefined();
    // Never presented as covered: the whole requirement reads as outstanding.
    expect(unmapped?.requiredGrams).toBe(44);
    expect(unmapped?.shortfallGrams).toBe(44);
    expect(plan.summary.unmappedProductCount).toBe(1);
  });

  it('only considers finalized formulas, not drafts', async () => {
    const { service, captured } = buildService(baseRows());
    await service.getPlan(OWNER, { locationId: 'loc-1' });
    const statusFilter = captured.filter(
      (call) => call.key === 'lab.formulas' && call.method === 'eq' && call.args[0] === 'status',
    );
    expect(statusFilter[0]?.args[1]).toBe('saved');
  });

  it('takes the most recent formula when a client has several', async () => {
    const { service, captured } = buildService(
      baseRows({
        'lab.formulas': [
          { id: 'formula-new', client_profile_id: 'client-1', saved_at: '2026-08-01T10:00:00.000Z', status: 'saved' },
          { id: 'formula-old', client_profile_id: 'client-1', saved_at: '2026-01-01T10:00:00.000Z', status: 'saved' },
        ],
        'lab.formula_items': [
          { formula_id: 'formula-new', product_id: 'prod-1', product_name: 'Colour 6.0', captured_grams: 100 },
          { formula_id: 'formula-old', product_id: 'prod-1', product_name: 'Colour 6.0', captured_grams: 999 },
        ],
      }),
    );
    const plan = await service.getPlan(OWNER, { locationId: 'loc-1' });

    expect(plan.appointments[0].formulaId).toBe('formula-new');
    expect(plan.products[0].requiredGrams).toBe(110);
    const order = captured.find((call) => call.key === 'lab.formulas' && call.method === 'order');
    expect(order?.args[0]).toBe('saved_at');
  });
});

describe('performance shape', () => {
  it('reads each table once regardless of how many appointments are in the window', async () => {
    const many = Array.from({ length: 25 }, (_, index) => ({
      id: `appt-${index}`,
      client_profile_id: `client-${index}`,
      assigned_staff_profile_id: null,
      scheduled_start_at: '2026-08-19T10:00:00.000Z',
      status: 'accepted',
    }));
    const rows = baseRows({
      'booking.appointments': many,
      'booking.appointment_services': many.map((appointment) => ({
        appointment_id: appointment.id,
        service_id: 'svc-1',
        service_name_snapshot: 'Full head colour',
      })),
      'core.client_profiles': many.map((_, index) => ({
        id: `client-${index}`,
        first_name: 'Client',
        last_name: String(index),
      })),
    });
    const { service, captured } = buildService(rows);
    await service.getPlan(OWNER, { locationId: 'loc-1' });

    // One select per table — no per-appointment fan-out.
    const selects = captured.filter((call) => call.method === 'select');
    const perTable = selects.reduce<Record<string, number>>((acc, call) => {
      acc[call.key] = (acc[call.key] ?? 0) + 1;
      return acc;
    }, {});
    for (const [table, count] of Object.entries(perTable)) {
      expect(`${table}:${count}`).toBe(`${table}:1`);
    }
  });
});
