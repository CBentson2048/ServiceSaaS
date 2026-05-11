import { useEffect, useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import type { PublicBookingAttemptSummary } from '@sheer/domain';
import { ApiRequestError, getPublicBookingAttempt } from '../auth/api';
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

  if (!selection?.bookingAttemptId && !selection?.bookingAttempt?.id) {
    return <Navigate to="/book/location" replace />;
  }
  if (attempt && attempt.status !== 'confirmed') {
    return <Navigate to="/book/review" replace />;
  }
  if (!appointment) {
    return (
      <ClientBookingShell title="Confirming booking" step="Done">
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
    navigate('/book/location');
  }

  return (
    <ClientBookingShell
      title="Booking confirmed"
      step="Done"
      footer={<AppButton size="lg" fullWidth onClick={finish} className="min-h-12 bg-[#1C1628] text-white hover:bg-[#2A2139]">Done</AppButton>}
    >
      <div className="rounded-[24px] border border-primary/20 bg-primary/5 px-4 py-5 text-center">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-primary text-[22px] font-semibold text-white">
          ✓
        </div>
        <h1 className="mt-4 text-[20px] font-semibold leading-6">Your booking is in</h1>
        <p className="mt-2 text-[13px] text-text-secondary">
          Your deposit has been paid and your appointment is confirmed. The salon will contact you using your selected preference.
        </p>
      </div>

      <AppCard className="mt-5">
        <div className="grid gap-x-6 md:grid-cols-2">
        <Summary label="Service" value={appointment.serviceName} />
        <Summary label="When" value={formatDateTime(appointment.scheduledStartAt)} />
        <Summary label="Stylist" value={appointment.stylistName} />
        <Summary label="Client" value={appointment.clientDisplayName} />
        <Summary label="Status" value={formatStatus(appointment.status)} />
        <Summary label="Contact preference" value={formatPreference(appointment.communicationPreference)} />
        <Summary
          label="Deposit"
          value={attempt ? `${formatMoney(attempt.depositAmount, attempt.currencyCode)} paid` : 'Paid'}
        />
        </div>
      </AppCard>

      <AppCard className="mt-4 border-border bg-surface">
        <div className="text-[14px] font-semibold">Want easier access next time?</div>
        <p className="mt-1 text-[12px] text-text-secondary">
          Your account is already set up. The app recommendation belongs after booking so you can manage future visits more easily.
        </p>
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

function toErrorMessage(err: unknown): string {
  if (err instanceof ApiRequestError) return err.message;
  if (err instanceof Error) return err.message;
  return 'Could not load booking confirmation';
}
