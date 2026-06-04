import { useEffect, useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import type { PublicBookingAttemptSummary } from '@sheer/domain';
import { ApiRequestError, getPublicBookingAttempt } from '../auth/api';
import { detectMobileStoreUrl, sheerAppDeepLink } from '../config/mobileApp';
import { AppButton, AppCard } from '../design';
import { ClientBookingShell } from './ClientBookingShell';
import {
  clearClientBookingSelection,
  readClientBookingSelection,
  updateClientBookingSelection,
} from './clientBookingFlow';

export function ClientBookingSuccessPage() {
  const navigate = useNavigate();
  const selection = readClientBookingSelection();
  const [attempt, setAttempt] = useState<PublicBookingAttemptSummary | null>(
    selection?.bookingAttempt ?? null,
  );
  const [error, setError] = useState<string | null>(null);
  const [storeUrl] = useState(() => detectMobileStoreUrl());
  const appointment = attempt?.appointment ?? selection?.appointment;

  useEffect(() => {
    const attemptId = selection?.bookingAttemptId ?? selection?.bookingAttempt?.id;
    if (!attemptId) return;
    const currentAttemptId = attemptId;
    let cancelled = false;
    async function load() {
      try {
        const result = await getPublicBookingAttempt(currentAttemptId);
        if (cancelled) return;
        setAttempt(result.bookingAttempt);
        updateClientBookingSelection({
          bookingAttempt: result.bookingAttempt,
          appointment: result.bookingAttempt.appointment,
        });
      } catch (err) {
        if (!cancelled) setError(toErrorMessage(err));
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [selection?.bookingAttempt?.id, selection?.bookingAttemptId]);

  // Deposit bookings carry a booking attempt; deposit-free bookings only carry the confirmed
  // appointment. Either is a valid way to reach the success page.
  if (!selection?.bookingAttemptId && !selection?.bookingAttempt?.id && !selection?.appointment) {
    return <Navigate to="/book/location" replace />;
  }
  if (attempt && attempt.status !== 'confirmed') {
    return <Navigate to="/book/review" replace />;
  }
  if (!appointment) {
    return (
      <ClientBookingShell title="Confirming booking" step="Step 6 of 6">
        <AppCard className="text-center text-[13px] text-text-secondary">
          Final confirmation is still processing. Refresh this page in a moment.
        </AppCard>
        {error ? (
          <div className="mt-4 rounded-input-lg border border-danger-border bg-danger-soft px-3 py-2 text-[13px] text-danger">
            {error}
          </div>
        ) : null}
      </ClientBookingShell>
    );
  }

  function finish() {
    clearClientBookingSelection();
    navigate('/');
  }

  return (
    <ClientBookingShell
      title="Booking confirmed"
      step="Step 6 of 6"
      footer={<AppButton size="lg" fullWidth onClick={finish} className="min-h-12 bg-[#1C1628] text-white hover:bg-[#2A2139]">Done</AppButton>}
    >
      <div className="rounded-[24px] border border-primary/20 bg-primary/5 px-4 py-5 text-center">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-primary text-[22px] font-semibold text-white">
          ✓
        </div>
        <h1 className="mt-4 text-[20px] font-semibold leading-6">Your booking is in</h1>
        <p className="mt-2 text-[13px] text-text-secondary">
          {attempt
            ? 'Your deposit has been paid and your appointment is confirmed. The salon will contact you using your selected preference.'
            : 'Your appointment is confirmed. The salon will contact you using your selected preference.'}
        </p>
      </div>

      <AppCard className="mt-5">
        <div className="grid gap-x-6 md:grid-cols-2">
        <Summary label="Services" value={appointment.serviceNames.join(', ')} />
        <Summary label="Duration" value={formatDuration(appointment.totalDurationMinutes)} />
        <Summary label="When" value={formatDateTime(appointment.scheduledStartAt)} />
        <Summary label="Stylist" value={appointment.stylistName} />
        <Summary label="Client" value={appointment.clientDisplayName} />
        <Summary label="Status" value={formatStatus(appointment.status)} />
        <Summary label="Contact preference" value={formatPreference(appointment.communicationPreference)} />
        {attempt ? (
          <Summary
            label="Deposit"
            value={`${formatMoney(attempt.depositAmount, attempt.currencyCode)} paid`}
          />
        ) : (
          <Summary label="Deposit" value="No deposit required" />
        )}
        </div>
      </AppCard>

      <AppCard className="mt-4 border-primary/25 bg-primary/5">
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            <div className="text-[14px] font-semibold">Manage this booking in the Sheer App</div>
            <p className="mt-1 text-[12px] leading-5 text-text-secondary">
              Your account is ready. Install the app to view upcoming visits, rebook faster, and stay in touch with your salon.
            </p>
          </div>
          <div className="flex shrink-0 flex-col gap-2 sm:flex-row md:flex-col">
            <AppButton
              variant="primary"
              size="sm"
              onClick={() => {
                window.location.href = sheerAppDeepLink;
              }}
            >
              Open app
            </AppButton>
            <AppButton
              variant="secondary"
              size="sm"
              onClick={() => {
                window.location.href = storeUrl;
              }}
            >
              Download app
            </AppButton>
          </div>
        </div>
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

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatStatus(status: string): string {
  return status.replace(/_/g, ' ').replace(/^\w/, (value) => value.toUpperCase());
}

function formatPreference(value: string): string {
  if (value === 'whatsapp') return 'WhatsApp';
  if (value === 'sms') return 'SMS';
  return 'Email';
}

function formatMoney(amount: number, currencyCode: string): string {
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: currencyCode,
  }).format(amount);
}

function formatDuration(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder ? `${hours} hr ${remainder} min` : `${hours} hr`;
}

function toErrorMessage(err: unknown): string {
  if (err instanceof ApiRequestError) return err.message;
  if (err instanceof Error) return err.message;
  return 'Could not load booking confirmation';
}
