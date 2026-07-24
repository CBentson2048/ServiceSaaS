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
            </div>
            <StatusBadge
              label={isPaid ? 'Paid' : 'Awaiting payment'}
              tone={isPaid ? 'success' : 'warning'}
            />
          </div>

          <ItemisedBill billing={bill.billing} />

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
