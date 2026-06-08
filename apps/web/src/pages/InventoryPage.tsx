import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import type {
  BusinessLocationSummary,
  InventoryLocationStock,
  InventoryProduct,
  InventoryStockMovement,
} from '@sheer/domain';
import {
  adjustInventoryStock,
  archiveInventoryProduct,
  createInventoryProduct,
  initializeInventoryStock,
  listInventoryLowStock,
  listInventoryMovements,
  listInventoryProducts,
  listInventoryStock,
  updateInventoryProduct,
  updateInventoryStockThreshold,
} from '../auth/api';
import { useAuth } from '../auth/AuthProvider';
import { useLocationScope } from '../components/LocationScopeContext';

type ProductForm = {
  id?: string;
  brand: string;
  name: string;
  category: string;
  sku: string;
  sizeValue: string;
  sizeUnit: string;
  defaultCostPerGramCents: string;
  retailPriceCents: string;
  lowStockThresholdGrams: string;
};

const emptyProductForm: ProductForm = {
  brand: '',
  name: '',
  category: '',
  sku: '',
  sizeValue: '',
  sizeUnit: 'g',
  defaultCostPerGramCents: '',
  retailPriceCents: '',
  lowStockThresholdGrams: '',
};

type StockHealth = 'healthy' | 'low' | 'critical';

