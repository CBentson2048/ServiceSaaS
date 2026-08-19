/**
 * Week 6 barcode consumption foundation.
 *
 * These cover the path a scan takes: resolve an identifier to exactly one
 * product in the caller's business, convert the quantity into base stock units,
 * and deduct through `inventory.adjust_location_stock` — the one RPC that owns
 * the movement ledger, the alerts and the negative-stock policy.
 *
 * The Supabase client is stubbed with a table-keyed chain (the pattern used by
 * the Lab formula specs), so assertions are about the payload the service sends
 * and the rules it applies, not about the network.
 */
import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { createClient } from '@supabase/supabase-js';
import type { AuthUser } from '@sheer/domain';
import { InventoryService } from './inventory.service';
import type { AuditService } from '../audit/audit.service';

jest.mock('@supabase/supabase-js', () => ({ createClient: jest.fn() }));
const mockedCreateClient = createClient as jest.MockedFunction<typeof createClient>;

interface Captured {
  key: string;
  method: string;
  args: unknown[];
}

const PRODUCT = {
  id: 'prod-1',
  business_id: 'biz-1',
  brand: 'Wella',
  name: 'Colour 6.0',
  category_id: null,
  sku: 'W-60',
  size_value: 100,
  size_unit: 'g',
  default_unit: 'g',
  default_cost_per_gram_cents: 5,
  retail_price_cents: null,
  low_stock_threshold_grams: 50,
  is_active: true,
  stock_unit: 'gram',
  pack_size: 100,
  barcode: '5010000000001',
  is_salon_use: false,
  is_lab_use: true,
  is_retail: false,
  lab_markup_percent: null,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
};

function build(
  rows: Record<string, unknown[]>,
  rpcResult: Record<string, unknown> = {
    movementId: 'mv-1',
    quantityOnHandGrams: 470,
    lowStockThresholdGrams: 50,
    idempotentReplay: false,
  },
) {
  const captured: Captured[] = [];
  const makeChain = (key: string) => {
    const data = () => rows[key] ?? [];
    const chain: Record<string, unknown> = {};
    for (const method of ['select', 'eq', 'in', 'order', 'limit', 'not', 'returns', 'ilike', 'or']) {
      chain[method] = (...args: unknown[]) => {
        captured.push({ key, method, args });
        return chain;
      };
    }
    chain.maybeSingle = async () => ({ data: data()[0] ?? null, error: null });
    chain.then = (resolve: (v: unknown) => unknown, reject?: (r: unknown) => unknown) =>
      Promise.resolve({ data: data(), error: null }).then(resolve, reject);
    return chain;
  };

  const rpcCalls: { name: string; payload: Record<string, unknown> }[] = [];
  const root = {
    schema: () => ({
      from: (table: string) => makeChain(table),
      rpc: async (name: string, args: { p_payload: Record<string, unknown> }) => {
        rpcCalls.push({ name, payload: args.p_payload });
        return { data: rpcResult, error: null };
      },
    }),
  };
  mockedCreateClient.mockReturnValue(root as never);

  const audit = { record: jest.fn().mockResolvedValue(undefined) } as unknown as AuditService;
  const config = { getOrThrow: (key: string) => `test-${key}` } as unknown as ConfigService;
  return { service: new InventoryService(config, audit), captured, rpcCalls, audit };
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
  locations: [{ id: 'loc-1' }],
  products: [PRODUCT],
  location_stock: [{ quantity_on_hand_grams: 500, low_stock_threshold_grams: 50 }],
  ...overrides,
});

beforeEach(() => jest.clearAllMocks());

describe('barcode lookup', () => {
  it('resolves a product and its stock at the location', async () => {
    const { service, captured } = build(baseRows());
    const result = await service.lookupByBarcode(OWNER, '5010000000001', 'loc-1');

    expect(result.product.id).toBe('prod-1');
    expect(result.product.barcode).toBe('5010000000001');
    expect(result.quantityOnHandGrams).toBe(500);

    // Scoped to the caller's business — a barcode is only unique within one.
    const eqs = captured.filter((c) => c.key === 'products' && c.method === 'eq').map((c) => c.args);
    expect(eqs).toEqual(expect.arrayContaining([['business_id', 'biz-1'], ['barcode', '5010000000001']]));
  });

  it('reports an unknown barcode as not found rather than an empty result', async () => {
    const { service } = build(baseRows({ products: [] }));
    await expect(service.lookupByBarcode(OWNER, '0000', 'loc-1')).rejects.toThrow(NotFoundException);
  });

  it('refuses an archived product instead of letting it be consumed', async () => {
    const { service } = build(baseRows({ products: [{ ...PRODUCT, is_active: false }] }));
    await expect(service.lookupByBarcode(OWNER, '5010000000001', 'loc-1')).rejects.toThrow(
      ConflictException,
    );
  });

  it('rejects an empty barcode', async () => {
    const { service } = build(baseRows());
    await expect(service.lookupByBarcode(OWNER, '   ', 'loc-1')).rejects.toThrow();
  });

  it('refuses a location outside the caller scope', async () => {
    const scoped = {
      ...OWNER,
      roles: ['manager'],
      primaryRole: 'manager',
      allowedLocationIds: ['loc-9'],
    } as unknown as AuthUser;
    const { service } = build(baseRows());
    await expect(service.lookupByBarcode(scoped, '5010000000001', 'loc-1')).rejects.toThrow(
      ForbiddenException,
    );
  });
});

