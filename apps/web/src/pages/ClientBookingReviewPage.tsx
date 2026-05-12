import { useMemo, useState } from 'react';
import { Elements, PaymentElement, useElements, useStripe } from '@stripe/react-stripe-js';
import { loadStripe } from '@stripe/stripe-js';
import { Navigate, useNavigate } from 'react-router-dom';
import {
  ApiRequestError,
  getPublicBookingAttempt,
  startPublicBookingCheckout,
} from '../auth/api';
import { AppButton, AppCard } from '../design';
import { ClientBookingShell } from './ClientBookingShell';
import { readClientBookingSelection, updateClientBookingSelection } from './clientBookingFlow';
import type {
  ClientBookingSelection,
  PublicBookingAttemptSummary,
  StartPublicBookingCheckoutResponse,
} from '@sheer/domain';

const stripePromise = loadStripe(import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY ?? '');

type CompleteReviewSelection = ClientBookingSelection &
  Required<
    Pick<
      ClientBookingSelection,
      'selectedSlot' | 'client' | 'account' | 'communicationPreference' | 'location' | 'service'
    >
  >;

export function ClientBookingReviewPage() {
  const selection = readClientBookingSelection();
  const [checkout, setCheckout] = useState<StartPublicBookingCheckoutResponse | null>(() =>
    selection?.bookingAttempt && selection.paymentClientSecret
      ? {
          bookingAttempt: selection.bookingAttempt,
          bookingAttemptId: selection.bookingAttempt.id,
          clientSecret: selection.paymentClientSecret,
          depositAmount: selection.bookingAttempt.depositAmount,
          currencyCode: selection.bookingAttempt.currencyCode,
        }
      : null,
  );
  const [startingCheckout, setStartingCheckout] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const stripeOptions = useMemo(
    () => (checkout ? { clientSecret: checkout.clientSecret } : undefined),
    [checkout],
  );
  if (!isCompleteReviewSelection(selection)) {
    return <Navigate to={nextIncompleteReviewStep(selection)} replace />;
  }
  const currentSelection = selection;

  async function startCheckout() {
    if (!currentSelection.staffProfileId) return;
    if (!import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY) {
      setError('Stripe publishable key is not configured.');
      return;
    }
    setStartingCheckout(true);
    setError(null);
    try {
      const result = await startPublicBookingCheckout({
        locationId: currentSelection.locationId,
        serviceId: currentSelection.serviceId,
        staffProfileId: currentSelection.staffProfileId,
        selectedStartAt: currentSelection.selectedSlot.startAt,
        staffRequestMode: currentSelection.staffRequestMode,
        client: currentSelection.client,
        communicationPreference: currentSelection.communicationPreference,
        clientProfileId: currentSelection.account.clientProfileId,
        bookedByUserProfileId: currentSelection.account.userProfileId,
      });
      setCheckout(result);
      updateClientBookingSelection({
        bookingAttempt: result.bookingAttempt,
        bookingAttemptId: result.bookingAttemptId,
        paymentClientSecret: result.clientSecret,
      });
    } catch (err) {
      setError(toErrorMessage(err));
    } finally {
      setStartingCheckout(false);
    }
  }

  return (
    <ClientBookingShell
      title="Review"
      step="Step 5 of 5"
      footer={
        checkout && stripeOptions ? null : (
          <AppButton
            size="lg"
            fullWidth
            loading={startingCheckout}
            onClick={() => void startCheckout()}
            className="min-h-12 bg-[#1C1628] text-white hover:bg-[#2A2139]"
          >
            Continue to payment
          </AppButton>
        )
      }
    >
      <h1 className="text-[18px] font-semibold leading-6">Review and pay deposit</h1>
      <p className="mt-1 text-[12px] text-text-secondary">
        We will re-check this slot before taking your deposit. Your appointment is confirmed only after payment succeeds.
      </p>
      {error ? <div className="mt-4 rounded-input-lg border border-danger-border bg-danger-soft px-3 py-2 text-[13px] text-danger">{error}</div> : null}
      <AppCard className="mt-5">
        <div className="grid gap-x-6 md:grid-cols-2">
        <Summary label="Location" value={currentSelection.location.name} />
        <Summary label="Service" value={currentSelection.service.name} />
        <Summary label="When" value={`${formatDate(currentSelection.selectedSlot.startAt)} at ${formatTime(currentSelection.selectedSlot.startAt)}`} />
        <Summary label="Stylist" value={currentSelection.selectedSlot.stylistName} />
        <Summary label="Contact" value={`${currentSelection.client.firstName} ${currentSelection.client.lastName}`} />
        <Summary label="Preference" value={formatPreference(currentSelection.communicationPreference)} />
        <Summary label="Account" value={currentSelection.account.email} />
        <Summary label="Phone" value={currentSelection.client.phone || 'Not provided'} />
        </div>
      </AppCard>
      <AppCard className="mt-4 border-primary/30 bg-primary/5">
        <div className="text-[13px] font-semibold">Deposit</div>
        <div className="mt-1 text-[12px] text-text-secondary">
          {formatDeposit(currentSelection.service.depositRequiredAmount, currentSelection.location.currencyCode)}
        </div>
        <div className="mt-2 text-[12px] text-text-secondary">
          Your card is charged by Stripe. If payment fails or is cancelled, no confirmed appointment is created.
        </div>
        {currentSelection.location.cancellationNoticeHours !== undefined ? (
          <div className="mt-3 rounded-input-lg bg-surface px-3 py-2 text-[12px] text-text-secondary">
            {formatCancellationNotice(currentSelection.location.cancellationNoticeHours)}
          </div>
        ) : null}
      </AppCard>
      {checkout && stripeOptions ? (
        <Elements stripe={stripePromise} options={stripeOptions}>
          <PaymentForm bookingAttempt={checkout.bookingAttempt} />
        </Elements>
      ) : null}
    </ClientBookingShell>
  );
}

