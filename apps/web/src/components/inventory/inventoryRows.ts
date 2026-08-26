/**
 * The Product Inventory table's row model, filters and overview metrics
 * (§6/§7/§27 of the Product Management redesign).
 *
 * A row is a product AT a location — the existing location-aware semantics of
 * inventory.location_stock, unchanged. Two additions make the table the real
 * product surface rather than a stock dump:
 *   - a product with no shelf record in scope still appears, as `not_stocked`,
 *     so a newly created product is findable and editable instead of invisible;
 *   - a shelf record flagged inactive appears as `unavailable`, matching the
 *     location-availability semantics the Pricing/Classification CR introduced.
 *
 * DOM-free: every rule here is unit-tested (inventoryRows.spec.ts).
 */
import type {
  BusinessLocationSummary,
  InventoryLocationStock,
  InventoryProduct,
  StockUnit,
} from '@sheer/domain';

export type StockStatus = 'healthy' | 'low' | 'out' | 'unavailable' | 'not_stocked' | 'archived';

export interface InventoryRow {
  /** Stable key: stock record id, else product+location. */
  key: string;
  productId: string;
  productName: string;
  brand?: string;
  sku?: string;
  barcode?: string;
  categoryId?: string;
  category?: string;
  locationId?: string;
  locationName: string;
  /** Base quantity on hand; null when the product has no shelf record here. */
  quantityOnHand: number | null;
  stockUnit: StockUnit;
  /** Effective safety threshold, 0 when none is configured. */
  thresholdBase: number;
  status: StockStatus;
  isActiveProduct: boolean;
  /** The underlying stock record, when one exists (adjustments need its id). */
  stockId?: string;
}

export interface InventoryFilters {
  search: string;
  /** undefined = every location in scope. */
  locationId?: string;
  categoryId?: string;
  status?: StockStatus | 'all';
  lowStockOnly?: boolean;
}

export const EMPTY_FILTERS: InventoryFilters = {
  search: '',
  locationId: undefined,
  categoryId: undefined,
  status: 'all',
  lowStockOnly: false,
};

export function stockStatusOf(row: {
  quantityOnHand: number | null;
  thresholdBase: number;
  stockIsActive?: boolean;
  productIsActive?: boolean;
}): StockStatus {
  // Archived wins: an archived product cannot be sold or consumed, whatever
  // its shelf says.
  if (row.productIsActive === false) return 'archived';
  if (row.quantityOnHand === null) return 'not_stocked';
  if (row.stockIsActive === false) return 'unavailable';
  if (row.quantityOnHand <= 0) return 'out';
  // `>` is deliberate: at exactly the threshold the shelf is already low —
  // this mirrors the server's isLowStock (quantity <= threshold).
  if (row.thresholdBase > 0 && row.quantityOnHand <= row.thresholdBase) return 'low';
  return 'healthy';
}

export const STATUS_LABELS: Record<StockStatus, string> = {
  healthy: 'Healthy',
  low: 'Low stock',
  out: 'Out of stock',
  unavailable: 'Not available here',
  not_stocked: 'Not stocked',
  archived: 'Archived',
};

export const STATUS_TONES: Record<StockStatus, 'success' | 'warning' | 'danger' | 'neutral'> = {
  healthy: 'success',
  low: 'warning',
  out: 'danger',
  unavailable: 'neutral',
  not_stocked: 'neutral',
  archived: 'neutral',
};

/**
 * Build every row for the scope. `locationsInScope` is what the sidebar scope
 * resolved to, so a "not stocked" row is only invented for locations the user
 * can actually see.
 */
