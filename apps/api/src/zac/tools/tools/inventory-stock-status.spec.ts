import type { AuthUser } from '@sheer/domain';
import type { ZacActingContext } from '../../context/zac-context.types';
import type { ZacInventoryRead } from '../ports/zac-service-ports';
import { InventoryStockStatusTool } from './inventory-stock-status.tool';

/**
 * Workstream 3 — stock status.
 *
 * Fixtures mirror the working database (docs/ZAC/phase-2-ws3-data-evidence.md):
 * 3 live-low rows against 2 open alert rows, 6 of 6 Kensington products idle
 * against a 30-day threshold the location itself set, and a ledger whose newest
 * entry is 2026-08-26.
 */

const CONTEXT = { roleContext: 'owner', roles: ['owner'] } as unknown as ZacActingContext;

const OWNER = {
  id: 'user-1',
  businessId: 'biz-1',
  roles: ['owner'],
  permissions: ['zac.access', 'inventory.manage'],
  allowedLocationIds: [],
} as unknown as AuthUser;

function stockRow(over: Record<string, unknown> = {}) {
  return {
    id: 's1',
    businessId: 'biz-1',
    locationId: 'loc-1',
    locationName: 'Kensington',
    productId: 'p1',
    productName: 'Majirel 6.0 Dark Blonde',
    quantityOnHandGrams: 319,
    effectiveLowStockThresholdGrams: 20,
    isLowStock: false,
    isActive: true,
    updatedAt: '2026-08-26T00:00:00.000Z',
    ...over,
  };
}

function deadRow(over: Record<string, unknown> = {}) {
  return {
    locationId: 'loc-1',
    locationName: 'Kensington',
    productId: 'p1',
    productName: 'SoColor 8N Light Blonde',
    quantityOnHandGrams: 1000,
    stockUnit: 'gram',
    lastOutboundAt: '2026-06-28T06:45:07.135Z',
    idleSince: '2026-06-28T06:45:07.135Z',
    daysIdle: 74,
    thresholdDays: 30,
    thresholdSource: 'location_default',
    estimatedValueCents: 5000,
    ...over,
  };
}

function productRow(over: Record<string, unknown> = {}) {
  return { id: 'p1', isActive: true, defaultCostPerGramCents: 5, supplierId: 'sup-1', ...over };
}

function port(over: Record<string, unknown> = {}): ZacInventoryRead {
  return {
    listStock: jest.fn().mockResolvedValue({ stock: [stockRow()], locations: [], scope: 'owner' }),
    listLowStock: jest.fn().mockResolvedValue({ alerts: [] }),
    listDeadStock: jest.fn().mockResolvedValue({ items: [], locations: [], totalEstimatedValueCents: 0 }),
    listMovements: jest.fn().mockResolvedValue({ movements: [{ createdAt: '2026-08-26T00:00:00.000Z' }] }),
    listProducts: jest.fn().mockResolvedValue({ products: [productRow()] }),
    listSuppliers: jest.fn().mockResolvedValue({ suppliers: [] }),
    listCategories: jest.fn().mockResolvedValue({ categories: [] }),
    ...over,
  } as unknown as ZacInventoryRead;
}

function tool(p: ZacInventoryRead) {
  return new InventoryStockStatusTool(p);
}

describe('InventoryStockStatusTool — contract', () => {
  it('is live, read-only, fail-closed and owner/manager only', () => {
    const subject = tool(port());

    expect(subject.enabled).toBe(true);
    expect(subject.readOnly).toBe(true);
    expect(subject.errorBehavior).toBe('fail_closed');
    expect(subject.allowedRoles).toEqual(['owner', 'manager']);
  });

  it('requires inventory.manage — the key the service itself enforces on every read', () => {
    // A weaker declaration would be cosmetic: resolveLocationScope calls
    // assertManagerOrOwner, which is a real userHasPermission check, so the
    // service would throw and ZAC would have advertised a capability it cannot
    // deliver.
    expect(tool(port()).requiredPermissions).toEqual(['inventory.manage']);
  });
});

