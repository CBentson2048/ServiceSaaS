/**
 * Retail pricing configuration — tenancy, validation and batch resolution.
 * The precedence arithmetic itself is pinned by retail-pricing.resolver.spec;
 * these specs prove what the SERVICE sends and refuses: scope shapes, the
 * one-mode-one-value rule (0 accepted, both rejected), business/location
 * boundaries, delete-as-inherit, and the single-query batch resolution.
 */
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { createClient } from '@supabase/supabase-js';
import type { AuthUser } from '@sheer/domain';
import { RetailPricingService } from './retail-pricing.service';
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
  category_id: 'cat-1',
  stock_unit: 'gram',
  pack_size: 100,
  size_value: 100,
  default_cost_per_gram_cents: 10, // £10.00 per pack of 100
  retail_price_cents: 1499,
  is_active: true,
};

const RULE = {
  id: 'rule-1',
  business_id: 'biz-1',
  scope: 'product',
  product_id: 'prod-1',
  category_id: null,
  location_id: null,
  pricing_mode: 'percentage_markup',
  markup_percent: 30,
  fixed_price_cents: null,
  created_at: '2026-08-26T00:00:00.000Z',
  updated_at: '2026-08-26T00:00:00.000Z',
};

function build(rows: Record<string, unknown[]> = {}) {
  const captured: Captured[] = [];
  const makeChain = (key: string) => {
    const data = () => rows[key] ?? [];
    const chain: Record<string, unknown> = {};
    for (const method of ['select', 'eq', 'in', 'order', 'limit', 'returns', 'or', 'upsert', 'insert', 'update', 'delete']) {
      chain[method] = (...args: unknown[]) => {
        captured.push({ key, method, args });
        return chain;
      };
    }
    chain.maybeSingle = async () => ({ data: data()[0] ?? null, error: null });
    chain.single = chain.maybeSingle;
    chain.then = (resolve: (v: unknown) => unknown, reject?: (r: unknown) => unknown) =>
      Promise.resolve({ data: data(), error: null }).then(resolve, reject);
    return chain;
  };
  const root = { schema: () => ({ from: (table: string) => makeChain(table) }) };
  mockedCreateClient.mockReturnValue(root as never);
  const audit = { record: jest.fn().mockResolvedValue(undefined) } as unknown as AuditService;
  const config = { getOrThrow: (key: string) => `test-${key}` } as unknown as ConfigService;
  return { service: new RetailPricingService(config, audit), captured, audit };
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
  permissions: ['settings.billing.manage', 'inventory.manage'],
} as unknown as AuthUser;

const MANAGER_L1: AuthUser = {
  ...OWNER,
  id: 'user-2',
  roles: ['manager'],
  primaryRole: 'manager',
  allowedLocationIds: ['loc-1'],
} as unknown as AuthUser;

const STYLIST: AuthUser = {
  ...OWNER,
  id: 'user-3',
  roles: ['stylist'],
  primaryRole: 'stylist',
  permissions: ['retail.record'],
} as unknown as AuthUser;

const baseRows = (overrides: Record<string, unknown[]> = {}) => ({
  products: [PRODUCT],
  categories: [{ id: 'cat-1' }],
  locations: [{ id: 'loc-1' }],
  retail_pricing_rules: [RULE],
  ...overrides,
});

beforeEach(() => jest.clearAllMocks());

describe('permissions', () => {
  it('refuses configuration without settings.billing.manage — stylists never price', async () => {
    const { service } = build(baseRows());
    await expect(
      service.upsertRule(STYLIST, { scope: 'product', productId: 'prod-1', pricingMode: 'percentage_markup', markupPercent: 20 }),
    ).rejects.toThrow(ForbiddenException);
    await expect(service.listRules(STYLIST, {})).rejects.toThrow(ForbiddenException);
    await expect(service.deleteRule(STYLIST, 'rule-1')).rejects.toThrow(ForbiddenException);
  });

  it('a manager may set a rule for their own location but not another', async () => {
    const { service } = build(baseRows());
    await expect(
      service.upsertRule(MANAGER_L1, { scope: 'location', locationId: 'loc-1', pricingMode: 'percentage_markup', markupPercent: 10 }),
    ).resolves.toBeDefined();
    await expect(
      service.upsertRule(MANAGER_L1, { scope: 'location', locationId: 'loc-9', pricingMode: 'percentage_markup', markupPercent: 10 }),
    ).rejects.toThrow(ForbiddenException);
  });
});

