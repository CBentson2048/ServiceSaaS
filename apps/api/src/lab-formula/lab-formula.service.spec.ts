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
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { createClient } from '@supabase/supabase-js';
import type { AuthUser } from '@sheer/domain';
import { LabFormulaService } from './lab-formula.service';
import type { LabRuntimeSession } from '../lab-session/lab-session.service';

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
// and each intermediate call is captured for filter assertions. `returns`
// yields the table's rows; `maybeSingle`/`single` yield the first row; `rpc`
// and `upsert` are captured terminals so save-path tests can assert on them.
function createMockAdmin(
  resultsByTable: Record<string, unknown[]>,
  rpcResult: Record<string, unknown> = {},
) {
  const captured: CapturedCall[] = [];
  const bindTable = (table: string) => {
    const terminal = async () => ({ data: resultsByTable[table] ?? [], error: null });
    const firstRow = async () => ({ data: (resultsByTable[table] ?? [])[0] ?? null, error: null });
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
      insert: record('insert'),
      returns: terminal,
      maybeSingle: firstRow,
      single: firstRow,
      upsert: async (...args: unknown[]) => {
        captured.push({ table, method: 'upsert', args });
        return { data: null, error: null };
      },
    };
    return chain;
  };
  const root: Record<string, unknown> = {
    schema: () => root,
    from: (table: string) => bindTable(table),
    rpc: async (name: string, args: unknown) => {
      captured.push({ table: '__rpc__', method: name, args: [args] });
      return { data: rpcResult, error: null };
    },
  };
  return { root, captured };
}

