import { useCallback, useEffect, useMemo, useState } from 'react';
import type { InventoryProduct, RetailPaymentMethod, StaffMember } from '@sheer/domain';
import { AppButton, AppText } from '../../design';
import { Modal } from '../team/Modal';
import { formatMoney } from '../kpi/format';
import { useAuth } from '../../auth/AuthProvider';
import {
  ApiRequestError,
  listInventoryProducts,
  listStaff,
  recordRetailSale,
} from '../../auth/api';

const INPUT_CLASSES =
  'w-full rounded-input-lg border border-border-strong bg-surface px-3.5 py-2.5 text-[14px] text-text-primary outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20 disabled:cursor-not-allowed disabled:bg-surface-alt';

const LABEL_CLASSES =
  'mb-1.5 block text-[12px] font-semibold uppercase tracking-[0.12em] text-text-secondary';

const PAYMENT_METHODS: { value: RetailPaymentMethod; label: string }[] = [
  { value: 'cash', label: 'Cash' },
  { value: 'card_reader', label: 'Card reader' },
  { value: 'other', label: 'Other' },
];

/** "12.5" / "12.50" / "12" → integer cents; null when unparseable/negative. */
function poundsToCents(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^\d+(\.\d{0,2})?$/.test(trimmed)) return null;
  const pounds = Number(trimmed);
  if (!Number.isFinite(pounds) || pounds < 0) return null;
  return Math.round(pounds * 100);
}

/**
 * Till panel: records one stylist-attributed retail sale. The selling stylist
 * is REQUIRED here even though the API allows desk sales without one — payroll
 * can only credit retail commission to attributed sales, so an unattributed
 * sale silently vanishes from every stylist's retail KPI.
 *
 * Only active products WITH a configured retail price are selectable; the unit
 * price prefills from the product (per unit) and stays editable for till-side
 * discounts. Pounds are converted to integer cents only at the payload edge.
 */
