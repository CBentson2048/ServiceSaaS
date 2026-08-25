import { useEffect, useRef, useState } from 'react';
import { ApiRequestError, lookupInventoryBarcode, recordProductConsumption } from '../../auth/api';
import {
  actionForEnter,
  classifyScanError,
  consumptionUnitLabel,
  defaultConsumptionUnit,
  describeScanSuccess,
  makeResolvedScan,
  newScanIdempotencyKey,
  sanitizeBarcode,
  validateConsumptionQuantity,
  type ConsumptionUnit,
  type ResolvedScan,
  type ScanError,
  type ScanPhase,
} from './scanConsumption';

/**
 * Week 6 ticket 3 — the visible barcode capture surface, built for a USB/
 * Bluetooth wedge scanner: a focused input the scanner types into, Enter
 * resolves the product, a second Enter confirms the deduction. All decisions
 * (input hygiene, duplicate-Enter guard, error states, quantity rules,
 * idempotency) live in scanConsumption.ts where they are unit-tested; stock
 * itself only ever changes through the authoritative consumption API.
 */
export function ScanConsumptionCard({
  accessToken,
  locationId,
  locationName,
  onStockChanged,
}: {
  accessToken: string | undefined;
  locationId: string;
  locationName: string;
  onStockChanged: () => void;
}) {
  const [phase, setPhase] = useState<ScanPhase>('idle');
  const [barcodeInput, setBarcodeInput] = useState('');
  const [resolved, setResolved] = useState<ResolvedScan | null>(null);
  const [quantity, setQuantity] = useState('1');
  const [unit, setUnit] = useState<ConsumptionUnit>('pack');
  const [error, setError] = useState<ScanError | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const scanInputRef = useRef<HTMLInputElement>(null);
  const quantityInputRef = useRef<HTMLInputElement>(null);

  // The scan field owns focus so a wedge scanner can fire at any time; after a
  // resolve, focus moves to the quantity so Enter confirms, and returns after
  // every completed or abandoned scan — repeated scanning needs no mouse.
  useEffect(() => {
    if (phase === 'idle') scanInputRef.current?.focus();
    if (phase === 'resolved') quantityInputRef.current?.focus();
  }, [phase]);

  function resetToIdle(clearFeedback: boolean) {
    setPhase('idle');
    setResolved(null);
    setBarcodeInput('');
    setQuantity('1');
    if (clearFeedback) {
      setError(null);
      setSuccess(null);
    }
  }

  async function handleLookup() {
    if (!accessToken || !locationId) return;
    if (actionForEnter(phase) !== 'lookup') return;
    const barcode = sanitizeBarcode(barcodeInput);
    if (!barcode) return;

    setPhase('looking_up');
    setError(null);
    setSuccess(null);
    try {
      const lookup = await lookupInventoryBarcode(accessToken, { barcode, locationId });
      const scan = makeResolvedScan(lookup, barcode, newScanIdempotencyKey());
      setResolved(scan);
      setUnit(defaultConsumptionUnit(scan));
      setQuantity('1');
      setPhase('resolved');
    } catch (cause: unknown) {
      const status = cause instanceof ApiRequestError ? cause.status : 0;
      const message = cause instanceof Error ? cause.message : 'The scan could not be completed.';
      setError(classifyScanError(status, message, barcode));
      resetOnError();
    }
  }

  function resetOnError() {
    setPhase('idle');
    setResolved(null);
    setBarcodeInput('');
    // Error/success text intentionally survives the reset so the operator can
    // read what happened while the field is already armed for the next scan.
  }

  async function handleConfirm() {
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
        locationId,
        productId: resolved.productId,
        barcode: resolved.barcode,
        quantity: validated.quantity,
        unit,
        reason: 'salon_consumption',
        // Reused across retries of THIS scan: a network blip cannot deduct twice.
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
      resetToIdle(false);
      onStockChanged();
    } catch (cause: unknown) {
      const status = cause instanceof ApiRequestError ? cause.status : 0;
      const message = cause instanceof Error ? cause.message : 'The consumption could not be recorded.';
      setError(classifyScanError(status, message, resolved.barcode));
      // Stay on the resolved product with the SAME idempotency key so the
      // operator can retry safely instead of rescanning.
      setPhase('resolved');
    }
  }

  const busy = phase === 'looking_up' || phase === 'submitting';

  return (
    <div className="rounded-card-lg border border-border bg-surface p-5 shadow-card">
      <div className="text-[15px] font-semibold text-text-primary">Scan to consume</div>
      <p className="mt-0.5 text-[13px] text-text-secondary">
        Point a USB or Bluetooth scanner at this field — or type a barcode — to record salon use at{' '}
        {locationName || 'the selected location'}. Every scan lands in the movement ledger.
      </p>

      <div className="mt-4 space-y-3">
        <label className="block">
          <span className="mb-1.5 block text-[12px] font-medium text-text-secondary">Barcode</span>
          <input
            ref={scanInputRef}
            value={barcodeInput}
            onChange={(event) => setBarcodeInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                void handleLookup();
              }
            }}
            placeholder="Scan or type a barcode, then Enter"
            disabled={busy || phase === 'resolved'}
            inputMode="text"
            autoComplete="off"
            spellCheck={false}
            aria-label="Barcode"
            className="h-11 w-full rounded-input-lg border border-border-strong bg-surface px-3 font-mono text-[14px] outline-none focus:border-primary disabled:opacity-60"
          />
        </label>

        {phase === 'looking_up' ? (
          <p className="text-[13px] text-text-secondary" role="status">
            Looking up…
          </p>
        ) : null}

        {resolved ? (
          <div className="rounded-input-lg border border-border bg-surface-alt p-3">
            <div className="flex items-baseline justify-between gap-3">
              <div>
                <div className="font-medium text-text-primary">{resolved.productName}</div>
                <div className="text-[12px] text-text-muted">
                  {[resolved.brand, resolved.sku, resolved.barcode].filter(Boolean).join(' · ')}
                </div>
              </div>
              <div className="text-right text-[12px] text-text-secondary">
                On hand
                <div className="text-[14px] font-semibold tabular-nums text-text-primary">
                  {resolved.stockUnit === 'unit'
                    ? `${resolved.quantityOnHandGrams} items`
                    : `${resolved.quantityOnHandGrams}${resolved.stockUnit === 'millilitre' ? 'ml' : 'g'}`}
                </div>
              </div>
            </div>

            <div className="mt-3 flex flex-wrap items-end gap-2">
              <label className="block">
                <span className="mb-1 block text-[12px] font-medium text-text-secondary">
                  Quantity ({consumptionUnitLabel(resolved, unit)})
                </span>
                <input
                  ref={quantityInputRef}
                  value={quantity}
                  onChange={(event) => setQuantity(event.target.value.replace(/[^0-9.]/g, ''))}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      void handleConfirm();
                    }
                    if (event.key === 'Escape') resetToIdle(true);
                  }}
                  inputMode="decimal"
                  aria-label="Quantity to consume"
                  className="h-10 w-28 rounded-input-lg border border-border-strong bg-surface px-3 text-[14px] outline-none focus:border-primary"
                />
              </label>
              {resolved.stockUnit !== 'unit' ? (
                <select
                  value={unit}
                  onChange={(event) => setUnit(event.target.value as ConsumptionUnit)}
                  aria-label="Quantity unit"
                  className="h-10 rounded-input-lg border border-border-strong bg-surface px-3 text-[13px] outline-none focus:border-primary"
                >
                  <option value="pack">{consumptionUnitLabel(resolved, 'pack')}</option>
                  <option value="base">{consumptionUnitLabel(resolved, 'base')}</option>
                </select>
              ) : null}
              <button
                type="button"
                onClick={() => void handleConfirm()}
                disabled={phase === 'submitting'}
                className="h-10 rounded-pill bg-primary px-5 text-[13px] font-semibold text-text-on-primary transition hover:bg-primary-deep disabled:opacity-50"
              >
                {phase === 'submitting' ? 'Recording…' : 'Consume (Enter)'}
              </button>
              <button
                type="button"
                onClick={() => resetToIdle(true)}
                disabled={phase === 'submitting'}
                className="h-10 rounded-pill border border-border-strong px-4 text-[13px] font-medium text-text-secondary transition hover:bg-surface-alt disabled:opacity-50"
              >
                Cancel (Esc)
              </button>
            </div>
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

        {success ? (
          <div
            role="status"
            className="rounded-input-lg border border-success-border bg-success-soft px-3 py-2.5 text-[13px] text-success"
          >
            {success}
          </div>
        ) : null}
      </div>
    </div>
  );
}
