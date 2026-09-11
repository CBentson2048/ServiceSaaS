/**
 * `previewReorder` — the READ-ONLY reorder path added for ZAC Phase 2
 * Workstream 3.
 *
 * THE FIREWALL IS THE POINT OF THIS FILE. Phase 2 is read-only and human-led:
 * ZAC may recommend an order, but must never create, approve or send one. The
 * only pre-existing implementation of the reorder algorithm was `generate()`,
 * which writes purchase orders, allocates gapless numbers, records an audit row
 * and emails a supplier.
 *
 * So the first four tests here do not check arithmetic. They check that nothing
 * happened: no insert, no update, no delete, no `create_purchase_order`, no
 * audit, no email. The arithmetic tests follow, and they exist to prove the
 * second half of the design — that preview and generate share ONE computation,
 * so ZAC's advice cannot drift from the draft the Generate button produces.
 */
import { ForbiddenException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { createClient } from '@supabase/supabase-js';
import type { AuthUser } from '@sheer/domain';
import { OrdersService } from './orders.service';
import type { AuditService } from '../audit/audit.service';
import type { EmailService } from '../email/email.service';

jest.mock('@supabase/supabase-js', () => ({ createClient: jest.fn() }));
const mockedCreateClient = createClient as jest.MockedFunction<typeof createClient>;

interface Captured {
  key: string;
  method: string;
}

const WRITE_VERBS = ['insert', 'update', 'upsert', 'delete'] as const;

function build(rows: Record<string, unknown[]>, rpc: Record<string, unknown> = {}) {
  const captured: Captured[] = [];
  const rpcCalls: { name: string; args: Record<string, unknown> }[] = [];

  const makeChain = (key: string) => {
    const chain: Record<string, unknown> = {};
    const methods = [
      'select', 'eq', 'in', 'order', 'limit', 'not', 'returns', 'or', 'ilike', 'gte', 'lt',
      ...WRITE_VERBS,
    ];
    for (const method of methods) {
      chain[method] = () => {
        captured.push({ key, method });
        return chain;
      };
    }
    chain.maybeSingle = async () => ({ data: rows[key]?.[0] ?? null, error: null });
    chain.single = chain.maybeSingle;
    chain.then = (resolve: (v: unknown) => unknown, reject?: (r: unknown) => unknown) =>
      Promise.resolve({ data: rows[key] ?? [], error: null }).then(resolve, reject);
    return chain;
  };

  mockedCreateClient.mockReturnValue({
    schema: () => ({
      from: (table: string) => makeChain(table),
      rpc: async (name: string, args: Record<string, unknown>) => {
        rpcCalls.push({ name, args });
        return { data: rpc[name] ?? [], error: null };
      },
    }),
  } as never);

  const audit = { record: jest.fn().mockResolvedValue(undefined) } as unknown as AuditService;
  const email = { send: jest.fn().mockResolvedValue({ delivered: true }) } as unknown as EmailService;
  const config = { getOrThrow: (key: string) => `test-${key}` } as unknown as ConfigService;
  return { service: new OrdersService(config, audit, email), captured, rpcCalls, audit, email };
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
  permissions: ['orders.view', 'orders.manage', 'orders.approve'],
} as unknown as AuthUser;

/** Holds orders.view ONLY — the minimum previewReorder is designed to accept. */
const VIEWER: AuthUser = {
  ...OWNER,
  id: 'user-3',
  roles: ['manager'],
  primaryRole: 'manager',
  permissions: ['orders.view'],
} as unknown as AuthUser;

const NO_ORDERS: AuthUser = { ...OWNER, id: 'user-4', permissions: [] } as unknown as AuthUser;

/**
 * The live Pinner shortfall, verbatim from the W1 evidence pass:
 * on hand 50, threshold 150, NO outbound usage in the 8-week window,
 * pack size 90 -> shortfall 100 -> 2 packs.
 */
function pinnerRows(overrides: Record<string, unknown[]> = {}) {
  return {
    locations: [{ id: 'loc-1', name: 'Pinner' }],
    location_settings: [{ reorder_usage_window_weeks: 8, reorder_coverage_weeks: 4 }],
    location_stock: [
      { product_id: 'prod-1', quantity_on_hand_grams: 50, low_stock_threshold_grams: 150 },
    ],
    products: [
      {
        id: 'prod-1',
        name: 'SoColor 8N Light Blonde',
        is_active: true,
        stock_unit: 'gram',
        pack_size: 90,
        size_value: 90,
        default_cost_per_gram_cents: 5,
        low_stock_threshold_grams: 150,
        supplier_id: 'sup-1',
        minimum_order_quantity: 1,
        order_multiple: 1,
      },
    ],
    suppliers: [{ id: 'sup-1', name: 'Wella Professionals', contact_email: null, account_reference: null, is_active: true }],
    purchase_orders: [],
    purchase_order_lines: [],
    businesses: [{ name: 'Salon' }],
    ...overrides,
  };
}

beforeEach(() => jest.clearAllMocks());

describe('previewReorder writes nothing — the read-only firewall', () => {
  it('issues no insert, update, upsert or delete', async () => {
    const { service, captured } = build(pinnerRows());

    await service.previewReorder(OWNER, 'loc-1');

    const writes = captured.filter((entry) => (WRITE_VERBS as readonly string[]).includes(entry.method));
    expect(writes).toEqual([]);
  });

  it('calls reorder_usage and NEVER create_purchase_order', async () => {
    const { service, rpcCalls } = build(pinnerRows());

    await service.previewReorder(OWNER, 'loc-1');

    expect(rpcCalls.map((call) => call.name)).toEqual(['reorder_usage']);
    // Named explicitly: this is the RPC that allocates a gapless PO number and
    // makes an order a commercial act.
    expect(rpcCalls.some((call) => call.name === 'create_purchase_order')).toBe(false);
  });

  it('records no audit entry — nothing happened worth auditing', async () => {
    const { service, audit } = build(pinnerRows());

    await service.previewReorder(OWNER, 'loc-1');

    expect(audit.record).toHaveBeenCalledTimes(0);
  });

  it('sends no supplier email', async () => {
    const { service, email } = build(pinnerRows());

    await service.previewReorder(OWNER, 'loc-1');

    expect(email.send).toHaveBeenCalledTimes(0);
  });
});

describe('previewReorder permissions', () => {
  it('accepts orders.view alone — advice must not require the power to act on it', async () => {
    const { service } = build(pinnerRows());

    await expect(service.previewReorder(VIEWER, 'loc-1')).resolves.toBeDefined();
  });

  it('refuses an actor with no orders permission at all', async () => {
    const { service } = build(pinnerRows());

    await expect(service.previewReorder(NO_ORDERS, 'loc-1')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('refuses a location outside the actor scope', async () => {
    const { service } = build(pinnerRows());
    const scoped = { ...VIEWER, roles: ['manager'], allowedLocationIds: ['loc-9'] } as unknown as AuthUser;

    await expect(service.previewReorder(scoped, 'loc-1')).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('previewReorder arithmetic matches what generate would draft', () => {
  it('reproduces the live Pinner suggestion: 100g short, pack 90 -> 2 packs', async () => {
    const { service } = build(pinnerRows());

    const preview = await service.previewReorder(OWNER, 'loc-1');

    expect(preview.lines).toHaveLength(1);
    expect(preview.lines[0]).toMatchObject({
      productId: 'prod-1',
      productName: 'SoColor 8N Light Blonde',
      supplierName: 'Wella Professionals',
      suggestedQuantity: 2,
      shortfallBase: 100,
      onHandBase: 50,
      thresholdBase: 150,
      outboundBaseInWindow: 0,
    });
  });

  it('reports usageObserved false when nothing was deducted in the window', async () => {
    // Every suggested line on the live database has zero recorded usage, so the
    // suggestion is a threshold top-up. Claiming "based on your usage" over
    // this would be an invented justification.
    const { service } = build(pinnerRows());

    const preview = await service.previewReorder(OWNER, 'loc-1');

    expect(preview.usageObserved).toBe(false);
  });

  it('reports usageObserved true when the window does carry outbound movement', async () => {
    const { service } = build(pinnerRows(), {
      reorder_usage: [{ product_id: 'prod-1', outbound_base: 240 }],
    });

    const preview = await service.previewReorder(OWNER, 'loc-1');

    expect(preview.usageObserved).toBe(true);
    expect(preview.lines[0]?.outboundBaseInWindow).toBe(240);
  });

  it('surfaces the location settings the forecast used', async () => {
    const { service } = build(pinnerRows());

    const preview = await service.previewReorder(OWNER, 'loc-1');

    expect(preview).toMatchObject({ locationId: 'loc-1', windowWeeks: 8, coverageWeeks: 4 });
    expect(Date.parse(preview.windowFromIso)).not.toBeNaN();
  });

  it('reports a product with no supplier as unorderable rather than omitting it', async () => {
    // 8 of 10 products on the live catalogue have no supplier. Silently dropping
    // them would hide the single most actionable finding.
    const rows = pinnerRows();
    (rows.products[0] as Record<string, unknown>).supplier_id = null;
    const { service } = build(rows);

    const preview = await service.previewReorder(OWNER, 'loc-1');

    expect(preview.lines).toEqual([]);
    expect(preview.unorderable).toEqual([
      { productId: 'prod-1', productName: 'SoColor 8N Light Blonde', reason: 'no_supplier' },
    ]);
  });

  it('reports a gram product with no pack size as unorderable, never guessing one', async () => {
    const rows = pinnerRows();
    Object.assign(rows.products[0] as Record<string, unknown>, { pack_size: null, size_value: null });
    const { service } = build(rows);

    const preview = await service.previewReorder(OWNER, 'loc-1');

    expect(preview.unorderable[0]).toMatchObject({ reason: 'no_pack_size' });
  });

  it('leaves a line total NULL when the product records no cost — never 0', async () => {
    // A cost-less line summing as zero is how an order total silently
    // under-reports what it will cost.
    const rows = pinnerRows();
    (rows.products[0] as Record<string, unknown>).default_cost_per_gram_cents = null;
    const { service } = build(rows);

    const preview = await service.previewReorder(OWNER, 'loc-1');

    expect(preview.lines[0]?.lineTotalCents).toBeNull();
    expect(preview.lines[0]?.unitCostCents).toBeNull();
    expect(preview.linesWithoutCost).toBe(1);
  });

  it('flags which rounding rules actually moved the number', async () => {
    const rows = pinnerRows();
    Object.assign(rows.products[0] as Record<string, unknown>, {
      minimum_order_quantity: 6,
      order_multiple: 6,
    });
    const { service } = build(rows);

    const preview = await service.previewReorder(OWNER, 'loc-1');

    // Bare need is 2 packs; MOQ 6 raises it. The multiple then does not move it
    // further, so it must not be cited as a reason.
    expect(preview.lines[0]).toMatchObject({
      suggestedQuantity: 6,
      roundedUpByMinimumOrderQuantity: true,
      roundedUpByOrderMultiple: false,
    });
  });

  it('does not cite MOQ or order multiple when both are 1 — as on every live product', async () => {
    const { service } = build(pinnerRows());

    const preview = await service.previewReorder(OWNER, 'loc-1');

    expect(preview.lines[0]).toMatchObject({
      roundedUpByMinimumOrderQuantity: false,
      roundedUpByOrderMultiple: false,
    });
  });

  it('returns nothing to order when the shelf is above its reorder point', async () => {
    const rows = pinnerRows();
    (rows.location_stock[0] as Record<string, unknown>).quantity_on_hand_grams = 5000;
    const { service } = build(rows);

    const preview = await service.previewReorder(OWNER, 'loc-1');

    expect(preview.lines).toEqual([]);
    expect(preview.unorderable).toEqual([]);
  });

  it('orders lines by the size of the gap, so the worst shortfall reads first', async () => {
    const rows = pinnerRows({
      location_stock: [
        { product_id: 'prod-1', quantity_on_hand_grams: 50, low_stock_threshold_grams: 150 },
        { product_id: 'prod-2', quantity_on_hand_grams: 0, low_stock_threshold_grams: 500 },
      ],
    });
    (rows.products as Record<string, unknown>[]).push({
      ...(rows.products[0] as Record<string, unknown>),
      id: 'prod-2',
      name: 'Majirel 6.0 Dark Blonde',
    });
    const { service } = build(rows);

    const preview = await service.previewReorder(OWNER, 'loc-1');

    expect(preview.lines.map((line) => line.shortfallBase)).toEqual([500, 100]);
  });
});