export function RecordRetailSaleModal({
  defaultLocationId,
  onClose,
  onRecorded,
}: {
  /** Preselected location (e.g. the sidebar scope); falls back to the first. */
  defaultLocationId?: string;
  onClose: () => void;
  /** Fired after EVERY successful record so the caller can refresh its list. */
  onRecorded: () => void;
}) {
  const auth = useAuth();
  const accessToken = auth.session?.accessToken;
  const locations = auth.user?.locations ?? [];

  const [products, setProducts] = useState<InventoryProduct[]>([]);
  const [staff, setStaff] = useState<StaffMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [locationId, setLocationId] = useState(() => {
    if (defaultLocationId && locations.some((location) => location.id === defaultLocationId)) {
      return defaultLocationId;
    }
    return locations[0]?.id ?? '';
  });
  const [productId, setProductId] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [staffProfileId, setStaffProfileId] = useState('');
  const [paymentMethod, setPaymentMethod] = useState<RetailPaymentMethod>('card_reader');
  const [unitPrice, setUnitPrice] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recordedMessage, setRecordedMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!accessToken) return;
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    Promise.all([listInventoryProducts(accessToken), listStaff(accessToken)])
      .then(([productsRes, staffRes]) => {
        if (cancelled) return;
        setProducts(productsRes.products.filter((product) => product.isActive));
        setStaff(
          staffRes.staff.filter(
            (member) => member.staffProfile && member.membershipStatus === 'active',
          ),
        );
      })
      .catch((err) => {
        if (!cancelled) {
          setLoadError(
            err instanceof ApiRequestError ? err.message : 'Unable to load products and staff',
          );
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [accessToken]);

  // Split the stylist list by the SELECTED location: attribution is almost
  // always someone working this salon, but cover shifts across locations are
  // legitimate, so nobody is hidden — just grouped.
  const staffAtLocation = useMemo(
    () =>
      staff.filter((member) =>
        (member.locations ?? (member.location ? [member.location] : [])).some(
          (memberLocation) => memberLocation.id === locationId,
        ),
      ),
    [staff, locationId],
  );
  const staffElsewhere = useMemo(
    () => staff.filter((member) => !staffAtLocation.includes(member)),
    [staff, staffAtLocation],
  );

  const selectedProduct = useMemo(
    () => products.find((product) => product.id === productId) ?? null,
    [products, productId],
  );

  const handleProductChange = useCallback(
    (nextProductId: string) => {
      setProductId(nextProductId);
      const product = products.find((candidate) => candidate.id === nextProductId);
      // Prefill the PER-UNIT price from the product's configured retail price.
      setUnitPrice(
        product?.retailPriceCents !== undefined ? (product.retailPriceCents / 100).toFixed(2) : '',
      );
    },
    [products],
  );

  const quantityValue = /^\d+$/.test(quantity.trim()) ? Number(quantity.trim()) : null;
  const unitPriceCents = poundsToCents(unitPrice);
  const totalCents =
    quantityValue !== null && quantityValue >= 1 && unitPriceCents !== null
      ? quantityValue * unitPriceCents
      : null;

  const canSubmit =
    !loading &&
    Boolean(locationId) &&
    Boolean(productId) &&
    Boolean(staffProfileId) &&
    quantityValue !== null &&
    quantityValue >= 1 &&
    unitPriceCents !== null;

  const handleSubmit = useCallback(async () => {
    if (!accessToken || !canSubmit || quantityValue === null || unitPriceCents === null) return;
    setSubmitting(true);
    setError(null);
    setRecordedMessage(null);
    try {
      const response = await recordRetailSale(accessToken, {
        locationId,
        productId,
        staffProfileId,
        quantity: quantityValue,
        unitPriceCents,
        paymentMethod,
      });
      onRecorded();
      const { sale } = response;
      setRecordedMessage(
        `Recorded ${sale.quantity} × ${sale.productName ?? selectedProduct?.name ?? 'product'} — ${formatMoney(
          sale.totalAmountCents,
          sale.currencyCode,
        )}.`,
      );
      // Reset for the next sale. The stylist resets too: attribution must be a
      // deliberate choice per sale, not an accidental carry-over.
      setProductId('');
      setQuantity('1');
      setStaffProfileId('');
      setUnitPrice('');
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Unable to record the sale');
    } finally {
      setSubmitting(false);
    }
  }, [
    accessToken,
    canSubmit,
    quantityValue,
    unitPriceCents,
    locationId,
    productId,
    staffProfileId,
    paymentMethod,
    selectedProduct,
    onRecorded,
  ]);

  return (
    <Modal
      open
      onClose={onClose}
      title="Record retail sale"
      description="Attributed sales feed the stylist's retail KPI and commission."
      footer={
        <>
          <AppButton size="sm" variant="ghost" onClick={onClose} disabled={submitting}>
            {recordedMessage ? 'Done' : 'Cancel'}
          </AppButton>
          <AppButton
            size="sm"
            onClick={() => void handleSubmit()}
            loading={submitting}
            disabled={!canSubmit}
          >
            Record sale
          </AppButton>
        </>
      }
    >
      <div className="space-y-4">
        {recordedMessage ? (
          <div className="rounded-input-lg border border-success-border bg-success-soft px-3 py-2.5">
            <AppText as="div" variant="caption" tone="success">
              {recordedMessage} Record another below, or Done to close.
            </AppText>
          </div>
        ) : null}

        {error ? (
          <div className="rounded-input-lg border border-danger-border bg-danger-soft px-3 py-2.5 text-[13px] text-danger">
            {error}
          </div>
        ) : null}

        {loadError ? (
          <div className="rounded-input-lg border border-danger-border bg-danger-soft px-3 py-2.5 text-[13px] text-danger">
            {loadError}
          </div>
        ) : null}

        {loading ? (
          <div className="rounded-input-lg border border-border bg-surface-alt px-3 py-6 text-center text-[13px] text-text-secondary">
            Loading products and staff…
          </div>
        ) : (
          <>
            <label className="block">
              <span className={LABEL_CLASSES}>Location</span>
              <select
                className={INPUT_CLASSES}
                value={locationId}
                onChange={(event) => setLocationId(event.target.value)}
              >
                {locations.length === 0 ? (
                  <option value="" disabled>
                    No locations available
                  </option>
                ) : null}
                {locations.map((location) => (
                  <option key={location.id} value={location.id}>
                    {location.name}
                  </option>
                ))}
              </select>
            </label>

            <label className="block">
              <span className={LABEL_CLASSES}>Product</span>
              <select
                className={INPUT_CLASSES}
                value={productId}
                onChange={(event) => handleProductChange(event.target.value)}
              >
                <option value="" disabled>
                  Pick a product
                </option>
                {products.map((product) => {
                  const hasRetailPrice = product.retailPriceCents !== undefined;
                  const nameWithBrand = product.brand
                    ? `${product.name} — ${product.brand}`
                    : product.name;
                  return (
                    <option key={product.id} value={product.id} disabled={!hasRetailPrice}>
                      {hasRetailPrice
                        ? `${nameWithBrand} — ${formatMoney(product.retailPriceCents ?? 0, 'GBP')}`
                        : `${nameWithBrand} (no retail price set)`}
                    </option>
                  );
                })}
              </select>
              {products.length === 0 ? (
                <span className="mt-1.5 block text-[12px] text-text-secondary">
                  No active products. Add products with a retail price under Product management.
                </span>
              ) : null}
            </label>

            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className={LABEL_CLASSES}>Quantity</span>
                <input
                  type="number"
                  min={1}
                  step={1}
                  className={INPUT_CLASSES}
                  value={quantity}
                  onChange={(event) => setQuantity(event.target.value)}
                />
              </label>
              <label className="block">
                <span className={LABEL_CLASSES}>Unit price £</span>
                <input
                  type="text"
                  inputMode="decimal"
                  placeholder="0.00"
                  className={INPUT_CLASSES}
                  value={unitPrice}
                  onChange={(event) => setUnitPrice(event.target.value)}
                />
              </label>
            </div>

            <label className="block">
              <span className={LABEL_CLASSES}>Selling stylist</span>
              <select
                className={INPUT_CLASSES}
                value={staffProfileId}
                onChange={(event) => setStaffProfileId(event.target.value)}
              >
                <option value="" disabled>
                  Pick the selling stylist
                </option>
                {/* Staff at the selected location first: attribution is almost
                    always someone working THIS salon today. Others remain
                    selectable (cover shifts are real) but clearly separated. */}
                <optgroup label="At this location">
                  {staffAtLocation.map((member) => (
                    <option key={member.staffProfile?.id} value={member.staffProfile?.id}>
                      {member.staffProfile?.displayName || member.fullName}
                    </option>
                  ))}
                </optgroup>
                {staffElsewhere.length > 0 ? (
                  <optgroup label="Other locations (cover shifts)">
                    {staffElsewhere.map((member) => (
                      <option key={member.staffProfile?.id} value={member.staffProfile?.id}>
                        {member.staffProfile?.displayName || member.fullName}
                        {member.location ? ` — ${member.location.name}` : ''}
                      </option>
                    ))}
                  </optgroup>
                ) : null}
              </select>
              <span className="mt-1.5 block text-[12px] text-text-secondary">
                Required — payroll can only credit retail commission to attributed sales.
              </span>
            </label>

            <label className="block">
              <span className={LABEL_CLASSES}>Payment method</span>
              <select
                className={INPUT_CLASSES}
                value={paymentMethod}
                onChange={(event) => setPaymentMethod(event.target.value as RetailPaymentMethod)}
              >
                {PAYMENT_METHODS.map((method) => (
                  <option key={method.value} value={method.value}>
                    {method.label}
                  </option>
                ))}
              </select>
            </label>

            <div className="rounded-input-lg border border-border bg-surface-alt px-3.5 py-2.5">
              <AppText as="div" weight="medium" className="text-[14px]">
                Total: {totalCents !== null ? formatMoney(totalCents, 'GBP') : '—'}
              </AppText>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
