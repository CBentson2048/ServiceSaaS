/**
 * Week 6 ticket 1 — supplier catalogue and product ordering metadata.
 *
 * Same stubbed-client pattern as the consumption spec: the chain records what
 * the service sends to Supabase, so these prove tenancy scoping, payload
 * mapping and the permission posture — the table constraints themselves
 * (unique name, check constraints) live in migration 0092 and are exercised
 * against a real database.
 */
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { createClient } from '@supabase/supabase-js';
import { plainToInstance } from 'class-transformer';
import type { AuthUser } from '@sheer/domain';
import { InventoryService } from './inventory.service';
import { UpdateInventorySupplierDto } from './dto';
import type { AuditService } from '../audit/audit.service';

/**
 * Build the DTO the way the global ValidationPipe does at runtime. This
 * matters: class-transformer instances carry EVERY declared field as an own
 * property (undefined when the client omitted it), so a service that asks
 * `'field' in dto` sees true for everything. The update tests below caught
 * exactly that bug once they stopped using plain object literals.
 */
function updateDto(body: Record<string, unknown>): UpdateInventorySupplierDto {
  return plainToInstance(UpdateInventorySupplierDto, body);
}

jest.mock('@supabase/supabase-js', () => ({ createClient: jest.fn() }));
const mockedCreateClient = createClient as jest.MockedFunction<typeof createClient>;

interface Captured {
  key: string;
  method: string;
  args: unknown[];
}

const SUPPLIER = {
  id: 'sup-1',
  business_id: 'biz-1',
  name: 'Wella Professionals',
  contact_email: 'orders@wella.test',
  contact_phone: '020 7946 0000',
  account_reference: 'LOH-123',
  lead_time_days: 3,
  notes: null,
  is_active: true,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
};

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
  barcode: null,
  supplier_id: 'sup-1',
  minimum_order_quantity: 6,
  order_multiple: 6,
  dead_stock_days: 90,
  is_salon_use: false,
  is_lab_use: true,
  is_retail: false,
  lab_markup_percent: null,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
};

