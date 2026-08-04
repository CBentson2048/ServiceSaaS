import { useCallback, useEffect, useMemo, useState } from 'react';
import { Navigate } from 'react-router-dom';
import type { RetailPaymentMethod, RetailSale } from '@sheer/domain';
import { userHasPermission } from '@sheer/domain';
import { AppButton, AppCard, AppText } from '../design';
import { SectionLabel } from '../components/dashboard/SectionLabel';
import { formatMoney } from '../components/kpi/format';
import { formatTimestamp } from '../components/payroll/format';
import { RecordRetailSaleModal } from '../components/payroll/RecordRetailSaleModal';
import { useAuth } from '../auth/AuthProvider';
import { useLocationScope } from '../components/LocationScopeContext';
import { ApiRequestError, listRetailSales, listStaff } from '../auth/api';

const COLS = '1.3fr 1.8fr 0.5fr 0.8fr 0.8fr 1.2fr 0.9fr';

const PAYMENT_METHOD_LABELS: Record<RetailPaymentMethod, string> = {
  cash: 'Cash',
  card_reader: 'Card reader',
  other: 'Other',
};

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Retail till page — the capture surface that feeds the retail KPI and retail
 * commission. Listing follows the shared sidebar location scope ("All"
 * aggregates every accessible location). Recording needs retail.record;
 * viewing the sales list additionally needs report.financials.view (the API
 * enforces both), so a recorder without report access still gets the button.
 */
export function RetailSalesPage() {
  const auth = useAuth();
  const accessToken = auth.session?.accessToken;
  const canRecord = userHasPermission(auth.user, 'retail.record');
  const canViewList = userHasPermission(auth.user, 'report.financials.view');
  const { selectedLocationId, isAllLocations } = useLocationScope();

  const [sales, setSales] = useState<RetailSale[]>([]);
  const [totalAmountCents, setTotalAmountCents] = useState(0);
  const [currencyCode, setCurrencyCode] = useState('GBP');
  // staffProfileId → display name, for the stylist column. Best-effort: a
  // failure here must not take down the sales list itself.
  const [staffNames, setStaffNames] = useState<Map<string, string>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);

  const load = useCallback(async () => {
    if (!accessToken || !canViewList) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const from = new Date(Date.now() - THIRTY_DAYS_MS).toISOString();
      const res = await listRetailSales(accessToken, {
        locationId: isAllLocations ? undefined : selectedLocationId,
        from,
      });
      setSales(res.sales);
      setTotalAmountCents(res.totalAmountCents);
      setCurrencyCode(res.currencyCode);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Unable to load retail sales');
    } finally {
      setLoading(false);
    }
  }, [accessToken, canViewList, isAllLocations, selectedLocationId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!accessToken || !canViewList) return;
    let cancelled = false;
    listStaff(accessToken)
      .then((res) => {
        if (cancelled) return;
        const names = new Map<string, string>();
        for (const member of res.staff) {
          if (member.staffProfile) {
            names.set(member.staffProfile.id, member.staffProfile.displayName || member.fullName);
          }
        }
        setStaffNames(names);
      })
      .catch(() => {
        // Names are decoration on top of the sale records; ids still render.
      });
    return () => {
      cancelled = true;
    };
  }, [accessToken, canViewList]);

  const stylistLabel = useMemo(
    () => (sale: RetailSale) =>
      sale.staffProfileId ? (staffNames.get(sale.staffProfileId) ?? 'Unknown') : 'Unattributed',
    [staffNames],
  );

  if (auth.user && !canRecord) {
    return <Navigate to="/dashboard" replace />;
  }

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6 lg:px-8">
      <header className="mb-6 flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <AppText as="h1" variant="heading" weight="medium">
            Retail sales
          </AppText>
          <AppText as="p" variant="caption" tone="muted" className="mt-1">
            Product sales at the till — attributed sales feed each stylist's retail commission.
          </AppText>
        </div>
        {canRecord ? (
          <AppButton size="sm" onClick={() => setRecording(true)}>
            Record sale
          </AppButton>
        ) : null}
      </header>

      {error ? (
        <div className="mb-4 rounded-input-lg border border-danger-border bg-danger-soft px-4 py-3 text-[13px] text-danger">
          {error}
        </div>
      ) : null}

      {!canViewList ? (
        <div className="rounded-input-lg border border-border bg-surface-alt px-4 py-10 text-center text-[13px] text-text-secondary">
          You can record sales, but viewing the sales list needs the financial reports permission.
        </div>
      ) : loading ? (
        <div className="rounded-input-lg border border-border bg-surface-alt px-4 py-10 text-center text-[13px] text-text-secondary">
          Loading retail sales…
        </div>
      ) : sales.length === 0 ? (
        <div className="rounded-input-lg border border-dashed border-border-strong bg-surface px-4 py-10 text-center text-[13px] text-text-secondary">
          No retail sales recorded yet. Record the first sale to start feeding retail commission.
        </div>
      ) : (
        <>
          <div className="mb-2 flex items-baseline justify-between">
            <SectionLabel>Last 30 days</SectionLabel>
            <AppText as="div" variant="caption" tone="muted">
              Total: {formatMoney(totalAmountCents, currencyCode)}
            </AppText>
          </div>
          <AppCard padding="none" elevation="none" className="overflow-hidden border-[1.5px]">
            <div
              className="grid items-center bg-surface-alt px-4 py-2.5"
              style={{ gridTemplateColumns: COLS }}
            >
              {['Date', 'Product', 'Qty', 'Unit price', 'Total', 'Stylist', 'Payment'].map(
                (heading) => (
                  <AppText
                    key={heading}
                    as="div"
                    variant="micro"
                    weight="medium"
                    uppercase
                    className="text-text-subtle"
                  >
                    {heading}
                  </AppText>
                ),
              )}
            </div>

            {sales.map((sale) => (
              <div
                key={sale.id}
                className="grid items-center border-t border-border-divider bg-surface px-4 py-3"
                style={{ gridTemplateColumns: COLS }}
              >
                <AppText as="div" className="text-[13px]">
                  {formatTimestamp(sale.soldAt)}
                </AppText>
                <AppText as="div" weight="medium" className="truncate pr-2 text-[13px]">
                  {sale.productName ?? '—'}
                </AppText>
                <AppText as="div" className="text-[13px]">
                  {sale.quantity}
                </AppText>
                <AppText as="div" className="text-[13px]">
                  {formatMoney(sale.unitPriceCents, sale.currencyCode)}
                </AppText>
                <AppText as="div" weight="medium" className="text-[13px]">
                  {formatMoney(sale.totalAmountCents, sale.currencyCode)}
                </AppText>
                <AppText
                  as="div"
                  tone={sale.staffProfileId ? 'primary' : 'muted'}
                  className="truncate pr-2 text-[13px]"
                >
                  {stylistLabel(sale)}
                </AppText>
                <AppText as="div" tone="secondary" className="text-[13px]">
                  {sale.paymentMethod ? PAYMENT_METHOD_LABELS[sale.paymentMethod] : '—'}
                </AppText>
              </div>
            ))}
          </AppCard>
        </>
      )}

      {recording ? (
        <RecordRetailSaleModal
          defaultLocationId={isAllLocations ? undefined : selectedLocationId}
          onClose={() => setRecording(false)}
          onRecorded={() => void load()}
        />
      ) : null}
    </div>
  );
}