export function InventoryPage() {
  const auth = useAuth();
  const accessToken = auth.session?.accessToken;
  const isOwner = auth.user?.role === 'owner';
  // The stock table follows the shared sidebar scope: "All" aggregates every
  // location, a concrete selection narrows to it.
  const { selectedLocationId: scopeLocationId, isAllLocations } = useLocationScope();
  const [products, setProducts] = useState<InventoryProduct[]>([]);
  const [stock, setStock] = useState<InventoryLocationStock[]>([]);
  const [locations, setLocations] = useState<BusinessLocationSummary[]>([]);
  const [movements, setMovements] = useState<InventoryStockMovement[]>([]);
  const [lowStockCount, setLowStockCount] = useState(0);
  // Stock mutations need a concrete target. It tracks the sidebar when a
  // specific location is picked, and falls back to the first location on "All"
  // so the adjustment form stays usable; the user can still override it below.
  const [actionLocationId, setActionLocationId] = useState('');
  const [search, setSearch] = useState('');
  const [lowStockOnly, setLowStockOnly] = useState(false);
  const [productForm, setProductForm] = useState<ProductForm>(emptyProductForm);
  const [showProductForm, setShowProductForm] = useState(false);
  const [stockProductId, setStockProductId] = useState('');
  const [initialQuantity, setInitialQuantity] = useState('');
  const [stockThreshold, setStockThreshold] = useState('');
  const [adjustProductId, setAdjustProductId] = useState('');
  const [adjustDirection, setAdjustDirection] = useState<'inbound' | 'loss'>('inbound');
  const [adjustQuantity, setAdjustQuantity] = useState('');
  const [adjustReason, setAdjustReason] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!accessToken) return;
    setLoading(true);
    setError(null);
    try {
      const listingLocationId = isAllLocations ? undefined : scopeLocationId;
      const [productResult, stockResult, movementResult, lowStockResult] = await Promise.all([
        listInventoryProducts(accessToken),
        listInventoryStock(accessToken, { locationId: listingLocationId, q: search, lowStockOnly }),
        listInventoryMovements(accessToken, { locationId: listingLocationId, limit: 20 }),
        listInventoryLowStock(accessToken, { locationId: listingLocationId }),
      ]);
      setProducts(productResult.products);
      setStock(stockResult.stock);
      setLocations(stockResult.locations);
      setMovements(movementResult.movements);
      setLowStockCount(lowStockResult.alerts.length);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not load inventory');
    } finally {
      setLoading(false);
    }
  }, [accessToken, lowStockOnly, search, scopeLocationId, isAllLocations]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Keep the mutation target sensible: follow the sidebar when it names a
  // specific location, otherwise (on "All") fall back to the first location so
  // the adjustment form stays usable. The user can still override it below.
  useEffect(() => {
    if (!isAllLocations) {
      setActionLocationId(scopeLocationId);
    } else {
      setActionLocationId((current) => current || locations[0]?.id || '');
    }
  }, [isAllLocations, scopeLocationId, locations]);

  const activeProducts = useMemo(() => products.filter((product) => product.isActive), [products]);
  // The location whose stock the table currently reflects (null while aggregating).
  const viewedLocation = isAllLocations
    ? undefined
    : locations.find((location) => location.id === scopeLocationId);
  // The location stock mutations will write to (the adjustment form's target).
  const actionLocation = locations.find((location) => location.id === actionLocationId);

  const outOfStockCount = useMemo(
    () => stock.filter((item) => item.quantityOnHandGrams <= 0).length,
    [stock],
  );
  const restockUnitsMonth = useMemo(
    () =>
      movements
        .filter((movement) => movement.quantityDeltaGrams > 0)
        .reduce((total, movement) => total + movement.quantityDeltaGrams, 0),
    [movements],
  );

  if (auth.status === 'authenticated' && auth.user?.role === 'stylist') {
    return <Navigate to="/unauthorized" replace />;
  }

  async function handleSaveProduct() {
    if (!accessToken || !isOwner) return;
    if (!productForm.name.trim()) {
      setError('Product name is required.');
      return;
    }
    setBusy('product');
    setError(null);
    setActionMessage(null);
    try {
      const payload = {
        brand: nullable(productForm.brand),
        name: productForm.name.trim(),
        category: nullable(productForm.category),
        sku: nullable(productForm.sku),
        sizeValue: optionalNumber(productForm.sizeValue),
        sizeUnit: nullable(productForm.sizeUnit) ?? 'g',
        defaultCostPerGramCents: optionalInteger(productForm.defaultCostPerGramCents),
        retailPriceCents: optionalInteger(productForm.retailPriceCents),
        lowStockThresholdGrams: optionalNumber(productForm.lowStockThresholdGrams) ?? 0,
      };
      const result = productForm.id
        ? await updateInventoryProduct(accessToken, productForm.id, payload)
        : await createInventoryProduct(accessToken, payload);
      setProducts((current) => upsertProduct(current, result.product));
      setProductForm(emptyProductForm);
      setShowProductForm(false);
      setActionMessage(`${result.product.name} saved.`);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not save product');
    } finally {
      setBusy(null);
    }
  }

  async function handleArchiveProduct(product: InventoryProduct) {
    if (!accessToken || !isOwner) return;
    setBusy(product.id);
    setError(null);
    setActionMessage(null);
    try {
      const result = await archiveInventoryProduct(accessToken, product.id);
      setProducts((current) => upsertProduct(current, result.product));
      setActionMessage(`${product.name} archived. Movement history remains intact.`);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not archive product');
    } finally {
      setBusy(null);
    }
  }

  async function handleInitializeStock() {
    if (!accessToken || !actionLocationId || !stockProductId) return;
    setBusy('initialize');
    setError(null);
    setActionMessage(null);
    try {
      const result = await initializeInventoryStock(accessToken, {
        locationId: actionLocationId,
        productId: stockProductId,
        quantityOnHandGrams: optionalNumber(initialQuantity) ?? 0,
        lowStockThresholdGrams: optionalNumber(stockThreshold),
      });
      setStock((current) => upsertStock(current, result.stock));
      setInitialQuantity('');
      setStockThreshold('');
      setActionMessage(`Stock initialized for ${result.stock.productName} at ${result.stock.locationName}.`);
      void reload();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not initialize stock');
    } finally {
      setBusy(null);
    }
  }

  async function handleAdjustStock() {
    if (!accessToken || !actionLocationId || !adjustProductId) return;
    const magnitude = optionalNumber(adjustQuantity);
    if (!magnitude || magnitude <= 0) {
      setError('Adjustment quantity must be greater than zero.');
      return;
    }
    const delta = adjustDirection === 'inbound' ? magnitude : -magnitude;
    setBusy('adjust');
    setError(null);
    setActionMessage(null);
    try {
      const result = await adjustInventoryStock(accessToken, {
        locationId: actionLocationId,
        productId: adjustProductId,
        quantityDeltaGrams: delta,
        movementType: delta > 0 ? 'restock' : 'manual_adjustment',
        reason: delta > 0 ? 'restock' : 'manual_adjustment',
        notes: nullable(adjustReason),
      });
      setStock((current) => upsertStock(current, result.stock));
      setAdjustQuantity('');
      setAdjustReason('');
      setActionMessage(`Stock adjusted for ${result.stock.productName}.`);
      void reload();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not adjust stock');
    } finally {
      setBusy(null);
    }
  }

  async function handleThresholdUpdate(item: InventoryLocationStock, value: string) {
    if (!accessToken) return;
    setBusy(item.id);
    setError(null);
    try {
      const result = await updateInventoryStockThreshold(accessToken, item.id, {
        lowStockThresholdGrams: optionalNumber(value),
      });
      setStock((current) => upsertStock(current, result.stock));
      void reload();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not update threshold');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-6 lg:px-8">
      <header className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-[22px] font-semibold leading-7 text-text-primary">Inventory</h1>
          <p className="mt-1 text-[13px] text-text-secondary">
            Manage catalogue products, location stock, low-stock thresholds, and auditable movements.
          </p>
        </div>
        <button
          type="button"
          className="inline-flex h-10 items-center gap-2 rounded-pill border border-border-strong bg-surface px-5 text-[13px] font-semibold text-text-primary transition hover:bg-surface-alt disabled:opacity-50"
          onClick={() => void reload()}
          disabled={loading}
        >
          <RefreshIcon className={loading ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
          Refresh
        </button>
      </header>

      {actionMessage ? (
        <div className="mb-4 rounded-input-lg border border-success-border bg-success-soft px-4 py-3 text-[13px] text-success">
          {actionMessage}
        </div>
      ) : null}
      {error ? (
        <div className="mb-4 rounded-input-lg border border-danger-border bg-danger-soft px-4 py-3 text-[13px] text-danger">
          {error}
        </div>
      ) : null}

      {/* KPI strip */}
      <section className="mb-8 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard
          label="Total SKUs"
          value={String(activeProducts.length)}
          icon={<BoxIcon className="h-4 w-4 text-primary" />}
          hint={`${stock.length} stocked across locations`}
        />
        <KpiCard
          label="Active alerts"
          value={String(lowStockCount)}
          icon={<AlertIcon className="h-4 w-4 text-warning" />}
          badge={lowStockCount > 0 ? { label: 'Action needed', tone: 'warning' } : undefined}
          hint="at or below safety threshold"
        />
        <KpiCard
          label="Out of stock"
          value={String(outOfStockCount).padStart(2, '0')}
          icon={<EmptyBoxIcon className="h-4 w-4 text-danger" />}
          badge={outOfStockCount > 0 ? { label: 'Critical', tone: 'danger' } : undefined}
          hint="records at zero on hand"
        />
        <KpiCard
          label="Restocked (recent)"
          value={formatGrams(restockUnitsMonth)}
          icon={<TrendIcon className="h-4 w-4 text-success" />}
          hint="inbound across last movements"
        />
      </section>

      {/* Current stock status + Product inventory */}
      <section className="mb-8">
        <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <h2 className="text-[15px] font-semibold text-text-primary">Current stock status</h2>
          <div className="flex items-center gap-4 text-[12px] text-text-secondary">
            <LegendDot className="bg-success-fill" label="Healthy" />
            <LegendDot className="bg-warning-fill" label="Low stock" />
            <LegendDot className="bg-danger-fill" label="Critical" />
          </div>
        </div>

        <div className="rounded-card-lg border border-border bg-surface shadow-card">
          {/* Toolbar */}
          <div className="flex flex-col gap-4 border-b border-border px-5 py-4 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <div className="text-[15px] font-semibold text-text-primary">Product inventory</div>
              <div className="mt-0.5 text-[13px] text-text-secondary">
                Real-time stock levels across {viewedLocation ? viewedLocation.name : 'all active locations'}.
              </div>
            </div>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <div className="relative">
                <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted" />
                <input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search SKU or name…"
                  className="h-10 w-full rounded-input-lg border border-border-strong bg-surface pl-9 pr-3 text-[13px] outline-none focus:border-primary sm:w-60"
                />
              </div>
              <label
                className={`inline-flex h-10 cursor-pointer items-center gap-2 rounded-input-lg border px-3 text-[13px] font-medium transition ${
                  lowStockOnly
                    ? 'border-primary bg-primary-soft text-primary-deep'
                    : 'border-border-strong bg-surface text-text-secondary hover:bg-surface-alt'
                }`}
              >
                <input
                  type="checkbox"
                  className="sr-only"
                  checked={lowStockOnly}
                  onChange={(event) => setLowStockOnly(event.target.checked)}
                />
                <FilterIcon className="h-4 w-4" />
                Low stock
              </label>
              {isOwner ? (
                <button
                  type="button"
                  className="inline-flex h-10 items-center gap-1.5 rounded-input-lg bg-primary px-4 text-[13px] font-semibold text-text-on-primary transition hover:bg-primary-deep"
                  onClick={() => {
                    setProductForm(emptyProductForm);
                    setShowProductForm((open) => !open);
                  }}
                >
                  <PlusIcon className="h-4 w-4" />
                  New product
                </button>
              ) : null}
            </div>
          </div>

          {/* Inline product form (owner only) */}
          {isOwner && showProductForm ? (
            <div className="grid gap-2 border-b border-border bg-surface-alt px-5 py-4 md:grid-cols-3">
              <input value={productForm.brand} onChange={(e) => setProductForm({ ...productForm, brand: e.target.value })} placeholder="Brand" className={inputClass} />
              <input value={productForm.name} onChange={(e) => setProductForm({ ...productForm, name: e.target.value })} placeholder="Product name" className={inputClass} />
              <input value={productForm.category} onChange={(e) => setProductForm({ ...productForm, category: e.target.value })} placeholder="Category" className={inputClass} />
              <input value={productForm.sku} onChange={(e) => setProductForm({ ...productForm, sku: e.target.value })} placeholder="SKU / code" className={inputClass} />
              <NumberInput value={productForm.sizeValue} onChange={(value) => setProductForm({ ...productForm, sizeValue: value })} placeholder="Size" />
              <input value={productForm.sizeUnit} onChange={(e) => setProductForm({ ...productForm, sizeUnit: e.target.value })} placeholder="Unit" className={inputClass} />
              <NumberInput value={productForm.defaultCostPerGramCents} onChange={(value) => setProductForm({ ...productForm, defaultCostPerGramCents: value })} placeholder="Cost/gram cents" />
              <NumberInput value={productForm.retailPriceCents} onChange={(value) => setProductForm({ ...productForm, retailPriceCents: value })} placeholder="Retail price cents" />
              <NumberInput value={productForm.lowStockThresholdGrams} onChange={(value) => setProductForm({ ...productForm, lowStockThresholdGrams: value })} placeholder="Default threshold g" />
              <div className="flex gap-2 md:col-span-3">
                <button type="button" className="h-9 rounded-pill bg-primary px-4 text-[12px] font-semibold text-text-on-primary disabled:opacity-50" onClick={() => void handleSaveProduct()} disabled={busy === 'product'}>
                  {productForm.id ? 'Update product' : 'Create product'}
                </button>
                <button type="button" className="h-9 rounded-pill border border-border-strong px-4 text-[12px] font-semibold text-text-secondary" onClick={() => { setProductForm(emptyProductForm); setShowProductForm(false); }}>
                  Cancel
                </button>
              </div>
            </div>
          ) : null}

          {/* Inventory table */}
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-left text-[13px]">
              <thead className="border-b border-border bg-surface-alt text-[11px] uppercase tracking-[0.08em] text-text-secondary">
                <tr>
                  <th className="px-5 py-3 font-medium">Product</th>
                  <th className="px-5 py-3 font-medium">Category</th>
                  <th className="px-5 py-3 font-medium">Location</th>
                  <th className="px-5 py-3 text-right font-medium">Stock level</th>
                  <th className="px-5 py-3 text-right font-medium">Safety threshold</th>
                  <th className="px-5 py-3 font-medium">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {stock.map((item) => {
                  const health = stockHealth(item);
                  return (
                    <tr key={item.id} className="transition hover:bg-surface-alt">
                      <td className="px-5 py-3.5">
                        <div className="flex items-center gap-3">
                          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-input border border-border bg-surface-alt text-text-secondary">
                            <BoxIcon className="h-4 w-4" />
                          </span>
                          <div>
                            <div className="font-medium text-text-primary">{item.productName}</div>
                            <div className="text-[12px] text-text-muted">{item.sku ?? '—'}</div>
                          </div>
                        </div>
                      </td>
                      <td className="px-5 py-3.5">
                        {item.category ? (
                          <span className="inline-flex items-center rounded-input border border-border bg-surface-alt px-2.5 py-1 text-[12px] text-text-secondary">
                            {item.category}
                          </span>
                        ) : (
                          <span className="text-text-muted">—</span>
                        )}
                      </td>
                      <td className="px-5 py-3.5">
                        <span className="inline-flex items-center gap-1.5 text-text-secondary">
                          <PinIcon className="h-3.5 w-3.5 text-text-muted" />
                          {item.locationName}
                        </span>
                      </td>
                      <td className="px-5 py-3.5 text-right">
                        <div className="font-semibold text-text-primary">{formatGrams(item.quantityOnHandGrams)}</div>
                        <div className={`text-[11px] ${health === 'healthy' ? 'text-success' : health === 'low' ? 'text-warning' : 'text-danger'}`}>
                          {health === 'healthy' ? 'In range' : health === 'low' ? 'Below threshold' : 'Out of stock'}
                        </div>
                      </td>
                      <td className="px-5 py-3.5 text-right">
                        <input
                          defaultValue={String(item.lowStockThresholdGrams ?? item.effectiveLowStockThresholdGrams ?? '')}
                          onBlur={(event) => void handleThresholdUpdate(item, event.target.value)}
                          className="h-8 w-24 rounded-input border border-border-strong bg-surface px-2 text-right text-[12px] outline-none focus:border-primary disabled:opacity-50"
                          disabled={busy === item.id}
                        />
                      </td>
                      <td className="px-5 py-3.5">
                        <HealthBadge health={health} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {!loading && stock.length === 0 ? <EmptyState label="No stock records yet" /> : null}
            {loading && stock.length === 0 ? <EmptyState label="Loading inventory…" /> : null}
          </div>
        </div>
      </section>

      {/* Operations & audit log */}
      <section>
        <h2 className="mb-3 text-[15px] font-semibold text-text-primary">Operations &amp; audit log</h2>
        <div className="grid gap-6 xl:grid-cols-[0.95fr_1.05fr]">
          {/* Record stock adjustment */}
          <div className="rounded-card-lg border border-border bg-surface p-5 shadow-card">
            <div className="text-[15px] font-semibold text-text-primary">Record stock adjustment</div>
            <p className="mt-0.5 text-[13px] text-text-secondary">
              Manually update inventory counts with reason notes. Every adjustment is written to the audit log.
            </p>

            <div className="mt-5 space-y-4">
              <Field label="Location">
                <select
                  value={actionLocationId}
                  onChange={(event) => setActionLocationId(event.target.value)}
                  className={inputClassTall}
                >
                  {locations.length === 0 ? <option value="">No locations</option> : null}
                  {locations.map((location) => (
                    <option key={location.id} value={location.id}>
                      {location.name}
                    </option>
                  ))}
                </select>
              </Field>

              <Field label="Product">
                <ProductSelect products={activeProducts} value={adjustProductId} onChange={setAdjustProductId} tall />
              </Field>

              <Field label="Adjustment type">
                <div className="grid grid-cols-2 gap-2">
                  <ToggleButton active={adjustDirection === 'inbound'} tone="success" onClick={() => setAdjustDirection('inbound')}>
                    Inbound (+)
                  </ToggleButton>
                  <ToggleButton active={adjustDirection === 'loss'} tone="danger" onClick={() => setAdjustDirection('loss')}>
                    Loss (−)
                  </ToggleButton>
                </div>
              </Field>

              <div className="grid grid-cols-2 gap-4">
                <Field label="Quantity (g)">
                  <NumberInput value={adjustQuantity} onChange={setAdjustQuantity} placeholder="0" tall positiveOnly />
                </Field>
                <div className="flex items-end">
                  <button
                    type="button"
                    className="h-11 w-full rounded-input-lg bg-primary px-4 text-[14px] font-semibold text-text-on-primary transition hover:bg-primary-deep disabled:opacity-50"
                    onClick={() => void handleAdjustStock()}
                    disabled={busy === 'adjust' || !adjustProductId || !adjustQuantity}
                  >
                    Finalize adjustment
                  </button>
                </div>
              </div>

              <Field label="Adjustment reason">
                <input
                  value={adjustReason}
                  onChange={(event) => setAdjustReason(event.target.value)}
                  placeholder="Cycle count correction, damage, etc."
                  className={inputClassTall}
                />
              </Field>
            </div>

            {/* Initialize stock — collapsible secondary action */}
            <details className="mt-5 rounded-input-lg border border-border bg-surface-alt">
              <summary className="cursor-pointer list-none px-3 py-2.5 text-[13px] font-medium text-text-secondary">
                + Initialize a product at {actionLocation?.name ?? 'this location'}
              </summary>
              <div className="space-y-2 border-t border-border px-3 py-3">
                <ProductSelect products={activeProducts} value={stockProductId} onChange={setStockProductId} />
                <div className="grid grid-cols-2 gap-2">
                  <NumberInput value={initialQuantity} onChange={setInitialQuantity} placeholder="Opening g" />
                  <NumberInput value={stockThreshold} onChange={setStockThreshold} placeholder="Threshold g" />
                </div>
                <button
                  type="button"
                  className="h-9 rounded-pill bg-surface-ink px-4 text-[12px] font-semibold text-text-on-primary disabled:opacity-50"
                  onClick={() => void handleInitializeStock()}
                  disabled={busy === 'initialize' || !stockProductId || !actionLocationId}
                >
                  Initialize stock
                </button>
              </div>
            </details>
          </div>

          {/* Recent stock movement (scrollable) */}
          <div className="flex flex-col rounded-card-lg border border-border bg-surface shadow-card">
            <div className="flex items-center justify-between border-b border-border px-5 py-4">
              <div>
                <div className="text-[15px] font-semibold text-text-primary">Recent stock movement</div>
                <div className="mt-0.5 text-[13px] text-text-secondary">Continuous log of all inventory transactions.</div>
              </div>
              <button
                type="button"
                className="text-[13px] font-semibold text-primary-deep transition hover:underline"
                onClick={() => void reload()}
              >
                View full log
              </button>
            </div>
            <div className="max-h-[360px] divide-y divide-border overflow-y-auto">
              {movements.map((movement) => (
                <div key={movement.id} className="flex items-start gap-3 px-5 py-3.5">
                  <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${movementDotClass(movement)}`} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline justify-between gap-3">
                      <div className="truncate text-[13px] text-text-primary">
                        <span className="font-medium">{movementActor(movement)}</span>{' '}
                        {movementVerb(movement)}{' '}
                        <span className={movement.quantityDeltaGrams < 0 ? 'font-semibold text-danger' : 'font-semibold text-success'}>
                          {movement.quantityDeltaGrams > 0 ? '+' : ''}
                          {formatGrams(movement.quantityDeltaGrams)}
                        </span>
                      </div>
                      <span className={`shrink-0 rounded-pill px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${movementTagClass(movement)}`}>
                        {movementTag(movement)}
                      </span>
                    </div>
                    <div className="mt-0.5 truncate text-[12px] text-text-muted">
                      {movement.productName} · {movement.locationName} · {formatRelative(movement.createdAt)}
                    </div>
                    {movement.notes || movement.reason ? (
                      <div className="mt-0.5 truncate text-[12px] text-text-secondary">{movement.notes ?? movement.reason}</div>
                    ) : null}
                  </div>
                </div>
              ))}
              {movements.length === 0 ? <EmptyState label="No stock movements yet" /> : null}
            </div>
          </div>
        </div>
      </section>

      {/* Product catalogue management (owner archive controls) */}
      {isOwner ? (
        <section className="mt-8 rounded-card-lg border border-border bg-surface shadow-card">
          <header className="flex items-center justify-between border-b border-border px-5 py-4">
            <div className="text-[15px] font-semibold text-text-primary">Product catalogue</div>
            <span className="text-[12px] text-text-secondary">{products.length} products</span>
          </header>
          <div className="divide-y divide-border">
            {products.map((product) => (
              <div key={product.id} className="flex flex-col gap-3 px-5 py-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-text-primary">{product.name}</span>
                    {!product.isActive ? <StatusPill label="Archived" tone="neutral" /> : null}
                  </div>
                  <div className="text-[12px] text-text-secondary">
                    {[product.brand, product.category, product.sku, product.sizeValue ? `${product.sizeValue}${product.sizeUnit}` : undefined].filter(Boolean).join(' · ') || '—'}
                  </div>
                </div>
                <div className="flex items-center gap-2 text-[12px] text-text-secondary">
                  <span>{formatMoney(product.defaultCostPerGramCents)} / g</span>
                  {product.isActive ? (
                    <>
                      <button type="button" className="rounded-pill border border-border-strong px-3 py-1 font-semibold text-text-primary transition hover:bg-surface-alt" onClick={() => { setProductForm(toProductForm(product)); setShowProductForm(true); }}>Edit</button>
                      <button type="button" className="rounded-pill border border-danger-border px-3 py-1 font-semibold text-danger transition hover:bg-danger-soft disabled:opacity-50" onClick={() => void handleArchiveProduct(product)} disabled={busy === product.id}>Archive</button>
                    </>
                  ) : null}
                </div>
              </div>
            ))}
            {products.length === 0 ? <EmptyState label="No products yet" /> : null}
          </div>
        </section>
      ) : null}
    </div>
  );
}

const inputClass =
  'h-9 w-full rounded-input-lg border border-border-strong bg-surface px-3 text-[13px] outline-none focus:border-primary';
const inputClassTall =
  'h-11 w-full rounded-input-lg border border-border-strong bg-surface px-3 text-[13px] outline-none focus:border-primary';

function stockHealth(item: InventoryLocationStock): StockHealth {
  if (item.quantityOnHandGrams <= 0) return 'critical';
  if (item.isLowStock) return 'low';
  return 'healthy';
}

function KpiCard({
  label,
  value,
  icon,
  hint,
  badge,
}: {
  label: string;
  value: string;
  icon: ReactNode;
  hint?: string;
  badge?: { label: string; tone: 'warning' | 'danger' };
}) {
  return (
    <div className="rounded-card-lg border border-border bg-surface p-4 shadow-card">
      <div className="flex items-start justify-between">
        <span className="text-[12px] font-medium text-text-secondary">{label}</span>
        <span className="flex h-8 w-8 items-center justify-center rounded-input bg-surface-alt">{icon}</span>
      </div>
      <div className="mt-2 text-[28px] font-semibold leading-none text-text-primary">{value}</div>
      <div className="mt-2 flex items-center gap-2">
        {badge ? <StatusPill label={badge.label} tone={badge.tone} /> : null}
        {hint ? <span className="text-[11px] text-text-muted">{hint}</span> : null}
      </div>
    </div>
  );
}

function StatusPill({ label, tone }: { label: string; tone: 'success' | 'warning' | 'danger' | 'neutral' }) {
  const cls =
    tone === 'success'
      ? 'border-success-border bg-success-soft text-success'
      : tone === 'warning'
        ? 'border-warning-border bg-warning-soft text-warning'
        : tone === 'danger'
          ? 'border-danger-border bg-danger-soft text-danger'
          : 'border-border bg-surface-alt text-text-secondary';
  return <span className={`inline-flex items-center rounded-pill border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${cls}`}>{label}</span>;
}

function HealthBadge({ health }: { health: StockHealth }) {
  if (health === 'healthy') return <StatusPill label="Healthy" tone="success" />;
  if (health === 'low') return <StatusPill label="Low stock" tone="warning" />;
  return <StatusPill label="Critical" tone="danger" />;
}

function LegendDot({ className, label }: { className: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={`h-2 w-2 rounded-full ${className}`} />
      {label}
    </span>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[12px] font-medium text-text-secondary">{label}</span>
      {children}
    </label>
  );
}

function ToggleButton({
  active,
  tone,
  onClick,
  children,
}: {
  active: boolean;
  tone: 'success' | 'danger';
  onClick: () => void;
  children: ReactNode;
}) {
  const activeCls =
    tone === 'success' ? 'border-success-border bg-success-soft text-success' : 'border-danger-border bg-danger-soft text-danger';
  return (
    <button
      type="button"
      onClick={onClick}
      className={`h-11 rounded-input-lg border text-[13px] font-medium transition ${
        active ? activeCls : 'border-border-strong bg-surface text-text-secondary hover:bg-surface-alt'
      }`}
    >
      {children}
    </button>
  );
}

function ProductSelect({
  products,
  value,
  onChange,
  tall,
}: {
  products: InventoryProduct[];
  value: string;
  onChange: (value: string) => void;
  tall?: boolean;
}) {
  return (
    <select value={value} onChange={(event) => onChange(event.target.value)} className={tall ? inputClassTall : inputClass}>
      <option value="">Choose product</option>
      {products.map((product) => (
        <option key={product.id} value={product.id}>
          {[product.brand, product.name].filter(Boolean).join(' · ')}
        </option>
      ))}
    </select>
  );
}

function NumberInput({
  value,
  onChange,
  placeholder,
  tall,
  positiveOnly,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  tall?: boolean;
  positiveOnly?: boolean;
}) {
  const allow = positiveOnly ? /[^0-9.]/g : /[^0-9.-]/g;
  return (
    <input
      inputMode="decimal"
      value={value}
      onChange={(event) => onChange(event.target.value.replace(allow, ''))}
      placeholder={placeholder}
      className={tall ? inputClassTall : inputClass}
    />
  );
}

function EmptyState({ label }: { label: string }) {
  return <div className="px-4 py-10 text-center text-[13px] text-text-secondary">{label}</div>;
}

// ---------------------------------------------------------------------------
// Movement presentation helpers
// ---------------------------------------------------------------------------

function movementActor(movement: InventoryStockMovement): string {
  if (movement.createdBy) return movement.createdBy;
  switch (movement.movementType) {
    case 'opening_balance':
      return 'System';
    case 'formula_usage':
    case 'formula_waste':
    case 'formula_reversal':
      return 'Formula engine';
    case 'retail_sale':
      return 'Point of sale';
    default:
      return 'System';
  }
}

function movementVerb(movement: InventoryStockMovement): string {
  switch (movement.movementType) {
    case 'opening_balance':
      return 'initialized';
    case 'restock':
      return 'restocked';
    case 'manual_adjustment':
    case 'correction':
      return 'adjusted';
    case 'retail_sale':
      return 'sold';
    case 'formula_usage':
      return 'used';
    case 'formula_waste':
      return 'wasted';
    case 'formula_reversal':
      return 'reversed';
    default:
      return 'moved';
  }
}

function movementTag(movement: InventoryStockMovement): string {
  switch (movement.movementType) {
    case 'opening_balance':
      return 'init';
    case 'restock':
      return 'restock';
    case 'manual_adjustment':
    case 'correction':
      return 'admin';
    case 'retail_sale':
      return 'sale';
    case 'formula_usage':
    case 'formula_waste':
    case 'formula_reversal':
      return 'usage';
    default:
      return 'system';
  }
}

function movementTagClass(movement: InventoryStockMovement): string {
  switch (movement.movementType) {
    case 'restock':
    case 'opening_balance':
      return 'bg-success-soft text-success';
    case 'manual_adjustment':
    case 'correction':
      return 'bg-primary-soft text-primary-deep';
    case 'retail_sale':
    case 'formula_usage':
    case 'formula_waste':
      return 'bg-warning-soft text-warning';
    default:
      return 'bg-surface-alt text-text-secondary';
  }
}

function movementDotClass(movement: InventoryStockMovement): string {
  if (movement.quantityDeltaGrams > 0) return 'bg-success-fill';
  if (movement.quantityDeltaGrams < 0) return 'bg-danger-fill';
  return 'bg-text-muted';
}

// ---------------------------------------------------------------------------
// Data transforms (unchanged behaviour)
// ---------------------------------------------------------------------------

function optionalNumber(value: string): number | undefined {
  if (value.trim() === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function optionalInteger(value: string): number | undefined {
  const parsed = optionalNumber(value);
  return parsed === undefined ? undefined : Math.round(parsed);
}

function nullable(value: string): string | null {
  const next = value.trim();
  return next ? next : null;
}

function upsertProduct(products: InventoryProduct[], product: InventoryProduct): InventoryProduct[] {
  return products.some((item) => item.id === product.id)
    ? products.map((item) => (item.id === product.id ? product : item))
    : [product, ...products];
}

function upsertStock(stock: InventoryLocationStock[], updated: InventoryLocationStock): InventoryLocationStock[] {
  return stock.some((item) => item.id === updated.id)
    ? stock.map((item) => (item.id === updated.id ? updated : item))
    : [updated, ...stock];
}

function toProductForm(product: InventoryProduct): ProductForm {
  return {
    id: product.id,
    brand: product.brand ?? '',
    name: product.name,
    category: product.category ?? '',
    sku: product.sku ?? '',
    sizeValue: product.sizeValue === undefined ? '' : String(product.sizeValue),
    sizeUnit: product.sizeUnit,
    defaultCostPerGramCents: product.defaultCostPerGramCents === undefined ? '' : String(product.defaultCostPerGramCents),
    retailPriceCents: product.retailPriceCents === undefined ? '' : String(product.retailPriceCents),
    lowStockThresholdGrams: String(product.lowStockThresholdGrams),
  };
}

function formatGrams(value: number): string {
  return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value)}g`;
}

function formatMoney(value?: number): string {
  if (value === undefined) return 'No cost';
  return `${value}p`;
}

function formatRelative(value: string): string {
  const then = new Date(value).getTime();
  const now = Date.now();
  const diffMs = now - then;
  const minutes = Math.round(diffMs / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(value).toLocaleDateString([], { day: '2-digit', month: 'short' });
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

function TrendIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="m3 17 6-6 4 4 8-8" />
      <path d="M17 7h4v4" />
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

function FilterIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 3H2l8 9.5V19l4 2v-8.5L22 3z" />
    </svg>
  );
}

function PlusIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

function PinIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0z" />
      <circle cx="12" cy="10" r="3" />
    </svg>
  );
}

function RefreshIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
      <path d="M21 3v5h-5" />
      <path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
      <path d="M3 21v-5h5" />
    </svg>
  );
}