describe('InventoryStockStatusTool — not configured', () => {
  it('answers set-up, not "stock is healthy", when no stock records exist', async () => {
    const result = await tool(
      port({ listStock: jest.fn().mockResolvedValue({ stock: [], locations: [], scope: 'owner' }) }),
    ).execute(OWNER, CONTEXT, {});

    expect(result.status).toBe('ok');
    expect(result.presentation?.answer).toContain('set-up rather than a stock problem');
    expect(result.presentation?.answer).not.toContain('Nothing is at or below');
  });

  it('refuses to imply all is well when no threshold is set', async () => {
    // A threshold of 0 means "never flag this", so an empty low-stock list is
    // not evidence that nothing is low.
    const result = await tool(
      port({
        listStock: jest
          .fn()
          .mockResolvedValue({ stock: [stockRow({ effectiveLowStockThresholdGrams: 0 })], locations: [], scope: 'owner' }),
      }),
    ).execute(OWNER, CONTEXT, {});

    expect(result.presentation?.answer).toContain('cannot tell you what is running low');
    expect(result.presentation?.answer).toContain('never flag this');
  });
});

describe('InventoryStockStatusTool — low stock', () => {
  it('reports the live low-stock items and flags those that have run out', async () => {
    const low = [
      stockRow({ productId: 'p2', productName: 'SoColor 8N', quantityOnHandGrams: 50, effectiveLowStockThresholdGrams: 150 }),
      stockRow({ productId: 'p3', productName: 'Majirel 6.0', quantityOnHandGrams: 0, effectiveLowStockThresholdGrams: 100, locationName: 'Primrose Hill' }),
    ];
    const result = await tool(
      port({ listStock: jest.fn().mockResolvedValue({ stock: low, locations: [], scope: 'owner' }) }),
    ).execute(OWNER, CONTEXT, {});

    expect(result.data?.['low_stock_count']).toBe(2);
    expect(result.presentation?.answer).toContain('SoColor 8N');
    expect(result.presentation?.answer).toContain('run out completely');
  });

  it('reports the divergence between the live figures and the saved alert cache', async () => {
    // The live split-brain: 3 live-low rows against 2 open alert rows.
    const low = [stockRow({ productId: 'a' }), stockRow({ productId: 'b' }), stockRow({ productId: 'c' })];
    const result = await tool(
      port({
        listStock: jest.fn().mockResolvedValue({ stock: low, locations: [], scope: 'owner' }),
        listLowStock: jest.fn().mockResolvedValue({ alerts: [{ id: '1' }, { id: '2' }] }),
      }),
    ).execute(OWNER, CONTEXT, {});

    const limits = result.presentation?.limitations.join(' ') ?? '';
    expect(limits).toContain('2 open');
    expect(limits).toContain('I have used the live figures');
  });
});

