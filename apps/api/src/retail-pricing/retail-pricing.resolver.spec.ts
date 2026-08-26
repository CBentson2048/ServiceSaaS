/**
 * The full pricing-precedence matrix for the canonical resolver
 * (packages/domain resolveRetailPricing). This is the money proof:
 *
 *   location_product > product > location_category > category > location
 *
 * First configured rule wins and STOPS — rules never stack, never add,
 * never multiply. Absence inherits; explicit 0% overrides. Fixed price is a
 * final selling price, never an uplift. No rule anywhere = the legacy
 * products.retail_price_cents behaviour, unchanged.
 */
import {
  applyPercentageMarkup,
  resolveRetailPricing,
  retailUnitCostCents,
  type RetailPricingCandidates,
} from '@sheer/domain';

const COST = 1000; // £10.00 per sellable unit

function resolve(
  candidates: RetailPricingCandidates,
  overrides: { unitCostCents?: number | null; legacyRetailPriceCents?: number | null } = {},
) {
  return resolveRetailPricing({
    productId: 'prod-1',
    locationId: 'loc-1',
    unitCostCents: overrides.unitCostCents === undefined ? COST : overrides.unitCostCents,
    legacyRetailPriceCents:
      overrides.legacyRetailPriceCents === undefined ? 1499 : overrides.legacyRetailPriceCents,
    candidates,
  });
}

const pct = (id: string, markupPercent: number) =>
  ({ id, pricingMode: 'percentage_markup', markupPercent }) as const;
const fixed = (id: string, fixedPriceCents: number) =>
  ({ id, pricingMode: 'fixed_price', fixedPriceCents }) as const;

describe('precedence — first configured rule wins and stops', () => {
  it('no rules anywhere: legacy retail price applies, with honest provenance', () => {
    const result = resolve({});
    expect(result).toMatchObject({
      sellingPriceCents: 1499,
      source: 'legacy_retail_price',
      pricingMode: 'fixed_price',
      configuredValue: 1499,
      effectiveMarkupPercent: 49.9,
    });
  });

  it('no rules and no legacy price: source none, nothing invented', () => {
    const result = resolve({}, { legacyRetailPriceCents: null });
    expect(result).toMatchObject({
      sellingPriceCents: null,
      source: 'none',
      pricingMode: null,
      configuredValue: null,
      effectiveMarkupPercent: null,
    });
  });

  it('location default only: location default wins over legacy', () => {
    const result = resolve({ location: pct('r-loc', 10) });
    expect(result).toMatchObject({
      sellingPriceCents: 1100,
      source: 'location_default',
      effectiveMarkupPercent: 10,
    });
  });

  it('category default beats location default', () => {
    const result = resolve({ category: pct('r-cat', 20), location: pct('r-loc', 10) });
    expect(result).toMatchObject({ sellingPriceCents: 1200, source: 'category_default' });
  });

  it('location category beats category default and location default', () => {
    const result = resolve({
      location_category: pct('r-lc', 25),
      category: pct('r-cat', 20),
      location: pct('r-loc', 10),
    });
    expect(result).toMatchObject({ sellingPriceCents: 1250, source: 'location_category' });
  });

  it('product default beats every category/location level', () => {
    const result = resolve({
      product: pct('r-p', 30),
      location_category: pct('r-lc', 25),
      category: pct('r-cat', 20),
      location: pct('r-loc', 10),
    });
    expect(result).toMatchObject({ sellingPriceCents: 1300, source: 'product_default' });
  });

  it('location product beats absolutely everything', () => {
    const result = resolve({
      location_product: fixed('r-lp', 1800),
      product: pct('r-p', 30),
      location_category: pct('r-lc', 25),
      category: pct('r-cat', 20),
      location: pct('r-loc', 10),
    });
    expect(result).toMatchObject({
      sellingPriceCents: 1800,
      source: 'location_product',
      sourceRuleId: 'r-lp',
      pricingMode: 'fixed_price',
    });
  });

  it('exactly one rule is represented in provenance — never a blend', () => {
    const result = resolve({
      product: pct('r-p', 30),
      category: pct('r-cat', 20),
    });
    // 30% only. Stacking (30+20) would be 1500; multiplying would be 1560.
    expect(result.sellingPriceCents).toBe(1300);
    expect(result.sourceRuleId).toBe('r-p');
    expect(result.configuredValue).toBe(30);
  });
});

