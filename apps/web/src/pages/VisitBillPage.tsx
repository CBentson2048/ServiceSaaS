import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { VisitBillResponse } from '@sheer/domain';
import { AppCard, StatusBadge } from '../design';
import { ApiRequestError, getVisitBill } from '../auth/api';
import { useAuth } from '../auth/AuthProvider';
import { BillPayments, ItemisedBill, formatMoney } from '../components/bookings/ItemisedBill';

// The retrievable bill for a settled (or settling) visit — the same itemised
// breakdown the till showed at checkout plus every payment taken, reachable
// again any time from the appointment book's "View bill" link and the CRM's
// visit history. This is the page `checkout.route` has always pointed at.
export function VisitBillPage() {
  const { visitId } = useParams<{ visitId: string }>();
  const auth = useAuth();
  const accessToken = auth.session?.accessToken;

  const [bill, setBill] = useState<VisitBillResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!accessToken || !visitId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    getVisitBill(accessToken, visitId)
      .then((result) => {
        if (!cancelled) setBill(result);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof ApiRequestError) setError(err.message);
        else if (err instanceof Error) setError(err.message);
        else setError('Could not load the bill');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [accessToken, visitId]);

  const isPaid = bill?.checkout.status === 'paid';
  const paidTotalCents = (bill?.payments ?? []).reduce((sum, payment) => sum + payment.amountCents, 0);

  // VAT breakdown for staff (this page is owner/manager-gated). Client-facing
  // line items stay all-in by design; this block reveals how much of the total
  // is tax. The STORED bill is authoritative when present — its per-line rate
  // was frozen at settlement, so later tax changes never rewrite history; a
  // not-yet-settled visit falls back to the live rollup.
  const vat = (() => {
    const stored = bill?.bill;
    if (stored && stored.taxCents > 0) {
      return {
        label: stored.taxLabel?.trim() || 'VAT',
        ratePercent: stored.taxRatePercent,
        netCents: stored.netCents,
        taxCents: stored.taxCents,
        grossCents: stored.grossCents,
        currencyCode: stored.currencyCode,
      };
    }
    const live = bill?.billing.tax;
    if (live && live.enabled && live.taxCents > 0) {
      return {
        label: live.label?.trim() || 'VAT',
        ratePercent: live.ratePercent,
        netCents: live.netCents,
        taxCents: live.taxCents,
        grossCents: live.grossCents,
        currencyCode: bill!.billing.currencyCode,
      };
    }
    return null;
  })();

  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-6 lg:px-8">
      <nav className="mb-4 text-[12px] text-text-secondary">
        <Link to="/bookings" className="hover:text-text-primary">
          Appointment book
        </Link>
        <span className="mx-1.5">/</span>
        <span className="text-text-primary">Bill</span>
      </nav>

      {loading ? (
        <AppCard padding="lg" className="rounded-card-lg text-[13px] text-text-secondary">
          Loading bill…
        </AppCard>
      ) : error ? (
        <div className="rounded-input-lg border border-danger-border bg-danger-soft px-4 py-3 text-[13px] text-danger">
          {error}
        </div>
      ) : bill ? (
        <AppCard elevation="hero" padding="lg" className="rounded-card-lg">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0">
              <div className="text-[15px] font-semibold text-text-primary">
                {bill.appointment.clientDisplayName}
              </div>
              <div className="mt-1 text-[13px] text-text-secondary">
                {bill.visit.serviceSummary ?? 'Service visit'} · {formatVisitDate(bill.visit.occurredAt)}
              </div>
              {bill.bill ? (
                // The permanent record: this bill is frozen as it was settled
                // and can be referenced by its number on the phone or in the books.
                <div className="mt-1 text-[12px] font-medium text-text-secondary">
                  Bill #{formatBillNumber(bill.bill.billNumber)}
                  <span className="mx-1.5 text-text-muted">·</span>
                  <span className="text-text-muted">
                    Recorded {formatVisitDate(bill.bill.occurredAt)}
                  </span>
                </div>
              ) : null}
            </div>
            <StatusBadge
              label={isPaid ? 'Paid' : 'Awaiting payment'}
              tone={isPaid ? 'success' : 'warning'}
            />
          </div>

          <ItemisedBill billing={bill.billing} />

          {vat ? (
            <div className="mt-4 rounded-input-lg border border-border bg-surface-alt/40 px-5 py-3">
              <p className="mb-2 text-[11px] font-medium uppercase tracking-[0.08em] text-text-muted">
                Tax breakdown
              </p>
              <div className="flex items-center justify-between text-[12px] text-text-secondary">
                <span>Net (excl. {vat.label})</span>
                <span className="tabular-nums">{formatMoney(vat.netCents, vat.currencyCode)}</span>
              </div>
              <div className="mt-1 flex items-center justify-between text-[12px] text-text-secondary">
                <span>
                  {vat.label} ({formatRate(vat.ratePercent)})
                </span>
                <span className="tabular-nums">{formatMoney(vat.taxCents, vat.currencyCode)}</span>
              </div>
              <div className="mt-1.5 flex items-center justify-between border-t border-border-divider pt-1.5 text-[13px]">
                <span className="font-medium text-text-secondary">Total (incl. {vat.label})</span>
                <span className="font-semibold text-text-primary tabular-nums">
                  {formatMoney(vat.grossCents, vat.currencyCode)}
                </span>
              </div>
            </div>
          ) : null}

          <BillPayments payments={bill.payments} />

          {bill.payments.length > 0 ? (
            <div className="mt-3 flex items-center justify-between gap-3 px-5 text-[13px]">
              <span className="font-medium text-text-secondary">Total paid</span>
              <span className="font-semibold text-text-primary tabular-nums">
                {formatMoney(paidTotalCents, bill.payments[0].currencyCode)}
              </span>
            </div>
          ) : (
            <div className="mt-4 rounded-input-lg border border-border bg-surface-alt/40 px-5 py-4 text-[13px] text-text-secondary">
              No in-salon payment has been taken for this visit yet.
            </div>
          )}
        </AppCard>
      ) : null}
    </div>
  );
}

function formatVisitDate(occurredAt: string): string {
  const date = new Date(occurredAt);
  if (Number.isNaN(date.getTime())) return occurredAt;
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'full', timeStyle: 'short' }).format(date);
}

function formatBillNumber(billNumber: number): string {
  return String(billNumber).padStart(6, '0');
}

function formatRate(ratePercent: number): string {
  const rate = Number(ratePercent);
  if (!Number.isFinite(rate)) return `${ratePercent}%`;
  return `${Number.isInteger(rate) ? rate : rate.toFixed(2)}%`;
}
