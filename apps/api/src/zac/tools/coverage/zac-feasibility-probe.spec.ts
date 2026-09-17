import type { AuthUser } from '@sheer/domain';
import type { ZacInventoryRead, ZacLabAnalyticsRead } from '../ports/zac-service-ports';
import { probeColourCoverage, probeStockCoverage } from './zac-feasibility-probe';

/**
 * The probe's whole job is to keep ZAC from reporting an absence as a result.
 * Every case below is a shape that exists on the working database today.
 */

const NOW = Date.parse('2026-09-11T12:00:00.000Z');
const WINDOW_FROM = '2026-06-13T12:00:00.000Z'; // 90 days back
const WINDOW_TO = '2026-09-11T12:00:00.000Z';

const OWNER = {
  id: 'user-1',
  businessId: 'biz-1',
  roles: ['owner'],
  permissions: ['inventory.manage', 'report.lab_analytics.view'],
  allowedLocationIds: [],
} as unknown as AuthUser;

function stockPort(overrides: Partial<Record<keyof ZacInventoryRead, unknown>> = {}): ZacInventoryRead {
  return {
    listStock: jest.fn().mockResolvedValue({ stock: [], locations: [], scope: 'owner' }),
    listLowStock: jest.fn().mockResolvedValue({ alerts: [] }),
    listDeadStock: jest.fn().mockResolvedValue({ items: [], locations: [], totalEstimatedValueCents: 0 }),
    listMovements: jest.fn().mockResolvedValue({ movements: [] }),
    listProducts: jest.fn().mockResolvedValue({ products: [] }),
    listSuppliers: jest.fn().mockResolvedValue({ suppliers: [] }),
    listCategories: jest.fn().mockResolvedValue({ categories: [] }),
    ...overrides,
  } as unknown as ZacInventoryRead;
}

function stockRow(over: Record<string, unknown> = {}) {
  return {
    isActive: true,
    effectiveLowStockThresholdGrams: 20,
    quantityOnHandGrams: 300,
    isLowStock: false,
    ...over,
  };
}

function product(over: Record<string, unknown> = {}) {
  return { isActive: true, defaultCostPerGramCents: 5, supplierId: 'sup-1', ...over };
}

describe('probeStockCoverage', () => {
  it('reports not_configured when the salon has no stock records — nine of eleven tenants', () => {
    return probeStockCoverage(stockPort(), OWNER, { windowFromIso: WINDOW_FROM, nowMs: NOW }).then((probe) => {
      expect(probe.verdict).toBe('not_configured');
      expect(probe.stockRecords).toBe(0);
    });
  });

  it('warns when stock exists but no threshold is set — zero means never-low, not always-low', async () => {
    const probe = await probeStockCoverage(
      stockPort({
        listStock: jest.fn().mockResolvedValue({
          stock: [stockRow({ effectiveLowStockThresholdGrams: 0 }), stockRow({ effectiveLowStockThresholdGrams: 0 })],
          locations: [],
          scope: 'owner',
        }),
        listMovements: jest
          .fn()
          .mockResolvedValue({ movements: [{ createdAt: '2026-09-10T00:00:00.000Z' }] }),
      }),
      OWNER,
      { windowFromIso: WINDOW_FROM, nowMs: NOW },
    );

    expect(probe.thresholdsConfigured).toBe(0);
    expect(probe.limitations.join(' ')).toContain('never flag this');
  });

  it('flags a stale ledger — the live one stops 2026-08-26, 16 days ago', async () => {
    const probe = await probeStockCoverage(
      stockPort({
        listStock: jest.fn().mockResolvedValue({ stock: [stockRow()], locations: [], scope: 'owner' }),
        listMovements: jest.fn().mockResolvedValue({ movements: [{ createdAt: '2026-08-26T00:00:00.000Z' }] }),
      }),
      OWNER,
      { windowFromIso: '2026-09-04T00:00:00.000Z', nowMs: NOW },
    );

    expect(probe.verdict).toBe('stale');
    expect(probe.ledger).toMatchObject({ daysSince: 16, predatesWindow: true });
  });

  it('is ready when stock is configured and the ledger is inside the window', async () => {
    const probe = await probeStockCoverage(
      stockPort({
        listStock: jest.fn().mockResolvedValue({ stock: [stockRow()], locations: [], scope: 'owner' }),
        listMovements: jest.fn().mockResolvedValue({ movements: [{ createdAt: '2026-09-09T00:00:00.000Z' }] }),
      }),
      OWNER,
      { windowFromIso: '2026-09-04T00:00:00.000Z', nowMs: NOW },
    );

    expect(probe.verdict).toBe('ready');
  });

  it('measures catalogue coverage: 6 of 10 costed, 2 of 10 with a supplier', async () => {
    const products = [
      ...Array.from({ length: 6 }, () => product()),
      ...Array.from({ length: 4 }, () => product({ defaultCostPerGramCents: undefined, supplierId: undefined })),
    ];
    // Only 2 of the 6 costed ones actually carry a supplier, matching the live
    // catalogue where 8 of 10 products have none.
    products[2] = product({ supplierId: undefined });
    products[3] = product({ supplierId: undefined });
    products[4] = product({ supplierId: undefined });
    products[5] = product({ supplierId: undefined });

    const probe = await probeStockCoverage(
      stockPort({
        listStock: jest.fn().mockResolvedValue({ stock: [stockRow()], locations: [], scope: 'owner' }),
        listProducts: jest.fn().mockResolvedValue({ products }),
      }),
      OWNER,
      { windowFromIso: WINDOW_FROM, nowMs: NOW },
    );

    expect(probe).toMatchObject({ products: 10, productsWithCost: 6, productsWithSupplier: 2 });
  });

  it('degrades to unreadable when the stock read throws, without claiming emptiness', async () => {
    const probe = await probeStockCoverage(
      stockPort({ listStock: jest.fn().mockRejectedValue(new Error('boom')) }),
      OWNER,
      { windowFromIso: WINDOW_FROM, nowMs: NOW },
    );

    expect(probe.verdict).toBe('unreadable');
    expect(probe.limitations.join(' ')).toContain('could not read your stock levels');
  });

  it('survives a failing catalogue read — a secondary read must not sink the answer', async () => {
    const probe = await probeStockCoverage(
      stockPort({
        listStock: jest.fn().mockResolvedValue({ stock: [stockRow()], locations: [], scope: 'owner' }),
        listProducts: jest.fn().mockRejectedValue(new Error('boom')),
        listMovements: jest.fn().mockResolvedValue({ movements: [{ createdAt: '2026-09-09T00:00:00.000Z' }] }),
      }),
      OWNER,
      { windowFromIso: '2026-09-04T00:00:00.000Z', nowMs: NOW },
    );

    expect(probe.verdict).toBe('ready');
    expect(probe.limitations.join(' ')).toContain('could not read your product catalogue');
  });

  it('asks the ledger for one row only — a point read, not a scan', async () => {
    const listMovements = jest.fn().mockResolvedValue({ movements: [] });
    await probeStockCoverage(
      stockPort({
        listStock: jest.fn().mockResolvedValue({ stock: [stockRow()], locations: [], scope: 'owner' }),
        listMovements,
      }),
      OWNER,
      { windowFromIso: WINDOW_FROM, nowMs: NOW },
    );

    expect(listMovements).toHaveBeenCalledWith(OWNER, expect.objectContaining({ limit: 1 }));
  });

  it('passes the acting user through unchanged to every read', async () => {
    const listStock = jest.fn().mockResolvedValue({ stock: [stockRow()], locations: [], scope: 'owner' });
    await probeStockCoverage(stockPort({ listStock }), OWNER, {
      windowFromIso: WINDOW_FROM,
      nowMs: NOW,
    });
    // ZAC never opens its own client; the guarded service re-checks the actor.
    expect(listStock).toHaveBeenCalledWith(OWNER, expect.any(Object));
  });
});

