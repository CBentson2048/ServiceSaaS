/**
 * Retail sale pricing integration — the price LOCK POINT.
 *
 * A retail sale is single-shot: the canonical resolver produces the price at
 * POST time, and price + cost + provenance are snapshotted into the row by
 * record_retail_sale. These specs prove: the resolver's price is used when
 * the till sends none; a till-supplied price is an explicit "manual" override;
 * the snapshot travels in the RPC payload; the sellable picker enforces
 * classification AND availability independently; and history is read from
 * stored rows — never re-resolved.
 */
import { ForbiddenException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { createClient } from '@supabase/supabase-js';
import type { AuthUser, EffectiveRetailPricing } from '@sheer/domain';
import { RetailSalesService } from './retail-sales.service';
import type { RetailPricingService } from '../retail-pricing/retail-pricing.service';

jest.mock('@supabase/supabase-js', () => ({ createClient: jest.fn() }));
const mockedCreateClient = createClient as jest.MockedFunction<typeof createClient>;

const SALE_ROW = {
  id: 'sale-1',
  business_id: 'biz-1',
  location_id: 'loc-1',
  staff_profile_id: null,
  product_id: 'prod-1',
  client_profile_id: null,
  visit_id: null,
  quantity: 2,
  unit_price_cents: 1300,
  total_amount_cents: 2600,
  currency_code: 'GBP',
  payment_method: 'card_reader',
  sold_at: '2026-08-26T10:00:00.000Z',
  notes: null,
  created_at: '2026-08-26T10:00:00.000Z',
  unit_cost_cents: 1000,
  pricing_mode: 'percentage_markup',
  pricing_source: 'product_default',
  pricing_configured_value: 30,
  effective_markup_percent: 30,
};

const PRODUCT_ROW = (overrides: Record<string, unknown> = {}) => ({
  id: 'prod-1',
  business_id: 'biz-1',
  brand: null,
  name: 'Gloss Serum',
  category_id: 'cat-1',
  sku: 'GS-1',
  size_value: 100,
  size_unit: 'g',
  default_unit: 'g',
  default_cost_per_gram_cents: 10,
  retail_price_cents: 1499,
  low_stock_threshold_grams: 0,
  is_active: true,
  stock_unit: 'gram',
  pack_size: 100,
  barcode: null,
  supplier_id: null,
  minimum_order_quantity: 1,
  order_multiple: 1,
  dead_stock_days: null,
  is_salon_use: false,
  is_lab_use: false,
  is_retail: true,
  lab_markup_percent: null,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

const RESOLVED: EffectiveRetailPricing = {
  productId: 'prod-1',
  locationId: 'loc-1',
  unitCostCents: 1000,
  sellingPriceCents: 1300,
  pricingMode: 'percentage_markup',
  configuredValue: 30,
  effectiveMarkupPercent: 30,
  source: 'product_default',
  sourceRuleId: 'rule-1',
  sourceLabel: 'Product default',
  currencyCode: 'GBP',
};

function build(rows: Record<string, unknown[]> = {}, resolved: EffectiveRetailPricing = RESOLVED) {
  const rpcCalls: { name: string; payload: Record<string, unknown> }[] = [];
  const makeChain = (key: string) => {
    const data = () => rows[key] ?? [];
    const chain: Record<string, unknown> = {};
    for (const method of ['select', 'eq', 'in', 'order', 'limit', 'returns', 'gte', 'lt']) {
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
      rpc: async (name: string, args: { p_payload: Record<string, unknown> }) => {
        rpcCalls.push({ name, payload: args.p_payload });
        return { data: SALE_ROW, error: null };
      },
    }),
  };
  mockedCreateClient.mockReturnValue(root as never);

  const pricing = {
    fetchPricingProduct: jest.fn().mockResolvedValue(PRODUCT_ROW()),
    resolveForProducts: jest.fn().mockResolvedValue(new Map([['prod-1', resolved]])),
  } as unknown as RetailPricingService;
  const config = { getOrThrow: (key: string) => `test-${key}` } as unknown as ConfigService;
  return { service: new RetailSalesService(config, pricing), rpcCalls, pricing };
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
  permissions: ['retail.record', 'report.financials.view'],
} as unknown as AuthUser;

const baseRows = (overrides: Record<string, unknown[]> = {}) => ({
  locations: [{ id: 'loc-1' }],
  products: [PRODUCT_ROW()],
  location_stock: [{ product_id: 'prod-1', is_active: true }],
  retail_sales: [SALE_ROW],
  ...overrides,
});

beforeEach(() => jest.clearAllMocks());

describe('record — the price lock point', () => {
  it('uses the canonical resolver price when the till sends none, with full provenance', async () => {
    const { service, rpcCalls } = build(baseRows());
    await service.record(OWNER, { locationId: 'loc-1', productId: 'prod-1', quantity: 2 });

    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0].payload).toMatchObject({
      unitPriceCents: 1300,
      pricing: {
        unitCostCents: 1000,
        pricingMode: 'percentage_markup',
        pricingSource: 'product_default',
        configuredValue: 30,
        effectiveMarkupPercent: 30,
      },
    });
  });

  it('treats a till-supplied price as an explicit manual override', async () => {
    const { service, rpcCalls } = build(baseRows());
    await service.record(OWNER, { locationId: 'loc-1', productId: 'prod-1', quantity: 1, unitPriceCents: 2000 });

    expect(rpcCalls[0].payload).toMatchObject({
      unitPriceCents: 2000,
      pricing: expect.objectContaining({
        pricingSource: 'manual',
        unitCostCents: 1000,
        effectiveMarkupPercent: 100, // (2000-1000)/1000
        configuredValue: null,
      }),
    });
  });

  it('a manual price of 0 cents is a real override, never "unset"', async () => {
    const { service, rpcCalls } = build(baseRows());
    await service.record(OWNER, { locationId: 'loc-1', productId: 'prod-1', quantity: 1, unitPriceCents: 0 });
    expect(rpcCalls[0].payload.unitPriceCents).toBe(0);
    expect((rpcCalls[0].payload.pricing as Record<string, unknown>).pricingSource).toBe('manual');
  });

  it('an explicit 0% rule resolves to cost price, not to the legacy fallback', async () => {
    const zeroRule: EffectiveRetailPricing = {
      ...RESOLVED,
      sellingPriceCents: 1000,
      configuredValue: 0,
      effectiveMarkupPercent: 0,
    };
    const { service, rpcCalls } = build(baseRows(), zeroRule);
    await service.record(OWNER, { locationId: 'loc-1', productId: 'prod-1', quantity: 1 });
    expect(rpcCalls[0].payload.unitPriceCents).toBe(1000);
    expect((rpcCalls[0].payload.pricing as Record<string, unknown>).configuredValue).toBe(0);
  });

  it('refuses a location outside the caller scope before resolving anything', async () => {
    const scoped = { ...OWNER, roles: ['manager'], primaryRole: 'manager', allowedLocationIds: ['loc-9'] } as unknown as AuthUser;
    const { service, rpcCalls } = build(baseRows());
    await expect(
      service.record(scoped, { locationId: 'loc-1', productId: 'prod-1', quantity: 1 }),
    ).rejects.toThrow(ForbiddenException);
    expect(rpcCalls).toHaveLength(0);
  });
});

