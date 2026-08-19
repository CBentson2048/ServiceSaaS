/**
 * Stock is stored in a single column whose meaning depends on the product. These
 * cases pin the one conversion the catalogue can actually support (pack -> base)
 * and, just as importantly, pin that an unsupported conversion throws instead of
 * quietly falling back to a number that would drift stock.
 */
import { BadRequestException } from '@nestjs/common';
import {
  formatStockQuantity,
  resolvePackSize,
  resolveStockUnit,
  roundBaseQuantity,
  toBaseQuantity,
  toPackQuantity,
} from './unit-conversion';

const tube = { id: 'p1', name: 'Colour 6.0', stockUnit: 'gram' as const, packSize: 100 };
const bottle = { id: 'p2', name: 'Developer 20vol', stockUnit: 'millilitre' as const, packSize: 1000 };
const item = { id: 'p3', name: 'Comb', stockUnit: 'unit' as const, packSize: null };
const legacy = { id: 'p4', name: 'Legacy tint', stockUnit: null, packSize: null, sizeValue: 60 };
const unsized = { id: 'p5', name: 'Unsized product', stockUnit: 'gram' as const, packSize: null };

describe('resolveStockUnit', () => {
  it('reads the recorded unit', () => {
    expect(resolveStockUnit(tube)).toBe('gram');
    expect(resolveStockUnit(bottle)).toBe('millilitre');
    expect(resolveStockUnit(item)).toBe('unit');
  });

  it('defaults to grams when unset, preserving pre-Week-6 meaning', () => {
    expect(resolveStockUnit(legacy)).toBe('gram');
    expect(resolveStockUnit({ stockUnit: 'furlong' as never })).toBe('gram');
  });
});

describe('resolvePackSize', () => {
  it('prefers the explicit pack size', () => {
    expect(resolvePackSize({ ...tube, sizeValue: 999 })).toBe(100);
  });

  it('falls back to sizeValue, which carried this meaning before Week 6', () => {
    expect(resolvePackSize(legacy)).toBe(60);
  });

  it('ignores zero and negative sizes rather than treating them as real', () => {
    expect(resolvePackSize({ packSize: 0, sizeValue: 0 })).toBeNull();
    expect(resolvePackSize({ packSize: -5 })).toBeNull();
  });

  it('returns null when nothing records a pack size', () => {
    expect(resolvePackSize(unsized)).toBeNull();
  });
});

describe('toBaseQuantity', () => {
  it('passes base quantities through untouched', () => {
    expect(toBaseQuantity(tube, 30)).toBe(30);
    expect(toBaseQuantity(tube, 30, 'base')).toBe(30);
  });

  it('multiplies packs by the pack size', () => {
    expect(toBaseQuantity(tube, 2, 'pack')).toBe(200);
    expect(toBaseQuantity(bottle, 3, 'pack')).toBe(3000);
  });

  it('treats one pack as one item for unit-stocked products', () => {
    // Multiplying here would double-count: the column already counts items.
    expect(toBaseQuantity(item, 4, 'pack')).toBe(4);
  });

  it('uses the legacy sizeValue when converting packs', () => {
    expect(toBaseQuantity(legacy, 2, 'pack')).toBe(120);
  });

  it('throws rather than guessing when a pack size is unknown', () => {
    expect(() => toBaseQuantity(unsized, 2, 'pack')).toThrow(BadRequestException);
    expect(() => toBaseQuantity(unsized, 2, 'pack')).toThrow(/no pack size recorded/i);
  });

  it('still accepts base quantities for a product with no pack size', () => {
    expect(toBaseQuantity(unsized, 25)).toBe(25);
  });

  it('rejects non-positive and non-finite quantities', () => {
    expect(() => toBaseQuantity(tube, 0)).toThrow(BadRequestException);
    expect(() => toBaseQuantity(tube, -1)).toThrow(BadRequestException);
    expect(() => toBaseQuantity(tube, Number.NaN)).toThrow(BadRequestException);
    expect(() => toBaseQuantity(tube, Number.POSITIVE_INFINITY)).toThrow(BadRequestException);
  });
});

describe('toPackQuantity', () => {
  it('is the inverse of toBaseQuantity for packable products', () => {
    expect(toPackQuantity(tube, toBaseQuantity(tube, 2, 'pack'))).toBe(2);
    expect(toPackQuantity(bottle, toBaseQuantity(bottle, 5, 'pack'))).toBe(5);
  });

  it('is the identity for unit-stocked products', () => {
    expect(toPackQuantity(item, 7)).toBe(7);
  });

  it('returns null when packs are meaningless for the product', () => {
    expect(toPackQuantity(unsized, 25)).toBeNull();
  });
});

describe('roundBaseQuantity', () => {
  it('rounds to the three decimals the column stores', () => {
    expect(roundBaseQuantity(30.0004)).toBe(30);
    expect(roundBaseQuantity(30.0006)).toBe(30.001);
  });

  it('clears accumulated float drift', () => {
    const drifted = 0.1 + 0.2; // 0.30000000000000004
    expect(roundBaseQuantity(drifted)).toBe(0.3);
  });

  it('keeps a repeated sum stable', () => {
    let total = 0;
    for (let i = 0; i < 10; i += 1) total = roundBaseQuantity(total + 12.345);
    expect(total).toBe(123.45);
  });
});

describe('formatStockQuantity', () => {
  it('labels each unit the way a stylist reads it', () => {
    expect(formatStockQuantity(45, 'gram')).toBe('45g');
    expect(formatStockQuantity(1000, 'millilitre')).toBe('1000ml');
    expect(formatStockQuantity(3, 'unit')).toBe('3 items');
    expect(formatStockQuantity(1, 'unit')).toBe('1 item');
  });

  it('shows one decimal only when there is one', () => {
    expect(formatStockQuantity(45.5, 'gram')).toBe('45.5g');
  });
});
