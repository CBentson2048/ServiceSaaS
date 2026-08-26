/**
 * Product create/edit form state (§9 of the redesign).
 *
 * Every field the product carries after Week 6 and the Pricing CR is
 * represented here — classification, availability is separate, supplier/MOQ/
 * order multiple, stock unit/pack size, barcode, dead-stock threshold — so the
 * drawer cannot silently drop a field (§29). DOM-free and unit-tested.
 */
import type { InventoryProduct, StockUnit, UpsertInventoryProductRequest } from '@sheer/domain';

export interface ProductFormState {
  id?: string;
  brand: string;
  name: string;
  categoryId: string;
  /** Kept so an archived-but-assigned category still renders its name. */
  categoryName: string;
  sku: string;
  sizeValue: string;
  sizeUnit: string;
  stockUnit: StockUnit;
  packSize: string;
  barcode: string;
  defaultCostPerGramCents: string;
  retailPriceCents: string;
  lowStockThresholdGrams: string;
  deadStockDays: string;
  supplierId: string;
  supplierName: string;
  minimumOrderQuantity: string;
  orderMultiple: string;
  isRetail: boolean;
  isSalonUse: boolean;
  isLabUse: boolean;
}

export const EMPTY_PRODUCT_FORM: ProductFormState = {
  brand: '',
  name: '',
  categoryId: '',
  categoryName: '',
  sku: '',
  sizeValue: '',
  sizeUnit: 'g',
  stockUnit: 'gram',
  packSize: '',
  barcode: '',
  defaultCostPerGramCents: '',
  retailPriceCents: '',
  lowStockThresholdGrams: '',
  deadStockDays: '',
  supplierId: '',
  supplierName: '',
  minimumOrderQuantity: '',
  orderMultiple: '',
  isRetail: false,
  isSalonUse: false,
  isLabUse: false,
};

export function productToFormState(product: InventoryProduct): ProductFormState {
  return {
    id: product.id,
    brand: product.brand ?? '',
    name: product.name,
    categoryId: product.categoryId ?? '',
    categoryName: product.category ?? '',
    sku: product.sku ?? '',
    sizeValue: product.sizeValue === undefined ? '' : String(product.sizeValue),
    sizeUnit: product.sizeUnit,
    stockUnit: product.stockUnit,
    packSize: product.packSize === undefined ? '' : String(product.packSize),
    barcode: product.barcode ?? '',
    defaultCostPerGramCents:
      product.defaultCostPerGramCents === undefined ? '' : String(product.defaultCostPerGramCents),
    retailPriceCents: product.retailPriceCents === undefined ? '' : String(product.retailPriceCents),
    lowStockThresholdGrams: String(product.lowStockThresholdGrams ?? 0),
    deadStockDays: product.deadStockDays === undefined ? '' : String(product.deadStockDays),
    supplierId: product.supplierId ?? '',
    supplierName: product.supplierName ?? '',
    // Defaults of 1 are the platform's, not the user's — showing "1" in an
    // empty-by-default field would imply configuration that was never made.
    minimumOrderQuantity: product.minimumOrderQuantity > 1 ? String(product.minimumOrderQuantity) : '',
    orderMultiple: product.orderMultiple > 1 ? String(product.orderMultiple) : '',
    isRetail: product.isRetail,
    isSalonUse: product.isSalonUse,
    isLabUse: product.isLabUse,
  };
}

export type ProductFormErrors = Partial<Record<keyof ProductFormState, string>>;

