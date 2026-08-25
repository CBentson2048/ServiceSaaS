/**
 * Week 6 ticket 8 — the reorder suggestion arithmetic (plan §11.2).
 *
 * Pure functions so the rounding chain is provable in Jest without a database:
 * usage forecast -> base shortfall -> packs -> minimum order quantity -> order
 * multiple. The usage figure itself comes from inventory.reorder_usage
 * (outbound movements only — a restock is not usage).
 */
import type { StockUnit } from '@sheer/domain';

export interface ReorderProductInputs {
  /** Current base quantity on the shelf. */
  onHandBase: number;
  /** Total outbound base quantity in the trailing usage window. */
  outboundBaseInWindow: number;
  /** Trailing weeks the outbound figure covers. */
  usageWindowWeeks: number;
  /** Weeks of forecast usage the order should cover. */
  coverageWeeks: number;
  /** Effective low-stock threshold in base quantities (0 = none). */
  lowStockThresholdBase: number;
  /** Base quantities per orderable pack; null when the product has none recorded. */
  packSize: number | null;
  stockUnit: StockUnit;
  /** Smallest order the supplier accepts, in packs. */
  minimumOrderQuantity: number;
  /** Supplier order step in packs. */
  orderMultiple: number;
}

export interface ReorderSuggestion {
  /** Packs to order after MOQ and multiple round-up. */
  packs: number;
  /** The raw base-quantity gap the packs are covering. */
  shortfallBase: number;
}

/**
 * A unit-stocked product with no recorded pack size is sold by the item:
 * one pack = one unit (the unit-conversion.ts convention). A gram/millilitre
 * product without a pack size cannot be ordered — the caller must surface it
 * as unorderable rather than guess.
 */
export function resolveOrderPackSize(stockUnit: StockUnit, packSize: number | null | undefined): number | null {
  if (packSize !== null && packSize !== undefined && packSize > 0) return packSize;
  return stockUnit === 'unit' ? 1 : null;
}

/**
 * The base-quantity gap between what the coverage window needs (forecast usage
 * plus the safety threshold) and what is on the shelf. <= 0 means no order.
 */
export function computeShortfallBase(
  inputs: Pick<
    ReorderProductInputs,
    'onHandBase' | 'outboundBaseInWindow' | 'usageWindowWeeks' | 'coverageWeeks' | 'lowStockThresholdBase'
  >,
): number {
  const windowWeeks = Math.max(1, inputs.usageWindowWeeks);
  const usagePerWeek = Math.max(0, inputs.outboundBaseInWindow) / windowWeeks;
  const forecast = usagePerWeek * Math.max(0, inputs.coverageWeeks);
  return Math.max(0, forecast + Math.max(0, inputs.lowStockThresholdBase) - inputs.onHandBase);
}

/**
 * Returns null when nothing needs ordering. Throws never — a missing pack size
 * must be filtered with {@link resolveOrderPackSize} before calling.
 */
export function suggestOrderPacks(inputs: ReorderProductInputs): ReorderSuggestion | null {
  const packSize = resolveOrderPackSize(inputs.stockUnit, inputs.packSize);
  if (packSize === null) {
    throw new Error('suggestOrderPacks called without a resolvable pack size');
  }

  const shortfallBase = computeShortfallBase(inputs);
  if (shortfallBase <= 0) return null;

  let packs = Math.ceil(shortfallBase / packSize);
  packs = Math.max(packs, Math.max(1, inputs.minimumOrderQuantity));
  const multiple = Math.max(1, inputs.orderMultiple);
  packs = Math.ceil(packs / multiple) * multiple;

  return { packs, shortfallBase };
}
