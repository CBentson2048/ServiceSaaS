/**
 * Human-readable stock activity (§19/§20 of the Product Management redesign).
 *
 * The old activity list printed `movement.createdBy` — a raw user-profile UUID —
 * as the headline actor. This module is the single place that decides what a
 * movement READS like, so a UUID can never reach the primary surface again:
 * internal ids are available only through `movementAuditFields`, which the
 * detail panel renders.
 *
 * DOM-free so it is fully unit-tested (see movementPresentation.spec.ts).
 */
import type { InventoryStockMovement, InventoryStockMovementType, StockUnit } from '@sheer/domain';

export type MovementDirection = 'in' | 'out' | 'flat';

/** Where the movement came from, in the salon's language. */
export type MovementSource =
  | 'QLAB'
  | 'Barcode scan'
  | 'Salon use'
  | 'Retail sale'
  | 'Restock'
  | 'Manual adjustment'
  | 'Opening balance'
  | 'Correction'
  | 'Stock movement';

const SOURCE_BY_TYPE: Record<InventoryStockMovementType, MovementSource> = {
  opening_balance: 'Opening balance',
  restock: 'Restock',
  manual_adjustment: 'Manual adjustment',
  formula_usage: 'QLAB',
  formula_waste: 'QLAB',
  formula_reversal: 'QLAB',
  retail_sale: 'Retail sale',
  salon_consumption: 'Salon use',
  correction: 'Correction',
};

/** Past-tense verb for the movement, used in the context line. */
const VERB_BY_TYPE: Record<InventoryStockMovementType, string> = {
  opening_balance: 'Opening balance',
  restock: 'Restocked',
  manual_adjustment: 'Adjusted',
  formula_usage: 'Used in a colour formula',
  formula_waste: 'Formula waste',
  formula_reversal: 'Formula correction',
  retail_sale: 'Sold',
  salon_consumption: 'Salon use',
  correction: 'Corrected',
};

/**
 * The actor for a movement with no signed-in user: these are written by the
 * platform itself, and naming the mechanism is more honest (and more useful)
 * than showing nothing or an id.
 */
const SYSTEM_ACTOR_BY_TYPE: Record<InventoryStockMovementType, string> = {
  opening_balance: 'System',
  restock: 'System',
  manual_adjustment: 'System',
  formula_usage: 'QLAB',
  formula_waste: 'QLAB',
  formula_reversal: 'QLAB',
  retail_sale: 'Point of sale',
  salon_consumption: 'System',
  correction: 'System',
};

export function movementDirection(movement: Pick<InventoryStockMovement, 'quantityDeltaGrams'>): MovementDirection {
  if (movement.quantityDeltaGrams > 0) return 'in';
  if (movement.quantityDeltaGrams < 0) return 'out';
  return 'flat';
}

export function movementSource(movement: Pick<InventoryStockMovement, 'movementType' | 'referenceType'>): MovementSource {
  // A barcode scan is a salon_consumption whose reference records the surface
  // it came from; naming it helps an owner audit "who scanned what".
  if (movement.referenceType === 'barcode_scan') return 'Barcode scan';
  return SOURCE_BY_TYPE[movement.movementType] ?? 'Stock movement';
}

/**
 * The actor to display. NEVER falls back to `createdBy`: an unresolved id
 * yields the system/mechanism actor instead, because a UUID tells a salon
 * owner nothing and looks like a defect.
 */
export function movementActorName(
  movement: Pick<InventoryStockMovement, 'movementType' | 'createdByName'>,
): string {
  const name = movement.createdByName?.trim();
  if (name) return name;
  return SYSTEM_ACTOR_BY_TYPE[movement.movementType] ?? 'System';
}

/** Signed quantity with the product's unit: "+200g", "−30g", "+2 items". */
export function formatMovementQuantity(deltaBase: number, stockUnit: StockUnit = 'gram'): string {
  const magnitude = Math.abs(deltaBase);
  const rounded = Math.round(magnitude * 10) / 10;
  const amount = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
  const sign = deltaBase > 0 ? '+' : deltaBase < 0 ? '−' : '';
  if (stockUnit === 'unit') return `${sign}${amount} ${rounded === 1 ? 'item' : 'items'}`;
  return `${sign}${amount}${stockUnit === 'millilitre' ? 'ml' : 'g'}`;
}

/** "2 minutes ago" / "3 days ago" / a date beyond a week. */
export function formatRelativeTime(iso: string, now: number = Date.now()): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '—';
  const minutes = Math.round((now - then) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes === 1) return '1 minute ago';
  if (minutes < 60) return `${minutes} minutes ago`;
  const hours = Math.round(minutes / 60);
  if (hours === 1) return '1 hour ago';
  if (hours < 24) return `${hours} hours ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  return new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

export interface MovementPresentation {
  /** "+200g" — the amount, signed, in the product's unit. */
  quantityLabel: string;
  /** "Majirel 6.0 Dark Blonde" — never an id. */
  productLabel: string;
  /** "Restocked at Pinner · by Ada Lovelace · 1 hour ago". */
  contextLabel: string;
  direction: MovementDirection;
  source: MovementSource;
  actor: string;
  brand?: string;
}

/**
 * The headline + context a row shows. Every part is human language; the parts
 * that do not exist are omitted rather than rendered as "undefined" or an id.
 */
export function presentMovement(
  movement: InventoryStockMovement,
  options: { stockUnit?: StockUnit; now?: number } = {},
): MovementPresentation {
  const actor = movementActorName(movement);
  const source = movementSource(movement);
  const verb = VERB_BY_TYPE[movement.movementType] ?? 'Stock movement';
  const context = [
    `${verb} at ${movement.locationName}`,
    `by ${actor}`,
    formatRelativeTime(movement.createdAt, options.now),
  ];
  return {
    quantityLabel: formatMovementQuantity(movement.quantityDeltaGrams, options.stockUnit ?? 'gram'),
    productLabel: movement.productName,
    contextLabel: context.join(' · '),
    direction: movementDirection(movement),
    source,
    actor,
    brand: movement.brand,
  };
}

/** Internal identifiers, for the audit detail panel only — never the list. */
export function movementAuditFields(movement: InventoryStockMovement): { label: string; value: string }[] {
  const fields: { label: string; value: string }[] = [
    { label: 'Movement ID', value: movement.id },
    { label: 'Product ID', value: movement.productId },
  ];
  if (movement.referenceType) {
    fields.push({ label: 'Reference', value: movement.referenceId ? `${movement.referenceType} · ${movement.referenceId}` : movement.referenceType });
  }
  if (movement.createdBy) fields.push({ label: 'Actor ID', value: movement.createdBy });
  return fields;
}

/** Absolute timestamp for the detail panel (the list shows relative time). */
export function formatAbsoluteTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