function optionalNumber(value: string): number | undefined {
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function isBlankOrNumber(value: string): boolean {
  return value.trim() === '' || Number.isFinite(Number(value.trim()));
}

export function validateProductForm(state: ProductFormState): ProductFormErrors {
  const errors: ProductFormErrors = {};
  if (!state.name.trim()) errors.name = 'Product name is required.';

  const numericFields: [keyof ProductFormState, string][] = [
    ['sizeValue', 'Size'],
    ['packSize', 'Pack size'],
    ['defaultCostPerGramCents', 'Cost'],
    ['retailPriceCents', 'Retail price'],
    ['lowStockThresholdGrams', 'Safety threshold'],
    ['deadStockDays', 'Dead stock days'],
    ['minimumOrderQuantity', 'Minimum order'],
    ['orderMultiple', 'Order multiple'],
  ];
  for (const [field, label] of numericFields) {
    const raw = String(state[field] ?? '');
    if (!isBlankOrNumber(raw)) {
      errors[field] = `${label} must be a number.`;
      continue;
    }
    const value = optionalNumber(raw);
    if (value !== undefined && value < 0) errors[field] = `${label} cannot be negative.`;
  }

  const packSize = optionalNumber(state.packSize);
  if (packSize !== undefined && packSize <= 0) errors.packSize = 'Pack size must be greater than zero.';

  for (const field of ['minimumOrderQuantity', 'orderMultiple'] as const) {
    const value = optionalNumber(state[field]);
    if (value !== undefined && (!Number.isInteger(value) || value < 1)) {
      errors[field] = 'Must be a whole number of packs, 1 or more.';
    }
  }

  const deadStockDays = optionalNumber(state.deadStockDays);
  if (deadStockDays !== undefined && (!Number.isInteger(deadStockDays) || deadStockDays < 1)) {
    errors.deadStockDays = 'Must be a whole number of days, 1 or more.';
  }

  const barcode = state.barcode.trim();
  if (barcode.length > 64) errors.barcode = 'Barcode is limited to 64 characters.';
  if (barcode && /\s/.test(barcode)) errors.barcode = 'Barcode cannot contain spaces.';

  // A weight-stocked product that is sold at the till must resolve a pack, or
  // the sale cannot deduct stock (the rule record_retail_sale enforces).
  if (state.isRetail && state.stockUnit !== 'unit') {
    const size = optionalNumber(state.sizeValue);
    if (packSize === undefined && (size === undefined || size <= 0)) {
      errors.packSize = 'A retail product needs a pack size (or a size) so a sale can deduct stock.';
    }
  }

  return errors;
}

export function hasErrors(errors: ProductFormErrors): boolean {
  return Object.keys(errors).length > 0;
}

/**
 * The API payload. Optional numeric fields go as null when cleared so the
 * server stores "not configured" rather than a fabricated zero.
 */
export function buildProductPayload(state: ProductFormState): UpsertInventoryProductRequest {
  const clean = (value: string) => (value.trim() ? value.trim() : null);
  const optionalInteger = (value: string) => {
    const parsed = optionalNumber(value);
    return parsed === undefined ? null : Math.round(parsed);
  };
  return {
    brand: clean(state.brand),
    name: state.name.trim(),
    categoryId: state.categoryId || null,
    sku: clean(state.sku),
    sizeValue: optionalNumber(state.sizeValue) ?? null,
    sizeUnit: clean(state.sizeUnit) ?? 'g',
    defaultCostPerGramCents: optionalInteger(state.defaultCostPerGramCents),
    retailPriceCents: optionalInteger(state.retailPriceCents),
    lowStockThresholdGrams: optionalNumber(state.lowStockThresholdGrams) ?? 0,
    stockUnit: state.stockUnit,
    packSize: optionalNumber(state.packSize) ?? null,
    barcode: clean(state.barcode),
    supplierId: state.supplierId || null,
    minimumOrderQuantity: optionalInteger(state.minimumOrderQuantity) ?? 1,
    orderMultiple: optionalInteger(state.orderMultiple) ?? 1,
    deadStockDays: optionalInteger(state.deadStockDays),
    isRetail: state.isRetail,
    isSalonUse: state.isSalonUse,
    isLabUse: state.isLabUse,
  };
}

/** Classification options, with the plain-English meaning each one carries. */
export const PRODUCT_USE_OPTIONS: {
  key: 'isRetail' | 'isSalonUse' | 'isLabUse';
  label: string;
  description: string;
}[] = [
  { key: 'isRetail', label: 'Retail', description: 'Sold directly to clients at the till.' },
  { key: 'isSalonUse', label: 'Salon use', description: 'Used operationally in the salon (backbar).' },
  { key: 'isLabUse', label: 'QLAB', description: 'Available for colour formulas in QLAB.' },
];
