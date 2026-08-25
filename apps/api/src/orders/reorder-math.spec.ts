/**
 * Week 6 ticket 8 — the reorder rounding chain (plan §11.2).
 * Pure functions: every rule provable without a database.
 */
import { computeShortfallBase, resolveOrderPackSize, suggestOrderPacks } from './reorder-math';

const base = {
  onHandBase: 0,
  outboundBaseInWindow: 0,
  usageWindowWeeks: 8,
  coverageWeeks: 4,
  lowStockThresholdBase: 0,
  packSize: 100 as number | null,
  stockUnit: 'gram' as const,
  minimumOrderQuantity: 1,
  orderMultiple: 1,
};

describe('shortfall forecast', () => {
  it('covers forecast usage plus the safety threshold', () => {
    // 800g used over 8 weeks = 100g/week; 4 weeks coverage = 400g; +50g threshold − 200g on hand.
    const shortfall = computeShortfallBase({
      onHandBase: 200,
      outboundBaseInWindow: 800,
      usageWindowWeeks: 8,
      coverageWeeks: 4,
      lowStockThresholdBase: 50,
    });
    expect(shortfall).toBe(250);
  });

  it('is zero when the shelf already covers the forecast', () => {
    expect(
      computeShortfallBase({
        onHandBase: 1000,
        outboundBaseInWindow: 800,
        usageWindowWeeks: 8,
        coverageWeeks: 4,
        lowStockThresholdBase: 50,
      }),
    ).toBe(0);
  });

  it('still reorders up to the threshold when there is no usage at all', () => {
    expect(
      computeShortfallBase({
        onHandBase: 20,
        outboundBaseInWindow: 0,
        usageWindowWeeks: 8,
        coverageWeeks: 4,
        lowStockThresholdBase: 100,
      }),
    ).toBe(80);
  });
});

describe('pack rounding', () => {
  it('rounds a base shortfall up to whole packs', () => {
    // 250g shortfall in 100g packs -> 3 packs.
    const result = suggestOrderPacks({ ...base, onHandBase: 0, outboundBaseInWindow: 500, lowStockThresholdBase: 0 });
    // 500/8*4 = 250 shortfall -> ceil(250/100) = 3
    expect(result).toEqual({ packs: 3, shortfallBase: 250 });
  });

  it('lifts an order below the minimum order quantity up to it', () => {
    const result = suggestOrderPacks({
      ...base,
      outboundBaseInWindow: 200, // 100 shortfall -> 1 pack
      minimumOrderQuantity: 6,
    });
    expect(result?.packs).toBe(6);
  });

  it('rounds up to the next order multiple', () => {
    const result = suggestOrderPacks({
      ...base,
      outboundBaseInWindow: 1400, // 700 shortfall -> 7 packs
      orderMultiple: 6,
    });
    expect(result?.packs).toBe(12);
  });

  it('applies MOQ before the multiple so both constraints hold', () => {
    const result = suggestOrderPacks({
      ...base,
      outboundBaseInWindow: 200, // 1 pack
      minimumOrderQuantity: 4,
      orderMultiple: 6,
    });
    // max(1, 4) = 4, then up to the next multiple of 6.
    expect(result?.packs).toBe(6);
  });

  it('returns null when nothing needs ordering', () => {
    expect(suggestOrderPacks({ ...base, onHandBase: 500 })).toBeNull();
  });
});

describe('pack size resolution', () => {
  it('treats one pack as one item for unit-stocked products with no pack size', () => {
    expect(resolveOrderPackSize('unit', null)).toBe(1);
  });

  it('refuses to guess for weight-stocked products with no pack size', () => {
    expect(resolveOrderPackSize('gram', null)).toBeNull();
    expect(resolveOrderPackSize('millilitre', null)).toBeNull();
  });

  it('prefers the recorded pack size when present', () => {
    expect(resolveOrderPackSize('unit', 12)).toBe(12);
    expect(resolveOrderPackSize('gram', 60)).toBe(60);
  });
});
