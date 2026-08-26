/**
 * The Product Inventory table's row model, filters and overview metrics
 * (§6/§7/§27). These pin the behaviour a salon owner relies on: every product
 * is findable, status is honest, and the numbers on top agree with the table
 * underneath them.
 */
import type { BusinessLocationSummary, InventoryLocationStock, InventoryProduct } from '@sheer/domain';
import {
  EMPTY_FILTERS,
  buildInventoryRows,
  filterInventoryRows,
  formatCount,
  formatCurrencyFromCents,
  formatRowQuantity,
  stockStatusOf,
  summariseInventory,
} from './inventoryRows';

const LOCATIONS: BusinessLocationSummary[] = [
  { id: 'loc-1', name: 'Pinner' },
  { id: 'loc-2', name: 'Kensington' },
];

const product = (overrides: Partial<InventoryProduct> = {}): InventoryProduct => ({
  id: 'prod-1',
  businessId: 'biz-1',
  name: 'Majirel 6.0',
  brand: 'L’Oréal',
  sku: 'MAJ-60',
  categoryId: 'cat-1',
  category: 'Colour',
  sizeUnit: 'g',
  defaultUnit: 'g',
  lowStockThresholdGrams: 50,
  isActive: true,
  stockUnit: 'gram',
  packSize: 100,
  barcode: '5010000000001',
  minimumOrderQuantity: 1,
  orderMultiple: 1,
  isSalonUse: true,
  isLabUse: true,
  isRetail: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

const stockRecord = (overrides: Partial<InventoryLocationStock> = {}): InventoryLocationStock => ({
  id: 'stock-1',
  businessId: 'biz-1',
  locationId: 'loc-1',
  locationName: 'Pinner',
  productId: 'prod-1',
  productName: 'Majirel 6.0',
  quantityOnHandGrams: 500,
  effectiveLowStockThresholdGrams: 50,
  isLowStock: false,
  isActive: true,
  updatedAt: '2026-08-01T00:00:00.000Z',
  ...overrides,
});

describe('stock status', () => {
  it('is healthy above the threshold', () => {
    expect(stockStatusOf({ quantityOnHand: 500, thresholdBase: 50 })).toBe('healthy');
  });

  it('is low AT the threshold, matching the server rule (quantity <= threshold)', () => {
    expect(stockStatusOf({ quantityOnHand: 50, thresholdBase: 50 })).toBe('low');
    expect(stockStatusOf({ quantityOnHand: 49, thresholdBase: 50 })).toBe('low');
  });

  it('is out at zero or below, never "low"', () => {
    expect(stockStatusOf({ quantityOnHand: 0, thresholdBase: 50 })).toBe('out');
    expect(stockStatusOf({ quantityOnHand: -5, thresholdBase: 50 })).toBe('out');
  });

  it('is healthy with plenty of stock and no threshold configured', () => {
    expect(stockStatusOf({ quantityOnHand: 10, thresholdBase: 0 })).toBe('healthy');
  });

  it('reports an unavailable shelf record distinctly from out of stock', () => {
    expect(stockStatusOf({ quantityOnHand: 500, thresholdBase: 50, stockIsActive: false })).toBe('unavailable');
  });

  it('lets archived win over every stock state', () => {
    expect(stockStatusOf({ quantityOnHand: 500, thresholdBase: 50, productIsActive: false })).toBe('archived');
  });
});

describe('building rows', () => {
  it('produces one row per product per stocked location', () => {
    const rows = buildInventoryRows({
      products: [product()],
      stock: [stockRecord(), stockRecord({ id: 'stock-2', locationId: 'loc-2', locationName: 'Kensington', quantityOnHandGrams: 0 })],
      locationsInScope: LOCATIONS,
    });
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.locationName).sort()).toEqual(['Kensington', 'Pinner']);
    expect(rows.find((row) => row.locationName === 'Kensington')?.status).toBe('out');
  });

  it('still shows a product that has no shelf record anywhere — it must stay findable', () => {
    const rows = buildInventoryRows({
      products: [product({ id: 'prod-new', name: 'Brand New Serum' })],
      stock: [],
      locationsInScope: LOCATIONS,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ productName: 'Brand New Serum', status: 'not_stocked', quantityOnHand: null });
  });

  it('does not repeat a stocked product as "not stocked" at its other locations', () => {
    const rows = buildInventoryRows({
      products: [product()],
      stock: [stockRecord()],
      locationsInScope: LOCATIONS,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].locationName).toBe('Pinner');
  });

  it('names the single location for an unstocked product when the scope is one salon', () => {
    const rows = buildInventoryRows({
      products: [product()],
      stock: [],
      locationsInScope: [LOCATIONS[0]],
    });
    expect(rows[0].locationName).toBe('Pinner');
    expect(rows[0].locationId).toBe('loc-1');
  });

  it('carries the identifiers the row and its actions need', () => {
    const rows = buildInventoryRows({ products: [product()], stock: [stockRecord()], locationsInScope: LOCATIONS });
    expect(rows[0]).toMatchObject({
      productId: 'prod-1',
      stockId: 'stock-1',
      sku: 'MAJ-60',
      barcode: '5010000000001',
      categoryId: 'cat-1',
      stockUnit: 'gram',
    });
  });

  it('sorts by product then location so the list is scannable', () => {
    const rows = buildInventoryRows({
      products: [product({ id: 'b', name: 'Zinc Mask' }), product({ id: 'a', name: 'Argan Oil' })],
      stock: [],
      locationsInScope: LOCATIONS,
    });
    expect(rows.map((row) => row.productName)).toEqual(['Argan Oil', 'Zinc Mask']);
  });
});

