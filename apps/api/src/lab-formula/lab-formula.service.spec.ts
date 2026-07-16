/**
 * LabFormulaService — client formula-history reads.
 *
 * These cover the persistence fix behind ticket "Store Solo client profiles …":
 * a client's saved colour formulas must come from the durable `lab.formulas`
 * table (not the in-process draft cache) so history survives restarts and
 * persists across visits, and each record stays linked to the stylist who mixed
 * it. The Supabase client is stubbed with a table-keyed chain so the assertions
 * are about which table/columns/filters the service reads, not the network.
 */
import { ForbiddenException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { createClient } from '@supabase/supabase-js';
import type { AuthUser } from '@sheer/domain';
import { LabFormulaService } from './lab-formula.service';

jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(),
}));

const mockedCreateClient = createClient as jest.MockedFunction<typeof createClient>;

interface CapturedCall {
  table: string;
  method: string;
  args: unknown[];
}

// A minimal chainable Supabase stub. Every `from(table)` returns a fresh chain
// bound to that table, so results are routed by table name (order-independent)
// and each intermediate call is captured for filter assertions.
function createMockAdmin(resultsByTable: Record<string, unknown[]>) {
  const captured: CapturedCall[] = [];
  const bindTable = (table: string) => {
    const terminal = async () => ({ data: resultsByTable[table] ?? [], error: null });
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
      not: record('not'),
      order: record('order'),
      limit: record('limit'),
      returns: terminal,
      maybeSingle: terminal,
    };
    return chain;
  };
  const root: Record<string, unknown> = {
    schema: () => root,
    from: (table: string) => bindTable(table),
  };
  return { root, captured };
}

function createService(resultsByTable: Record<string, unknown[]>) {
  const { root, captured } = createMockAdmin(resultsByTable);
  mockedCreateClient.mockReturnValue(root as never);
  const config = { getOrThrow: jest.fn(() => 'test') } as unknown as ConfigService;
  return { service: new LabFormulaService(config), captured };
}

function ownerActor(): AuthUser {
  return {
    id: 'user_1',
    roles: ['owner'],
    primaryRole: 'owner',
    businessId: 'business_1',
    allowedLocationIds: ['location_1'],
    locationScope: { kind: 'all', locationIds: ['location_1'] },
    locations: [{ id: 'location_1', name: 'Kensington' }],
    profile: { id: 'user_1', email: 'owner@example.com', fullName: 'Owner One' },
    permissions: [],
  };
}

function stylistActor(): AuthUser {
  return {
    ...ownerActor(),
    roles: ['stylist'],
    primaryRole: 'stylist',
    staffProfileId: 'staff_1',
    locationScope: { kind: 'self', locationIds: ['location_1'] },
  };
}

function clientActor(clientProfileId: string): AuthUser {
  return {
    ...ownerActor(),
    roles: ['client'],
    primaryRole: 'client',
    allowedLocationIds: [],
    locationScope: { kind: 'self', locationIds: [] },
    clientProfileId,
  };
}

function savedFormulaRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'formula-uuid-1',
    external_formula_id: 'formula_1700000000000',
    lab_session_id: 'lab_session_1',
    appointment_id: 'appointment_1',
    visit_id: 'visit_1',
    business_id: 'business_1',
    location_id: 'location_1',
    client_profile_id: 'client_1',
    source_formula_id: null,
    actual_cost_cents: 1200,
    waste_cost_cents: 50,
    billable_charge_cents: 1200,
    currency_code: 'GBP',
    saved_at: '2026-07-10T10:00:00.000Z',
    created_at: '2026-07-10T09:00:00.000Z',
    updated_at: '2026-07-10T10:00:00.000Z',
    formula_items: [
      {
        id: 'item-uuid-1',
        external_item_id: 'formula_item_1',
        product_id: 'product_1',
        product_name: 'Koleston 6/0',
        brand: 'Wella',
        shade: '6/0',
        developer: '20 vol',
        ratio: '1:1.5',
        processing_time_minutes: 35,
        captured_grams: '60.000',
        waste_grams: '5.000',
        entry_mode: 'ble_scale',
        captured_at: '2026-07-10T09:30:00.000Z',
        cost_per_gram_cents: 20,
        cost_cents: 1200,
        waste_cost_cents: 50,
        notes: null,
      },
    ],
    ...overrides,
  };
}

