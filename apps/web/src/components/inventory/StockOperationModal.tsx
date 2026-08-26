import { useEffect, useMemo, useState } from 'react';
import type { BusinessLocationSummary, InventoryLocationStock, InventoryProduct } from '@sheer/domain';
import { ApiRequestError, adjustInventoryStock } from '../../auth/api';
import { AppButton } from '../../design/components';
import { Modal } from '../team/Modal';
import {
  EMPTY_STOCK_OPERATION,
  OPERATION_COPY,
  baseUnitLabel,
  planStockOperation,
  type StockOperation,
  type StockOperationState,
} from './stockOperationForm';

const INPUT =
  'h-10 w-full rounded-input-lg border border-border-strong bg-surface px-3 text-[13px] text-text-primary outline-none focus:border-primary focus:ring-2 focus:ring-primary/20';

/**
 * Adjust Stock / Restock as focused tasks (§17/§18) rather than forms that
 * live on the page forever. Both write through the same authoritative
 * adjust-stock RPC the platform already uses, so movements, low-stock alerts
 * and the negative-stock policy behave exactly as before.
 */
export function StockOperationModal({
  open,
  operation,
  accessToken,
  locations,
  products,
  stock,
  defaultLocationId,
  defaultProductId,
  onClose,
  onRecorded,
}: {
  open: boolean;
  operation: StockOperation;
  accessToken: string | undefined;
  locations: BusinessLocationSummary[];
  products: InventoryProduct[];
  stock: InventoryLocationStock[];
  defaultLocationId?: string;
  defaultProductId?: string;
  onClose: () => void;
  onRecorded: (message: string) => void;
}) {
  const [state, setState] = useState<StockOperationState>(EMPTY_STOCK_OPERATION);
  const [fieldError, setFieldError] = useState<{ field: keyof StockOperationState; message: string } | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const copy = OPERATION_COPY[operation];

  // Reset only when the dialog is (re)opened for a task — NOT when a
  // background refresh hands down a new `locations` array identity, which
  // would wipe a form the user is halfway through.
  const firstLocationId = locations[0]?.id ?? '';
  useEffect(() => {
    if (!open) return;
    setState({
      ...EMPTY_STOCK_OPERATION,
      locationId: defaultLocationId ?? firstLocationId,
      productId: defaultProductId ?? '',
      direction: 'inbound',
    });
    setFieldError(null);
    setSubmitError(null);
  }, [open, operation, defaultLocationId, defaultProductId, firstLocationId]);

  const activeProducts = useMemo(() => products.filter((product) => product.isActive), [products]);
  const selectedProduct = activeProducts.find((product) => product.id === state.productId);
  const onHand = useMemo(() => {
    const record = stock.find(
      (entry) => entry.productId === state.productId && entry.locationId === state.locationId,
    );
    return record?.quantityOnHandGrams ?? null;
  }, [stock, state.productId, state.locationId]);

  async function handleSubmit() {
    if (!accessToken) return;
    const plan = planStockOperation(operation, state);
    if (!plan.ok) {
      setFieldError({ field: plan.field, message: plan.message });
      return;
    }
    setFieldError(null);
    setSubmitError(null);
    setSaving(true);
    try {
      const result = await adjustInventoryStock(accessToken, plan.request);
      onRecorded(
        `${copy.title} recorded for ${result.stock.productName} at ${result.stock.locationName}.`,
      );
      onClose();
    } catch (error: unknown) {
      // The server explains a refusal (e.g. insufficient stock when the
      // location forbids negative stock) — show that, not a generic failure.
      setSubmitError(
        error instanceof ApiRequestError ? error.message : 'That change could not be recorded. Try again.',
      );
    } finally {
      setSaving(false);
    }
  }

  const unitLabel = baseUnitLabel(selectedProduct?.stockUnit);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={copy.title}
      description={copy.description}
      footer={
        <>
          <AppButton size="sm" variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </AppButton>
          <AppButton size="sm" onClick={() => void handleSubmit()} loading={saving}>
            {copy.cta}
          </AppButton>
        </>
      }
    >
      <div className="space-y-3">
        {submitError ? (
          <div role="alert" className="rounded-input-lg border border-danger-border bg-danger-soft px-3 py-2.5 text-[13px] text-danger">
            {submitError}
          </div>
        ) : null}

        <div>
          <label className="mb-1 block text-[12px] font-medium text-text-secondary" htmlFor="stock-op-location">
            Location
          </label>
          <select
            id="stock-op-location"
            className={INPUT}
            value={state.locationId}
            onChange={(event) => setState((current) => ({ ...current, locationId: event.target.value }))}
          >
            {locations.length === 0 ? <option value="">No locations</option> : null}
            {locations.map((location) => (
              <option key={location.id} value={location.id}>
                {location.name}
              </option>
            ))}
          </select>
          {fieldError?.field === 'locationId' ? (
            <span className="mt-1 block text-[11px] text-danger">{fieldError.message}</span>
          ) : null}
        </div>

        <div>
          <label className="mb-1 block text-[12px] font-medium text-text-secondary" htmlFor="stock-op-product">
            Product
          </label>
          <select
            id="stock-op-product"
            aria-describedby="stock-op-product-hint"
            className={INPUT}
            value={state.productId}
            onChange={(event) => setState((current) => ({ ...current, productId: event.target.value }))}
          >
            <option value="">Choose a product</option>
            {activeProducts.map((product) => (
              <option key={product.id} value={product.id}>
                {[product.brand, product.name].filter(Boolean).join(' · ')}
              </option>
            ))}
          </select>
          <span id="stock-op-product-hint">
            {fieldError?.field === 'productId' ? (
              <span className="mt-1 block text-[11px] text-danger">{fieldError.message}</span>
            ) : onHand !== null ? (
              <span className="mt-1 block text-[11px] text-text-muted">
                Currently {onHand}
                {unitLabel === 'units' ? ' units' : unitLabel} on hand here.
              </span>
            ) : state.productId ? (
              <span className="mt-1 block text-[11px] text-text-muted">Not stocked at this location yet.</span>
            ) : null}
          </span>
        </div>

        {operation === 'adjust' ? (
          <fieldset>
            <legend className="mb-1 block text-[12px] font-medium text-text-secondary">Correction type</legend>
            <div className="grid grid-cols-2 gap-2">
              {(
                [
                  ['inbound', 'Found / add', 'Stock the shelf has but the system does not'],
                  ['loss', 'Loss / remove', 'Breakage, waste or a miscount'],
                ] as const
              ).map(([value, label, hint]) => (
                <label
                  key={value}
                  className={`cursor-pointer rounded-input-lg border px-3 py-2 text-[13px] transition ${
                    state.direction === value
                      ? value === 'inbound'
                        ? 'border-success-border bg-success-soft text-success'
                        : 'border-danger-border bg-danger-soft text-danger'
                      : 'border-border-strong bg-surface text-text-secondary hover:bg-surface-alt'
                  }`}
                >
                  <input
                    type="radio"
                    name="adjust-direction"
                    className="sr-only"
                    checked={state.direction === value}
                    onChange={() => setState((current) => ({ ...current, direction: value }))}
                  />
                  <span className="block font-medium">{label}</span>
                  <span className="mt-0.5 block text-[11px] opacity-80">{hint}</span>
                </label>
              ))}
            </div>
          </fieldset>
        ) : null}

        <div>
          <label className="mb-1 block text-[12px] font-medium text-text-secondary" htmlFor="stock-op-quantity">
            {operation === 'restock' ? 'Quantity received' : 'Quantity'} ({unitLabel})
          </label>
          <input
            id="stock-op-quantity"
            aria-describedby="stock-op-quantity-hint"
            className={INPUT}
            inputMode="decimal"
            value={state.quantity}
            onChange={(event) =>
              setState((current) => ({ ...current, quantity: event.target.value.replace(/[^0-9.]/g, '') }))
            }
            placeholder="0"
            aria-label={`Quantity in ${unitLabel}`}
          />
          <span id="stock-op-quantity-hint">
            {fieldError?.field === 'quantity' ? (
              <span className="mt-1 block text-[11px] text-danger">{fieldError.message}</span>
            ) : (
              <span className="mt-1 block text-[11px] text-text-muted">
                In the product&rsquo;s own unit ({unitLabel}) — not packs.
              </span>
            )}
          </span>
        </div>

        <div>
          <label className="mb-1 block text-[12px] font-medium text-text-secondary" htmlFor="stock-op-reason">
            Reason {operation === 'adjust' && state.direction === 'loss' ? '' : '(optional)'}
          </label>
          <input
            id="stock-op-reason"
            aria-describedby="stock-op-reason-hint"
            className={INPUT}
            value={state.reason}
            onChange={(event) => setState((current) => ({ ...current, reason: event.target.value }))}
            placeholder={operation === 'restock' ? 'Delivery note or order reference' : 'Cycle count, breakage, waste…'}
          />
          <span id="stock-op-reason-hint">
            {fieldError?.field === 'reason' ? (
              <span className="mt-1 block text-[11px] text-danger">{fieldError.message}</span>
            ) : (
              <span className="mt-1 block text-[11px] text-text-muted">Saved with the movement in the audit trail.</span>
            )}
          </span>
        </div>
      </div>
    </Modal>
  );
}
