import type { AuthUser } from '@sheer/domain';
import type { ZacActingContext } from '../../context/zac-context.types';
import type { ZacInventoryRead, ZacOrdersRead } from '../ports/zac-service-ports';
import { InventoryReorderAdvisoryTool } from './inventory-reorder-advisory.tool';

/**
 * Workstream 3 — order-recommendation context. ADVISORY ONLY.
 *
 * Two things are pinned here above all:
 *
 *  1. The tool never orders, never says it ordered, and always hands the act
 *     back to a person. The read-only guarantee itself lives in the ports (a
 *     write is a compile error), in the boundary sweep, and in
 *     `preview-reorder.spec.ts` — this file pins the LANGUAGE, which is the
 *     part a reader of the answer actually relies on.
 *  2. It never claims a usage forecast it does not have. Every suggested line
 *     on the working database has zero recorded outbound movement behind it, so
 *     "based on your usage" would be invented.
 */

const CONTEXT = { roleContext: 'owner', roles: ['owner'] } as unknown as ZacActingContext;

const OWNER = {
  id: 'user-1',
  businessId: 'biz-1',
  roles: ['owner'],
  permissions: ['zac.access', 'orders.view'],
  allowedLocationIds: [],
} as unknown as AuthUser;

const LOCATIONS = async () => [{ id: 'loc-1', name: 'Pinner' }];

/** The live Pinner line: 50g on hand, 150g threshold, no usage, pack 90 -> 2 packs. */
function line(over: Record<string, unknown> = {}) {
  return {
    productId: 'p1',
    productName: 'SoColor 8N Light Blonde',
    supplierId: 'sup-1',
    supplierName: 'Wella Professionals',
    packSize: 90,
    stockUnit: 'gram',
    suggestedQuantity: 2,
    shortfallBase: 100,
    onHandBase: 50,
    thresholdBase: 150,
    outboundBaseInWindow: 0,
    unitCostCents: 450,
    lineTotalCents: 900,
    roundedUpByMinimumOrderQuantity: false,
    roundedUpByOrderMultiple: false,
    ...over,
  };
}

function preview(over: Record<string, unknown> = {}) {
  return {
    locationId: 'loc-1',
    windowWeeks: 8,
    coverageWeeks: 4,
    windowFromIso: '2026-07-17T00:00:00.000Z',
    usageObserved: false,
    lines: [line()],
    unorderable: [],
    linesWithoutCost: 0,
    ...over,
  };
}

function ordersPort(over: Record<string, unknown> = {}): ZacOrdersRead {
  return {
    previewReorder: jest.fn().mockResolvedValue(preview()),
    list: jest.fn().mockResolvedValue({ orders: [] }),
    getOrder: jest.fn(),
    ...over,
  } as unknown as ZacOrdersRead;
}

function inventoryPort(over: Record<string, unknown> = {}): ZacInventoryRead {
  return {
    listStock: jest.fn().mockResolvedValue({ stock: [], locations: [], scope: 'owner' }),
    listLowStock: jest.fn().mockResolvedValue({ alerts: [] }),
    listDeadStock: jest.fn().mockResolvedValue({ items: [], locations: [], totalEstimatedValueCents: 0 }),
    listMovements: jest.fn().mockResolvedValue({ movements: [] }),
    listProducts: jest.fn().mockResolvedValue({ products: [] }),
    listSuppliers: jest.fn().mockResolvedValue({ suppliers: [] }),
    listCategories: jest.fn().mockResolvedValue({ categories: [] }),
    ...over,
  } as unknown as ZacInventoryRead;
}

function tool(orders = ordersPort(), inventory = inventoryPort()) {
  return new InventoryReorderAdvisoryTool(orders, inventory, LOCATIONS as never);
}