function PaymentForm({ bookingAttempt }: { bookingAttempt: PublicBookingAttemptSummary }) {
  const navigate = useNavigate();
  const stripe = useStripe();
  const elements = useElements();
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function submitPayment() {
    if (!stripe || !elements) return;
    setSubmitting(true);
    setMessage(null);
    try {
      const result = await stripe.confirmPayment({
        elements,
        redirect: 'if_required',
      });
      if (result.error) {
        setMessage(result.error.message ?? 'Payment could not be completed.');
        return;
      }

      const confirmedAttempt =
        bookingAttempt.status === 'confirmed' && bookingAttempt.appointment
          ? bookingAttempt
          : await waitForConfirmedAttempt(bookingAttempt.id);
      updateClientBookingSelection({
        bookingAttempt: confirmedAttempt,
        bookingAttemptId: confirmedAttempt.id,
        appointment: confirmedAttempt.appointment,
      });
      navigate('/book/success');
    } catch (err) {
      setMessage(toErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AppCard className="mt-4">
      <div className="text-[14px] font-semibold">Payment</div>
      <p className="mt-1 text-[12px] text-text-secondary">
        Pay {formatDeposit(bookingAttempt.depositAmount, bookingAttempt.currencyCode)} to confirm this booking.
      </p>
      <div className="mt-4">
        <PaymentElement />
      </div>
      {message ? (
        <div className="mt-4 rounded-input-lg border border-danger-border bg-danger-soft px-3 py-2 text-[13px] text-danger">
          {message}
        </div>
      ) : null}
      <AppButton
        size="lg"
        fullWidth
        loading={submitting}
        disabled={!stripe || !elements}
        onClick={() => void submitPayment()}
        className="mt-4 min-h-12 bg-[#1C1628] text-white hover:bg-[#2A2139]"
      >
        Pay deposit and confirm
      </AppButton>
    </AppCard>
  );
}

async function waitForConfirmedAttempt(attemptId: string): Promise<PublicBookingAttemptSummary> {
  for (let i = 0; i < 10; i += 1) {
    const result = await getPublicBookingAttempt(attemptId);
    if (result.bookingAttempt.status === 'confirmed' && result.bookingAttempt.appointment) {
      return result.bookingAttempt;
    }
    if (result.bookingAttempt.status === 'payment_failed') {
      throw new Error('Payment failed, so the booking was not confirmed.');
    }
    await delay(1000);
  }
  throw new Error('Payment was received, but confirmation is still processing. Please refresh the success page shortly.');
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function Summary({ label, value }: { label: string; value: string }) {
  return (
    <div className="border-b border-border py-2 last:border-0">
      <div className="text-[11px] uppercase tracking-wide text-text-muted">{label}</div>
      <div className="mt-1 text-[13px] font-medium">{value}</div>
    </div>
  );
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function formatPreference(value: string): string {
  if (value === 'whatsapp') return 'WhatsApp';
  if (value === 'sms') return 'SMS';
  return 'Email';
}

function formatDeposit(amount: number | undefined, currencyCode: string): string {
  if (!amount || amount <= 0) {
    return 'No deposit is configured for this service yet.';
  }
  return `${new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: currencyCode,
  }).format(amount)} deposit required.`;
}

function formatCancellationNotice(hours: number): string {
  if (hours === 0) return 'Cancellation notice is not configured for this location.';
  if (hours % 24 === 0) {
    const days = hours / 24;
    return `Please give at least ${days} day${days === 1 ? '' : 's'} notice for cancellations.`;
  }
  return `Please give at least ${hours} hour${hours === 1 ? '' : 's'} notice for cancellations.`;
}

function toErrorMessage(err: unknown): string {
  if (err instanceof ApiRequestError) return err.message;
  if (err instanceof Error) return err.message;
  return 'Could not create booking';
}

function isCompleteReviewSelection(selection: ClientBookingSelection | null): selection is CompleteReviewSelection {
  return Boolean(
    selection?.selectedSlot &&
      selection.client &&
      selection.account &&
      selection.communicationPreference &&
      selection.location &&
      selection.service,
  );
}

function nextIncompleteReviewStep(selection: ClientBookingSelection | null): string {
  if (!selection?.selectedSlot) return '/book/date-time';
  if (!selection.client || !selection.account) return '/login?booking=1';
  if (!selection.communicationPreference) return '/book/preference';
  return '/login?booking=1';
}
