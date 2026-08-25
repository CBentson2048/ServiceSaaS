/**
 * Week 6 ticket 3 — the logic behind the barcode scan-to-consume surface.
 *
 * DOM-free on purpose: this repo tests web logic without jsdom (see
 * jest.config.cjs), so everything a wedge scanner can throw at the UI —
 * control characters, double Enter, retries, unknown codes — is decided here
 * and proved in scanConsumption.spec.ts. The component is a thin shell that
 * renders these decisions and calls the existing consumption API; stock is
 * NEVER modified from the frontend directly.
 */
import type { BarcodeLookupResponse, StockUnit } from '@sheer/domain';

// ---------------------------------------------------------------------------
// Input hygiene
// ---------------------------------------------------------------------------

/**
 * A USB/Bluetooth wedge scanner types the code and usually appends Enter (CR
 * and/or LF); some prefix or suffix control characters. Strip every control
 * character, trim, and cap at the API's 64-character barcode limit.
 */
export function sanitizeBarcode(raw: string): string {
  // eslint-disable-next-line no-control-regex
  return raw.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 64);
}

// ---------------------------------------------------------------------------
// Phases and Enter handling
// ---------------------------------------------------------------------------

export type ScanPhase = 'idle' | 'looking_up' | 'resolved' | 'submitting';

/**
 * What a wedge scanner's Enter keystroke should do in each phase. The two busy
 * phases IGNORE Enter — that is the whole duplicate-submission guard: a
 * scanner that fires Enter twice, or an operator leaning on the key, cannot
 * start a second lookup or a second deduction while one is in flight.
 */
export function actionForEnter(phase: ScanPhase): 'lookup' | 'confirm' | 'ignore' {
  switch (phase) {
    case 'idle':
      return 'lookup';
    case 'resolved':
      return 'confirm';
    case 'looking_up':
    case 'submitting':
      return 'ignore';
  }
}

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

export type ScanErrorKind =
  | 'unknown_barcode'
  | 'archived_product'
  | 'forbidden'
  | 'invalid_request'
  | 'server';

export interface ScanError {
  kind: ScanErrorKind;
  message: string;
}

/**
 * Map an API failure to a state the operator can act on. The server already
 * distinguishes these loudly (404 unknown code, 409 archived, 403 permission
 * or location scope, 400 invalid input); the UI must keep them distinct rather
 * than flatten everything into "something went wrong".
 */
export function classifyScanError(status: number, message: string, barcode?: string): ScanError {
  switch (status) {
    case 404:
      return {
        kind: 'unknown_barcode',
        message: `No product matches ${barcode ? `"${barcode}"` : 'this barcode'}. Add the barcode to a product in the catalogue to enable scanning.`,
      };
    case 409:
      return { kind: 'archived_product', message };
    case 401:
    case 403:
      return { kind: 'forbidden', message };
    case 400:
      return { kind: 'invalid_request', message };
    default:
      return { kind: 'server', message: message || 'The scan could not be completed. Try again.' };
  }
}

// ---------------------------------------------------------------------------
// The resolved product and its quantity semantics
// ---------------------------------------------------------------------------

export type ConsumptionUnit = 'base' | 'pack';

export interface ResolvedScan {
  barcode: string;
  productId: string;
  productName: string;
  brand?: string;
  sku?: string;
  stockUnit: StockUnit;
  packSize?: number;
  quantityOnHandGrams: number;
  /**
   * Generated once per resolved scan and reused for every confirm attempt of
   * THAT scan, so a retried submission after a network error replays the
   * original movement server-side instead of deducting twice. A new scan gets
   * a new key.
   */
  idempotencyKey: string;
}

export function makeResolvedScan(
  lookup: BarcodeLookupResponse,
  barcode: string,
  idempotencyKey: string,
): ResolvedScan {
  return {
    barcode,
    productId: lookup.product.id,
    productName: lookup.product.name,
    brand: lookup.product.brand,
    sku: lookup.product.sku,
    stockUnit: lookup.product.stockUnit,
    packSize: lookup.product.packSize,
    quantityOnHandGrams: lookup.quantityOnHandGrams,
    idempotencyKey,
  };
}

