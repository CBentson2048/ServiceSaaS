import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { BusinessLocationSummary, InventoryLocationStock, InventoryProduct } from '@sheer/domain';
import { ApiRequestError, lookupInventoryBarcode, recordProductConsumption } from '../../auth/api';
import { AppButton } from '../../design/components';
import { Modal } from '../team/Modal';
import { CameraScannerView } from './CameraScannerView';
import {
  actionForEnter,
  classifyScanError,
  consumptionUnitLabel,
  defaultConsumptionUnit,
  describeScanSuccess,
  makeResolvedScan,
  newScanIdempotencyKey,
  resolvedScanFromProduct,
  sanitizeBarcode,
  validateConsumptionQuantity,
  type ConsumptionUnit,
  type ResolvedScan,
  type ScanError,
  type ScanPhase,
} from './scanConsumption';

type InputMode = 'scanner' | 'camera' | 'search';

/**
 * Scan / Consume (§13–§16): one dialog, three ways in — USB/Bluetooth wedge
 * scanner (the default, autofocused), device camera, or manual product search —
 * all converging on the same confirmation step and the same authoritative
 * consumption API.
 *
 * Scanning IDENTIFIES; it never deducts. Stock changes only when the user
 * confirms a quantity (§15), and every attempt of one scan reuses a single
 * idempotency key so a retry cannot deduct twice.
 */
