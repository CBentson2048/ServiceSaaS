import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type {
  BusinessLocationSummary,
  EffectiveRetailPricing,
  InventoryCategory,
  InventoryProduct,
  InventorySupplier,
  ProductLocationAvailability,
  StockUnit,
} from '@sheer/domain';
import { RETAIL_PRICING_SOURCE_LABELS } from '@sheer/domain';
import {
  ApiRequestError,
  createInventoryProduct,
  getEffectiveRetailPricing,
  getProductAvailability,
  setProductAvailability,
  updateInventoryProduct,
} from '../../auth/api';
import { AppButton, Drawer } from '../../design/components';
import {
  EMPTY_PRODUCT_FORM,
  PRODUCT_USE_OPTIONS,
  buildProductPayload,
  hasErrors,
  productToFormState,
  validateProductForm,
  type ProductFormErrors,
  type ProductFormState,
} from './productForm';

const INPUT =
  'h-10 w-full rounded-input-lg border border-border-strong bg-surface px-3 text-[13px] text-text-primary outline-none focus:border-primary focus:ring-2 focus:ring-primary/20';

/**
 * Create/edit a product in a right-side drawer, so the catalogue stays on
 * screen behind it (§9). Sections separate the three concepts the Pricing CR
 * established and users kept confusing: what the product IS (basic + stock),
 * what it is FOR (product use), WHERE it is stocked (availability) — with
 * pricing summarised and linked, never duplicated.
 */
