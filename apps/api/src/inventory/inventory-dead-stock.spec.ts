/**
 * Week 6 ticket 7 — dead stock alerts.
 *
 * The classification arithmetic (idle clock, restock immunity, threshold
 * precedence) lives in inventory.dead_stock_report (0093) and is proved by
 * supabase/tests/week6_dead_stock_alerts.sql. These specs stub the Supabase
 * client, so they own the OTHER half: which locations the RPC is scoped to,
 * who is allowed to ask, and how a report row is decorated for display.
 */
import { ForbiddenException, InternalServerErrorException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { createClient } from '@supabase/supabase-js';
import type { AuthUser } from '@sheer/domain';
import { InventoryService } from './inventory.service';
import type { AuditService } from '../audit/audit.service';

jest.mock('@supabase/supabase-js', () => ({ createClient: jest.fn() }));
const mockedCreateClient = createClient as jest.MockedFunction<typeof createClient>;

const PRODUCT = {
  id: 'prod-1',
  business_id: 'biz-1',
  brand: 'Wella',
  name: 'Forgotten Toner',
  category_id: null,
  sku: 'W-TONER',
  size_value: 60,
  size_unit: 'g',
  default_unit: 'g',
  default_cost_per_gram_cents: 5,
  retail_price_cents: null,
  low_stock_threshold_grams: 0,
  is_active: true,
  stock_unit: 'gram',
  pack_size: 60,
  barcode: null,
  supplier_id: 'sup-1',
  minimum_order_quantity: 1,
  order_multiple: 1,
  dead_stock_days: 60,
  is_salon_use: false,
  is_lab_use: true,
  is_retail: false,
  lab_markup_percent: null,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
};

const REPORT_ROW = {
  location_id: 'loc-1',
  product_id: 'prod-1',
  quantity_on_hand_grams: 200,
  last_outbound_at: '2026-05-01T10:00:00.000Z',
  idle_since: '2026-05-01T10:00:00.000Z',
  days_idle: 115,
  threshold_days: 60,
  threshold_source: 'product',
};

function build(
  rows: Record<string, unknown[]>,
  rpc: { rows?: unknown[]; error?: { message: string } } = {},
) {
  const rpcCalls: { name: string; args: Record<string, unknown> }[] = [];
  const makeChain = (key: string) => {
    const data = () => rows[key] ?? [];
    const chain: Record<string, unknown> = {};
    for (const method of ['select', 'eq', 'in', 'order', 'limit', 'not', 'returns', 'ilike', 'or']) {
      chain[method] = () => chain;
    }
    chain.maybeSingle = async () => ({ data: data()[0] ?? null, error: null });
    chain.then = (resolve: (v: unknown) => unknown, reject?: (r: unknown) => unknown) =>
      Promise.resolve({ data: data(), error: null }).then(resolve, reject);
    return chain;
  };

  const root = {
    schema: () => ({
      from: (table: string) => makeChain(table),
      rpc: async (name: string, args: Record<string, unknown>) => {
        rpcCalls.push({ name, args });
        return rpc.error ? { data: null, error: rpc.error } : { data: rpc.rows ?? [], error: null };
      },
    }),
  };
  mockedCreateClient.mockReturnValue(root as never);

  const audit = { record: jest.fn().mockResolvedValue(undefined) } as unknown as AuditService;
  const config = { getOrThrow: (key: string) => `test-${key}` } as unknown as ConfigService;
  return { service: new InventoryService(config, audit), rpcCalls };
}

const OWNER: AuthUser = {
  id: 'user-1',
  roles: ['owner'],
  primaryRole: 'owner',
  businessId: 'biz-1',
  allowedLocationIds: ['loc-1'],
  locationScope: { kind: 'all' },
  locations: [],
  profile: { id: 'user-1', email: 'o@s.test', fullName: 'Owner' },
  permissions: ['inventory.manage'],
} as unknown as AuthUser;

const baseRows = (overrides: Record<string, unknown[]> = {}) => ({
  locations: [
    { id: 'loc-1', name: 'Main' },
    { id: 'loc-2', name: 'Second' },
  ],
  products: [PRODUCT],
  suppliers: [{ id: 'sup-1', name: 'Wella Professionals' }],
  ...overrides,
});

beforeEach(() => jest.clearAllMocks());

describe('dead stock listing', () => {
  it('asks the report for every business location when an owner sets no filter', async () => {
    const { service, rpcCalls } = build(baseRows(), { rows: [REPORT_ROW] });
    await service.listDeadStock(OWNER);

    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0].name).toBe('dead_stock_report');
    expect(rpcCalls[0].args).toEqual({
      p_business_id: 'biz-1',
      p_location_ids: ['loc-1', 'loc-2'],
    });
  });

  it('decorates a report row with product, supplier and location display data', async () => {
    const { service } = build(baseRows(), { rows: [REPORT_ROW] });
    const result = await service.listDeadStock(OWNER);

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      locationId: 'loc-1',
      locationName: 'Main',
      productId: 'prod-1',
      productName: 'Forgotten Toner',
      brand: 'Wella',
      sku: 'W-TONER',
      supplierName: 'Wella Professionals',
      quantityOnHandGrams: 200,
      stockUnit: 'gram',
      lastOutboundAt: '2026-05-01T10:00:00.000Z',
      daysIdle: 115,
      thresholdDays: 60,
      thresholdSource: 'product',
      // 200 base units at 5 cents each.
      estimatedValueCents: 1000,
    });
    expect(result.totalEstimatedValueCents).toBe(1000);
  });

  it('passes a category-sourced threshold through untouched', async () => {
    // 0101 added 'category' between product and location default. The service
    // must not interpret the source — it decorates and forwards, so a level it
    // has never heard of still reaches the UI intact.
    const { service } = build(baseRows(), {
      rows: [{ ...REPORT_ROW, threshold_days: 10, threshold_source: 'category' }],
    });

    const result = await service.listDeadStock(OWNER);

    expect(result.items[0]).toMatchObject({
      thresholdDays: 10,
      thresholdSource: 'category',
    });
  });

  it('reports never-used stock without a last-outbound date instead of faking one', async () => {
    const { service } = build(baseRows(), {
      rows: [{ ...REPORT_ROW, last_outbound_at: null, idle_since: '2026-04-01T00:00:00.000Z' }],
    });
    const result = await service.listDeadStock(OWNER);
    expect(result.items[0].lastOutboundAt).toBeUndefined();
    expect(result.items[0].idleSince).toBe('2026-04-01T00:00:00.000Z');
  });

  it('leaves the value blank when the product has no recorded cost', async () => {
    const { service } = build(
      baseRows({ products: [{ ...PRODUCT, default_cost_per_gram_cents: null }] }),
      { rows: [REPORT_ROW] },
    );
    const result = await service.listDeadStock(OWNER);
    expect(result.items[0].estimatedValueCents).toBeUndefined();
    expect(result.totalEstimatedValueCents).toBe(0);
  });

  it('scopes a manager to their own locations only', async () => {
    const manager = {
      ...OWNER,
      roles: ['manager'],
      primaryRole: 'manager',
      allowedLocationIds: ['loc-1'],
    } as unknown as AuthUser;
    const { service, rpcCalls } = build(baseRows(), { rows: [] });
    await service.listDeadStock(manager);
    expect(rpcCalls[0].args).toMatchObject({ p_location_ids: ['loc-1'] });
  });

  it('refuses an explicit location outside the manager scope before reading anything', async () => {
    const manager = {
      ...OWNER,
      roles: ['manager'],
      primaryRole: 'manager',
      allowedLocationIds: ['loc-1'],
    } as unknown as AuthUser;
    const { service, rpcCalls } = build(baseRows());
    await expect(service.listDeadStock(manager, 'loc-2')).rejects.toThrow(ForbiddenException);
    expect(rpcCalls).toHaveLength(0);
  });

  it('refuses a caller without inventory.manage', async () => {
    const stylist = {
      ...OWNER,
      roles: ['stylist'],
      primaryRole: 'stylist',
      permissions: [],
    } as unknown as AuthUser;
    const { service } = build(baseRows());
    await expect(service.listDeadStock(stylist)).rejects.toThrow(ForbiddenException);
  });

  it('answers an empty scope with an empty report rather than querying', async () => {
    const manager = {
      ...OWNER,
      roles: ['manager'],
      primaryRole: 'manager',
      allowedLocationIds: [],
    } as unknown as AuthUser;
    const { service, rpcCalls } = build(baseRows());
    const result = await service.listDeadStock(manager);
    expect(result).toEqual({ items: [], locations: [], totalEstimatedValueCents: 0 });
    expect(rpcCalls).toHaveLength(0);
  });

  it('surfaces a report failure as a server error', async () => {
    const { service } = build(baseRows(), { error: { message: 'boom' } });
    await expect(service.listDeadStock(OWNER)).rejects.toThrow(InternalServerErrorException);
  });
});
