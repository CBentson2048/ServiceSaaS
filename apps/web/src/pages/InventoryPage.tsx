import { useCallback, useEffect, useMemo, useState } from 'react';
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

export function InventoryPage() {
  const auth = useAuth();
  const accessToken = auth.session?.accessToken;
  const isOwner = auth.user?.role === 'owner';
  const [products, setProducts] = useState<InventoryProduct[]>([]);
  const [stock, setStock] = useState<InventoryLocationStock[]>([]);
  const [locations, setLocations] = useState<BusinessLocationSummary[]>([]);
  const [movements, setMovements] = useState<InventoryStockMovement[]>([]);
  const [lowStockCount, setLowStockCount] = useState(0);
  const [selectedLocationId, setSelectedLocationId] = useState('');
  const [search, setSearch] = useState('');
  const [lowStockOnly, setLowStockOnly] = useState(false);
  const [productForm, setProductForm] = useState<ProductForm>(emptyProductForm);
  const [stockProductId, setStockProductId] = useState('');
  const [initialQuantity, setInitialQuantity] = useState('');
  const [stockThreshold, setStockThreshold] = useState('');
  const [adjustProductId, setAdjustProductId] = useState('');
  const [adjustDelta, setAdjustDelta] = useState('');
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
      const [productResult, stockResult, movementResult, lowStockResult] = await Promise.all([
        listInventoryProducts(accessToken),
        listInventoryStock(accessToken, { locationId: selectedLocationId || undefined, q: search, lowStockOnly }),
        listInventoryMovements(accessToken, { locationId: selectedLocationId || undefined, limit: 20 }),
        listInventoryLowStock(accessToken, { locationId: selectedLocationId || undefined }),
      ]);
      setProducts(productResult.products);
      setStock(stockResult.stock);
      setLocations(stockResult.locations);
      setMovements(movementResult.movements);
      setLowStockCount(lowStockResult.alerts.length);
      if (!selectedLocationId && stockResult.locations.length > 0) {
        setSelectedLocationId(stockResult.locations[0].id);
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not load inventory');
    } finally {
      setLoading(false);
    }
  }, [accessToken, lowStockOnly, search, selectedLocationId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const activeProducts = useMemo(() => products.filter((product) => product.isActive), [products]);
  const selectedLocation = locations.find((location) => location.id === selectedLocationId);

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
    if (!accessToken || !selectedLocationId || !stockProductId) return;
    setBusy('initialize');
    setError(null);
    setActionMessage(null);
    try {
      const result = await initializeInventoryStock(accessToken, {
        locationId: selectedLocationId,
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
    if (!accessToken || !selectedLocationId || !adjustProductId) return;
    const delta = optionalNumber(adjustDelta);
    if (!delta) {
      setError('Adjustment quantity must not be zero.');
      return;
    }
    setBusy('adjust');
    setError(null);
    setActionMessage(null);
    try {
      const result = await adjustInventoryStock(accessToken, {
        locationId: selectedLocationId,
        productId: adjustProductId,
        quantityDeltaGrams: delta,
        movementType: delta > 0 ? 'restock' : 'manual_adjustment',
        reason: delta > 0 ? 'restock' : 'manual_adjustment',
        notes: nullable(adjustReason),
      });
      setStock((current) => upsertStock(current, result.stock));
      setAdjustDelta('');
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
          className="h-10 rounded-pill border border-border-strong bg-surface px-5 text-[13px] font-semibold text-text-primary transition hover:bg-surface-alt"
          onClick={() => void reload()}
          disabled={loading}
        >
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

      <section className="mb-6 grid gap-4 lg:grid-cols-3">
        <MetricCard label="Active products" value={activeProducts.length} />
        <MetricCard label="Stock records" value={stock.length} />
        <MetricCard label="Low-stock alerts" value={lowStockCount} tone={lowStockCount > 0 ? 'danger' : 'default'} />
      </section>

      <section className="mb-6 rounded-card-lg border border-border bg-surface">
        <header className="border-b border-border bg-surface-alt px-4 py-3">
          <div className="text-[12px] font-semibold uppercase tracking-[0.12em] text-text-secondary">Location stock</div>
          <div className="mt-1 text-[13px] text-text-secondary">
            Stock is isolated per location. Adjustments write stock movement records.
          </div>
        </header>
        <div className="grid gap-4 px-4 py-4 lg:grid-cols-[0.8fr_1fr_1fr]">
          <div className="space-y-3">
            <select
              value={selectedLocationId}
              onChange={(event) => setSelectedLocationId(event.target.value)}
              className="h-10 w-full rounded-input-lg border border-border-strong bg-surface px-3 text-[13px] outline-none focus:border-primary"
            >
              {locations.map((location) => (
                <option key={location.id} value={location.id}>
                  {location.name}
                </option>
              ))}
            </select>
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search stock"
              className="h-10 w-full rounded-input-lg border border-border-strong bg-surface px-3 text-[13px] outline-none focus:border-primary"
            />
            <label className="flex items-center gap-2 text-[13px] text-text-secondary">
              <input type="checkbox" checked={lowStockOnly} onChange={(event) => setLowStockOnly(event.target.checked)} />
              Low stock only
            </label>
          </div>

          <div className="space-y-2 rounded-input-lg border border-border bg-surface-alt p-3">
            <div className="text-[13px] font-semibold text-text-primary">Initialize product at {selectedLocation?.name}</div>
            <ProductSelect products={activeProducts} value={stockProductId} onChange={setStockProductId} />
            <div className="grid grid-cols-2 gap-2">
              <NumberInput value={initialQuantity} onChange={setInitialQuantity} placeholder="Opening g" />
              <NumberInput value={stockThreshold} onChange={setStockThreshold} placeholder="Threshold g" />
            </div>
            <button
              type="button"
              className="h-9 rounded-pill bg-primary px-4 text-[12px] font-semibold text-text-on-primary disabled:opacity-50"
              onClick={() => void handleInitializeStock()}
              disabled={busy === 'initialize' || !stockProductId || !selectedLocationId}
            >
              Initialize stock
            </button>
          </div>

          <div className="space-y-2 rounded-input-lg border border-border bg-surface-alt p-3">
            <div className="text-[13px] font-semibold text-text-primary">Manual stock adjustment</div>
            <ProductSelect products={activeProducts} value={adjustProductId} onChange={setAdjustProductId} />
            <NumberInput value={adjustDelta} onChange={setAdjustDelta} placeholder="+/- grams" />
            <input
              value={adjustReason}
              onChange={(event) => setAdjustReason(event.target.value)}
              placeholder="Reason / note"
              className="h-9 w-full rounded-input-lg border border-border-strong bg-surface px-3 text-[13px] outline-none focus:border-primary"
            />
            <button
              type="button"
              className="h-9 rounded-pill bg-primary px-4 text-[12px] font-semibold text-text-on-primary disabled:opacity-50"
              onClick={() => void handleAdjustStock()}
              disabled={busy === 'adjust' || !adjustProductId || !adjustDelta}
            >
              Record adjustment
            </button>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-[13px]">
            <thead className="bg-surface-alt text-[11px] uppercase tracking-[0.08em] text-text-secondary">
              <tr>
                <th className="px-4 py-3">Product</th>
                <th className="px-4 py-3">Location</th>
                <th className="px-4 py-3">On hand</th>
                <th className="px-4 py-3">Threshold</th>
                <th className="px-4 py-3">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {stock.map((item) => (
                <tr key={item.id}>
                  <td className="px-4 py-3">
                    <div className="font-medium text-text-primary">{item.productName}</div>
                    <div className="text-[12px] text-text-secondary">{[item.brand, item.category, item.sku].filter(Boolean).join(' · ')}</div>
                  </td>
                  <td className="px-4 py-3 text-text-secondary">{item.locationName}</td>
                  <td className="px-4 py-3 font-medium text-text-primary">{formatGrams(item.quantityOnHandGrams)}</td>
                  <td className="px-4 py-3">
                    <input
                      defaultValue={String(item.lowStockThresholdGrams ?? '')}
                      onBlur={(event) => void handleThresholdUpdate(item, event.target.value)}
                      className="h-8 w-28 rounded-input-lg border border-border-strong bg-surface px-2 text-[12px] outline-none focus:border-primary disabled:opacity-50"
                      disabled={busy === item.id}
                    />
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`rounded-pill border px-2.5 py-1 text-[11px] font-semibold ${
                        item.isLowStock
                          ? 'border-danger-border bg-danger-soft text-danger'
                          : 'border-success-border bg-success-soft text-success'
                      }`}
                    >
                      {item.isLowStock ? 'Low stock' : 'OK'}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!loading && stock.length === 0 ? <EmptyState label="No stock records yet" /> : null}
        </div>
      </section>

      <div className="grid gap-6 xl:grid-cols-[1.1fr_0.9fr]">
        <section className="rounded-card-lg border border-border bg-surface">
          <header className="border-b border-border bg-surface-alt px-4 py-3">
            <div className="text-[12px] font-semibold uppercase tracking-[0.12em] text-text-secondary">Product catalogue</div>
          </header>
          {isOwner ? (
            <div className="grid gap-2 border-b border-border px-4 py-4 md:grid-cols-3">
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
                {productForm.id ? (
                  <button type="button" className="h-9 rounded-pill border border-border-strong px-4 text-[12px] font-semibold text-text-secondary" onClick={() => setProductForm(emptyProductForm)}>
                    Cancel edit
                  </button>
                ) : null}
              </div>
            </div>
          ) : (
            <div className="border-b border-border px-4 py-3 text-[13px] text-text-secondary">
              Managers can manage location stock. Product catalogue edits are owner-only.
            </div>
          )}
          <div className="divide-y divide-border">
            {products.map((product) => (
              <div key={product.id} className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <div className="font-medium text-text-primary">{product.name}</div>
                  <div className="text-[12px] text-text-secondary">
                    {[product.brand, product.category, product.sku, product.sizeValue ? `${product.sizeValue}${product.sizeUnit}` : undefined].filter(Boolean).join(' · ')}
                  </div>
                </div>
                <div className="flex items-center gap-2 text-[12px] text-text-secondary">
                  <span>{formatMoney(product.defaultCostPerGramCents)} / g</span>
                  {isOwner && product.isActive ? (
                    <>
                      <button type="button" className="rounded-pill border border-border-strong px-3 py-1 font-semibold" onClick={() => setProductForm(toProductForm(product))}>Edit</button>
                      <button type="button" className="rounded-pill border border-danger-border px-3 py-1 font-semibold text-danger" onClick={() => void handleArchiveProduct(product)} disabled={busy === product.id}>Archive</button>
                    </>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="rounded-card-lg border border-border bg-surface">
          <header className="border-b border-border bg-surface-alt px-4 py-3">
            <div className="text-[12px] font-semibold uppercase tracking-[0.12em] text-text-secondary">Recent stock movements</div>
          </header>
          <div className="divide-y divide-border">
            {movements.map((movement) => (
              <div key={movement.id} className="px-4 py-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="font-medium text-text-primary">{movement.productName}</div>
                  <div className={movement.quantityDeltaGrams < 0 ? 'text-danger' : 'text-success'}>
                    {movement.quantityDeltaGrams > 0 ? '+' : ''}
                    {formatGrams(movement.quantityDeltaGrams)}
                  </div>
                </div>
                <div className="mt-1 text-[12px] text-text-secondary">
                  {movement.locationName} · {movement.movementType.replace(/_/g, ' ')} · {formatDateTime(movement.createdAt)}
                </div>
                {movement.notes || movement.reason ? <div className="mt-1 text-[12px] text-text-secondary">{movement.notes ?? movement.reason}</div> : null}
              </div>
            ))}
            {movements.length === 0 ? <EmptyState label="No stock movements yet" /> : null}
          </div>
        </section>
      </div>
    </div>
  );
}

const inputClass =
  'h-9 w-full rounded-input-lg border border-border-strong bg-surface px-3 text-[13px] outline-none focus:border-primary';

function MetricCard({ label, value, tone = 'default' }: { label: string; value: number; tone?: 'default' | 'danger' }) {
  return (
    <div className="rounded-card-lg border border-border bg-surface px-4 py-3">
      <div className="text-[12px] uppercase tracking-[0.08em] text-text-secondary">{label}</div>
      <div className={tone === 'danger' ? 'mt-1 text-[26px] font-semibold text-danger' : 'mt-1 text-[26px] font-semibold text-text-primary'}>{value}</div>
    </div>
  );
}

function ProductSelect({ products, value, onChange }: { products: InventoryProduct[]; value: string; onChange: (value: string) => void }) {
  return (
    <select value={value} onChange={(event) => onChange(event.target.value)} className={inputClass}>
      <option value="">Choose product</option>
      {products.map((product) => (
        <option key={product.id} value={product.id}>
          {[product.brand, product.name].filter(Boolean).join(' · ')}
        </option>
      ))}
    </select>
  );
}

function NumberInput({ value, onChange, placeholder }: { value: string; onChange: (value: string) => void; placeholder: string }) {
  return (
    <input
      inputMode="decimal"
      value={value}
      onChange={(event) => onChange(event.target.value.replace(/[^0-9.-]/g, ''))}
      placeholder={placeholder}
      className={inputClass}
    />
  );
}

function EmptyState({ label }: { label: string }) {
  return <div className="px-4 py-8 text-center text-[13px] text-text-secondary">{label}</div>;
}

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

function formatDateTime(value: string): string {
  return new Date(value).toLocaleString([], { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}