function build(
  rows: Record<string, unknown[]>,
  errors: Record<string, { code?: string; message: string }> = {},
) {
  const captured: Captured[] = [];
  const makeChain = (key: string) => {
    const data = () => rows[key] ?? [];
    const fail = () => errors[key] ?? null;
    const chain: Record<string, unknown> = {};
    for (const method of [
      'select', 'insert', 'update', 'delete', 'eq', 'in', 'order', 'limit', 'not', 'returns', 'ilike', 'or',
    ]) {
      chain[method] = (...args: unknown[]) => {
        captured.push({ key, method, args });
        return chain;
      };
    }
    chain.single = async () => ({ data: fail() ? null : (data()[0] ?? null), error: fail() });
    chain.maybeSingle = async () => ({ data: fail() ? null : (data()[0] ?? null), error: fail() });
    chain.then = (resolve: (v: unknown) => unknown, reject?: (r: unknown) => unknown) =>
      Promise.resolve({ data: fail() ? null : data(), error: fail() }).then(resolve, reject);
    return chain;
  };

  const root = {
    schema: () => ({
      from: (table: string) => makeChain(table),
      rpc: async () => ({ data: {}, error: null }),
    }),
  };
  mockedCreateClient.mockReturnValue(root as never);

  const audit = { record: jest.fn().mockResolvedValue(undefined) } as unknown as AuditService;
  const config = { getOrThrow: (key: string) => `test-${key}` } as unknown as ConfigService;
  return { service: new InventoryService(config, audit), captured };
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

const MANAGER: AuthUser = {
  ...OWNER,
  id: 'user-2',
  roles: ['manager'],
  primaryRole: 'manager',
} as unknown as AuthUser;

const STYLIST: AuthUser = {
  ...OWNER,
  id: 'user-3',
  roles: ['stylist'],
  primaryRole: 'stylist',
  permissions: [],
} as unknown as AuthUser;

beforeEach(() => jest.clearAllMocks());

describe('supplier catalogue', () => {
  it('lists suppliers scoped to the business, active only by default', async () => {
    const { service, captured } = build({ suppliers: [SUPPLIER] });
    const result = await service.listSuppliers(OWNER, {});

    expect(result.suppliers).toHaveLength(1);
    expect(result.suppliers[0]).toMatchObject({
      id: 'sup-1',
      name: 'Wella Professionals',
      contactEmail: 'orders@wella.test',
      accountReference: 'LOH-123',
      leadTimeDays: 3,
      isActive: true,
    });

    const eqs = captured.filter((c) => c.key === 'suppliers' && c.method === 'eq').map((c) => c.args);
    expect(eqs).toEqual(expect.arrayContaining([['business_id', 'biz-1'], ['is_active', true]]));
  });

  it('includes inactive suppliers when asked', async () => {
    const { service, captured } = build({ suppliers: [SUPPLIER] });
    await service.listSuppliers(OWNER, { includeInactive: true });
    const eqs = captured.filter((c) => c.key === 'suppliers' && c.method === 'eq').map((c) => c.args);
    expect(eqs).not.toEqual(expect.arrayContaining([['is_active', true]]));
  });

  it('refuses a caller without inventory.manage', async () => {
    const { service } = build({ suppliers: [SUPPLIER] });
    await expect(service.listSuppliers(STYLIST, {})).rejects.toThrow(ForbiddenException);
  });

  it('creates a supplier with trimmed fields under the caller business', async () => {
    const { service, captured } = build({ suppliers: [SUPPLIER] });
    await service.createSupplier(MANAGER, {
      name: '  Wella Professionals  ',
      contactEmail: ' orders@wella.test ',
      leadTimeDays: 3,
    });

    const insert = captured.find((c) => c.key === 'suppliers' && c.method === 'insert');
    expect(insert?.args[0]).toMatchObject({
      business_id: 'biz-1',
      name: 'Wella Professionals',
      contact_email: 'orders@wella.test',
      lead_time_days: 3,
      is_active: true,
    });
  });

  it('reports a duplicate name as a conflict, not a server error', async () => {
    const { service } = build({ suppliers: [] }, { suppliers: { code: '23505', message: 'duplicate' } });
    await expect(service.createSupplier(OWNER, { name: 'Wella Professionals' })).rejects.toThrow(
      ConflictException,
    );
  });

  it('updates only the fields that were provided, clearing on explicit null', async () => {
    const { service, captured } = build({ suppliers: [SUPPLIER] });
    await service.updateSupplier(OWNER, 'sup-1', updateDto({ contactEmail: null, leadTimeDays: 5 }));

    const update = captured.find((c) => c.key === 'suppliers' && c.method === 'update');
    expect(update?.args[0]).toEqual({ contact_email: null, lead_time_days: 5 });
    // The write is pinned to the row AND the tenant.
    const eqs = captured.filter((c) => c.key === 'suppliers' && c.method === 'eq').map((c) => c.args);
    expect(eqs).toEqual(expect.arrayContaining([['id', 'sup-1'], ['business_id', 'biz-1']]));
  });

  it('preserves every omitted field on a partial update', async () => {
    const { service, captured } = build({ suppliers: [SUPPLIER] });
    await service.updateSupplier(OWNER, 'sup-1', updateDto({ isActive: false }));

    // A pipe-built DTO carries all declared fields as own (undefined)
    // properties; only the one the caller actually sent may reach the patch.
    const update = captured.find((c) => c.key === 'suppliers' && c.method === 'update');
    expect(update?.args[0]).toEqual({ is_active: false });
  });

  it('rejects an update with nothing to change', async () => {
    const { service } = build({ suppliers: [SUPPLIER] });
    await expect(service.updateSupplier(OWNER, 'sup-1', updateDto({}))).rejects.toThrow(
      BadRequestException,
    );
  });

  it('rejects blanking the name, whether whitespace or explicit null', async () => {
    const { service } = build({ suppliers: [SUPPLIER] });
    await expect(
      service.updateSupplier(OWNER, 'sup-1', updateDto({ name: '   ' })),
    ).rejects.toThrow(BadRequestException);
    // IsOptional lets null through validation; it must 400, not crash on .trim().
    await expect(
      service.updateSupplier(OWNER, 'sup-1', updateDto({ name: null })),
    ).rejects.toThrow(BadRequestException);
  });

  it('reports an unknown supplier as not found', async () => {
    const { service } = build({ suppliers: [] });
    await expect(service.updateSupplier(OWNER, 'sup-9', updateDto({ name: 'X' }))).rejects.toThrow(
      NotFoundException,
    );
  });

  it('lets a manager create but not delete', async () => {
    const { service } = build({ suppliers: [SUPPLIER] });
    await expect(service.createSupplier(MANAGER, { name: 'New supplier' })).resolves.toBeDefined();
    await expect(service.deleteSupplier(MANAGER, 'sup-1')).rejects.toThrow(ForbiddenException);
  });

  it('lets an owner delete and returns the removed supplier', async () => {
    const { service, captured } = build({ suppliers: [SUPPLIER] });
    const result = await service.deleteSupplier(OWNER, 'sup-1');
    expect(result.supplier.id).toBe('sup-1');
    const eqs = captured.filter((c) => c.key === 'suppliers' && c.method === 'eq').map((c) => c.args);
    expect(eqs).toEqual(expect.arrayContaining([['id', 'sup-1'], ['business_id', 'biz-1']]));
  });
});

describe('product ordering metadata', () => {
  it('writes supplier and ordering fields on create and resolves the supplier name', async () => {
    const { service, captured } = build({ suppliers: [SUPPLIER], products: [PRODUCT] });
    const result = await service.createProduct(OWNER, {
      name: 'Colour 6.0',
      supplierId: 'sup-1',
      minimumOrderQuantity: 6,
      orderMultiple: 6,
      deadStockDays: 90,
    });

    const insert = captured.find((c) => c.key === 'products' && c.method === 'insert');
    expect(insert?.args[0]).toMatchObject({
      supplier_id: 'sup-1',
      minimum_order_quantity: 6,
      order_multiple: 6,
      dead_stock_days: 90,
    });
    expect(result.product.supplierId).toBe('sup-1');
    expect(result.product.supplierName).toBe('Wella Professionals');
    expect(result.product.minimumOrderQuantity).toBe(6);
    expect(result.product.orderMultiple).toBe(6);
    expect(result.product.deadStockDays).toBe(90);
  });

  it('refuses a supplier that does not belong to the business', async () => {
    const { service, captured } = build({ suppliers: [], products: [PRODUCT] });
    await expect(
      service.createProduct(OWNER, { name: 'Colour 6.0', supplierId: 'sup-other' }),
    ).rejects.toThrow(BadRequestException);
    // The refusal must come from a tenant-scoped lookup, not a global one.
    const eqs = captured.filter((c) => c.key === 'suppliers' && c.method === 'eq').map((c) => c.args);
    expect(eqs).toEqual(
      expect.arrayContaining([['business_id', 'biz-1'], ['id', 'sup-other']]),
    );
  });

  it('leaves omitted ordering fields to the column defaults instead of writing them', async () => {
    const { service, captured } = build({
      products: [{ ...PRODUCT, supplier_id: null, minimum_order_quantity: 1, order_multiple: 1, dead_stock_days: null }],
    });
    const result = await service.createProduct(OWNER, { name: 'Colour 6.0' });

    // Partial semantics: the lab-station form does not round-trip these fields,
    // so an upsert that wrote defaults here would reset supplier/MOQ on every
    // lab edit. Omitted must mean "not in the payload at all".
    const insert = captured.find((c) => c.key === 'products' && c.method === 'insert');
    const payload = insert?.args[0] as Record<string, unknown>;
    expect('supplier_id' in payload).toBe(false);
    expect('minimum_order_quantity' in payload).toBe(false);
    expect('order_multiple' in payload).toBe(false);
    expect('dead_stock_days' in payload).toBe(false);
    expect(result.product.supplierId).toBeUndefined();
    expect(result.product.supplierName).toBeUndefined();
    expect(result.product.minimumOrderQuantity).toBe(1);
    expect(result.product.orderMultiple).toBe(1);
    expect(result.product.deadStockDays).toBeUndefined();
  });

  it('clears the supplier link on an explicit null without touching other fields', async () => {
    const { service, captured } = build({
      suppliers: [SUPPLIER],
      products: [{ ...PRODUCT, supplier_id: null }],
    });
    await service.updateProduct(OWNER, 'prod-1', { name: 'Colour 6.0', supplierId: null });

    const update = captured.find((c) => c.key === 'products' && c.method === 'update');
    const payload = update?.args[0] as Record<string, unknown>;
    expect(payload.supplier_id).toBeNull();
    expect('minimum_order_quantity' in payload).toBe(false);
  });
});
