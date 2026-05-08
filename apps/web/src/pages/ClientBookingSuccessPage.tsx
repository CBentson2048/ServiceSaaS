import { Navigate, useNavigate } from 'react-router-dom';
import { AppButton, AppCard } from '../design';
import { ClientBookingShell } from './ClientBookingShell';
import { clearClientBookingSelection, readClientBookingSelection } from './clientBookingFlow';

export function ClientBookingSuccessPage() {
  const navigate = useNavigate();
  const selection = readClientBookingSelection();
  const appointment = selection?.appointment;
  if (!appointment) return <Navigate to="/book/location" replace />;

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
          We created your reservation and linked it to your account. The salon will contact you using your selected preference.
        </p>
      </div>

      <AppCard className="mt-5">
        <Summary label="Service" value={appointment.serviceName} />
        <Summary label="When" value={formatDateTime(appointment.scheduledStartAt)} />
        <Summary label="Stylist" value={appointment.stylistName} />
        <Summary label="Client" value={appointment.clientDisplayName} />
        <Summary label="Status" value={formatStatus(appointment.status)} />
        <Summary label="Contact preference" value={formatPreference(appointment.communicationPreference)} />
        {appointment.depositRequiredAmount > 0 ? (
          <div className="mt-3 rounded-input-lg bg-warning-soft px-3 py-2 text-[12px] text-warning">
            Deposit collection is prepared but payment is not enabled yet. No payment has been taken.
          </div>
        ) : null}
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