export function ProductDrawer({
  open,
  product,
  categories,
  suppliers,
  locations,
  accessToken,
  canManage,
  /** Location whose effective price is summarised; the sidebar scope. */
  pricingLocationId,
  onClose,
  onSaved,
}: {
  open: boolean;
  /** undefined = create a new product. */
  product?: InventoryProduct;
  categories: InventoryCategory[];
  suppliers: InventorySupplier[];
  locations: BusinessLocationSummary[];
  accessToken: string | undefined;
  canManage: boolean;
  pricingLocationId?: string;
  onClose: () => void;
  onSaved: (product: InventoryProduct, mode: 'created' | 'updated') => void;
}) {
  const [form, setForm] = useState<ProductFormState>(EMPTY_PRODUCT_FORM);
  const [errors, setErrors] = useState<ProductFormErrors>({});
  const [saving, setSaving] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  // The pristine copy the form was opened with, so an accidental Escape or
  // overlay click cannot throw away typed edits without asking.
  const [pristine, setPristine] = useState<ProductFormState>(EMPTY_PRODUCT_FORM);

  // Reset the form whenever the drawer opens for a different record.
  const productKey = product ? `${product.id}:${product.updatedAt}` : 'new';
  useEffect(() => {
    if (!open) return;
    const initial = product ? productToFormState(product) : EMPTY_PRODUCT_FORM;
    setForm(initial);
    setPristine(initial);
    setErrors({});
    setSubmitError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, productKey]);

  const set = <K extends keyof ProductFormState>(key: K, value: ProductFormState[K]) =>
    setForm((current) => ({ ...current, [key]: value }));

  const isDirty = JSON.stringify(form) !== JSON.stringify(pristine);

  function requestClose() {
    if (saving) return;
    if (isDirty && !window.confirm('Discard your unsaved changes to this product?')) return;
    onClose();
  }

  async function handleSave() {
    if (!accessToken || !canManage) return;
    const found = validateProductForm(form);
    setErrors(found);
    if (hasErrors(found)) {
      setSubmitError('Check the highlighted fields and try again.');
      return;
    }
    setSaving(true);
    setSubmitError(null);
    try {
      const payload = buildProductPayload(form);
      const result = form.id
        ? await updateInventoryProduct(accessToken, form.id, payload)
        : await createInventoryProduct(accessToken, payload);
      onSaved(result.product, form.id ? 'updated' : 'created');
    } catch (error: unknown) {
      // The server distinguishes a duplicate barcode/SKU from a real failure;
      // show what it said rather than a generic message.
      setSubmitError(
        error instanceof ApiRequestError ? error.message : 'The product could not be saved. Try again.',
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <Drawer
      open={open}
      onClose={requestClose}
      title={product ? product.name : 'New product'}
      description={
        product ? 'Edit this product’s details, stock settings, use and availability.' : 'Add a product to the catalogue.'
      }
      widthClassName="sm:max-w-2xl"
      footer={
        <>
          <AppButton size="sm" variant="ghost" onClick={requestClose} disabled={saving}>
            Cancel
          </AppButton>
          {canManage ? (
            <AppButton size="sm" onClick={() => void handleSave()} loading={saving}>
              {product ? 'Save changes' : 'Create product'}
            </AppButton>
          ) : null}
        </>
      }
    >
      {submitError ? (
        <div role="alert" className="mb-4 rounded-input-lg border border-danger-border bg-danger-soft px-3 py-2.5 text-[13px] text-danger">
          {submitError}
        </div>
      ) : null}

      <div className="space-y-6">
        <Section title="Basic information">
          <Grid>
            <Field label="Product name" error={errors.name} required>
              <input className={INPUT} value={form.name} onChange={(e) => set('name', e.target.value)} />
            </Field>
            <Field label="Brand">
              <input className={INPUT} value={form.brand} onChange={(e) => set('brand', e.target.value)} />
            </Field>
            <Field label="SKU / code">
              <input className={INPUT} value={form.sku} onChange={(e) => set('sku', e.target.value)} />
            </Field>
            <Field label="Category">
              <select className={INPUT} value={form.categoryId} onChange={(e) => set('categoryId', e.target.value)}>
                <option value="">Uncategorised</option>
                {form.categoryId && !categories.some((category) => category.id === form.categoryId) ? (
                  <option value={form.categoryId}>{form.categoryName || 'Current category'}</option>
                ) : null}
                {categories.map((category) => (
                  <option key={category.id} value={category.id}>
                    {category.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Size" error={errors.sizeValue} hint="e.g. 100 for a 100g tube">
              <input className={INPUT} inputMode="decimal" value={form.sizeValue} onChange={(e) => set('sizeValue', e.target.value)} />
            </Field>
            <Field label="Size unit">
              <input className={INPUT} value={form.sizeUnit} onChange={(e) => set('sizeUnit', e.target.value)} />
            </Field>
          </Grid>
        </Section>

        <Section title="Stock settings" subtitle="How this product is counted, reordered and flagged.">
          <Grid>
            <Field label="Stocked in">
              <select className={INPUT} value={form.stockUnit} onChange={(e) => set('stockUnit', e.target.value as StockUnit)}>
                <option value="gram">Grams</option>
                <option value="millilitre">Millilitres</option>
                <option value="unit">Whole units</option>
              </select>
            </Field>
            <Field label="Pack size" error={errors.packSize} hint="Base quantity in one sellable pack">
              <input className={INPUT} inputMode="decimal" value={form.packSize} onChange={(e) => set('packSize', e.target.value)} />
            </Field>
            <Field label="Safety threshold" error={errors.lowStockThresholdGrams} hint="Low-stock warning level">
              <input className={INPUT} inputMode="decimal" value={form.lowStockThresholdGrams} onChange={(e) => set('lowStockThresholdGrams', e.target.value)} />
            </Field>
            <Field label="Dead stock after (days)" error={errors.deadStockDays} hint="Blank uses the location default">
              <input className={INPUT} inputMode="numeric" value={form.deadStockDays} onChange={(e) => set('deadStockDays', e.target.value)} />
            </Field>
            <Field label="Cost per base unit (pence)" error={errors.defaultCostPerGramCents}>
              <input className={INPUT} inputMode="numeric" value={form.defaultCostPerGramCents} onChange={(e) => set('defaultCostPerGramCents', e.target.value)} />
            </Field>
            <Field label="Supplier">
              <select className={INPUT} value={form.supplierId} onChange={(e) => set('supplierId', e.target.value)}>
                <option value="">No supplier</option>
                {form.supplierId && !suppliers.some((supplier) => supplier.id === form.supplierId) ? (
                  <option value={form.supplierId}>{form.supplierName || 'Current supplier'}</option>
                ) : null}
                {suppliers.map((supplier) => (
                  <option key={supplier.id} value={supplier.id}>
                    {supplier.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Minimum order (packs)" error={errors.minimumOrderQuantity}>
              <input className={INPUT} inputMode="numeric" value={form.minimumOrderQuantity} onChange={(e) => set('minimumOrderQuantity', e.target.value)} />
            </Field>
            <Field label="Order multiple (packs)" error={errors.orderMultiple}>
              <input className={INPUT} inputMode="numeric" value={form.orderMultiple} onChange={(e) => set('orderMultiple', e.target.value)} />
            </Field>
          </Grid>
        </Section>

        <Section title="Barcode" subtitle="Scanned at the shelf to record salon use.">
          <Field label="Barcode (EAN/UPC or supplier code)" error={errors.barcode}>
            <input
              className={`${INPUT} font-mono`}
              value={form.barcode}
              spellCheck={false}
              onChange={(e) => set('barcode', e.target.value)}
              placeholder="Scan or type…"
            />
          </Field>
        </Section>

        <Section title="Product use" subtitle="What is this product for? More than one can apply.">
          <div className="grid gap-2 sm:grid-cols-3">
            {PRODUCT_USE_OPTIONS.map((option) => {
              const checked = form[option.key];
              return (
                <label
                  key={option.key}
                  className={`flex cursor-pointer gap-2.5 rounded-input-lg border p-3 transition ${
                    checked ? 'border-primary bg-primary-soft' : 'border-border-strong bg-surface hover:bg-surface-alt'
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={(event) => set(option.key, event.target.checked)}
                    className="mt-0.5 h-4 w-4 shrink-0 rounded border-border-strong text-primary focus:ring-primary/20"
                  />
                  <span className="min-w-0">
                    <span className={`block text-[13px] font-medium ${checked ? 'text-primary-deep' : 'text-text-primary'}`}>
                      {option.label}
                    </span>
                    <span className="mt-0.5 block text-[11px] leading-4 text-text-muted">{option.description}</span>
                  </span>
                </label>
              );
            })}
          </div>
        </Section>

        <Section title="Available locations" subtitle="Where do we stock or sell this product?">
          {form.id ? (
            <AvailabilityEditor productId={form.id} accessToken={accessToken} canManage={canManage} />
          ) : (
            <p className="text-[12px] text-text-muted">
              Save the product first — you can then choose the locations that stock it.
            </p>
          )}
        </Section>

        <Section title="Pricing" subtitle="What it sells for. Rules live on the Pricing tab.">
          <div className="mb-3">
            <Field
              label="Retail price (pence)"
              error={errors.retailPriceCents}
              hint="Fallback price used at the till when no pricing rule applies."
            >
              <input
                className={INPUT}
                inputMode="numeric"
                value={form.retailPriceCents}
                onChange={(e) => set('retailPriceCents', e.target.value)}
              />
            </Field>
          </div>
          {form.id ? (
            <PricingSummary
              productId={form.id}
              locationId={pricingLocationId}
              locations={locations}
              accessToken={accessToken}
            />
          ) : (
            <p className="text-[12px] text-text-muted">Pricing can be configured once the product exists.</p>
          )}
        </Section>
      </div>
    </Drawer>
  );
}

// ---------------------------------------------------------------------------

/**
 * Location availability, with a real failure state: a load error offers Retry
 * and never becomes permanent text (§11). Form data elsewhere in the drawer is
 * untouched by a retry because this component owns only its own state.
 */
function AvailabilityEditor({
  productId,
  accessToken,
  canManage,
}: {
  productId: string;
  accessToken: string | undefined;
  canManage: boolean;
}) {
  const [rows, setRows] = useState<ProductLocationAvailability[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [busyLocation, setBusyLocation] = useState<string | null>(null);
  const [writeError, setWriteError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!accessToken) return;
    setLoading(true);
    setLoadFailed(false);
    try {
      const result = await getProductAvailability(accessToken, productId);
      setRows(result.locations);
    } catch {
      setLoadFailed(true);
    } finally {
      setLoading(false);
    }
  }, [accessToken, productId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function toggle(locationId: string, available: boolean) {
    if (!accessToken || !canManage) return;
    setBusyLocation(locationId);
    setWriteError(null);
    try {
      const result = await setProductAvailability(accessToken, productId, { locationId, available });
      setRows(result.locations);
    } catch (error: unknown) {
      setWriteError(
        error instanceof ApiRequestError ? error.message : 'That change could not be saved. Try again.',
      );
    } finally {
      setBusyLocation(null);
    }
  }

  if (loadFailed) {
    return (
      <div className="rounded-input-lg border border-warning-border bg-warning-soft px-3 py-2.5">
        <p className="text-[13px] text-warning">Unable to load locations.</p>
        <AppButton size="sm" variant="secondary" className="mt-2" onClick={() => void load()} loading={loading}>
          Retry
        </AppButton>
      </div>
    );
  }

  if (rows === null) {
    return <p className="text-[12px] text-text-muted">Loading locations…</p>;
  }

  if (rows.length === 0) {
    return <p className="text-[12px] text-text-muted">No locations available for your account.</p>;
  }

  // Single-location businesses get a sentence, not a checklist to maintain.
  if (rows.length === 1) {
    const only = rows[0];
    return (
      <label className="flex items-center gap-2.5 rounded-input-lg border border-border-strong bg-surface px-3 py-2.5 text-[13px] text-text-primary">
        <input
          type="checkbox"
          checked={only.available}
          disabled={!canManage || busyLocation === only.locationId}
          onChange={(event) => void toggle(only.locationId, event.target.checked)}
          className="h-4 w-4 rounded border-border-strong text-primary focus:ring-primary/20"
        />
        Stocked at {only.locationName}
      </label>
    );
  }

  return (
    <>
      <div className="grid gap-2 sm:grid-cols-2">
        {rows.map((row) => (
          <label
            key={row.locationId}
            className={`flex cursor-pointer items-center gap-2.5 rounded-input-lg border px-3 py-2.5 text-[13px] transition ${
              row.available ? 'border-primary bg-primary-soft text-primary-deep' : 'border-border-strong bg-surface text-text-primary hover:bg-surface-alt'
            }`}
          >
            <input
              type="checkbox"
              checked={row.available}
              disabled={!canManage || busyLocation === row.locationId}
              onChange={(event) => void toggle(row.locationId, event.target.checked)}
              className="h-4 w-4 rounded border-border-strong text-primary focus:ring-primary/20"
            />
            {row.locationName}
          </label>
        ))}
      </div>
      {writeError ? <p className="mt-2 text-[12px] text-danger">{writeError}</p> : null}
    </>
  );
}

/**
 * A read-only summary of what the product currently sells for at the viewed
 * location, straight from the canonical resolver — with a link to the Pricing
 * tab rather than a second copy of its controls (§9).
 */
function PricingSummary({
  productId,
  locationId,
  locations,
  accessToken,
}: {
  productId: string;
  locationId?: string;
  locations: BusinessLocationSummary[];
  accessToken: string | undefined;
}) {
  const [pricing, setPricing] = useState<EffectiveRetailPricing | null>(null);
  const [failed, setFailed] = useState(false);
  const target = locationId ?? locations[0]?.id;

  const load = useCallback(async () => {
    if (!accessToken || !target) return;
    setFailed(false);
    try {
      const result = await getEffectiveRetailPricing(accessToken, { productId, locationId: target });
      setPricing(result.pricing);
    } catch {
      setFailed(true);
    }
  }, [accessToken, productId, target]);

  useEffect(() => {
    void load();
  }, [load]);

  const locationName = locations.find((location) => location.id === target)?.name;

  return (
    <div className="rounded-input-lg border border-border bg-surface-alt px-3 py-2.5">
      {failed ? (
        <div className="flex items-center justify-between gap-3">
          <span className="text-[13px] text-text-secondary">Unable to load pricing.</span>
          <AppButton size="sm" variant="secondary" onClick={() => void load()}>
            Retry
          </AppButton>
        </div>
      ) : pricing === null ? (
        <span className="text-[12px] text-text-muted">Resolving price…</span>
      ) : (
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div>
            <span className="text-[16px] font-semibold tabular-nums text-text-primary">
              {pricing.sellingPriceCents !== null
                ? new Intl.NumberFormat('en-GB', { style: 'currency', currency: pricing.currencyCode }).format(
                    pricing.sellingPriceCents / 100,
                  )
                : 'No price configured'}
            </span>
            <span className="ml-2 text-[12px] text-text-secondary">
              {locationName ? `at ${locationName} · ` : ''}
              {RETAIL_PRICING_SOURCE_LABELS[pricing.source]}
              {pricing.effectiveMarkupPercent !== null ? ` · ${pricing.effectiveMarkupPercent}% markup` : ''}
            </span>
          </div>
          <Link to="/inventory/pricing" className="text-[13px] font-medium text-primary hover:text-primary-deep">
            Configure pricing →
          </Link>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function Section({ title, subtitle, children }: { title: string; subtitle?: string; children: ReactNode }) {
  return (
    <section>
      <h3 className="text-[13px] font-semibold uppercase tracking-[0.06em] text-text-secondary">{title}</h3>
      {subtitle ? <p className="mt-0.5 text-[12px] text-text-muted">{subtitle}</p> : null}
      <div className="mt-3">{children}</div>
    </section>
  );
}

function Grid({ children }: { children: ReactNode }) {
  return <div className="grid gap-3 sm:grid-cols-2">{children}</div>;
}

/**
 * A labelled field. The hint and error sit OUTSIDE the <label> so they never
 * become part of the control's accessible name — a screen reader should say
 * "Pack size", not "Pack size Base quantity in one sellable pack".
 */
function Field({
  label,
  children,
  hint,
  error,
  required,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
  error?: string;
  required?: boolean;
}) {
  return (
    <div className="block">
      <label className="mb-1 block text-[12px] font-medium text-text-secondary">
        <span>
          {label}
          {required ? <span className="text-danger"> *</span> : null}
        </span>
        {children}
      </label>
      {error ? (
        <span role="alert" className="mt-1 block text-[11px] text-danger">
          {error}
        </span>
      ) : hint ? (
        <span className="mt-1 block text-[11px] text-text-muted">{hint}</span>
      ) : null}
    </div>
  );
}