describe('scope shape and mode/value validation', () => {
  it('rejects a product rule without a productId, and one with a stray locationId', async () => {
    const { service } = build(baseRows());
    await expect(
      service.upsertRule(OWNER, { scope: 'product', pricingMode: 'percentage_markup', markupPercent: 20 }),
    ).rejects.toThrow(BadRequestException);
    await expect(
      service.upsertRule(OWNER, { scope: 'product', productId: 'prod-1', locationId: 'loc-1', pricingMode: 'percentage_markup', markupPercent: 20 }),
    ).rejects.toThrow(BadRequestException);
  });

  it('accepts an explicit 0% markup — 0 is configuration, not absence', async () => {
    const { service, captured } = build(baseRows());
    await service.upsertRule(OWNER, { scope: 'product', productId: 'prod-1', pricingMode: 'percentage_markup', markupPercent: 0 });
    const upsert = captured.find((c) => c.key === 'retail_pricing_rules' && c.method === 'upsert');
    expect((upsert?.args[0] as Record<string, unknown>).markup_percent).toBe(0);
    expect((upsert?.args[0] as Record<string, unknown>).fixed_price_cents).toBeNull();
  });

  it('rejects percentage mode without a percent, and fixed mode without a price', async () => {
    const { service } = build(baseRows());
    await expect(
      service.upsertRule(OWNER, { scope: 'product', productId: 'prod-1', pricingMode: 'percentage_markup' }),
    ).rejects.toThrow(/markupPercent is required/);
    await expect(
      service.upsertRule(OWNER, { scope: 'product', productId: 'prod-1', pricingMode: 'fixed_price' }),
    ).rejects.toThrow(/fixedPriceCents is required/);
  });

  it('rejects supplying both values at once', async () => {
    const { service } = build(baseRows());
    await expect(
      service.upsertRule(OWNER, {
        scope: 'product',
        productId: 'prod-1',
        pricingMode: 'fixed_price',
        fixedPriceCents: 1800,
        markupPercent: 20,
      }),
    ).rejects.toThrow(/must not be supplied/);
  });
});

describe('tenancy', () => {
  it('refuses a product from another business', async () => {
    const { service } = build(baseRows({ products: [] }));
    await expect(
      service.upsertRule(OWNER, { scope: 'product', productId: 'prod-other', pricingMode: 'percentage_markup', markupPercent: 20 }),
    ).rejects.toThrow(NotFoundException);
  });

  it('refuses a category from another business', async () => {
    const { service } = build(baseRows({ categories: [] }));
    await expect(
      service.upsertRule(OWNER, { scope: 'category', categoryId: 'cat-other', pricingMode: 'percentage_markup', markupPercent: 20 }),
    ).rejects.toThrow(BadRequestException);
  });

  it('pins every rule read and write to the caller business', async () => {
    const { service, captured } = build(baseRows());
    await service.listRules(OWNER, {});
    await service.deleteRule(OWNER, 'rule-1');
    const eqs = captured.filter((c) => c.key === 'retail_pricing_rules' && c.method === 'eq').map((c) => c.args);
    expect(eqs).toEqual(expect.arrayContaining([['business_id', 'biz-1']]));
  });
});

describe('delete = inherit', () => {
  it('removes the rule and audits with the before-image', async () => {
    const { service, captured, audit } = build(baseRows());
    await service.deleteRule(OWNER, 'rule-1');
    expect(captured.some((c) => c.key === 'retail_pricing_rules' && c.method === 'delete')).toBe(true);
    expect(audit.record).toHaveBeenCalledWith(
      OWNER,
      expect.objectContaining({
        action: 'retail_pricing.rule_cleared',
        before: expect.objectContaining({ markupPercent: 30 }),
      }),
    );
  });
});

describe('batch resolution', () => {
  it('resolves many products from ONE rules query, matching rules per product', async () => {
    const rules = [
      { ...RULE, id: 'r-p1', scope: 'product', product_id: 'prod-1', markup_percent: 30 },
      { ...RULE, id: 'r-cat', scope: 'category', product_id: null, category_id: 'cat-1', markup_percent: 20 },
      { ...RULE, id: 'r-loc', scope: 'location', product_id: null, category_id: null, location_id: 'loc-1', markup_percent: 10 },
      // Another business/location noise the filter must ignore is impossible
      // here (business filter is in the query); another LOCATION's rule:
      { ...RULE, id: 'r-loc2', scope: 'location', product_id: null, category_id: null, location_id: 'loc-2', markup_percent: 99 },
    ];
    const { service, captured } = build(baseRows({ retail_pricing_rules: rules }));

    const productTwo = { ...PRODUCT, id: 'prod-2', category_id: 'cat-1' };
    const productThree = { ...PRODUCT, id: 'prod-3', category_id: null };
    const result = await service.resolveForProducts('biz-1', 'loc-1', [PRODUCT, productTwo, productThree] as never);

    // prod-1 has its own product rule: 1000 × 1.30.
    expect(result.get('prod-1')).toMatchObject({ sellingPriceCents: 1300, source: 'product_default' });
    // prod-2 falls to the category default: 1000 × 1.20.
    expect(result.get('prod-2')).toMatchObject({ sellingPriceCents: 1200, source: 'category_default' });
    // prod-3 has no category: the location default fires, never loc-2's rule.
    expect(result.get('prod-3')).toMatchObject({ sellingPriceCents: 1100, source: 'location_default' });

    const ruleQueries = captured.filter((c) => c.key === 'retail_pricing_rules' && c.method === 'select');
    expect(ruleQueries).toHaveLength(1);
  });

  it('falls back to the legacy retail price when no rule matches', async () => {
    const { service } = build(baseRows({ retail_pricing_rules: [] }));
    const result = await service.resolveForProducts('biz-1', 'loc-1', [PRODUCT] as never);
    expect(result.get('prod-1')).toMatchObject({
      sellingPriceCents: 1499,
      source: 'legacy_retail_price',
    });
  });
});
