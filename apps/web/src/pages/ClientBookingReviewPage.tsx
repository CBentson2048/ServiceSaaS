import { useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { ApiRequestError, createPublicBooking } from '../auth/api';
import { AppButton, AppCard } from '../design';
import { ClientBookingShell } from './ClientBookingShell';
import { readClientBookingSelection, updateClientBookingSelection } from './clientBookingFlow';
import type { ClientBookingSelection } from '@sheer/domain';

type CompleteReviewSelection = ClientBookingSelection &
  Required<
    Pick<
      ClientBookingSelection,
      'selectedSlot' | 'client' | 'account' | 'communicationPreference' | 'location' | 'service'
    >
  >;

export function ClientBookingReviewPage() {
  const navigate = useNavigate();
  const selection = readClientBookingSelection();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!isCompleteReviewSelection(selection)) {
    return <Navigate to="/book/account" replace />;
  }
  const currentSelection = selection;

  async function submit() {
    if (!currentSelection.staffProfileId) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await createPublicBooking({
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
      updateClientBookingSelection({ appointment: result.appointment });
      navigate('/book/success');
    } catch (err) {
      setError(toErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <ClientBookingShell
      title="Review"
      step="Step 5 of 5"
      footer={<AppButton size="lg" fullWidth loading={submitting} onClick={() => void submit()} className="min-h-12 bg-[#1C1628] text-white hover:bg-[#2A2139]">Confirm booking</AppButton>}
    >
      <h1 className="text-[18px] font-semibold leading-6">Confirm your booking</h1>
      <p className="mt-1 text-[12px] text-text-secondary">We will re-check this slot before creating the appointment.</p>
      {error ? <div className="mt-4 rounded-input-lg border border-danger-border bg-danger-soft px-3 py-2 text-[13px] text-danger">{error}</div> : null}
      <AppCard className="mt-5">
        <Summary label="Location" value={currentSelection.location.name} />
        <Summary label="Service" value={currentSelection.service.name} />
        <Summary label="When" value={`${formatDate(currentSelection.selectedSlot.startAt)} at ${formatTime(currentSelection.selectedSlot.startAt)}`} />
        <Summary label="Stylist" value={currentSelection.selectedSlot.stylistName} />
        <Summary label="Contact" value={`${currentSelection.client.firstName} ${currentSelection.client.lastName}`} />
        <Summary label="Preference" value={formatPreference(currentSelection.communicationPreference)} />
        <Summary label="Account" value={currentSelection.account.email} />
      </AppCard>
      <AppCard className="mt-4 border-primary/30 bg-primary/5">
        <div className="text-[13px] font-semibold">Deposit</div>
        <div className="mt-1 text-[12px] text-text-secondary">
          {formatDeposit(currentSelection.service.depositRequiredAmount, currentSelection.location.currencyCode)}
        </div>
        <div className="mt-2 text-[12px] text-text-secondary">
          Deposit payment will be enabled in the next stage. No payment will be taken now.
        </div>
        {currentSelection.location.cancellationNoticeHours !== undefined ? (
          <div className="mt-3 rounded-input-lg bg-surface px-3 py-2 text-[12px] text-text-secondary">
            {formatCancellationNotice(currentSelection.location.cancellationNoticeHours)}
          </div>
        ) : null}
      </AppCard>
    </ClientBookingShell>
  );
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
