import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Navigate } from 'react-router-dom';
import type {
  BusinessLocationSummary,
  InventoryCategory,
  InventoryDeadStockItem,
  InventoryLocationStock,
  InventoryProduct,
  InventoryStockMovement,
  InventorySupplier,
} from '@sheer/domain';
import { userHasAnyRole, userHasRole } from '@sheer/domain';
import {
  RangeTabs,
  resolveCustomWindow,
  type CustomRange,
  type DashboardRange,
} from '../components/dashboard/RangeTabs';
import {
  ApiRequestError,
  archiveInventoryProduct,
  listInventoryCategories,
  listInventoryDeadStock,
  listInventoryMovements,
  listInventoryProducts,
  listInventoryStock,
  listInventorySuppliers,
  updateInventoryStockThreshold,
} from '../auth/api';
import { useAuth } from '../auth/AuthProvider';
import { useLocationScope } from '../components/LocationScopeContext';
import { ProductDrawer } from '../components/inventory/ProductDrawer';
import { ScanConsumeModal } from '../components/inventory/ScanConsumeModal';
import { StockOperationModal } from '../components/inventory/StockOperationModal';
import type { StockOperation } from '../components/inventory/stockOperationForm';
import {
  EMPTY_FILTERS,
  STATUS_LABELS,
  STATUS_TONES,
  buildInventoryRows,
  filterInventoryRows,
  formatCount,
  formatCurrencyFromCents,
  formatRowQuantity,
  summariseInventory,
  type InventoryFilters,
  type InventoryRow,
  type StockStatus,
} from '../components/inventory/inventoryRows';
import {
  formatAbsoluteTime,
  formatMovementQuantity,
  movementAuditFields,
  presentMovement,
} from '../components/inventory/movementPresentation';
import { AppButton, StatusBadge } from '../design/components';
import { Modal } from '../components/team/Modal';

/**
 * Product Management — Products tab.
 *
 * Information architecture (redesign §4): Overview → Product Inventory →
 * Stock insights (dead stock) → Recent stock activity. Every write is a task
 * that opens a drawer or modal (new/edit product, scan-consume, adjust,
 * restock), so the page itself stays a management surface rather than a stack
 * of permanent forms. Nothing here talks to stock directly: all mutations go
 * through the existing authoritative inventory API.
 */