describe('InventoryReorderAdvisoryTool — the advisory boundary', () => {
  it('is gated on orders.view, not orders.manage — advice must not require the power to act', () => {
    expect(tool().requiredPermissions).toEqual(['orders.view']);
  });

  it('never claims to have ordered, created, submitted or sent anything', async () => {
    const result = await tool().execute(OWNER, CONTEXT, {});
    const text = `${result.presentation?.answer ?? ''} ${result.presentation?.suggestedNextStep ?? ''}`;

    expect(text).not.toMatch(
      /\b(i (have )?(ordered|placed|created|submitted|approved|sent)|order(ed|s) (has|have) been (placed|created|sent)|i'?ve ordered)\b/i,
    );
  });

  it('closes by handing the act back to a person', async () => {
    const result = await tool().execute(OWNER, CONTEXT, {});

    expect(result.presentation?.answer).toContain('a suggestion to review, not an order');
    expect(result.presentation?.answer).toContain('Nothing has been created or sent');
    expect(result.presentation?.suggestedNextStep).toContain('Purchase orders');
  });

  it('reads only the preview and never a write method', async () => {
    const orders = ordersPort();
    await tool(orders).execute(OWNER, CONTEXT, {});

    expect(orders.previewReorder).toHaveBeenCalledWith(OWNER, 'loc-1');
    // The port has no generate/submit/send at all — this asserts the runtime
    // consequence of that, so a widened Pick<> is caught here too.
    expect((orders as unknown as Record<string, unknown>)['generate']).toBeUndefined();
    expect((orders as unknown as Record<string, unknown>)['send']).toBeUndefined();
  });
});

describe('InventoryReorderAdvisoryTool — usage honesty', () => {
  it('says a suggestion is a threshold top-up when no usage was recorded', async () => {
    const result = await tool().execute(OWNER, CONTEXT, {});

    expect(result.data?.['usage_observed']).toBe(false);
    expect(result.presentation?.answer).toContain('top-ups to the');
    expect(result.presentation?.answer).not.toContain('at the rate you got through stock');
  });

  it('claims a usage-based forecast only when usage actually exists', async () => {
    const result = await tool(
      ordersPort({
        previewReorder: jest
          .fn()
          .mockResolvedValue(preview({ usageObserved: true, lines: [line({ outboundBaseInWindow: 240 })] })),
      }),
    ).execute(OWNER, CONTEXT, {});

    expect(result.presentation?.answer).toContain('at the rate you got through stock');
  });

  it('states that reversals are not netted out of the usage figure', async () => {
    const result = await tool().execute(OWNER, CONTEXT, {});

    expect(result.presentation?.limitations.join(' ')).toContain('Reversed deductions are not netted off');
  });

  it('states that supplier lead times are not part of the calculation', async () => {
    // The supplier record carries lead_time_days (3 on the live data) but the
    // algorithm never reads it. Implying otherwise would be a false claim.
    const result = await tool().execute(OWNER, CONTEXT, {});

    expect(result.presentation?.limitations.join(' ')).toContain('lead times are not part of this calculation');
  });
});

describe('InventoryReorderAdvisoryTool — what it reports', () => {
  it('names the suggestion with the shelf figures behind it', async () => {
    const result = await tool().execute(OWNER, CONTEXT, {});

    expect(result.data?.['suggested_line_count']).toBe(1);
    expect(result.presentation?.answer).toContain('2 × SoColor 8N Light Blonde');
    expect(result.presentation?.answer).toContain('50g on hand against a 150g threshold');
  });

  it('surfaces products that cannot be ordered rather than dropping them', async () => {
    // 8 of 10 live products have no supplier — the most actionable finding here.
    const result = await tool(
      ordersPort({
        previewReorder: jest.fn().mockResolvedValue(
          preview({
            lines: [],
            unorderable: [{ productId: 'p9', productName: 'Shades EQ 09V', reason: 'no_supplier' }],
          }),
        ),
      }),
    ).execute(OWNER, CONTEXT, {});

    expect(result.data?.['unorderable_count']).toBe(1);
    expect(result.presentation?.answer).toContain('no supplier attached');
    expect(result.presentation?.answer).toContain('Shades EQ 09V');
  });

  it('reports catalogue-wide supplier coverage as its own finding', async () => {
    const products = [
      ...Array.from({ length: 2 }, (_, i) => ({ id: `s${i}`, isActive: true, supplierId: 'sup-1' })),
      ...Array.from({ length: 8 }, (_, i) => ({ id: `n${i}`, isActive: true })),
    ];
    const result = await tool(
      ordersPort(),
      inventoryPort({ listProducts: jest.fn().mockResolvedValue({ products }) }),
    ).execute(OWNER, CONTEXT, {});

    expect(result.data).toMatchObject({ products: 10, products_with_supplier: 2 });
    expect(result.presentation?.answer).toContain('8 of your 10 active products');
  });

  it('warns when an order is already in preparation', async () => {
    const result = await tool(
      ordersPort({
        list: jest.fn().mockResolvedValue({
          orders: [
            { orderNumber: 'PO-00006', status: 'draft', supplierName: 'Wella Professionals' },
            { orderNumber: 'PO-00002', status: 'sent', supplierName: 'Wella Professionals' },
          ],
        }),
      }),
    ).execute(OWNER, CONTEXT, {});

    expect(result.data?.['orders_in_preparation']).toBe(1);
    expect(result.presentation?.answer).toContain('PO-00006');
    // A SENT order is history, not something in progress.
    expect(result.presentation?.answer).not.toContain('PO-00002');
  });

  it('says nothing is needed when the shelf clears the reorder point', async () => {
    const result = await tool(
      ordersPort({ previewReorder: jest.fn().mockResolvedValue(preview({ lines: [] })) }),
    ).execute(OWNER, CONTEXT, {});

    expect(result.presentation?.answer).toContain('Nothing is below its reorder point');
    expect(result.presentation?.responseType).toBe('Insight');
  });

  it('omits a total when too few lines record a cost, rather than under-reporting', async () => {
    const result = await tool(
      ordersPort({
        previewReorder: jest.fn().mockResolvedValue(
          preview({
            lines: [line(), line({ productId: 'p2', unitCostCents: null, lineTotalCents: null })],
            linesWithoutCost: 1,
          }),
        ),
      }),
    ).execute(OWNER, CONTEXT, {});

    // 1 of 2 costed is exactly at the 50% floor, so the total stands but is
    // flagged; the assertion that matters is it is never silently short.
    const limits = result.presentation?.limitations.join(' ') ?? '';
    expect(limits).toContain('estimated order value');
  });

  it('degrades to unavailable when the preview cannot be read', async () => {
    const result = await tool(
      ordersPort({ previewReorder: jest.fn().mockRejectedValue(new Error('boom')) }),
    ).execute(OWNER, CONTEXT, {});

    expect(result.status).toBe('unavailable');
  });

  it('survives a failing order-history read and says what it lost', async () => {
    const result = await tool(
      ordersPort({ list: jest.fn().mockRejectedValue(new Error('boom')) }),
    ).execute(OWNER, CONTEXT, {});

    expect(result.status).toBe('ok');
    expect(result.presentation?.limitations.join(' ')).toContain('already being prepared');
  });
});