export function buildInventoryRows(input: {
  products: InventoryProduct[];
  stock: InventoryLocationStock[];
  locationsInScope: BusinessLocationSummary[];
}): InventoryRow[] {
  const productById = new Map(input.products.map((product) => [product.id, product]));
  const rows: InventoryRow[] = [];
  const seen = new Set<string>();

  for (const record of input.stock) {
    const product = productById.get(record.productId);
    const stockUnit = product?.stockUnit ?? 'gram';
    const quantity = record.quantityOnHandGrams;
    const threshold = record.effectiveLowStockThresholdGrams ?? 0;
    seen.add(`${record.productId}:${record.locationId}`);
    rows.push({
      key: record.id,
      productId: record.productId,
      productName: product?.name ?? record.productName,
      brand: product?.brand ?? record.brand,
      sku: product?.sku ?? record.sku,
      barcode: product?.barcode,
      categoryId: product?.categoryId,
      category: product?.category ?? record.category,
      locationId: record.locationId,
      locationName: record.locationName,
      quantityOnHand: quantity,
      stockUnit,
      thresholdBase: threshold,
      status: stockStatusOf({
        quantityOnHand: quantity,
        thresholdBase: threshold,
        stockIsActive: record.isActive,
        productIsActive: product?.isActive,
      }),
      isActiveProduct: product?.isActive ?? true,
      stockId: record.id,
    });
  }

  // Products with no shelf record anywhere in scope: surfaced once per scope so
  // they can be found, edited and stocked. A product stocked at one location in
  // scope is NOT repeated as "not stocked" at the others — that would flood the
  // table for multi-location businesses.
  for (const product of input.products) {
    const stockedSomewhereInScope = input.locationsInScope.some((location) =>
      seen.has(`${product.id}:${location.id}`),
    );
    if (stockedSomewhereInScope) continue;
    rows.push({
      key: `unstocked:${product.id}`,
      productId: product.id,
      productName: product.name,
      brand: product.brand,
      sku: product.sku,
      barcode: product.barcode,
      categoryId: product.categoryId,
      category: product.category,
      locationId: input.locationsInScope.length === 1 ? input.locationsInScope[0].id : undefined,
      locationName: input.locationsInScope.length === 1 ? input.locationsInScope[0].name : '—',
      quantityOnHand: null,
      stockUnit: product.stockUnit,
      thresholdBase: product.lowStockThresholdGrams ?? 0,
      status: product.isActive ? 'not_stocked' : 'archived',
      isActiveProduct: product.isActive,
    });
  }

  return rows.sort(
    (a, b) => a.productName.localeCompare(b.productName) || a.locationName.localeCompare(b.locationName),
  );
}

/** Search matches name, brand, SKU and barcode — the four things staff know. */
export function rowMatchesSearch(row: InventoryRow, term: string): boolean {
  const needle = term.trim().toLowerCase();
  if (!needle) return true;
  return [row.productName, row.brand ?? '', row.sku ?? '', row.barcode ?? '', row.category ?? '']
    .join(' ')
    .toLowerCase()
    .includes(needle);
}

export function filterInventoryRows(rows: InventoryRow[], filters: InventoryFilters): InventoryRow[] {
  return rows.filter((row) => {
    // Archived products stay out of the way until explicitly asked for.
    if (row.status === 'archived' && filters.status !== 'archived') return false;
    if (!rowMatchesSearch(row, filters.search)) return false;
    if (filters.locationId && row.locationId !== filters.locationId) return false;
    if (filters.categoryId && row.categoryId !== filters.categoryId) return false;
    if (filters.status && filters.status !== 'all' && row.status !== filters.status) return false;
    if (filters.lowStockOnly && row.status !== 'low' && row.status !== 'out') return false;
    return true;
  });
}

export interface InventoryOverview {
  /** Distinct active products visible in the current view. */
  products: number;
  lowStock: number;
  outOfStock: number;
  /** Cents tied up in dead stock, from the server's dead-stock report. */
  deadStockValueCents: number;
  deadStockCount: number;
}

/**
 * Overview metrics for the rows currently in view, so the numbers agree with
 * the table beneath them (§6: metrics respect active filters/location).
 */
export function summariseInventory(
  rows: InventoryRow[],
  deadStock: { count: number; valueCents: number },
): InventoryOverview {
  const products = new Set<string>();
  let lowStock = 0;
  let outOfStock = 0;
  for (const row of rows) {
    if (row.isActiveProduct) products.add(row.productId);
    if (row.status === 'low') lowStock += 1;
    if (row.status === 'out') outOfStock += 1;
  }
  return {
    products: products.size,
    lowStock,
    outOfStock,
    deadStockValueCents: deadStock.valueCents,
    deadStockCount: deadStock.count,
  };
}

/** Quantity with the product's unit; "—" when the product is not stocked here. */
export function formatRowQuantity(row: Pick<InventoryRow, 'quantityOnHand' | 'stockUnit'>): string {
  if (row.quantityOnHand === null) return '—';
  const rounded = Math.round(row.quantityOnHand * 10) / 10;
  const amount = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 1 }).format(rounded);
  if (row.stockUnit === 'unit') return `${amount} ${rounded === 1 ? 'item' : 'items'}`;
  return `${amount}${row.stockUnit === 'millilitre' ? 'ml' : 'g'}`;
}

/** Plain count formatting — never zero-padded ("2", not "02"; §6). */
export function formatCount(value: number): string {
  return new Intl.NumberFormat('en-GB').format(value);
}

export function formatCurrencyFromCents(cents: number, currency = 'GBP'): string {
  return new Intl.NumberFormat('en-GB', { style: 'currency', currency }).format(cents / 100);
}
