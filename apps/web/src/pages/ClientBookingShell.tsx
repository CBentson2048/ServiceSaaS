import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { AppCard } from '../design';
import { readClientBookingSelection } from './clientBookingFlow';

export function ClientBookingShell({
  title,
  step,
  children,
  footer,
}: {
  title: string;
  step: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const navigate = useNavigate();
  const selection = readClientBookingSelection();
  return (
    <div className="min-h-screen bg-[#f7f4ff] text-text-primary">
      <div className="mx-auto flex min-h-screen w-full max-w-5xl flex-col bg-[#fbf9ff] shadow-hero sm:my-6 sm:min-h-[720px] sm:rounded-[28px] lg:min-h-[760px]">
        <header className="rounded-b-none bg-[#1C1628] px-4 pb-2 pt-3 text-white sm:rounded-t-[28px] lg:px-6">
          <div className="flex items-center justify-between gap-3">
            <button
              type="button"
              onClick={() => navigate(-1)}
              className="text-[13px] font-medium text-white/85"
            >
              Back
            </button>
            <div className="text-[13px] font-semibold">{title}</div>
            <div className="text-[11px] text-white/55">{step}</div>
          </div>
          <div className="mt-3 h-1 rounded-full bg-white/12">
            <div className="h-1 rounded-full bg-primary" style={{ width: progressWidth(step) }} />
          </div>
        </header>
        <div className="flex flex-1 flex-col lg:grid lg:grid-cols-[minmax(0,1fr)_320px]">
          <main className="flex-1 px-4 pb-28 pt-5 lg:px-6 lg:pb-8 lg:pt-6">{children}</main>
          <aside className="hidden border-l border-border bg-surface/55 px-5 py-6 lg:block">
            <div className="sticky top-6 space-y-4">
              <BookingSummary selection={selection} />
              {footer ? <div>{footer}</div> : null}
            </div>
          </aside>
        </div>
        {footer ? (
          <div className="sticky bottom-0 border-t border-border bg-[#fbf9ff]/95 px-4 py-4 backdrop-blur sm:rounded-b-[28px] lg:hidden">
            {footer}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function progressWidth(step: string): string {
  if (/done|complete|confirmed/i.test(step)) return '100%';
  const match = /(\d+)\s*of\s*(\d+)/i.exec(step);
  const current = match ? Number(match[1]) : 1;
  const total = match ? Number(match[2]) : 6;
  return `${Math.min(100, Math.max(12, (current / total) * 100))}%`;
}

function BookingSummary({
  selection,
}: {
  selection: ReturnType<typeof readClientBookingSelection>;
}) {
  const rows = [
    ['Location', selection?.location?.name],
    ['Services', selection?.services?.map((service) => service.name).join(', ')],
    ['Duration', selection?.services ? formatDuration(totalDuration(selection.services)) : undefined],
    ['Stylist', selection?.selectedSlot?.stylistName ?? stylistLabel(selection)],
    ['Time', selection?.selectedSlot ? formatDateTime(selection.selectedSlot.startAt) : undefined],
    ['Client', selection?.client ? `${selection.client.firstName} ${selection.client.lastName}` : undefined],
    ['Deposit', selection?.bookingAttempt ? formatMoney(selection.bookingAttempt.depositAmount, selection.bookingAttempt.currencyCode) : undefined],
  ].filter((row): row is [string, string] => Boolean(row[1]));

  return (
    <AppCard elevation="none" className="border-border bg-white/75">
      <div className="text-[13px] font-semibold">Booking summary</div>
      {rows.length > 0 ? (
        <div className="mt-3 space-y-2">
          {rows.map(([label, value]) => (
            <div key={label} className="border-b border-border pb-2 last:border-0 last:pb-0">
              <div className="text-[10px] uppercase tracking-wide text-text-muted">{label}</div>
              <div className="mt-0.5 text-[12px] font-medium">{value}</div>
            </div>
          ))}
        </div>
      ) : (
        <div className="mt-2 text-[12px] text-text-secondary">
          Your selected booking details will appear here as you move through the flow.
        </div>
      )}
    </AppCard>
  );
}

function stylistLabel(selection: ReturnType<typeof readClientBookingSelection>): string | undefined {
  if (!selection) return undefined;
  if (selection.staffRequestMode === 'next_available') return 'Next available';
  return undefined;
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

function formatMoney(amount: number, currencyCode: string): string {
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: currencyCode,
  }).format(amount);
}

function totalDuration(services: Array<{ estimatedDurationMinutes: number }>): number {
  return services.reduce((sum, service) => sum + service.estimatedDurationMinutes, 0);
}

function formatDuration(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder ? `${hours} hr ${remainder} min` : `${hours} hr`;
}