describe('InventoryStockStatusTool — dead stock', () => {
  it('names the threshold and its source alongside the verdict', async () => {
    // Every live dead-stock row is flagged against a 30-day location default
    // Kensington deliberately set (the platform default is 90). Reporting the
    // verdict without the threshold presents a configuration choice as a
    // business problem.
    const items = [deadRow(), deadRow({ productId: 'p2', productName: 'No.2 Bond Perfector', daysIdle: 74 })];
    const result = await tool(
      port({
        listDeadStock: jest.fn().mockResolvedValue({ items, locations: [], totalEstimatedValueCents: 10_000 }),
      }),
    ).execute(OWNER, CONTEXT, {});

    expect(result.data?.['dead_stock_count']).toBe(2);
    expect(result.presentation?.answer).toContain("location's default of 30 days");
    expect(result.presentation?.answer).toContain('the threshold is the thing to change');
  });

  it('suppresses the value when too little of the catalogue records a cost', async () => {
    // 4 costed of 10 products is below the 50% floor; a total missing 60% of
    // its inputs is not a smaller number, it is a wrong one.
    const products = [
      ...Array.from({ length: 4 }, (_, i) => productRow({ id: `c${i}` })),
      ...Array.from({ length: 6 }, (_, i) => productRow({ id: `n${i}`, defaultCostPerGramCents: undefined })),
    ];
    const result = await tool(
      port({
        listDeadStock: jest.fn().mockResolvedValue({ items: [deadRow()], locations: [], totalEstimatedValueCents: 5000 }),
        listProducts: jest.fn().mockResolvedValue({ products }),
      }),
    ).execute(OWNER, CONTEXT, {});

    expect(result.data?.['dead_stock_value_cents']).toBeNull();
    expect(result.presentation?.answer).not.toContain('worth about');
  });

  it('quotes the value when enough of the catalogue is costed', async () => {
    const products = [
      ...Array.from({ length: 6 }, (_, i) => productRow({ id: `c${i}` })),
      ...Array.from({ length: 4 }, (_, i) => productRow({ id: `n${i}`, defaultCostPerGramCents: undefined })),
    ];
    const result = await tool(
      port({
        listDeadStock: jest.fn().mockResolvedValue({ items: [deadRow()], locations: [], totalEstimatedValueCents: 5000 }),
        listProducts: jest.fn().mockResolvedValue({ products }),
      }),
    ).execute(OWNER, CONTEXT, {});

    expect(result.data?.['dead_stock_value_cents']).toBe(5000);
    expect(result.presentation?.answer).toContain('£50.00');
  });
});

describe('InventoryStockStatusTool — ledger recency', () => {
  it('states the ledger date so idle stock is not mistaken for a purchasing problem', async () => {
    const result = await tool(
      port({
        listDeadStock: jest.fn().mockResolvedValue({ items: [deadRow()], locations: [], totalEstimatedValueCents: 0 }),
      }),
    ).execute(OWNER, CONTEXT, {});

    expect(result.presentation?.answer).toContain('26 August 2026');
    expect(result.presentation?.limitations.join(' ')).toContain('without being recorded');
  });
});

describe('InventoryStockStatusTool — degradation', () => {
  it('keeps the low-stock half when the dead-stock report fails', async () => {
    const result = await tool(
      port({
        listStock: jest
          .fn()
          .mockResolvedValueOnce({ stock: [stockRow()], locations: [], scope: 'owner' })
          .mockResolvedValueOnce({ stock: [stockRow({ quantityOnHandGrams: 5 })], locations: [], scope: 'owner' }),
        listDeadStock: jest.fn().mockRejectedValue(new Error('boom')),
      }),
    ).execute(OWNER, CONTEXT, {});

    expect(result.status).toBe('ok');
    expect(result.presentation?.limitations.join(' ')).toContain('could not read your dead-stock report');
  });

  it('degrades to unavailable when stock itself cannot be read', async () => {
    const result = await tool(
      port({ listStock: jest.fn().mockRejectedValue(new Error('boom')) }),
    ).execute(OWNER, CONTEXT, {});

    expect(result.status).toBe('unavailable');
    expect(result.data).toBeNull();
  });
});

describe('InventoryStockStatusTool — PII and call-through', () => {
  it('never carries the name of whoever moved the stock', async () => {
    const result = await tool(
      port({
        listMovements: jest.fn().mockResolvedValue({
          movements: [{ createdAt: '2026-08-26T00:00:00.000Z', createdByName: 'Maya Chen', createdBy: 'user-9' }],
        }),
      }),
    ).execute(OWNER, CONTEXT, {});

    expect(JSON.stringify(result)).not.toContain('Maya Chen');
  });

  it('passes the acting user through to every guarded read', async () => {
    const p = port();
    await tool(p).execute(OWNER, CONTEXT, {});

    expect(p.listStock).toHaveBeenCalledWith(OWNER, expect.any(Object));
    expect(p.listDeadStock).toHaveBeenCalledWith(OWNER, undefined);
  });
});