/** Packs when the product has (or implies) a pack; otherwise base quantities. */
export function defaultConsumptionUnit(scan: Pick<ResolvedScan, 'stockUnit' | 'packSize'>): ConsumptionUnit {
  if (scan.stockUnit === 'unit') return 'pack'; // one pack = one item
  return scan.packSize && scan.packSize > 0 ? 'pack' : 'base';
}

/** Human label for the quantity field ("packs of 100g", "items", "g", "ml"). */
export function consumptionUnitLabel(
  scan: Pick<ResolvedScan, 'stockUnit' | 'packSize'>,
  unit: ConsumptionUnit,
): string {
  if (scan.stockUnit === 'unit') return 'items';
  if (unit === 'base') return scan.stockUnit === 'millilitre' ? 'ml' : 'g';
  return scan.packSize && scan.packSize > 0
    ? `packs of ${scan.packSize}${scan.stockUnit === 'millilitre' ? 'ml' : 'g'}`
    : 'packs';
}

export type QuantityValidation = { ok: true; quantity: number } | { ok: false; message: string };

/**
 * The API accepts up to 3 decimals; whole-item products must be consumed in
 * whole items (you cannot scan out 1.5 combs). Everything else is a positive
 * number.
 */
export function validateConsumptionQuantity(
  input: string,
  scan: Pick<ResolvedScan, 'stockUnit'>,
  unit: ConsumptionUnit,
): QuantityValidation {
  const value = Number(input);
  if (input.trim() === '' || !Number.isFinite(value)) {
    return { ok: false, message: 'Enter a quantity.' };
  }
  if (value <= 0) {
    return { ok: false, message: 'Quantity must be greater than zero.' };
  }
  const decimals = (input.trim().split('.')[1] ?? '').length;
  if (decimals > 3) {
    return { ok: false, message: 'Quantity supports at most 3 decimal places.' };
  }
  const mustBeWhole = scan.stockUnit === 'unit' || unit === 'pack';
  if (mustBeWhole && !Number.isInteger(value)) {
    return {
      ok: false,
      message: scan.stockUnit === 'unit' ? 'Whole items only for this product.' : 'Whole packs only — switch to the base unit for a partial amount.',
    };
  }
  return { ok: true, quantity: value };
}

// ---------------------------------------------------------------------------
// Success reporting
// ---------------------------------------------------------------------------

export interface ScanSuccess {
  productName: string;
  deductedGrams: number;
  onHandGrams: number;
  stockUnit: StockUnit;
  replayed: boolean;
}

function formatBase(value: number, stockUnit: StockUnit): string {
  const rounded = Math.round(value * 10) / 10;
  const text = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
  if (stockUnit === 'unit') return `${text} ${rounded === 1 ? 'item' : 'items'}`;
  return `${text}${stockUnit === 'millilitre' ? 'ml' : 'g'}`;
}

/**
 * A replayed submission deducted nothing — saying "consumed" again would make
 * the operator think stock left the shelf twice.
 */
export function describeScanSuccess(success: ScanSuccess): string {
  if (success.replayed) {
    return `${success.productName}: already recorded — nothing further deducted. On hand: ${formatBase(success.onHandGrams, success.stockUnit)}.`;
  }
  return `${success.productName}: consumed ${formatBase(success.deductedGrams, success.stockUnit)}. On hand: ${formatBase(success.onHandGrams, success.stockUnit)}.`;
}

/** crypto.randomUUID when available (browser, modern node); safe fallback otherwise. */
export function newScanIdempotencyKey(): string {
  const cryptoRef = globalThis.crypto as Crypto | undefined;
  if (cryptoRef?.randomUUID) return `scan-${cryptoRef.randomUUID()}`;
  return `scan-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
