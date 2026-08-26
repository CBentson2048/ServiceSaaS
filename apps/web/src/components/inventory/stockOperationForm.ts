/**
 * Adjust Stock / Restock decisions (§17/§18 of the redesign).
 *
 * These two actions differ in what they MEAN to the ledger, not just in
 * wording:
 *   - Restock  -> a `restock` movement: goods arrived from a supplier.
 *   - Adjust   -> a `manual_adjustment` movement in either direction: a
 *                 correction (miscount, breakage, waste), NOT a delivery.
 *
 * Keeping a correction out of the `restock` type matters downstream — the
 * reorder forecast and dead-stock clock read movement types — so the UI states
 * the difference plainly instead of guessing from the sign.
 *
 * Quantities stay in the product's BASE unit. Pack↔base conversion is the
 * API's job (inventory/unit-conversion.ts); duplicating it in the browser
 * would create a second source of truth for stock maths.
 */
import type { AdjustInventoryStockRequest, StockUnit } from '@sheer/domain';

export type StockOperation = 'adjust' | 'restock';
export type AdjustDirection = 'inbound' | 'loss';

export interface StockOperationState {
  locationId: string;
  productId: string;
  direction: AdjustDirection;
  quantity: string;
  reason: string;
}

export const EMPTY_STOCK_OPERATION: StockOperationState = {
  locationId: '',
  productId: '',
  direction: 'inbound',
  quantity: '',
  reason: '',
};

export type StockOperationPlan =
  | { ok: true; request: AdjustInventoryStockRequest }
  | { ok: false; field: keyof StockOperationState; message: string };

/**
 * Validate and translate the form into the existing adjust-stock request.
 * A restock is always inbound; an adjustment carries the direction the user
 * chose. Zero is rejected — the API refuses it and it means nothing anyway.
 */
export function planStockOperation(
  operation: StockOperation,
  state: StockOperationState,
): StockOperationPlan {
  if (!state.locationId) {
    return { ok: false, field: 'locationId', message: 'Choose a location.' };
  }
  if (!state.productId) {
    return { ok: false, field: 'productId', message: 'Choose a product.' };
  }
  const trimmed = state.quantity.trim();
  if (trimmed === '') {
    return { ok: false, field: 'quantity', message: 'Enter a quantity.' };
  }
  const magnitude = Number(trimmed);
  if (!Number.isFinite(magnitude) || magnitude <= 0) {
    return { ok: false, field: 'quantity', message: 'Quantity must be greater than zero.' };
  }
  if ((trimmed.split('.')[1] ?? '').length > 3) {
    return { ok: false, field: 'quantity', message: 'Quantity supports at most 3 decimal places.' };
  }
  // A correction that removes stock should say why: it is the only record of
  // what happened to the missing product.
  if (operation === 'adjust' && state.direction === 'loss' && !state.reason.trim()) {
    return { ok: false, field: 'reason', message: 'Give a reason for the loss — it is the only record of it.' };
  }

  const inbound = operation === 'restock' || state.direction === 'inbound';
  return {
    ok: true,
    request: {
      locationId: state.locationId,
      productId: state.productId,
      quantityDeltaGrams: inbound ? magnitude : -magnitude,
      movementType: operation === 'restock' ? 'restock' : 'manual_adjustment',
      reason: operation === 'restock' ? state.reason.trim() || 'restock' : state.reason.trim() || 'manual_adjustment',
      notes: state.reason.trim() || null,
    },
  };
}

/** The base-unit suffix shown beside the quantity box. */
export function baseUnitLabel(stockUnit: StockUnit | undefined): string {
  if (stockUnit === 'unit') return 'units';
  if (stockUnit === 'millilitre') return 'ml';
  return 'g';
}

export const OPERATION_COPY: Record<StockOperation, { title: string; description: string; cta: string }> = {
  adjust: {
    title: 'Adjust stock',
    description:
      'Correct what the shelf says — a miscount, breakage or waste. For goods that arrived from a supplier, use Restock instead.',
    cta: 'Record adjustment',
  },
  restock: {
    title: 'Restock',
    description: 'Record stock received from a supplier. This adds to the shelf and is logged as a delivery.',
    cta: 'Record restock',
  },
};