describe('recording consumption', () => {
  it('deducts the requested base quantity through the authoritative RPC', async () => {
    const { service, rpcCalls } = build(baseRows());
    const result = await service.recordConsumption(OWNER, {
      locationId: 'loc-1',
      productId: 'prod-1',
      quantity: 30,
    });

    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0].name).toBe('adjust_location_stock');
    expect(rpcCalls[0].payload).toMatchObject({
      businessId: 'biz-1',
      locationId: 'loc-1',
      productId: 'prod-1',
      quantityDeltaGrams: -30,
      movementType: 'salon_consumption',
    });
    expect(result.quantityDeductedGrams).toBe(30);
    expect(result.quantityOnHandGrams).toBe(470);
  });

  it('converts a pack quantity using the product pack size', async () => {
    const { service, rpcCalls } = build(baseRows());
    await service.recordConsumption(OWNER, {
      locationId: 'loc-1',
      productId: 'prod-1',
      quantity: 2,
      unit: 'pack',
    });
    expect(rpcCalls[0].payload.quantityDeltaGrams).toBe(-200);
  });

  it('treats one pack as one item for a unit-stocked product', async () => {
    const { service, rpcCalls } = build(
      baseRows({ products: [{ ...PRODUCT, stock_unit: 'unit', pack_size: null, size_value: null }] }),
    );
    await service.recordConsumption(OWNER, {
      locationId: 'loc-1',
      productId: 'prod-1',
      quantity: 3,
      unit: 'pack',
    });
    expect(rpcCalls[0].payload.quantityDeltaGrams).toBe(-3);
  });

  it('resolves the product from a barcode when no id is given', async () => {
    const { service, rpcCalls } = build(baseRows());
    await service.recordConsumption(OWNER, {
      locationId: 'loc-1',
      barcode: '5010000000001',
      quantity: 25,
    });
    expect(rpcCalls[0].payload).toMatchObject({
      productId: 'prod-1',
      referenceType: 'barcode_scan',
      metadata: { barcode: '5010000000001' },
    });
  });

  it('requires either a product id or a barcode', async () => {
    const { service } = build(baseRows());
    await expect(
      service.recordConsumption(OWNER, { locationId: 'loc-1', quantity: 10 }),
    ).rejects.toThrow(/productId or barcode/i);
  });

  it('passes the idempotency key so a retried scan cannot deduct twice', async () => {
    const { service, rpcCalls } = build(baseRows());
    await service.recordConsumption(OWNER, {
      locationId: 'loc-1',
      productId: 'prod-1',
      quantity: 30,
      idempotencyKey: 'scan-abc',
    });
    expect(rpcCalls[0].payload.idempotencyKey).toBe('scan-abc');
  });

  it('reports a replayed retry as deducting nothing further', async () => {
    const { service, audit } = build(baseRows(), {
      movementId: 'mv-1',
      quantityOnHandGrams: 470,
      lowStockThresholdGrams: 50,
      idempotentReplay: true,
    });
    const result = await service.recordConsumption(OWNER, {
      locationId: 'loc-1',
      productId: 'prod-1',
      quantity: 30,
      idempotencyKey: 'scan-abc',
    });

    expect(result.idempotentReplay).toBe(true);
    expect(result.quantityDeductedGrams).toBe(0);
    // Stock is unchanged from the original call, so the balance still reads 470.
    expect(result.quantityOnHandGrams).toBe(470);
    // A replay is not a new business event and must not be audited again.
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('audits a real consumption with its provenance', async () => {
    const { service, audit } = build(baseRows());
    await service.recordConsumption(OWNER, {
      locationId: 'loc-1',
      barcode: '5010000000001',
      quantity: 30,
    });
    expect(audit.record).toHaveBeenCalledWith(
      OWNER,
      expect.objectContaining({
        action: 'stock.adjusted',
        entityType: 'stock',
        entityId: 'prod-1',
        locationId: 'loc-1',
        metadata: expect.objectContaining({
          movementType: 'salon_consumption',
          quantityDeltaGrams: -30,
          barcode: '5010000000001',
        }),
      }),
    );
  });

  it('refuses an unknown product id', async () => {
    const { service } = build(baseRows({ products: [] }));
    await expect(
      service.recordConsumption(OWNER, { locationId: 'loc-1', productId: 'nope', quantity: 5 }),
    ).rejects.toThrow(NotFoundException);
  });

  it('refuses an archived product', async () => {
    const { service } = build(baseRows({ products: [{ ...PRODUCT, is_active: false }] }));
    await expect(
      service.recordConsumption(OWNER, { locationId: 'loc-1', productId: 'prod-1', quantity: 5 }),
    ).rejects.toThrow(ConflictException);
  });

  it('rejects a non-positive quantity before touching stock', async () => {
    const { service, rpcCalls } = build(baseRows());
    await expect(
      service.recordConsumption(OWNER, { locationId: 'loc-1', productId: 'prod-1', quantity: 0 }),
    ).rejects.toThrow();
    expect(rpcCalls).toHaveLength(0);
  });

  it('refuses a location outside the caller scope before touching stock', async () => {
    const scoped = {
      ...OWNER,
      roles: ['manager'],
      primaryRole: 'manager',
      allowedLocationIds: ['loc-9'],
    } as unknown as AuthUser;
    const { service, rpcCalls } = build(baseRows());
    await expect(
      service.recordConsumption(scoped, { locationId: 'loc-1', productId: 'prod-1', quantity: 5 }),
    ).rejects.toThrow(ForbiddenException);
    expect(rpcCalls).toHaveLength(0);
  });
});