function labPort(windowMixed: number, baselineMixed: number, baselineWasteCents = 0): ZacLabAnalyticsRead {
  const summary = jest.fn().mockImplementation((_actor, _range, _loc, from: string) => {
    const isBaseline = Date.parse(from) < Date.parse(WINDOW_FROM);
    return Promise.resolve({
      summary: {
        formulasMixed: isBaseline ? baselineMixed : windowMixed,
        wasteCostCents: isBaseline ? baselineWasteCents : 0,
      },
    });
  });
  return { summary } as unknown as ZacLabAnalyticsRead;
}

describe('probeColourCoverage', () => {
  const opts = {
    windowFromIso: WINDOW_FROM,
    windowToIso: WINDOW_TO,
    nowMs: NOW,
    baselineDays: 365,
  };

  it('reports not_configured when no formula has ever been saved', async () => {
    const probe = await probeColourCoverage(labPort(0, 0), OWNER, opts);
    expect(probe.verdict).toBe('not_configured');
  });

  it('distinguishes stale from never-configured — the baseline is what makes that possible', async () => {
    // The live Salon shape: nothing in a recent window, but 5 formulas on record.
    const probe = await probeColourCoverage(labPort(0, 5), OWNER, opts);

    expect(probe.verdict).toBe('stale');
    expect(probe).toMatchObject({ formulasInWindow: 0, formulasInBaseline: 5 });
  });

  it('is ready when the window itself carries colour work', async () => {
    const probe = await probeColourCoverage(labPort(5, 5), OWNER, opts);
    expect(probe.verdict).toBe('ready');
  });

  it('detects that waste is never captured — true for every formula on the database', async () => {
    const probe = await probeColourCoverage(labPort(5, 5, 0), OWNER, opts);
    expect(probe.wasteNeverCaptured).toBe(true);
  });

  it('does not claim waste is uncaptured when some was recorded', async () => {
    const probe = await probeColourCoverage(labPort(5, 5, 1200), OWNER, opts);
    expect(probe.wasteNeverCaptured).toBe(false);
  });

  it('always asks for an explicit custom window, never a preset', async () => {
    const port = labPort(5, 5);
    await probeColourCoverage(port, OWNER, opts);

    // The service's presets resolve in the API host's local timezone while ZAC
    // works in UTC; a preset would silently shift the window.
    for (const call of (port.summary as jest.Mock).mock.calls) {
      expect(call[1]).toBe('custom');
      expect(typeof call[3]).toBe('string');
      expect(typeof call[4]).toBe('string');
    }
  });

  it('degrades to unreadable when the window read throws', async () => {
    const port = { summary: jest.fn().mockRejectedValue(new Error('boom')) } as unknown as ZacLabAnalyticsRead;
    const probe = await probeColourCoverage(port, OWNER, opts);

    expect(probe.verdict).toBe('unreadable');
  });

  it('survives a failing baseline read and says it lost that context', async () => {
    const summary = jest
      .fn()
      .mockResolvedValueOnce({ summary: { formulasMixed: 3, wasteCostCents: 0 } })
      .mockRejectedValueOnce(new Error('boom'));
    const probe = await probeColourCoverage({ summary } as unknown as ZacLabAnalyticsRead, OWNER, opts);

    expect(probe.verdict).toBe('ready');
    expect(probe.limitations.join(' ')).toContain('longer colour history');
  });
});
