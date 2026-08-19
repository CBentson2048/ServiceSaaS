import { BadRequestException } from '@nestjs/common';
import type { StockQuantityUnit, StockUnit } from '@sheer/domain';

/**
 * Stock is stored in one column, `inventory.location_stock.quantity_on_hand_grams`,
 * and every deduction path has to agree on what a number in that column means.
 * For a colour tube it means grams; for a product sold as whole items it means
 * items. `products.stock_unit` records which, and `products.pack_size` records
 * how many base quantities are in one sellable/orderable pack.
 *
 * There is deliberately NO conversion between gram, millilitre and unit here.
 * Converting millilitres to grams needs a density the catalogue does not carry,
 * so the only conversion performed is pack -> base, which is a recorded fact
 * about the product rather than an assumed physical constant.
 */

/** The product fields this module needs. Kept structural so callers can pass rows. */
export interface UnitConvertibleProduct {
  id?: string;
  name?: string | null;
  stockUnit?: StockUnit | null;
  packSize?: number | null;
  /** Legacy stand-in for pack size, in use since 0024. */
  sizeValue?: number | null;
}

export const DEFAULT_STOCK_UNIT: StockUnit = 'gram';

export function resolveStockUnit(product: UnitConvertibleProduct): StockUnit {
  const unit = product.stockUnit;
  return unit === 'gram' || unit === 'millilitre' || unit === 'unit' ? unit : DEFAULT_STOCK_UNIT;
}

/**
 * Base quantities in one pack, or null when the product does not record one.
 * `size_value` is the fallback because it carried this meaning before Week 6.
 */
export function resolvePackSize(product: UnitConvertibleProduct): number | null {
  const candidates = [product.packSize, product.sizeValue];
  for (const value of candidates) {
    if (value !== null && value !== undefined && Number.isFinite(value) && value > 0) {
      return value;
    }
  }
  return null;
}

function describe(product: UnitConvertibleProduct): string {
  return product.name?.trim() || product.id || 'product';
}

/**
 * Convert a caller-supplied quantity into base stock quantities.
 *
 * `base` is returned unchanged. `pack` multiplies by the product's pack size —
 * except for a product whose stock unit is already `unit`, where one pack is one
 * item and multiplying would double-count.
 *
 * Throws rather than guessing when a pack quantity is requested for a product
 * that records no pack size: a silent fallback here is exactly how stock drifts.
 */
export function toBaseQuantity(
  product: UnitConvertibleProduct,
  quantity: number,
  unit: StockQuantityUnit = 'base',
): number {
  if (!Number.isFinite(quantity)) {
    throw new BadRequestException('quantity must be a finite number');
  }
  if (quantity <= 0) {
    throw new BadRequestException('quantity must be greater than zero');
  }

  if (unit === 'base') return quantity;

  if (resolveStockUnit(product) === 'unit') return quantity;

  const packSize = resolvePackSize(product);
  if (packSize === null) {
    throw new BadRequestException(
      `${describe(product)} has no pack size recorded, so a pack quantity cannot be converted. ` +
        `Set a pack size on the product, or supply the quantity in base units.`,
    );
  }
  return quantity * packSize;
}

/** Inverse of {@link toBaseQuantity}; returns null when packs are meaningless. */
export function toPackQuantity(product: UnitConvertibleProduct, baseQuantity: number): number | null {
  if (resolveStockUnit(product) === 'unit') return baseQuantity;
  const packSize = resolvePackSize(product);
  if (packSize === null) return null;
  return baseQuantity / packSize;
}

/**
 * Stock quantities are `numeric(12,3)` in Postgres. Rounding to three decimals
 * on the way in keeps repeated float arithmetic from accumulating a drift the
 * database would silently round away anyway.
 */
export function roundBaseQuantity(value: number): number {
  return Math.round((value + Number.EPSILON) * 1000) / 1000;
}

/** Format a quantity for display alongside its unit. */
export function formatStockQuantity(value: number, unit: StockUnit): string {
  const rounded = roundBaseQuantity(value);
  const suffix = unit === 'gram' ? 'g' : unit === 'millilitre' ? 'ml' : rounded === 1 ? 'item' : 'items';
  const digits = Number.isInteger(rounded) ? 0 : 1;
  return unit === 'unit' ? `${rounded.toFixed(digits)} ${suffix}` : `${rounded.toFixed(digits)}${suffix}`;
}