describe('filters', () => {
  const rows = buildInventoryRows({
    products: [
      product(),
      product({ id: 'prod-2', name: 'Blondor', sku: 'BLND', categoryId: 'cat-2', category: 'Lightener', barcode: '999' }),
      product({ id: 'prod-3', name: 'Retired Gloss', isActive: false }),
    ],
    stock: [
      stockRecord(),
      stockRecord({ id: 'stock-2', productId: 'prod-2', productName: 'Blondor', locationId: 'loc-2', locationName: 'Kensington', quantityOnHandGrams: 10, effectiveLowStockThresholdGrams: 50 }),
    ],
    locationsInScope: LOCATIONS,
  });

  it('hides archived products until they are asked for', () => {
    const visible = filterInventoryRows(rows, EMPTY_FILTERS);
    expect(visible.some((row) => row.productName === 'Retired Gloss')).toBe(false);
    const archived = filterInventoryRows(rows, { ...EMPTY_FILTERS, status: 'archived' });
    expect(archived.map((row) => row.productName)).toEqual(['Retired Gloss']);
  });

  it('searches name, brand, SKU, barcode and category', () => {
    for (const term of ['majirel', 'oréal', 'MAJ-60', '5010000000001', 'colour']) {
      const found = filterInventoryRows(rows, { ...EMPTY_FILTERS, search: term });
      expect(found.map((row) => row.productName)).toContain('Majirel 6.0');
    }
  });

  it('returns nothing for a term that matches no product', () => {
    expect(filterInventoryRows(rows, { ...EMPTY_FILTERS, search: 'nonexistent' })).toHaveLength(0);
  });

  it('filters by location', () => {
    const found = filterInventoryRows(rows, { ...EMPTY_FILTERS, locationId: 'loc-2' });
    expect(found.map((row) => row.productName)).toEqual(['Blondor']);
  });

  it('filters by category', () => {
    const found = filterInventoryRows(rows, { ...EMPTY_FILTERS, categoryId: 'cat-2' });
    expect(found.map((row) => row.productName)).toEqual(['Blondor']);
  });

  it('filters by status', () => {
    expect(filterInventoryRows(rows, { ...EMPTY_FILTERS, status: 'low' }).map((row) => row.productName)).toEqual(['Blondor']);
    expect(filterInventoryRows(rows, { ...EMPTY_FILTERS, status: 'healthy' }).map((row) => row.productName)).toEqual(['Majirel 6.0']);
  });

  it('low-stock-only keeps low AND out of stock — both need attention', () => {
    const withOut = buildInventoryRows({
      products: [product(), product({ id: 'prod-2', name: 'Blondor' })],
      stock: [stockRecord(), stockRecord({ id: 's2', productId: 'prod-2', productName: 'Blondor', quantityOnHandGrams: 0 })],
      locationsInScope: LOCATIONS,
    });
    const found = filterInventoryRows(withOut, { ...EMPTY_FILTERS, lowStockOnly: true });
    expect(found.map((row) => row.productName)).toEqual(['Blondor']);
  });

  it('combines filters', () => {
    const found = filterInventoryRows(rows, { ...EMPTY_FILTERS, search: 'blondor', locationId: 'loc-2', status: 'low' });
    expect(found).toHaveLength(1);
  });
});

describe('overview metrics', () => {
  it('counts distinct products, low and out rows from what is in view', () => {
    const rows = buildInventoryRows({
      products: [product(), product({ id: 'prod-2', name: 'Blondor' })],
      stock: [
        stockRecord(),
        stockRecord({ id: 's2', locationId: 'loc-2', locationName: 'Kensington', quantityOnHandGrams: 10 }),
        stockRecord({ id: 's3', productId: 'prod-2', productName: 'Blondor', quantityOnHandGrams: 0 }),
      ],
      locationsInScope: LOCATIONS,
    });
    const summary = summariseInventory(rows, { count: 2, valueCents: 4500 });
    // Two distinct products, one low row (the 10g), one out row.
    expect(summary).toEqual({ products: 2, lowStock: 1, outOfStock: 1, deadStockValueCents: 4500, deadStockCount: 2 });
  });

  it('agrees with a filtered table', () => {
    const rows = buildInventoryRows({ products: [product()], stock: [stockRecord()], locationsInScope: LOCATIONS });
    const filtered = filterInventoryRows(rows, { ...EMPTY_FILTERS, status: 'out' });
    expect(summariseInventory(filtered, { count: 0, valueCents: 0 }).products).toBe(0);
  });
});

describe('formatting', () => {
  it('never zero-pads a count', () => {
    expect(formatCount(2)).toBe('2');
    expect(formatCount(0)).toBe('0');
    expect(formatCount(1234)).toBe('1,234');
  });

  it('shows a dash for an unstocked row rather than 0', () => {
    expect(formatRowQuantity({ quantityOnHand: null, stockUnit: 'gram' })).toBe('—');
    expect(formatRowQuantity({ quantityOnHand: 0, stockUnit: 'gram' })).toBe('0g');
  });

  it('uses the product unit', () => {
    expect(formatRowQuantity({ quantityOnHand: 1, stockUnit: 'unit' })).toBe('1 item');
    expect(formatRowQuantity({ quantityOnHand: 3, stockUnit: 'unit' })).toBe('3 items');
    expect(formatRowQuantity({ quantityOnHand: 250.5, stockUnit: 'millilitre' })).toBe('250.5ml');
  });

  it('formats money in pounds', () => {
    expect(formatCurrencyFromCents(4500)).toBe('£45.00');
  });
});