const stylistTables = {
  visits: [{ id: 'visit_1', primary_staff_profile_id: 'staff_1', service_summary: 'Full head colour' }],
  appointments: [],
  staff_profiles: [{ id: 'staff_1', display_name: 'Alex Stylist' }],
};

describe('LabFormulaService — client formula history', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('reads a client history from lab.formulas and links each record to the stylist', async () => {
    const { service, captured } = createService({
      formulas: [savedFormulaRow()],
      ...stylistTables,
    });

    const records = await service.historyForClient(ownerActor(), 'client_1');

    expect(records).toHaveLength(1);
    const [record] = records;
    // Durable row, not an ephemeral draft: id/savedAt come straight from the DB.
    expect(record.id).toBe('formula_1700000000000');
    expect(record.savedAt).toBe('2026-07-10T10:00:00.000Z');
    expect(record.status).toBe('saved');
    // Linked to the stylist who mixed it (resolved from the owning visit).
    expect(record.staffProfileId).toBe('staff_1');
    expect(record.stylistName).toBe('Alex Stylist');
    expect(record.visit?.serviceType).toBe('Full head colour');
    // Ingredients rebuilt from lab.formula_items.
    expect(record.items).toHaveLength(1);
    expect(record.items[0].productName).toBe('Koleston 6/0');
    expect(record.items[0].capturedGrams).toBe(60);
    // Read the durable table, scoped to the business + client + saved status.
    const formulaEqFilters = captured
      .filter((call) => call.table === 'formulas' && call.method === 'eq')
      .map((call) => call.args[0]);
    expect(formulaEqFilters).toEqual(
      expect.arrayContaining(['business_id', 'client_profile_id', 'status']),
    );
  });

  it('bounds a stylist to their allowed locations', async () => {
    const { service, captured } = createService({
      formulas: [savedFormulaRow()],
      ...stylistTables,
    });

    await service.historyForClient(stylistActor(), 'client_1');

    const locationScope = captured.find(
      (call) => call.table === 'formulas' && call.method === 'in' && call.args[0] === 'location_id',
    );
    expect(locationScope).toBeDefined();
    expect(locationScope?.args[1]).toEqual(['location_1']);
  });

  it('does not location-scope an owner read', async () => {
    const { service, captured } = createService({
      formulas: [savedFormulaRow()],
      ...stylistTables,
    });

    await service.historyForClient(ownerActor(), 'client_1');

    const locationScope = captured.find(
      (call) => call.table === 'formulas' && call.method === 'in' && call.args[0] === 'location_id',
    );
    expect(locationScope).toBeUndefined();
  });

  it('rejects a client reading another client’s history', async () => {
    const { service } = createService({ formulas: [] });

    await expect(service.historyForClient(clientActor('client_A'), 'client_B')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('returns an empty history when the client has no saved formulas', async () => {
    const { service } = createService({ formulas: [] });

    expect(await service.historyForClient(ownerActor(), 'client_1')).toEqual([]);
  });

  it('latestForClient returns the first (newest) saved formula', async () => {
    const older = savedFormulaRow({
      id: 'formula-uuid-0',
      external_formula_id: 'formula_1600000000000',
      saved_at: '2026-06-01T10:00:00.000Z',
    });
    const newer = savedFormulaRow();
    const { service } = createService({
      // The DB returns newest-first (order saved_at desc); the mock preserves order.
      formulas: [newer, older],
      ...stylistTables,
    });

    const latest = await service.latestForClient(ownerActor(), 'client_1');
    expect(latest?.id).toBe('formula_1700000000000');
  });

  it('historyForSelf returns a cost-stripped, client-safe view for the signed-in client', async () => {
    const { service } = createService({
      formulas: [savedFormulaRow()],
      ...stylistTables,
    });

    const response = await service.historyForSelf(clientActor('client_1'));

    expect(response.formulas).toHaveLength(1);
    const [formula] = response.formulas;
    expect(formula.serviceType).toBe('Full head colour');
    expect(formula.items[0].productName).toBe('Koleston 6/0');
    // Cost / waste / billing must never leave the API for a client.
    expect(formula).not.toHaveProperty('totalCostCents');
    expect(formula.items[0]).not.toHaveProperty('capturedGrams');
    expect(formula.items[0]).not.toHaveProperty('costCents');
  });
});