function createService(
  resultsByTable: Record<string, unknown[]>,
  rpcResult: Record<string, unknown> = {},
) {
  const { root, captured } = createMockAdmin(resultsByTable, rpcResult);
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
    status: 'saved',
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
    expect(formulaEqFilters).toEqual(expect.arrayContaining(['business_id', 'client_profile_id']));
    // Default read is finalized-only — drafts need an explicit staff opt-in.
    const statusFilter = captured.find(
      (call) => call.table === 'formulas' && call.method === 'in' && call.args[0] === 'status',
    );
    expect(statusFilter?.args[1]).toEqual(['saved']);
  });

  it('includes durable drafts (flagged) only when a staff read opts in', async () => {
    const { service, captured } = createService({
      formulas: [savedFormulaRow({ status: 'draft' })],
      ...stylistTables,
    });

    const records = await service.historyForClient(ownerActor(), 'client_1', { includeDrafts: true });

    const statusFilter = captured.find(
      (call) => call.table === 'formulas' && call.method === 'in' && call.args[0] === 'status',
    );
    expect(statusFilter?.args[1]).toEqual(['draft', 'saved']);
    expect(records[0].isDraft).toBe(true);
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

  it('surfaces formula-level stylist notes on the staff history record', async () => {
    const { service } = createService({
      formulas: [savedFormulaRow({ notes: 'Left to develop 40 min — client prone to warmth' })],
      ...stylistTables,
    });

    const [record] = await service.historyForClient(ownerActor(), 'client_1');
    expect(record.notes).toBe('Left to develop 40 min — client prone to warmth');
  });

  it('keeps formula-level notes out of the client-safe self view (stylist-internal)', async () => {
    const { service } = createService({
      formulas: [savedFormulaRow({ notes: 'Internal: overlap roots only' })],
      ...stylistTables,
    });

    const response = await service.historyForSelf(clientActor('client_1'));
    expect(response.formulas[0]).not.toHaveProperty('notes');
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

function labSession(): LabRuntimeSession {
  return {
    sessionId: 'lab_session_1',
    businessId: 'business_1',
    locationId: 'location_1',
    sharedDeviceId: 'device_1',
    userProfileId: 'user_1',
    staffProfileId: 'staff_1',
    role: 'manager',
    permissions: [],
  };
}

/** booking.visits row that resolves the draft's business/location/client scope. */
const draftContextTables = {
  visits: [
    {
      id: 'visit_1',
      business_id: 'business_1',
      location_id: 'location_1',
      client_profile_id: 'client_1',
      primary_staff_profile_id: 'staff_1',
      appointment_id: 'appointment_1',
    },
  ],
};

describe('LabFormulaService — lab-session draft save', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('persists a draft via the RPC with billing and inventory switched OFF', async () => {
    const { service, captured } = createService(draftContextTables);

    const result = await service.saveDraftForLabSession(labSession(), 'formula_ext_1', {
      formulaId: 'formula_ext_1',
      labSessionId: 'ignored-by-server',
      visitId: 'visit_1',
      // Draft rows may be unweighed and cost-less — looser than finalize.
      items: [{ id: 'item_1', productName: 'Koleston 6/0', entryMode: 'manual', costCents: 500 }],
      billingHandoffRequested: false,
    });

    const rpc = captured.find((call) => call.table === '__rpc__');
    expect(rpc?.method).toBe('save_formula_with_reconciliation');
    const payload = (rpc?.args[0] as { p_payload: Record<string, unknown> }).p_payload;
    expect(payload.formulaId).toBe('formula_ext_1');
    expect(payload.billingHandoffRequested).toBe(false);
    expect(payload.inventoryDeductionRequested).toBe(false);
    // Drives status='draft' in the RPC so checkout/receipt/analytics readers
    // (all keyed on status='saved') never see an unfinalized mix.
    expect(payload.finalizeRequested).toBe(false);
    expect(payload.labSessionId).toBe('lab_session_1');

    expect(result.billingStatus).toBe('not_requested');
    expect(result.inventoryStatus).toBe('not_requested');
  });

  it('never writes a product-usage billing line for a draft, even with a visit and a cost', async () => {
    const { service, captured } = createService({
      ...draftContextTables,
      // Billing IS enabled for the location — the draft must still not bill.
      billing_rules: [
        {
          product_billing_enabled: true,
          product_billing_rule: 'cost_plus_markup_percent',
          product_markup_percent: 30,
          product_fixed_uplift_amount: null,
          product_round_up_enabled: false,
          product_round_up_increment: null,
        },
      ],
    });

    await service.saveDraftForLabSession(labSession(), 'formula_ext_1', {
      formulaId: 'formula_ext_1',
      labSessionId: 'lab_session_1',
      visitId: 'visit_1',
      items: [{ id: 'item_1', productName: 'Koleston 6/0', entryMode: 'manual', costCents: 1200 }],
      billingHandoffRequested: false,
    });

    const billingUpsert = captured.find(
      (call) => call.table === 'visit_line_items' && call.method === 'upsert',
    );
    expect(billingUpsert).toBeUndefined();
  });

  it('still writes the product-usage billing line when billing IS requested (finalize path)', async () => {
    const { service, captured } = createService({
      ...draftContextTables,
      billing_rules: [
        {
          product_billing_enabled: true,
          product_billing_rule: 'cost_plus_markup_percent',
          product_markup_percent: 30,
          product_fixed_uplift_amount: null,
          product_round_up_enabled: false,
          product_round_up_increment: null,
        },
      ],
    });

    await service.finalizeForLabSession(labSession(), 'formula_ext_1', {
      formulaId: 'formula_ext_1',
      labSessionId: 'lab_session_1',
      visitId: 'visit_1',
      items: [
        {
          id: 'item_1',
          productName: 'Koleston 6/0',
          entryMode: 'ble_scale',
          capturedGrams: 60,
          costPerGramCents: 20,
          costCents: 1200,
        },
      ],
      billingHandoffRequested: true,
    });

    const billingUpsert = captured.find(
      (call) => call.table === 'visit_line_items' && call.method === 'upsert',
    );
    expect(billingUpsert).toBeDefined();
    const row = billingUpsert?.args[0] as Record<string, unknown>;
    // 1200 cost + 30% markup = 1560 billable.
    expect(row.billable_amount_cents).toBe(1560);
    expect(row.cost_amount_cents).toBe(1200);
  });

  it('rejects a draft with no appointment or visit context', async () => {
    const { service } = createService(draftContextTables);

    await expect(
      service.saveDraftForLabSession(labSession(), 'formula_ext_1', {
        formulaId: 'formula_ext_1',
        labSessionId: 'lab_session_1',
        items: [{ id: 'item_1', productName: 'Koleston 6/0', entryMode: 'manual' }],
        billingHandoffRequested: false,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a draft with no ingredients', async () => {
    const { service } = createService(draftContextTables);

    await expect(
      service.saveDraftForLabSession(labSession(), 'formula_ext_1', {
        formulaId: 'formula_ext_1',
        labSessionId: 'lab_session_1',
        visitId: 'visit_1',
        items: [],
        billingHandoffRequested: false,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