export function ScanConsumeModal({
  open,
  accessToken,
  locationId,
  locationName,
  locations,
  products,
  stock,
  onClose,
  onConsumed,
}: {
  open: boolean;
  accessToken: string | undefined;
  /** Default target — the sidebar scope, or the first salon when viewing All. */
  locationId: string;
  locationName: string;
  /** Every location in scope; a picker appears when there is more than one. */
  locations: BusinessLocationSummary[];
  /** Catalogue already loaded by the page — powers the search fallback. */
  products: InventoryProduct[];
  stock: InventoryLocationStock[];
  onClose: () => void;
  onConsumed: () => void;
}) {
  const [mode, setMode] = useState<InputMode>('scanner');
  // Consumption must never be attributed to the wrong salon: when the page is
  // showing several locations the target is chosen explicitly, not inferred.
  const [targetLocationId, setTargetLocationId] = useState(locationId);
  const [phase, setPhase] = useState<ScanPhase>('idle');
  const [barcodeInput, setBarcodeInput] = useState('');
  const [searchTerm, setSearchTerm] = useState('');
  const [resolved, setResolved] = useState<ResolvedScan | null>(null);
  const [quantity, setQuantity] = useState('1');
  const [unit, setUnit] = useState<ConsumptionUnit>('pack');
  const [error, setError] = useState<ScanError | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const scanInputRef = useRef<HTMLInputElement>(null);
  const quantityInputRef = useRef<HTMLInputElement>(null);

  // Focus follows the workflow: the scanner field is armed whenever we are
  // waiting for a scan, the quantity box when a product is resolved — so a
  // wedge scanner and the Enter key alone can drive the whole loop.
  useEffect(() => {
    if (!open) return;
    if (phase === 'idle' && mode === 'scanner') scanInputRef.current?.focus();
    if (phase === 'resolved') quantityInputRef.current?.focus();
  }, [open, phase, mode]);

  useEffect(() => {
    if (!open) return;
    setTargetLocationId(locationId);
  }, [open, locationId]);

  useEffect(() => {
    if (open) return;
    // Reset when the dialog closes so the next open starts clean.
    setMode('scanner');
    setPhase('idle');
    setBarcodeInput('');
    setSearchTerm('');
    setResolved(null);
    setQuantity('1');
    setError(null);
    setSuccess(null);
  }, [open]);

  const stockByProduct = useMemo(() => {
    const map = new Map<string, number>();
    for (const record of stock) {
      if (record.locationId === targetLocationId) map.set(record.productId, record.quantityOnHandGrams);
    }
    return map;
  }, [stock, targetLocationId]);

  const searchResults = useMemo(() => {
    const term = searchTerm.trim().toLowerCase();
    if (!term) return [];
    return products
      .filter((product) => product.isActive)
      .filter((product) =>
        [product.name, product.brand ?? '', product.sku ?? '', product.barcode ?? '']
          .join(' ')
          .toLowerCase()
          .includes(term),
      )
      .slice(0, 8);
  }, [products, searchTerm]);

  const resolveBarcode = useCallback(
    async (rawBarcode: string) => {
      if (!accessToken) return;
      if (!targetLocationId) {
        setError({
          kind: 'invalid_request',
          message: 'No location is available to record stock against. Choose a salon in the sidebar and try again.',
        });
        return;
      }
      const barcode = sanitizeBarcode(rawBarcode);
      if (!barcode) return;
      setPhase('looking_up');
      setError(null);
      setSuccess(null);
      try {
        const lookup = await lookupInventoryBarcode(accessToken, { barcode, locationId: targetLocationId });
        const scan = makeResolvedScan(lookup, barcode, newScanIdempotencyKey());
        setResolved(scan);
        setUnit(defaultConsumptionUnit(scan));
        setQuantity('1');
        setPhase('resolved');
      } catch (cause: unknown) {
        const status = cause instanceof ApiRequestError ? cause.status : 0;
        const message = cause instanceof Error ? cause.message : 'The scan could not be completed.';
        setError(classifyScanError(status, message, barcode));
        setResolved(null);
        setBarcodeInput('');
        setPhase('idle');
        setMode('scanner');
      }
    },
    [accessToken, targetLocationId],
  );

  function handleScannerEnter() {
    if (actionForEnter(phase) !== 'lookup') return;
    void resolveBarcode(barcodeInput);
  }

  function selectProduct(product: InventoryProduct) {
    const onHand = stockByProduct.get(product.id);
    if (onHand === undefined) {
      setError({
        kind: 'invalid_request',
        message: `${product.name} is not stocked at ${targetLocationName}. Add it to this location before recording use.`,
      });
      return;
    }
    const scan = resolvedScanFromProduct(product, onHand, newScanIdempotencyKey());
    setResolved(scan);
    setUnit(defaultConsumptionUnit(scan));
    setQuantity('1');
    setError(null);
    setSuccess(null);
    setPhase('resolved');
  }

  async function confirmConsumption() {
    if (!accessToken || !resolved) return;
    if (actionForEnter(phase) !== 'confirm') return;
    const validated = validateConsumptionQuantity(quantity, resolved, unit);
    if (!validated.ok) {
      setError({ kind: 'invalid_request', message: validated.message });
      return;
    }
    setPhase('submitting');
    setError(null);
    try {
      const result = await recordProductConsumption(accessToken, {
        locationId: targetLocationId,
        productId: resolved.productId,
        // Only a real scan is logged as one; a searched product is manual use.
        ...(resolved.source === 'barcode' && resolved.barcode ? { barcode: resolved.barcode } : {}),
        quantity: validated.quantity,
        unit,
        reason: 'salon_consumption',
        idempotencyKey: resolved.idempotencyKey,
      });
      setSuccess(
        describeScanSuccess({
          productName: result.productName,
          deductedGrams: result.quantityDeductedGrams,
          onHandGrams: result.quantityOnHandGrams,
          stockUnit: resolved.stockUnit,
          replayed: result.idempotentReplay,
        }),
      );
      setResolved(null);
      setBarcodeInput('');
      setSearchTerm('');
      setQuantity('1');
      setPhase('idle');
      setMode('scanner');
      onConsumed();
    } catch (cause: unknown) {
      const status = cause instanceof ApiRequestError ? cause.status : 0;
      const message = cause instanceof Error ? cause.message : 'The consumption could not be recorded.';
      setError(classifyScanError(status, message, resolved.barcode));
      // Stay on the product with the SAME key so a retry is safe.
      setPhase('resolved');
    }
  }

  const busy = phase === 'looking_up' || phase === 'submitting';
  const targetLocationName =
    locations.find((location) => location.id === targetLocationId)?.name ?? locationName;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Scan / consume"
      description={`Record salon use at ${targetLocationName || 'this location'}. Scanning identifies the product — stock only changes when you confirm.`}
      widthClassName="max-w-xl"
      footer={
        <AppButton size="sm" variant="ghost" onClick={onClose}>
          Done
        </AppButton>
      }
    >
      <div className="space-y-4">
        {success ? (
          <div role="status" className="rounded-input-lg border border-success-border bg-success-soft px-3 py-2.5 text-[13px] text-success">
            {success} Ready for the next scan.
          </div>
        ) : null}
        {error ? (
          <div
            role="alert"
            className={`rounded-input-lg border px-3 py-2.5 text-[13px] ${
              error.kind === 'unknown_barcode' || error.kind === 'invalid_request'
                ? 'border-warning-border bg-warning-soft text-warning'
                : 'border-danger-border bg-danger-soft text-danger'
            }`}
          >
            {error.message}
          </div>
        ) : null}

        {resolved ? (
          <ConfirmStep
            resolved={resolved}
            quantity={quantity}
            unit={unit}
            submitting={phase === 'submitting'}
            quantityInputRef={quantityInputRef}
            onQuantityChange={setQuantity}
            onUnitChange={setUnit}
            onConfirm={() => void confirmConsumption()}
            onCancel={() => {
              setResolved(null);
              setPhase('idle');
              setMode('scanner');
            }}
          />
        ) : (
          <>
            {locations.length > 1 ? (
              <div>
                <label className="mb-1 block text-[12px] font-medium text-text-secondary" htmlFor="scan-location">
                  Location
                </label>
                <select
                  id="scan-location"
                  value={targetLocationId}
                  onChange={(event) => setTargetLocationId(event.target.value)}
                  className="h-10 w-full rounded-input-lg border border-border-strong bg-surface px-3 text-[13px] outline-none focus:border-primary"
                >
                  {locations.map((location) => (
                    <option key={location.id} value={location.id}>
                      {location.name}
                    </option>
                  ))}
                </select>
                <span className="mt-1 block text-[11px] text-text-muted">
                  Stock is taken from this salon&rsquo;s shelf.
                </span>
              </div>
            ) : null}

            <div className="flex flex-wrap gap-2" role="tablist" aria-label="Barcode input method">
              {(
                [
                  ['scanner', 'Scanner / type'],
                  ['camera', 'Scan with camera'],
                  ['search', 'Search product'],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  role="tab"
                  aria-selected={mode === value}
                  onClick={() => {
                    setMode(value);
                    setError(null);
                  }}
                  className={`h-9 rounded-pill border px-4 text-[13px] font-medium transition ${
                    mode === value
                      ? 'border-primary bg-primary-soft text-primary-deep'
                      : 'border-border-strong bg-surface text-text-secondary hover:bg-surface-alt'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>

            {mode === 'scanner' ? (
              <label className="block">
                <span className="mb-1.5 block text-[12px] font-medium text-text-secondary">Barcode</span>
                <input
                  ref={scanInputRef}
                  value={barcodeInput}
                  onChange={(event) => setBarcodeInput(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      handleScannerEnter();
                    }
                  }}
                  disabled={busy}
                  autoComplete="off"
                  spellCheck={false}
                  aria-label="Barcode"
                  placeholder="Scan with a USB scanner, or type a barcode and press Enter"
                  className="h-11 w-full rounded-input-lg border border-border-strong bg-surface px-3 font-mono text-[14px] outline-none focus:border-primary disabled:opacity-60"
                />
                <span className="mt-1.5 block text-[11px] text-text-muted">
                  A USB or Bluetooth scanner types here automatically and presses Enter for you.
                </span>
              </label>
            ) : null}

            {mode === 'camera' ? (
              <CameraScannerView
                onDetected={(code) => void resolveBarcode(code)}
                onCancel={() => setMode('scanner')}
              />
            ) : null}

            {mode === 'search' ? (
              <div>
                <label className="block">
                  <span className="mb-1.5 block text-[12px] font-medium text-text-secondary">Find a product</span>
                  <input
                    value={searchTerm}
                    onChange={(event) => setSearchTerm(event.target.value)}
                    aria-label="Search products"
                    placeholder="Name, brand or SKU…"
                    className="h-11 w-full rounded-input-lg border border-border-strong bg-surface px-3 text-[14px] outline-none focus:border-primary"
                  />
                </label>
                <ul className="mt-2 divide-y divide-border overflow-hidden rounded-input-lg border border-border">
                  {searchResults.map((product) => (
                    <li key={product.id}>
                      <button
                        type="button"
                        onClick={() => selectProduct(product)}
                        className="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left transition hover:bg-surface-alt"
                      >
                        <span className="min-w-0">
                          <span className="block truncate text-[13px] font-medium text-text-primary">{product.name}</span>
                          <span className="block truncate text-[11px] text-text-muted">
                            {[product.brand, product.sku].filter(Boolean).join(' · ') || '—'}
                          </span>
                        </span>
                        <span className="shrink-0 text-[12px] text-text-secondary">
                          {stockByProduct.has(product.id) ? 'In stock here' : 'Not stocked here'}
                        </span>
                      </button>
                    </li>
                  ))}
                  {searchTerm.trim() && searchResults.length === 0 ? (
                    <li className="px-3 py-4 text-center text-[13px] text-text-secondary">
                      No products match “{searchTerm.trim()}”.
                    </li>
                  ) : null}
                  {!searchTerm.trim() ? (
                    <li className="px-3 py-4 text-center text-[13px] text-text-muted">
                      Type to find a product by name, brand or SKU.
                    </li>
                  ) : null}
                </ul>
              </div>
            ) : null}

            {phase === 'looking_up' ? (
              <p role="status" className="text-[13px] text-text-secondary">
                Looking up…
              </p>
            ) : null}
          </>
        )}
      </div>
    </Modal>
  );
}

function ConfirmStep({
  resolved,
  quantity,
  unit,
  submitting,
  quantityInputRef,
  onQuantityChange,
  onUnitChange,
  onConfirm,
  onCancel,
}: {
  resolved: ResolvedScan;
  quantity: string;
  unit: ConsumptionUnit;
  submitting: boolean;
  quantityInputRef: React.RefObject<HTMLInputElement | null>;
  onQuantityChange: (value: string) => void;
  onUnitChange: (unit: ConsumptionUnit) => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const onHandLabel =
    resolved.stockUnit === 'unit'
      ? `${resolved.quantityOnHandGrams} items`
      : `${resolved.quantityOnHandGrams}${resolved.stockUnit === 'millilitre' ? 'ml' : 'g'}`;

  return (
    <div className="rounded-input-lg border border-border bg-surface-alt p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[15px] font-semibold text-text-primary">{resolved.productName}</div>
          <div className="mt-0.5 text-[12px] text-text-muted">
            {[resolved.brand, resolved.sku, resolved.barcode].filter(Boolean).join(' · ') || '—'}
          </div>
        </div>
        <div className="shrink-0 text-right">
          <div className="text-[11px] uppercase tracking-wide text-text-secondary">Current stock</div>
          <div className="text-[16px] font-semibold tabular-nums text-text-primary">{onHandLabel}</div>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-end gap-2">
        <label className="block">
          <span className="mb-1 block text-[12px] font-medium text-text-secondary">
            Amount used ({consumptionUnitLabel(resolved, unit)})
          </span>
          <input
            ref={quantityInputRef}
            value={quantity}
            onChange={(event) => onQuantityChange(event.target.value.replace(/[^0-9.]/g, ''))}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                onConfirm();
              }
            }}
            maxLength={8}
            inputMode="decimal"
            aria-label="Amount used"
            className="h-10 w-28 rounded-input-lg border border-border-strong bg-surface px-3 text-[14px] outline-none focus:border-primary"
          />
        </label>
        {resolved.stockUnit !== 'unit' ? (
          <select
            value={unit}
            onChange={(event) => onUnitChange(event.target.value as ConsumptionUnit)}
            aria-label="Quantity unit"
            className="h-10 rounded-input-lg border border-border-strong bg-surface px-3 text-[13px] outline-none focus:border-primary"
          >
            <option value="pack">{consumptionUnitLabel(resolved, 'pack')}</option>
            <option value="base">{consumptionUnitLabel(resolved, 'base')}</option>
          </select>
        ) : null}
        <AppButton size="sm" onClick={onConfirm} loading={submitting}>
          Record consumption
        </AppButton>
        <AppButton size="sm" variant="ghost" onClick={onCancel} disabled={submitting}>
          Cancel
        </AppButton>
      </div>
    </div>
  );
}