describe('null versus zero — the critical financial rule', () => {
  it('a missing product rule falls through to the category', () => {
    const result = resolve({ category: pct('r-cat', 20) });
    expect(result).toMatchObject({ sellingPriceCents: 1200, source: 'category_default' });
  });

  it('an explicit 0% product rule STOPS inheritance and returns cost price', () => {
    const result = resolve({ product: pct('r-p', 0), category: pct('r-cat', 20) });
    expect(result).toMatchObject({
      sellingPriceCents: 1000, // cost, zero markup — NOT the category's 20%
      source: 'product_default',
      configuredValue: 0,
      effectiveMarkupPercent: 0,
    });
  });

  it('an explicit 0% location-product rule wins over everything', () => {
    const result = resolve({
      location_product: pct('r-lp', 0),
      product: fixed('r-p', 1700),
      category: pct('r-cat', 20),
    });
    expect(result).toMatchObject({ sellingPriceCents: 1000, source: 'location_product', configuredValue: 0 });
  });

  it('0 is never treated as falsy anywhere in the result', () => {
    const result = resolve({ location: pct('r-loc', 0) });
    expect(result.configuredValue).toBe(0);
    expect(result.effectiveMarkupPercent).toBe(0);
    expect(result.sellingPriceCents).toBe(1000);
  });
});

describe('fixed selling price semantics', () => {
  it('a fixed price is the final selling price — not cost + value, not a percent', () => {
    const result = resolve({ product: fixed('r-p', 1800) });
    expect(result.sellingPriceCents).toBe(1800); // not 1000+1800, not 1000×1.18
    expect(result.pricingMode).toBe('fixed_price');
  });

  it('derives the effective markup for display (cost 10 → fixed 15 = 50%)', () => {
    const result = resolve({ product: fixed('r-p', 1500) });
    expect(result.effectiveMarkupPercent).toBe(50);
  });

  it('fixed £18 at cost £10 reads 80%', () => {
    const result = resolve({ location_product: fixed('r-lp', 1800) });
    expect(result.effectiveMarkupPercent).toBe(80);
  });

  it('never divides by zero: cost 0 → fixed price stands, markup null', () => {
    const result = resolve({ product: fixed('r-p', 1500) }, { unitCostCents: 0 });
    expect(result.sellingPriceCents).toBe(1500);
    expect(result.effectiveMarkupPercent).toBeNull();
  });

  it('never fabricates percentages: missing cost → fixed price stands, markup null', () => {
    const result = resolve({ product: fixed('r-p', 1500) }, { unitCostCents: null });
    expect(result.sellingPriceCents).toBe(1500);
    expect(result.effectiveMarkupPercent).toBeNull();
  });

  it('a fixed category price wins at exactly its precedence slot', () => {
    const result = resolve({ category: fixed('r-cat', 1400), location: pct('r-loc', 10) });
    expect(result).toMatchObject({ sellingPriceCents: 1400, source: 'category_default' });
  });

  it('a higher-precedence percentage beats a lower-level fixed price', () => {
    const result = resolve({ product: pct('r-p', 30), category: fixed('r-cat', 1400) });
    expect(result).toMatchObject({ sellingPriceCents: 1300, source: 'product_default' });
  });

  it('a higher-precedence fixed price beats a lower-level percentage', () => {
    const result = resolve({ location_product: fixed('r-lp', 2500), product: pct('r-p', 30) });
    expect(result).toMatchObject({ sellingPriceCents: 2500, source: 'location_product' });
  });
});

describe('percentage with missing cost — honest, never invented', () => {
  it('the rule still wins but the price is null (nothing to mark up)', () => {
    const result = resolve({ product: pct('r-p', 25) }, { unitCostCents: null });
    expect(result).toMatchObject({
      sellingPriceCents: null,
      source: 'product_default',
      configuredValue: 25,
      effectiveMarkupPercent: null,
    });
  });
});

describe('rounding and precision (house convention: integer cents)', () => {
  it('cost £9.99 at 20% is deterministic: 999 + round(199.8) = 1199 (£11.99)', () => {
    expect(applyPercentageMarkup(999, 20)).toBe(1199);
    const result = resolve({ product: pct('r-p', 20) }, { unitCostCents: 999 });
    expect(result.sellingPriceCents).toBe(1199);
  });

  it('fractional percents stay in integer cents (1000 at 12.5% = 1125)', () => {
    expect(applyPercentageMarkup(1000, 12.5)).toBe(1125);
  });
});

describe('cost per sellable unit', () => {
  it('weight product: per-base cost × pack size', () => {
    expect(retailUnitCostCents({ stockUnit: 'gram', packSize: 100, defaultCostPerGramCents: 5 })).toBe(500);
  });

  it('falls back to size_value when no pack size (the pre-0091 convention)', () => {
    expect(retailUnitCostCents({ stockUnit: 'gram', packSize: null, sizeValue: 60, defaultCostPerGramCents: 5 })).toBe(300);
  });

  it('unit product: per-item cost, no pack involved', () => {
    expect(retailUnitCostCents({ stockUnit: 'unit', defaultCostPerGramCents: 850 })).toBe(850);
  });

  it('null when cost or pack is unknown — never guesses', () => {
    expect(retailUnitCostCents({ stockUnit: 'gram', packSize: 100, defaultCostPerGramCents: null })).toBeNull();
    expect(retailUnitCostCents({ stockUnit: 'gram', packSize: null, sizeValue: null, defaultCostPerGramCents: 5 })).toBeNull();
  });
});