export function InventoryPage() {
  const auth = useAuth();
  const accessToken = auth.session?.accessToken;
  const isOwner = userHasRole(auth.user, 'owner');
  const canManage = userHasAnyRole(auth.user, ['owner', 'manager']);
  const { selectedLocationId: scopeLocationId, isAllLocations } = useLocationScope();

  const [products, setProducts] = useState<InventoryProduct[]>([]);
  const [categories, setCategories] = useState<InventoryCategory[]>([]);
  const [suppliers, setSuppliers] = useState<InventorySupplier[]>([]);
  const [stock, setStock] = useState<InventoryLocationStock[]>([]);
  const [locations, setLocations] = useState<BusinessLocationSummary[]>([]);
  const [movements, setMovements] = useState<InventoryStockMovement[]>([]);
  const [deadStock, setDeadStock] = useState<InventoryDeadStockItem[]>([]);
  const [deadStockValueCents, setDeadStockValueCents] = useState(0);

  const [filters, setFilters] = useState<InventoryFilters>(EMPTY_FILTERS);
  const [range, setRange] = useState<DashboardRange>('month');
  const [customRange, setCustomRange] = useState<CustomRange>({ from: '', to: '' });
  const [activityProduct, setActivityProduct] = useState<{ id: string; name: string } | null>(null);
  const [openMovement, setOpenMovement] = useState<InventoryStockMovement | null>(null);

  const [drawerProduct, setDrawerProduct] = useState<InventoryProduct | undefined>(undefined);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [scanOpen, setScanOpen] = useState(false);
  const [operation, setOperation] = useState<{ kind: StockOperation; productId?: string; locationId?: string } | null>(null);

  const [catalogueState, setCatalogueState] = useState<LoadState>('loading');
  const [stockState, setStockState] = useState<LoadState>('loading');
  const [activityState, setActivityState] = useState<LoadState>('loading');
  const [insightsState, setInsightsState] = useState<LoadState>('loading');
  const [busyRow, setBusyRow] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const activityRef = useRef<HTMLDivElement>(null);

  const listingLocationId = isAllLocations ? undefined : scopeLocationId;
  const movementWindow = useMemo(() => resolveRangeWindow(range, customRange), [range, customRange]);

  // Four independent loaders so a write invalidates only what it changed
  // (§31) — editing a product never refetches the movement ledger.
  const loadCatalogue = useCallback(async () => {
    if (!accessToken) return;
    setCatalogueState('loading');
    try {
      const [productResult, categoryResult, supplierResult] = await Promise.all([
        listInventoryProducts(accessToken, { includeInactive: true }),
        listInventoryCategories(accessToken),
        listInventorySuppliers(accessToken),
      ]);
      setProducts(productResult.products);
      setCategories(categoryResult.categories);
      setSuppliers(supplierResult.suppliers);
      setCatalogueState('ready');
    } catch {
      setCatalogueState('failed');
    }
  }, [accessToken]);

  const loadStock = useCallback(async () => {
    if (!accessToken) return;
    setStockState('loading');
    try {
      const result = await listInventoryStock(accessToken, { locationId: listingLocationId });
      setStock(result.stock);
      setLocations(result.locations);
      setStockState('ready');
    } catch {
      setStockState('failed');
    }
  }, [accessToken, listingLocationId]);

  const loadActivity = useCallback(async () => {
    if (!accessToken) return;
    setActivityState('loading');
    try {
      const result = await listInventoryMovements(accessToken, {
        locationId: listingLocationId,
        productId: activityProduct?.id,
        limit: 100,
        from: movementWindow?.from,
        to: movementWindow?.to,
      });
      setMovements(result.movements);
      setActivityState('ready');
    } catch {
      setActivityState('failed');
    }
  }, [accessToken, listingLocationId, activityProduct, movementWindow]);

  const loadInsights = useCallback(async () => {
    if (!accessToken) return;
    setInsightsState('loading');
    try {
      // The low-stock KPI is derived from the rows in view so it always agrees
      // with the table; the server's alert list is not needed a second time.
      const deadStockResult = await listInventoryDeadStock(accessToken, {
        locationId: listingLocationId,
      });
      setDeadStock(deadStockResult.items);
      setDeadStockValueCents(deadStockResult.totalEstimatedValueCents);
      setInsightsState('ready');
    } catch {
      setInsightsState('failed');
    }
  }, [accessToken, listingLocationId]);

  useEffect(() => {
    void loadCatalogue();
  }, [loadCatalogue]);
  useEffect(() => {
    void loadStock();
  }, [loadStock]);
  useEffect(() => {
    void loadActivity();
  }, [loadActivity]);
  useEffect(() => {
    void loadInsights();
  }, [loadInsights]);

  /** A stock write changes levels, alerts and the ledger — but not the catalogue. */
  const refreshAfterStockChange = useCallback(() => {
    void loadStock();
    void loadActivity();
    void loadInsights();
  }, [loadStock, loadActivity, loadInsights]);

  const rows = useMemo(
    () =>
      buildInventoryRows({ products, stock, locationsInScope: locations }),
    [products, stock, locations],
  );
  const visibleRows = useMemo(() => filterInventoryRows(rows, filters), [rows, filters]);
  const overview = useMemo(
    () => summariseInventory(visibleRows, { count: deadStock.length, valueCents: deadStockValueCents }),
    [visibleRows, deadStock.length, deadStockValueCents],
  );
  const productById = useMemo(() => new Map(products.map((product) => [product.id, product])), [products]);
  const filtersActive =
    Boolean(filters.search.trim()) ||
    Boolean(filters.locationId) ||
    Boolean(filters.categoryId) ||
    (filters.status && filters.status !== 'all') ||
    Boolean(filters.lowStockOnly);

  if (auth.status === 'authenticated' && !canManage) {
    return <Navigate to="/unauthorized" replace />;
  }

  function openProduct(productId?: string) {
    if (productId) {
      const found = productById.get(productId);
      if (!found) {
        // Never silently turn "edit this product" into "create a new one".
        setError('That product could not be loaded. Refresh the catalogue and try again.');
        return;
      }
      setDrawerProduct(found);
    } else {
      setDrawerProduct(undefined);
    }
    setDrawerOpen(true);
  }

  async function handleThresholdUpdate(row: InventoryRow, value: string) {
    if (!accessToken || !row.stockId) return;
    // Blur fires whether or not anything changed; only write a real change.
    const current = row.thresholdBase ? String(row.thresholdBase) : '';
    if (value.trim() === current) return;
    const parsed = value.trim() === '' ? null : Number(value);
    if (parsed !== null && (!Number.isFinite(parsed) || parsed < 0)) {
      // Clearing a threshold must be deliberate (an empty box), never the
      // accident of a typo — a silently cleared threshold stops low-stock
      // warnings for that product.
      setError(`"${value}" is not a valid threshold for ${row.productName}. Enter a number, or clear the box to remove the threshold.`);
      setBusyRow(null);
      return;
    }
    setBusyRow(row.key);
    setError(null);
    try {
      await updateInventoryStockThreshold(accessToken, row.stockId, {
        lowStockThresholdGrams: parsed,
      });
      void loadStock();
      void loadInsights();
    } catch (cause: unknown) {
      setError(cause instanceof ApiRequestError ? cause.message : 'Could not update the safety threshold.');
    } finally {
      setBusyRow(null);
    }
  }

  async function handleArchive(row: InventoryRow) {
    if (!accessToken || !isOwner) return;
    if (!window.confirm(`Archive ${row.productName}? Its movement history is kept.`)) return;
    setBusyRow(row.key);
    setError(null);
    try {
      await archiveInventoryProduct(accessToken, row.productId);
      setNotice(`${row.productName} archived. Movement history remains intact.`);
      void loadCatalogue();
      void loadStock();
      void loadInsights();
    } catch (cause: unknown) {
      setError(cause instanceof ApiRequestError ? cause.message : 'Could not archive the product.');
    } finally {
      setBusyRow(null);
    }
  }

  function showProductHistory(row: InventoryRow) {
    setActivityProduct({ id: row.productId, name: row.productName });
    // Scrolling keeps the click and its result on the same screen.
    window.setTimeout(() => activityRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
  }

  const scopeLocationName = isAllLocations
    ? 'all locations'
    : (locations.find((location) => location.id === scopeLocationId)?.name ?? 'this location');
  const operationLocationId = isAllLocations ? locations[0]?.id : scopeLocationId;

  return (
    <>
      <h2 className="sr-only">Products</h2>

      {notice ? (
        <div className="mb-4 flex items-start justify-between gap-3 rounded-input-lg border border-success-border bg-success-soft px-4 py-3 text-[13px] text-success">
          <span>{notice}</span>
          <button type="button" onClick={() => setNotice(null)} aria-label="Dismiss" className="opacity-70 hover:opacity-100">
            ✕
          </button>
        </div>
      ) : null}
      {error ? (
        <div role="alert" className="mb-4 rounded-input-lg border border-danger-border bg-danger-soft px-4 py-3 text-[13px] text-danger">
          {error}
        </div>
      ) : null}

      {/* ---------------------------------------------------------------- */}
      {/* 1. Overview                                                       */}
      {/* ---------------------------------------------------------------- */}
      <section className="mb-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-label="Overview">
        <KpiCard
          label="Products"
          value={formatCount(overview.products)}
          hint={filtersActive ? 'matching your filters' : `active across ${scopeLocationName}`}
          icon={<BoxIcon className="h-4 w-4 text-primary" />}
        />
        <KpiCard
          label="Low stock"
          value={formatCount(overview.lowStock)}
          hint="shelves at or below their safety threshold"
          icon={<AlertIcon className="h-4 w-4 text-warning" />}
          badge={overview.lowStock > 0 ? { label: 'Action needed', tone: 'warning' } : undefined}
          onClick={() => setFilters((current) => ({ ...current, status: 'low', lowStockOnly: false }))}
        />
        <KpiCard
          label="Out of stock"
          value={formatCount(overview.outOfStock)}
          hint="shelves with nothing left"
          icon={<EmptyBoxIcon className="h-4 w-4 text-danger" />}
          badge={overview.outOfStock > 0 ? { label: 'Critical', tone: 'danger' } : undefined}
          onClick={() => setFilters((current) => ({ ...current, status: 'out', lowStockOnly: false }))}
        />
        <KpiCard
          label="Dead stock value"
          value={insightsState === 'failed' ? '—' : formatCurrencyFromCents(overview.deadStockValueCents)}
          hint={
            insightsState === 'failed'
              ? 'could not be calculated'
              : `${formatCount(overview.deadStockCount)} product${overview.deadStockCount === 1 ? '' : 's'} sitting unused`
          }
          icon={<ClockIcon className="h-4 w-4 text-text-secondary" />}
        />
      </section>

      {/* ---------------------------------------------------------------- */}
      {/* 2. Product inventory — the primary surface                        */}
      {/* ---------------------------------------------------------------- */}
      <section aria-label="Product inventory" className="mb-8 rounded-card-lg border border-border bg-surface shadow-card">
        <div className="flex flex-col gap-3 border-b border-border px-5 py-4 xl:flex-row xl:items-center xl:justify-between">
          <div>
            <h3 className="text-[15px] font-semibold text-text-primary">Product inventory</h3>
            <p className="mt-0.5 text-[13px] text-text-secondary">
              Live stock across {scopeLocationName}. Everything you can do to a product starts here.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <AppButton size="sm" variant="secondary" onClick={() => setScanOpen(true)}>
              Scan / consume
            </AppButton>
            <AppButton size="sm" variant="secondary" onClick={() => setOperation({ kind: 'adjust' })}>
              Adjust stock
            </AppButton>
            <AppButton size="sm" variant="secondary" onClick={() => setOperation({ kind: 'restock' })}>
              Restock
            </AppButton>
            {canManage ? (
              <AppButton size="sm" onClick={() => openProduct(undefined)}>
                + New product
              </AppButton>
            ) : null}
          </div>
        </div>

        {/* Filters */}
        <div className="flex flex-col gap-2 border-b border-border px-5 py-3 lg:flex-row lg:items-center">
          <div className="relative flex-1 lg:max-w-xs">
            <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted" />
            <input
              value={filters.search}
              onChange={(event) => setFilters((current) => ({ ...current, search: event.target.value }))}
              placeholder="Search name, brand, SKU or barcode…"
              aria-label="Search products"
              className="h-9 w-full rounded-input-lg border border-border-strong bg-surface pl-9 pr-3 text-[13px] outline-none focus:border-primary"
            />
          </div>
          <select
            value={filters.locationId ?? ''}
            onChange={(event) => setFilters((current) => ({ ...current, locationId: event.target.value || undefined }))}
            aria-label="Filter by location"
            className={FILTER_SELECT}
          >
            <option value="">All locations in view</option>
            {locations.map((location) => (
              <option key={location.id} value={location.id}>
                {location.name}
              </option>
            ))}
          </select>
          <select
            value={filters.categoryId ?? ''}
            onChange={(event) => setFilters((current) => ({ ...current, categoryId: event.target.value || undefined }))}
            aria-label="Filter by category"
            className={FILTER_SELECT}
          >
            <option value="">All categories</option>
            {categories.map((category) => (
              <option key={category.id} value={category.id}>
                {category.name}
              </option>
            ))}
          </select>
          <select
            value={filters.status ?? 'all'}
            onChange={(event) =>
              setFilters((current) => ({ ...current, status: event.target.value as StockStatus | 'all' }))
            }
            aria-label="Filter by stock status"
            className={FILTER_SELECT}
          >
            <option value="all">Any status</option>
            <option value="healthy">Healthy</option>
            <option value="low">Low stock</option>
            <option value="out">Out of stock</option>
            <option value="not_stocked">Not stocked</option>
            <option value="unavailable">Not available here</option>
            <option value="archived">Archived</option>
          </select>
          {filtersActive ? (
            <button
              type="button"
              onClick={() => setFilters(EMPTY_FILTERS)}
              className="h-9 rounded-pill px-3 text-[13px] font-medium text-text-secondary transition hover:bg-surface-alt hover:text-text-primary"
            >
              Clear filters
            </button>
          ) : null}
        </div>

        {/* Table */}
        {stockState === 'failed' || catalogueState === 'failed' ? (
          <RetryState
            title="Unable to load the product inventory."
            onRetry={() => {
              void loadCatalogue();
              void loadStock();
            }}
          />
        ) : (stockState === 'loading' || catalogueState === 'loading') && rows.length === 0 ? (
          <EmptyState title="Loading products…" body="Fetching the catalogue and current stock levels." />
        ) : visibleRows.length === 0 ? (
          rows.length === 0 ? (
            <EmptyState
              title="No products yet"
              body="Add your first product to begin tracking stock."
              action={canManage ? <AppButton size="sm" onClick={() => openProduct(undefined)}>+ New product</AppButton> : undefined}
            />
          ) : (
            <EmptyState
              title="No products match these filters"
              body="Try a different search term, or clear the filters to see everything."
              action={<AppButton size="sm" variant="secondary" onClick={() => setFilters(EMPTY_FILTERS)}>Clear filters</AppButton>}
            />
          )
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[860px] text-left text-[13px]">
              <thead className="border-b border-border bg-surface-alt text-[11px] uppercase tracking-[0.08em] text-text-secondary">
                <tr>
                  <th scope="col" className="px-5 py-2.5 font-medium">Product</th>
                  <th scope="col" className="px-4 py-2.5 font-medium">Category</th>
                  <th scope="col" className="px-4 py-2.5 font-medium">Location</th>
                  <th scope="col" className="px-4 py-2.5 text-right font-medium">Stock</th>
                  <th scope="col" className="px-4 py-2.5 text-right font-medium">Safety threshold</th>
                  <th scope="col" className="px-4 py-2.5 font-medium">Status</th>
                  <th scope="col" className="px-4 py-2.5 text-right font-medium">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {visibleRows.map((row) => (
                  <tr key={row.key} className="transition hover:bg-surface-alt">
                    <td className="px-5 py-3">
                      <button
                        type="button"
                        onClick={() => openProduct(row.productId)}
                        className="text-left font-medium text-text-primary hover:text-primary-deep"
                      >
                        {row.productName}
                      </button>
                      <div className="text-[12px] text-text-muted">
                        {[row.brand, row.sku].filter(Boolean).join(' · ') || '—'}
                        {!row.isActiveProduct ? ' · archived' : ''}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-text-secondary">{row.category ?? '—'}</td>
                    <td className="px-4 py-3 text-text-secondary">{row.locationName}</td>
                    <td className="px-4 py-3 text-right font-semibold tabular-nums text-text-primary">
                      {formatRowQuantity(row)}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {row.stockId ? (
                        <input
                          defaultValue={row.thresholdBase ? String(row.thresholdBase) : ''}
                          onBlur={(event) => void handleThresholdUpdate(row, event.target.value)}
                          disabled={busyRow === row.key}
                          aria-label={`Safety threshold for ${row.productName} at ${row.locationName}`}
                          className="h-8 w-24 rounded-input border border-border-strong bg-surface px-2 text-right text-[12px] outline-none focus:border-primary disabled:opacity-50"
                        />
                      ) : (
                        <span className="text-text-muted">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge label={STATUS_LABELS[row.status]} tone={STATUS_TONES[row.status]} />
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-1">
                        <button
                          type="button"
                          onClick={() => openProduct(row.productId)}
                          className="rounded-pill border border-border-strong px-3 py-1 text-[12px] font-semibold text-text-primary transition hover:bg-surface-alt"
                        >
                          Edit
                        </button>
                        <RowMenu
                          label={`More actions for ${row.productName}`}
                          items={[
                            // The row's own location travels with the action —
                            // adjusting a Kensington row must not touch Pinner.
                            ...(row.isActiveProduct
                              ? [
                                  {
                                    label: 'Adjust stock',
                                    onSelect: () =>
                                      setOperation({ kind: 'adjust', productId: row.productId, locationId: row.locationId }),
                                  },
                                  {
                                    label: 'Restock',
                                    onSelect: () =>
                                      setOperation({ kind: 'restock', productId: row.productId, locationId: row.locationId }),
                                  },
                                ]
                              : []),
                            { label: 'Movement history', onSelect: () => showProductHistory(row) },
                            ...(isOwner && row.isActiveProduct
                              ? [{ label: 'Archive product', onSelect: () => void handleArchive(row), danger: true }]
                              : []),
                          ]}
                        />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ---------------------------------------------------------------- */}
      {/* 3. Stock insights — dead stock                                     */}
      {/* ---------------------------------------------------------------- */}
      <section aria-label="Stock insights" className="mb-8 rounded-card-lg border border-border bg-surface shadow-card">
        <header className="flex flex-col gap-1 border-b border-border px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h3 className="text-[15px] font-semibold text-text-primary">Stock insights</h3>
            <p className="mt-0.5 text-[13px] text-text-secondary">
              Stock on the shelf with no usage inside its threshold — money sitting still.
            </p>
          </div>
          {deadStock.length > 0 && deadStockValueCents > 0 ? (
            <div className="text-[13px] text-text-secondary">
              Tied up: <span className="font-semibold text-text-primary">{formatCurrencyFromCents(deadStockValueCents)}</span>
            </div>
          ) : null}
        </header>
        {insightsState === 'failed' ? (
          <RetryState title="Unable to load stock insights." onRetry={() => void loadInsights()} />
        ) : insightsState === 'loading' && deadStock.length === 0 ? (
          <EmptyState title="Checking for dead stock…" body="Comparing shelf levels with recent usage." />
        ) : deadStock.length === 0 ? (
          <EmptyState title="No dead stock" body="Everything on the shelf has moved inside its threshold." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[780px] text-left text-[13px]">
              <thead className="border-b border-border bg-surface-alt text-[11px] uppercase tracking-[0.08em] text-text-secondary">
                <tr>
                  <th scope="col" className="px-5 py-2.5 font-medium">Product</th>
                  <th scope="col" className="px-4 py-2.5 font-medium">Location</th>
                  <th scope="col" className="px-4 py-2.5 text-right font-medium">On hand</th>
                  <th scope="col" className="px-4 py-2.5 text-right font-medium">Idle</th>
                  <th scope="col" className="px-4 py-2.5 font-medium">Last used</th>
                  <th scope="col" className="px-4 py-2.5 text-right font-medium">Est. value</th>
                  <th scope="col" className="px-4 py-2.5 text-right font-medium">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {deadStock.map((item) => (
                  <tr key={`${item.locationId}-${item.productId}`} className="transition hover:bg-surface-alt">
                    <td className="px-5 py-3">
                      <div className="font-medium text-text-primary">{item.productName}</div>
                      <div className="text-[12px] text-text-muted">
                        {[item.brand, item.sku, item.supplierName].filter(Boolean).join(' · ') || '—'}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-text-secondary">{item.locationName}</td>
                    <td className="px-4 py-3 text-right font-semibold tabular-nums text-text-primary">
                      {formatRowQuantity({ quantityOnHand: item.quantityOnHandGrams, stockUnit: item.stockUnit })}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="font-semibold text-danger">{item.daysIdle}d</div>
                      <div className="text-[11px] text-text-muted">
                        limit {item.thresholdDays}d ({item.thresholdSource === 'product' ? 'product' : 'location'})
                      </div>
                    </td>
                    <td className="px-4 py-3 text-text-secondary">
                      {item.lastOutboundAt
                        ? new Date(item.lastOutboundAt).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
                        : 'Never used'}
                    </td>
                    <td className="px-4 py-3 text-right text-text-secondary">
                      {item.estimatedValueCents === undefined ? '—' : formatCurrencyFromCents(item.estimatedValueCents)}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <button
                        type="button"
                        onClick={() => openProduct(item.productId)}
                        className="rounded-pill border border-border-strong px-3 py-1 text-[12px] font-semibold text-text-primary transition hover:bg-surface-alt"
                      >
                        View product
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ---------------------------------------------------------------- */}
      {/* 4. Recent stock activity                                           */}
      {/* ---------------------------------------------------------------- */}
      <section ref={activityRef} aria-label="Recent stock activity" className="rounded-card-lg border border-border bg-surface shadow-card">
        <header className="flex flex-col gap-3 border-b border-border px-5 py-4 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <h3 className="text-[15px] font-semibold text-text-primary">Recent stock activity</h3>
            <p className="mt-0.5 text-[13px] text-text-secondary">
              {activityProduct ? `${activityProduct.name} · ` : ''}
              every movement in the selected period, newest first.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {activityProduct ? (
              <button
                type="button"
                onClick={() => setActivityProduct(null)}
                className="h-9 rounded-pill border border-primary bg-primary-soft px-3 text-[12px] font-medium text-primary-deep"
              >
                {activityProduct.name} ✕
              </button>
            ) : null}
            {/* The date range belongs to this section only — it filters
                movements, never the product inventory above (§27). */}
            <RangeTabs
              value={range}
              onChange={setRange}
              allowCustom
              customRange={customRange}
              onCustomRangeChange={setCustomRange}
            />
          </div>
        </header>

        {activityState === 'failed' ? (
          <RetryState title="Unable to load stock activity." onRetry={() => void loadActivity()} />
        ) : activityState === 'loading' && movements.length === 0 ? (
          <EmptyState title="Loading activity…" body="Reading the movement ledger." />
        ) : movements.length === 0 ? (
          <EmptyState title="No stock movements in this period" body="Try a wider date range, or record a scan, adjustment or restock." />
        ) : (
          <ul className="max-h-[420px] divide-y divide-border overflow-y-auto">
            {movements.map((movement) => {
              const view = presentMovement(movement, {
                stockUnit: productById.get(movement.productId)?.stockUnit ?? 'gram',
              });
              return (
                <li key={movement.id}>
                  <button
                    type="button"
                    onClick={() => setOpenMovement(movement)}
                    className="flex w-full items-start gap-3 px-5 py-3 text-left transition hover:bg-surface-alt"
                  >
                    <span
                      aria-hidden
                      className={`mt-1 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[12px] font-semibold ${
                        view.direction === 'in'
                          ? 'bg-success-soft text-success'
                          : view.direction === 'out'
                            ? 'bg-danger-soft text-danger'
                            : 'bg-surface-alt text-text-secondary'
                      }`}
                    >
                      {view.direction === 'in' ? '↑' : view.direction === 'out' ? '↓' : '•'}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-baseline gap-x-2">
                        <span
                          className={`text-[13px] font-semibold tabular-nums ${
                            view.direction === 'in' ? 'text-success' : view.direction === 'out' ? 'text-danger' : 'text-text-secondary'
                          }`}
                        >
                          {view.quantityLabel}
                        </span>
                        <span className="truncate text-[13px] font-medium text-text-primary">{view.productLabel}</span>
                        {view.brand ? <span className="text-[12px] text-text-muted">{view.brand}</span> : null}
                      </span>
                      <span className="mt-0.5 block truncate text-[12px] text-text-secondary">{view.contextLabel}</span>
                    </span>
                    <StatusBadge label={view.source} tone="neutral" className="mt-0.5 shrink-0" />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* ---------------------------------------------------------------- */}
      {/* Drawers and modals                                                 */}
      {/* ---------------------------------------------------------------- */}
      <ProductDrawer
        open={drawerOpen}
        product={drawerProduct}
        categories={categories}
        suppliers={suppliers}
        locations={locations}
        accessToken={accessToken}
        canManage={canManage}
        pricingLocationId={isAllLocations ? undefined : scopeLocationId}
        onClose={() => {
          setDrawerOpen(false);
          // Availability toggles inside the drawer change shelf records.
          void loadStock();
        }}
        onSaved={(product, mode) => {
          setDrawerOpen(false);
          setNotice(`${product.name} ${mode === 'created' ? 'created' : 'saved'}.`);
          void loadCatalogue();
          void loadStock();
        }}
      />

      <ScanConsumeModal
        open={scanOpen}
        accessToken={accessToken}
        locationId={operationLocationId ?? ''}
        locationName={locations.find((location) => location.id === operationLocationId)?.name ?? ''}
        locations={locations}
        products={products}
        stock={stock}
        onClose={() => setScanOpen(false)}
        onConsumed={refreshAfterStockChange}
      />

      <StockOperationModal
        open={operation !== null}
        operation={operation?.kind ?? 'adjust'}
        accessToken={accessToken}
        locations={locations}
        products={products}
        stock={stock}
        defaultLocationId={operation?.locationId ?? operationLocationId}
        defaultProductId={operation?.productId}
        onClose={() => setOperation(null)}
        onRecorded={(message) => {
          setNotice(message);
          refreshAfterStockChange();
        }}
      />

      <MovementDetailModal
        movement={openMovement}
        stockUnit={openMovement ? (productById.get(openMovement.productId)?.stockUnit ?? 'gram') : 'gram'}
        onClose={() => setOpenMovement(null)}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

type LoadState = 'loading' | 'ready' | 'failed';

const FILTER_SELECT =
  'h-9 rounded-input-lg border border-border-strong bg-surface px-3 text-[13px] text-text-primary outline-none focus:border-primary';

function KpiCard({
  label,
  value,
  hint,
  icon,
  badge,
  onClick,
}: {
  label: string;
  value: string;
  hint?: string;
  icon: ReactNode;
  badge?: { label: string; tone: 'warning' | 'danger' };
  onClick?: () => void;
}) {
  const content = (
    <>
      <div className="flex items-start justify-between">
        <span className="text-[12px] font-medium text-text-secondary">{label}</span>
        <span className="flex h-8 w-8 items-center justify-center rounded-input bg-surface-alt">{icon}</span>
      </div>
      <div className="mt-2 text-[26px] font-semibold leading-none tabular-nums text-text-primary">{value}</div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {badge ? <StatusBadge label={badge.label} tone={badge.tone} /> : null}
        {hint ? <span className="text-[11px] text-text-muted">{hint}</span> : null}
      </div>
    </>
  );
  const className = 'rounded-card-lg border border-border bg-surface p-4 text-left shadow-card';
  if (!onClick) return <div className={className}>{content}</div>;
  return (
    <button type="button" onClick={onClick} className={`${className} transition hover:border-border-strong hover:bg-surface-alt`}>
      {content}
    </button>
  );
}

/**
 * Row overflow menu: keeps the table to one visible action plus the rest.
 *
 * The menu is rendered in a portal because the table scrolls horizontally, and
 * a scroll container clips BOTH axes — an absolutely positioned menu would be
 * cut off at the table edge (invisible for the last rows).
 */
function RowMenu({
  label,
  items,
}: {
  label: string;
  items: { label: string; onSelect: () => void; danger?: boolean }[];
}) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ top: number; right: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    // Flip above the trigger when there is not enough room below.
    const estimatedHeight = items.length * 36 + 8;
    const openUpwards = rect.bottom + estimatedHeight > window.innerHeight;
    setPosition({
      top: openUpwards ? rect.top - estimatedHeight : rect.bottom + 4,
      right: Math.max(8, window.innerWidth - rect.right),
    });
  }, [open, items.length]);

  useEffect(() => {
    if (!open) return;
    function onDocumentClick(event: MouseEvent) {
      const target = event.target as Node;
      if (!menuRef.current?.contains(target) && !triggerRef.current?.contains(target)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
    }
    // A menu pinned to the viewport must not drift when the page scrolls.
    function onScrollOrResize() {
      setOpen(false);
    }
    document.addEventListener('mousedown', onDocumentClick);
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('scroll', onScrollOrResize, true);
    window.addEventListener('resize', onScrollOrResize);
    return () => {
      document.removeEventListener('mousedown', onDocumentClick);
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('scroll', onScrollOrResize, true);
      window.removeEventListener('resize', onScrollOrResize);
    };
  }, [open]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        className="rounded-input px-2 py-1 text-[15px] leading-none text-text-secondary transition hover:bg-surface-alt hover:text-text-primary"
      >
        ⋯
      </button>
      {open && position
        ? createPortal(
            <div
              ref={menuRef}
              role="menu"
              style={{ position: 'fixed', top: position.top, right: position.right }}
              className="z-50 w-48 overflow-hidden rounded-input-lg border border-border bg-surface py-1 shadow-modal"
            >
              {items.map((item) => (
                <button
                  key={item.label}
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setOpen(false);
                    item.onSelect();
                  }}
                  className={`block w-full px-3 py-2 text-left text-[13px] transition hover:bg-surface-alt ${
                    item.danger ? 'text-danger' : 'text-text-primary'
                  }`}
                >
                  {item.label}
                </button>
              ))}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

/** Movement audit detail — the only place internal ids appear (§20). */
function MovementDetailModal({
  movement,
  stockUnit,
  onClose,
}: {
  movement: InventoryStockMovement | null;
  stockUnit: InventoryProduct['stockUnit'];
  onClose: () => void;
}) {
  if (!movement) return null;
  const view = presentMovement(movement, { stockUnit });
  const rows: { label: string; value: string }[] = [
    { label: 'Movement', value: view.source },
    { label: 'Product', value: [movement.productName, movement.brand].filter(Boolean).join(' · ') },
    { label: 'Amount', value: formatMovementQuantity(movement.quantityDeltaGrams, stockUnit) },
    { label: 'Location', value: movement.locationName },
    { label: 'Recorded by', value: view.actor },
    { label: 'When', value: formatAbsoluteTime(movement.createdAt) },
  ];
  if (movement.reason) rows.push({ label: 'Reason', value: movement.reason });
  if (movement.notes) rows.push({ label: 'Notes', value: movement.notes });

  return (
    <Modal
      open
      onClose={onClose}
      title="Movement detail"
      description="The full audit record for this stock movement."
      footer={
        <AppButton size="sm" variant="ghost" onClick={onClose}>
          Close
        </AppButton>
      }
    >
      <dl className="divide-y divide-border">
        {rows.map((row) => (
          <div key={row.label} className="flex justify-between gap-4 py-2 text-[13px]">
            <dt className="text-text-secondary">{row.label}</dt>
            <dd className="text-right font-medium text-text-primary">{row.value}</dd>
          </div>
        ))}
      </dl>
      <details className="mt-4">
        <summary className="cursor-pointer text-[12px] font-medium text-text-secondary">Audit identifiers</summary>
        <dl className="mt-2 divide-y divide-border">
          {movementAuditFields(movement).map((field) => (
            <div key={field.label} className="flex justify-between gap-4 py-1.5 text-[12px]">
              <dt className="text-text-muted">{field.label}</dt>
              <dd className="break-all text-right font-mono text-[11px] text-text-secondary">{field.value}</dd>
            </div>
          ))}
        </dl>
      </details>
    </Modal>
  );
}

function EmptyState({ title, body, action }: { title: string; body: string; action?: ReactNode }) {
  return (
    <div className="px-5 py-12 text-center">
      <div className="text-[14px] font-medium text-text-primary">{title}</div>
      <p className="mx-auto mt-1 max-w-sm text-[13px] text-text-secondary">{body}</p>
      {action ? <div className="mt-3 flex justify-center">{action}</div> : null}
    </div>
  );
}

function RetryState({ title, onRetry }: { title: string; onRetry: () => void }) {
  return (
    <div className="px-5 py-10 text-center" role="alert">
      <div className="text-[14px] font-medium text-text-primary">{title}</div>
      <p className="mx-auto mt-1 max-w-sm text-[13px] text-text-secondary">
        The data could not be fetched. Check your connection and try again.
      </p>
      <div className="mt-3 flex justify-center">
        <AppButton size="sm" variant="secondary" onClick={onRetry}>
          Retry
        </AppButton>
      </div>
    </div>
  );
}

/**
 * Resolve the activity range to an explicit window. Null for an incomplete
 * custom range, which leaves the movement query unbounded.
 */
function resolveRangeWindow(range: DashboardRange, custom: CustomRange): { from: string; to: string } | null {
  if (range === 'custom') return resolveCustomWindow(custom);
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  if (range === 'today') return { from: start.toISOString(), to: end.toISOString() };
  if (range === 'week') {
    const monday = new Date(start);
    monday.setDate(monday.getDate() - ((start.getDay() + 6) % 7));
    return { from: monday.toISOString(), to: end.toISOString() };
  }
  const firstOfMonth = new Date(start.getFullYear(), start.getMonth(), 1);
  return { from: firstOfMonth.toISOString(), to: end.toISOString() };
}

// ---------------------------------------------------------------------------
// Inline icons (no icon dependency in the web app)
// ---------------------------------------------------------------------------

type IconProps = { className?: string };

function BoxIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
      <path d="m3.3 7 8.7 5 8.7-5M12 22V12" />
    </svg>
  );
}

function EmptyBoxIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <path d="M8 12h8" />
    </svg>
  );
}

function AlertIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
      <path d="M12 9v4M12 17h.01" />
    </svg>
  );
}

function ClockIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}

function SearchIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="7" />
      <path d="m21 21-4.3-4.3" />
    </svg>
  );
}
