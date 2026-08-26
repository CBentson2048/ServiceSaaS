/**
 * The product form must carry EVERY field the product has gained (Week 6 and
 * the Pricing CR) and must never invent or drop one (§29). These tests are the
 * guard against a redesign quietly regressing a field.
 */
import type { InventoryProduct } from '@sheer/domain';
import {
  EMPTY_PRODUCT_FORM,
  buildProductPayload,
  hasErrors,
  productToFormState,
  validateProductForm,
} from './productForm';

const product: InventoryProduct = {
  id: 'prod-1',
  businessId: 'biz-1',
  name: 'Majirel 6.0',
  brand: 'L’Oréal',
  sku: 'MAJ-60',
  categoryId: 'cat-1',
  category: 'Colour',
  sizeValue: 100,
  sizeUnit: 'g',
  defaultUnit: 'g',
  defaultCostPerGramCents: 5,
  retailPriceCents: 1499,
  lowStockThresholdGrams: 50,
  isActive: true,
  stockUnit: 'gram',
  packSize: 100,
  barcode: '5010000000001',
  supplierId: 'sup-1',
  supplierName: 'Wella Professionals',
  minimumOrderQuantity: 6,
  orderMultiple: 6,
  deadStockDays: 90,
  isSalonUse: true,
  isLabUse: true,
  isRetail: true,
  labMarkupPercent: 25,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

describe('loading an existing product', () => {
  it('round-trips every stock, ordering, barcode and classification field', () => {
    expect(productToFormState(product)).toMatchObject({
      id: 'prod-1',
      name: 'Majirel 6.0',
      brand: 'L’Oréal',
      sku: 'MAJ-60',
      categoryId: 'cat-1',
      sizeValue: '100',
      stockUnit: 'gram',
      packSize: '100',
      barcode: '5010000000001',
      supplierId: 'sup-1',
      supplierName: 'Wella Professionals',
      minimumOrderQuantity: '6',
      orderMultiple: '6',
      deadStockDays: '90',
      lowStockThresholdGrams: '50',
      isRetail: true,
      isSalonUse: true,
      isLabUse: true,
    });
  });

  it('leaves platform defaults (MOQ/multiple of 1) blank rather than implying configuration', () => {
    const state = productToFormState({ ...product, minimumOrderQuantity: 1, orderMultiple: 1 });
    expect(state.minimumOrderQuantity).toBe('');
    expect(state.orderMultiple).toBe('');
  });

  it('keeps the assigned category name so an archived category still reads', () => {
    expect(productToFormState(product).categoryName).toBe('Colour');
  });
});

describe('validation', () => {
  const valid = { ...EMPTY_PRODUCT_FORM, name: 'New product' };

  it('requires a name', () => {
    expect(validateProductForm({ ...valid, name: '  ' }).name).toBeDefined();
    expect(hasErrors(validateProductForm(valid))).toBe(false);
  });

  it('rejects non-numeric and negative numbers', () => {
    expect(validateProductForm({ ...valid, packSize: 'abc' }).packSize).toBeDefined();
    expect(validateProductForm({ ...valid, lowStockThresholdGrams: '-5' }).lowStockThresholdGrams).toBeDefined();
  });

  it('rejects a zero pack size — a pack of nothing cannot deduct stock', () => {
    expect(validateProductForm({ ...valid, packSize: '0' }).packSize).toBeDefined();
  });

  it('requires whole packs for MOQ and order multiple', () => {
    expect(validateProductForm({ ...valid, minimumOrderQuantity: '1.5' }).minimumOrderQuantity).toBeDefined();
    expect(validateProductForm({ ...valid, orderMultiple: '0' }).orderMultiple).toBeDefined();
    expect(validateProductForm({ ...valid, minimumOrderQuantity: '6' }).minimumOrderQuantity).toBeUndefined();
  });

  it('requires whole days for the dead-stock threshold, and allows blank (location default)', () => {
    expect(validateProductForm({ ...valid, deadStockDays: '2.5' }).deadStockDays).toBeDefined();
    expect(validateProductForm({ ...valid, deadStockDays: '' }).deadStockDays).toBeUndefined();
  });

  it('rejects a barcode with spaces or beyond the API limit', () => {
    expect(validateProductForm({ ...valid, barcode: '501 000' }).barcode).toBeDefined();
    expect(validateProductForm({ ...valid, barcode: 'x'.repeat(65) }).barcode).toBeDefined();
    expect(validateProductForm({ ...valid, barcode: '5010000000001' }).barcode).toBeUndefined();
  });

  it('stops a weight-stocked retail product that could never deduct at the till', () => {
    const errors = validateProductForm({ ...valid, isRetail: true, stockUnit: 'gram', packSize: '', sizeValue: '' });
    expect(errors.packSize).toMatch(/pack size/i);
    // A size alone is enough — record_retail_sale falls back to it.
    expect(validateProductForm({ ...valid, isRetail: true, sizeValue: '100' }).packSize).toBeUndefined();
    // Unit-stocked retail needs no pack at all.
    expect(validateProductForm({ ...valid, isRetail: true, stockUnit: 'unit' }).packSize).toBeUndefined();
  });
});

describe('payload', () => {
  it('sends cleared optional fields as null, not zero', () => {
    const payload = buildProductPayload({ ...EMPTY_PRODUCT_FORM, name: 'X' });
    expect(payload).toMatchObject({
      sizeValue: null,
      packSize: null,
      barcode: null,
      supplierId: null,
      deadStockDays: null,
      defaultCostPerGramCents: null,
      retailPriceCents: null,
    });
  });

  it('defaults MOQ and order multiple to 1 when blank — the platform default', () => {
    const payload = buildProductPayload({ ...EMPTY_PRODUCT_FORM, name: 'X' });
    expect(payload.minimumOrderQuantity).toBe(1);
    expect(payload.orderMultiple).toBe(1);
  });

  it('carries the classification flags and never mutates them into one another', () => {
    const payload = buildProductPayload({ ...EMPTY_PRODUCT_FORM, name: 'X', isRetail: true, isLabUse: true });
    expect(payload).toMatchObject({ isRetail: true, isLabUse: true, isSalonUse: false });
  });

  it('round-trips an existing product without losing a field', () => {
    const payload = buildProductPayload(productToFormState(product));
    expect(payload).toMatchObject({
      name: 'Majirel 6.0',
      brand: 'L’Oréal',
      sku: 'MAJ-60',
      categoryId: 'cat-1',
      sizeValue: 100,
      stockUnit: 'gram',
      packSize: 100,
      barcode: '5010000000001',
      supplierId: 'sup-1',
      minimumOrderQuantity: 6,
      orderMultiple: 6,
      deadStockDays: 90,
      lowStockThresholdGrams: 50,
      defaultCostPerGramCents: 5,
      retailPriceCents: 1499,
      isRetail: true,
      isSalonUse: true,
      isLabUse: true,
    });
  });

  it('trims text fields', () => {
    const payload = buildProductPayload({ ...EMPTY_PRODUCT_FORM, name: '  Spaced  ', sku: '  S1  ' });
    expect(payload.name).toBe('Spaced');
    expect(payload.sku).toBe('S1');
  });
});