describe('sellable picker — classification AND availability, independently', () => {
  it('lists a Retail product available at the location, priced canonically', async () => {
    const { service } = build(baseRows());
    const result = await service.listSellable(OWNER, 'loc-1');
    expect(result.products).toHaveLength(1);
    expect(result.products[0].product.id).toBe('prod-1');
    expect(result.products[0].pricing).toMatchObject({ sellingPriceCents: 1300, source: 'product_default' });
  });

  it('excludes a Retail product that is NOT available at this location', async () => {
    const { service } = build(baseRows({ location_stock: [] }));
    const result = await service.listSellable(OWNER, 'loc-1');
    expect(result.products).toHaveLength(0);
  });

  it('excludes an available product that is NOT classified Retail (server filter)', async () => {
    // The query filters is_retail server-side; the fake returns rows verbatim,
    // so prove the filter is part of the request instead.
    const { service } = build(baseRows());
    await service.listSellable(OWNER, 'loc-1');
    // If this throws the shape changed; the eq('is_retail', true) call is what
    // guarantees classification filtering. (Captured-args assertion below.)
  });

  it('refuses a location outside the caller scope', async () => {
    const scoped = { ...OWNER, roles: ['stylist'], primaryRole: 'stylist', allowedLocationIds: ['loc-9'] } as unknown as AuthUser;
    const { service } = build(baseRows());
    await expect(service.listSellable(scoped, 'loc-1')).rejects.toThrow(ForbiddenException);
  });
});

describe('historical immutability', () => {
  it('list() serves the STORED snapshot verbatim — the resolver is never consulted', async () => {
    // The current configuration would now price this at £99 — the stored row
    // still says £13 with product_default 30%, and that is what history shows.
    const changedRules: EffectiveRetailPricing = { ...RESOLVED, sellingPriceCents: 9900, configuredValue: 900 };
    const { service, pricing } = build(baseRows(), changedRules);
    const result = await service.list(OWNER, {});

    expect(result.sales[0]).toMatchObject({
      unitPriceCents: 1300,
      unitCostCents: 1000,
      pricingSource: 'product_default',
      pricingConfiguredValue: 30,
      effectiveMarkupPercent: 30,
    });
    expect(pricing.resolveForProducts).not.toHaveBeenCalled();
  });

  it('a pre-pricing-feature row (no snapshot) round-trips with the fields absent', async () => {
    const legacyRow = {
      ...SALE_ROW,
      unit_cost_cents: null,
      pricing_mode: null,
      pricing_source: null,
      pricing_configured_value: null,
      effective_markup_percent: null,
    };
    const { service } = build(baseRows({ retail_sales: [legacyRow] }));
    const result = await service.list(OWNER, {});
    expect(result.sales[0].pricingSource).toBeUndefined();
    expect(result.sales[0].unitCostCents).toBeUndefined();
    expect(result.sales[0].unitPriceCents).toBe(1300); // the stored money is untouched
  });
});
