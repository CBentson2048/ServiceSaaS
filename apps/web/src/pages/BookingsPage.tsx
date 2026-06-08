import { useCallback, useEffect, useMemo, useState, type SVGProps } from 'react';
import type {
  AppointmentBillingTax,
  AppointmentCompletionResponse,
  CreateStylistRebookingRequest,
  StaffBookingSummary,
  WeeklyRotaResponse,
} from '@sheer/domain';
import { AppButton, AppCard, Pill, StatusBadge } from '../design';
import {
  ApiRequestError,
  completeBooking,
  confirmBookingPayment,
  createStylistRebooking,
  getWeeklyRota,
  listBookings,
} from '../auth/api';
import { useAuth } from '../auth/AuthProvider';
import { useLocationScope } from '../components/LocationScopeContext';
import { DayCalendarBoard } from '../components/bookings/DayCalendarBoard';
import { WeekStrip } from '../components/bookings/WeekStrip';
import type { CalendarToolbarKey, CalendarToolbarState } from '../components/bookings/CalendarToolbar';
import { isSameLocalDay, snapToMonday, toIsoDate } from '../components/rota/dateUtils';

type StatusTone = 'success' | 'warning' | 'danger' | 'neutral';

export function BookingsPage() {
  const auth = useAuth();
  const accessToken = auth.session?.accessToken;
  // The active location is owned by the sidebar's location picker (shared scope).
  const { selectedLocationId } = useLocationScope();

  const [bookings, setBookings] = useState<StaffBookingSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [completionLoadingId, setCompletionLoadingId] = useState<string | null>(null);
  const [paymentLoadingId, setPaymentLoadingId] = useState<string | null>(null);
  const [checkoutSummary, setCheckoutSummary] = useState<AppointmentCompletionResponse | null>(null);
  const [paymentMethod, setPaymentMethod] = useState<'cash' | 'card_reader'>('card_reader');
  const [checkoutMessage, setCheckoutMessage] = useState<string | null>(null);
  const [rebookingLoading, setRebookingLoading] = useState(false);
  const [rebookingSkipped, setRebookingSkipped] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);

  // Calendar state. The timetable spans the full page width and appointments
  // are selected straight from the board.
  const [day, setDay] = useState<Date>(() => new Date());
  const [rota, setRota] = useState<WeeklyRotaResponse | null>(null);
  const [rotaLoading, setRotaLoading] = useState(false);
  const [rotaError, setRotaError] = useState<string | null>(null);
  const [selectedBookingId, setSelectedBookingId] = useState<string | null>(null);
  const [toolbar, setToolbar] = useState<CalendarToolbarState>(loadToolbarState);

  const toggleToolbar = useCallback((key: CalendarToolbarKey) => {
    setToolbar((current) => {
      const next = { ...current, [key]: !current[key] };
      saveToolbarState(next);
      return next;
    });
  }, []);

  const reload = useCallback(async () => {
    if (!accessToken) return;
    setLoading(true);
    setError(null);
    try {
      const result = await listBookings(accessToken);
      setBookings(result.bookings);
    } catch (err: unknown) {
      if (err instanceof ApiRequestError) setError(err.message);
      else if (err instanceof Error) setError(err.message);
      else setError('Could not load bookings');
    } finally {
      setLoading(false);
    }
  }, [accessToken]);

  const handleComplete = useCallback(
    async (booking: StaffBookingSummary) => {
      if (!accessToken || isCompletionLocked(booking.status)) return;
      setCompletionLoadingId(booking.id);
      setCheckoutMessage(null);
      setError(null);
      try {
        const result = await completeBooking(accessToken, booking.id);
        setBookings((current) =>
          current.map((entry) => (entry.id === booking.id ? { ...entry, ...result.appointment } : entry)),
        );
        setCheckoutSummary(result);
        setCheckoutMessage(
          `Awaiting in-salon payment for ${result.appointment.clientDisplayName}. Balance due: ${formatMoney(
            result.billing.balanceDueCents,
            result.billing.currencyCode,
          )}.`,
        );
      } catch (err: unknown) {
        if (err instanceof ApiRequestError) setError(err.message);
        else if (err instanceof Error) setError(err.message);
        else setError('Could not complete booking');
      } finally {
        setCompletionLoadingId(null);
      }
    },
    [accessToken],
  );

  const handleConfirmPayment = useCallback(
    async (summary: AppointmentCompletionResponse) => {
      if (!accessToken) return;
      setPaymentLoadingId(summary.appointment.id);
      setError(null);
      try {
        const result = await confirmBookingPayment(accessToken, summary.appointment.id, {
          paymentMethod,
          amountCents: summary.billing.balanceDueCents,
        });
        setBookings((current) =>
          current.map((entry) => (entry.id === result.appointment.id ? { ...entry, ...result.appointment } : entry)),
        );
        setCheckoutSummary(result);
        setCheckoutMessage(
          `Payment confirmed for ${result.appointment.clientDisplayName}: ${formatMoney(
            result.payment.amountCents,
            result.payment.currencyCode,
          )} by ${formatPaymentMethod(result.payment.paymentMethod)}.`,
        );
      } catch (err: unknown) {
        if (err instanceof ApiRequestError) setError(err.message);
        else if (err instanceof Error) setError(err.message);
        else setError('Could not confirm payment');
      } finally {
        setPaymentLoadingId(null);
      }
    },
    [accessToken, paymentMethod],
  );

  const handleCreateRebooking = useCallback(
    async (summary: AppointmentCompletionResponse, payload: CreateStylistRebookingRequest) => {
      if (!accessToken) return;
      setRebookingLoading(true);
      setError(null);
      try {
        const result = await createStylistRebooking(accessToken, summary.appointment.id, payload);
        setCheckoutSummary(result);
        setRebookingSkipped((current) => ({ ...current, [summary.appointment.id]: false }));
        setCheckoutMessage(
          `Rebooked ${result.appointment.clientDisplayName}. The source visit is now linked for KPI credit.`,
        );
      } catch (err: unknown) {
        if (err instanceof ApiRequestError) setError(err.message);
        else if (err instanceof Error) setError(err.message);
        else setError('Could not create rebooking');
      } finally {
        setRebookingLoading(false);
      }
    },
    [accessToken],
  );

  const handleCloseCheckout = useCallback(() => {
    setCheckoutSummary(null);
    setCheckoutMessage(null);
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const weekStartIso = useMemo(() => toIsoDate(snapToMonday(day)), [day]);

  // Load rota (column roster + working hours + leave/absence) for the calendar.
  useEffect(() => {
    if (!accessToken || !selectedLocationId) return;
    let cancelled = false;
    setRotaLoading(true);
    setRotaError(null);
    getWeeklyRota(accessToken, { locationId: selectedLocationId, weekStart: weekStartIso })
      .then((result) => {
        if (!cancelled) setRota(result);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof ApiRequestError) setRotaError(err.message);
        else if (err instanceof Error) setRotaError(err.message);
        else setRotaError('Could not load the rota for this day');
      })
      .finally(() => {
        if (!cancelled) setRotaLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [accessToken, selectedLocationId, weekStartIso]);

  // A selected appointment should not linger when the day / location changes.
  useEffect(() => {
    setSelectedBookingId(null);
  }, [day, selectedLocationId]);

  const calendarBookings = useMemo(
    () =>
      bookings
        .filter((booking) => booking.locationId === selectedLocationId && isSameLocalDay(booking.startsAt, day))
        .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt)),
    [bookings, selectedLocationId, day],
  );

  const selectedBooking = useMemo(
    () => (selectedBookingId ? bookings.find((booking) => booking.id === selectedBookingId) ?? null : null),
    [bookings, selectedBookingId],
  );

  const showSelectedStrip =
    selectedBooking && (!checkoutSummary || checkoutSummary.appointment.id !== selectedBooking.id);

  // The location picker now lives at the bottom of the nav sidebar; only the
  // refresh control is docked to the calendar toolbar.
  const calendarControls = (
    <AppButton
      variant="secondary"
      size="sm"
      leadingIcon={<RefreshIcon className="h-3.5 w-3.5" />}
      onClick={() => void reload()}
    >
      Refresh
    </AppButton>
  );

  return (
    <div className="w-full px-4 py-5 lg:px-6">
      {error ? (
        <div className="mb-4 rounded-input-lg border border-danger-border bg-danger-soft px-4 py-3 text-[13px] text-danger">
          {error}
        </div>
      ) : null}

      {checkoutMessage ? (
        <div className="mb-4 rounded-input-lg border border-success-border bg-success-soft px-4 py-3 text-[13px] text-success">
          {checkoutMessage}
        </div>
      ) : null}

      {checkoutSummary ? (
        <CheckoutPanel
          summary={checkoutSummary}
          paymentMethod={paymentMethod}
          paymentLoading={paymentLoadingId === checkoutSummary.appointment.id}
          onPaymentMethodChange={setPaymentMethod}
          onConfirmPayment={() => void handleConfirmPayment(checkoutSummary)}
          rebookingLoading={rebookingLoading}
          rebookingSkipped={Boolean(rebookingSkipped[checkoutSummary.appointment.id])}
          onSkipRebooking={() =>
            setRebookingSkipped((current) => ({ ...current, [checkoutSummary.appointment.id]: true }))
          }
          onCreateRebooking={(payload) => void handleCreateRebooking(checkoutSummary, payload)}
          onClose={handleCloseCheckout}
        />
      ) : null}

      {/* Calendar + timetable claim the full page width. The day agenda panel
          was removed; appointments are selected directly on the board, and the
          location picker / refresh now live in the calendar toolbar. */}
      <div className="flex flex-col gap-4">
        <WeekStrip
          day={day}
          onSelectDay={setDay}
          toolbar={toolbar}
          onToggleToolbar={toggleToolbar}
          toolbarTrailing={calendarControls}
        />

        {showSelectedStrip && selectedBooking ? (
          <SelectedBookingStrip
            booking={selectedBooking}
            completing={completionLoadingId === selectedBooking.id}
            onComplete={() => void handleComplete(selectedBooking)}
            onClose={() => setSelectedBookingId(null)}
          />
        ) : null}

        {!selectedLocationId ? (
          <AppCard padding="none" elevation="card">
            <EmptyState title="No location available" body="A salon location is needed to show the calendar." />
          </AppCard>
        ) : rotaError ? (
          <div className="rounded-input-lg border border-danger-border bg-danger-soft px-4 py-3 text-[13px] text-danger">
            {rotaError}
          </div>
        ) : (loading || rotaLoading) && !rota ? (
          <AppCard padding="none" elevation="card">
            <EmptyState title="Loading calendar…" body="Fetching the rota and appointments for this day." />
          </AppCard>
        ) : (
          <DayCalendarBoard
            day={day}
            staff={rota?.staff ?? []}
            shifts={rota?.shifts ?? []}
            leave={rota?.leave ?? []}
            absences={rota?.absences ?? []}
            bookings={calendarBookings}
            selectedBookingId={selectedBookingId}
            onSelectBooking={(booking) => setSelectedBookingId(booking.id)}
            showAllTeamMembers={toolbar.showAllTeamMembers}
            showTimeline={toolbar.showTimeline}
          />
        )}
      </div>
    </div>
  );
}

function SelectedBookingStrip({
  booking,
  completing,
  onComplete,
  onClose,
}: {
  booking: StaffBookingSummary;
  completing: boolean;
  onComplete: () => void;
  onClose: () => void;
}) {
  return (
    <AppCard elevation="card" className="mb-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate text-[14px] font-medium text-text-primary">{booking.clientDisplayName}</span>
            <StatusBadge label={formatStatus(booking.status)} tone={statusTone(booking.status)} />
          </div>
          <div className="mt-0.5 truncate text-[12px] text-text-secondary">
            {(booking.serviceNames.join(', ') || 'Service')} · {formatTime(booking.startsAt)} – {formatTime(booking.endsAt)}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <CompleteButton booking={booking} completing={completing} onComplete={onComplete} />
          <button
            type="button"
            onClick={onClose}
            aria-label="Clear selection"
            className="inline-flex h-8 w-8 items-center justify-center rounded-pill border border-border text-text-secondary transition hover:bg-surface-alt hover:text-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
          >
            <CloseIcon className="h-4 w-4" />
          </button>
        </div>
      </div>
    </AppCard>
  );
}

function CompleteButton({
  booking,
  completing,
  onComplete,
  fullWidth = false,
}: {
  booking: StaffBookingSummary;
  completing: boolean;
  onComplete: () => void;
  fullWidth?: boolean;
}) {
  const completionLocked = isCompletionLocked(booking.status);
  const label = booking.status === 'awaiting_payment' ? 'Open checkout' : booking.status === 'paid' ? 'Paid' : 'Complete';
  return (
    <AppButton
      size="sm"
      variant={booking.status === 'awaiting_payment' ? 'primary' : 'secondary'}
      fullWidth={fullWidth}
      loading={completing}
      disabled={completionLocked}
      onClick={onComplete}
    >
      {label}
    </AppButton>
  );
}

function CheckoutPanel({
  summary,
  paymentMethod,
  paymentLoading,
  rebookingLoading,
  rebookingSkipped,
  onPaymentMethodChange,
  onConfirmPayment,
  onSkipRebooking,
  onCreateRebooking,
  onClose,
}: {
  summary: AppointmentCompletionResponse;
  paymentMethod: 'cash' | 'card_reader';
  paymentLoading: boolean;
  rebookingLoading: boolean;
  rebookingSkipped: boolean;
  onPaymentMethodChange: (method: 'cash' | 'card_reader') => void;
  onConfirmPayment: () => void;
  onSkipRebooking: () => void;
  onCreateRebooking: (payload: CreateStylistRebookingRequest) => void;
  onClose: () => void;
}) {
  const isPaid = summary.checkout.status === 'paid';
  return (
    <AppCard elevation="hero" padding="lg" className="mb-4 rounded-card-lg">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="text-[15px] font-semibold text-text-primary">
            {isPaid ? 'Payment confirmed' : 'Awaiting in-salon payment'}
          </div>
          <div className="mt-1 text-[13px] text-text-secondary">
            {summary.appointment.clientDisplayName} · {summary.checkout.message}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <StatusBadge label={isPaid ? 'Paid' : 'Awaiting payment'} tone={isPaid ? 'success' : 'warning'} />
          <button
            type="button"
            onClick={onClose}
            aria-label="Close checkout"
            className="inline-flex h-8 w-8 items-center justify-center rounded-pill border border-border text-text-secondary transition hover:bg-surface-alt hover:text-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
          >
            <CloseIcon className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
        <BillMetric label="Services" value={formatMoney(summary.billing.serviceTotalCents, summary.billing.currencyCode)} />
        <BillMetric label="Product usage" value={formatMoney(summary.billing.productUsageTotalCents, summary.billing.currencyCode)} />
        <BillMetric label="Gross total" value={formatMoney(summary.billing.totalCents, summary.billing.currencyCode)} />
        <BillMetric label="Deposit paid" value={formatMoney(summary.billing.depositPaidCents, summary.billing.currencyCode)} />
        <BillMetric label="Balance due" value={formatMoney(summary.billing.balanceDueCents, summary.billing.currencyCode)} strong />
      </div>

      {summary.billing.tax?.enabled ? (
        <TaxSummaryLine tax={summary.billing.tax} currencyCode={summary.billing.currencyCode} />
      ) : null}

      <RebookingPanel
        summary={summary}
        loading={rebookingLoading}
        skipped={rebookingSkipped}
        onSkip={onSkipRebooking}
        onCreate={onCreateRebooking}
      />

      {!isPaid ? (
        <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-col gap-1.5">
            <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-text-muted">Payment method</span>
            <div className="flex gap-2">
              {(['card_reader', 'cash'] as const).map((method) => (
                <Pill
                  key={method}
                  label={formatPaymentMethod(method)}
                  active={paymentMethod === method}
                  tone="ink"
                  onClick={() => onPaymentMethodChange(method)}
                />
              ))}
            </div>
          </div>
          <AppButton variant="primary" loading={paymentLoading} onClick={onConfirmPayment}>
            Confirm in-salon payment
          </AppButton>
        </div>
      ) : null}
    </AppCard>
  );
}

function RebookingPanel({
  summary,
  loading,
  skipped,
  onSkip,
  onCreate,
}: {
  summary: AppointmentCompletionResponse;
  loading: boolean;
  skipped: boolean;
  onSkip: () => void;
  onCreate: (payload: CreateStylistRebookingRequest) => void;
}) {
  const [open, setOpen] = useState(false);
  const [selectedStartAt, setSelectedStartAt] = useState(defaultRebookingInputValue());
  const [clientNote, setClientNote] = useState('');
  const rebooked = Boolean(summary.visit.rebooked);

  function submit() {
    const iso = toIsoFromLocalInput(selectedStartAt);
    if (!iso) return;
    onCreate({
      sourceVisitId: summary.visit.id,
      selectedStartAt: iso,
      staffProfileId: summary.appointment.assignedStaffProfileId,
      clientNote: clientNote.trim() || undefined,
    });
  }

  return (
    <div className="mt-4 rounded-input-lg border border-border bg-surface-alt p-3">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <div className="text-[13px] font-semibold text-text-primary">Rebooking</div>
          <div className="mt-1 text-[12px] text-text-secondary">
            {rebooked
              ? `Linked follow-up appointment ${summary.visit.rebookedAppointmentId ?? ''}.`
              : skipped
                ? 'Skipped for this checkout. This visit is not counted as rebooked.'
                : 'Create a real follow-up appointment before this visit counts as rebooked.'}
          </div>
        </div>
        <StatusBadge
          label={rebooked ? 'Rebooked' : skipped ? 'Skipped' : 'Not rebooked'}
          tone={rebooked ? 'success' : skipped ? 'neutral' : 'warning'}
        />
      </div>
      {!rebooked && !skipped ? (
        <div className="mt-3 flex flex-wrap gap-2">
          <AppButton size="sm" variant="primary" onClick={() => setOpen(true)}>
            Rebook now
          </AppButton>
          <AppButton size="sm" variant="secondary" onClick={onSkip}>
            Skip rebooking
          </AppButton>
        </div>
      ) : null}
      {open && !rebooked && !skipped ? (
        <div className="mt-3 grid gap-3 rounded-input-lg border border-border bg-surface p-3 lg:grid-cols-[1fr_1fr_auto] lg:items-end">
          <label className="block text-[12px] font-medium text-text-secondary">
            Follow-up time
            <input
              type="datetime-local"
              value={selectedStartAt}
              onChange={(event) => setSelectedStartAt(event.target.value)}
              className="mt-1 h-10 w-full rounded-input border border-border bg-surface px-3 text-[13px] text-text-primary outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20"
            />
          </label>
          <label className="block text-[12px] font-medium text-text-secondary">
            Optional note
            <input
              value={clientNote}
              onChange={(event) => setClientNote(event.target.value)}
              placeholder="e.g. 8 week toner refresh"
              className="mt-1 h-10 w-full rounded-input border border-border bg-surface px-3 text-[13px] text-text-primary outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20"
            />
          </label>
          <AppButton variant="primary" loading={loading} disabled={!selectedStartAt} onClick={submit}>
            Create rebooking
          </AppButton>
        </div>
      ) : null}
    </div>
  );
}

function BillMetric({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="rounded-input-lg border border-border bg-surface-alt px-3 py-2">
      <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-text-secondary">{label}</div>
      <div className={`mt-1 ${strong ? 'text-[16px] font-semibold text-text-primary' : 'text-text-secondary'}`}>{value}</div>
    </div>
  );
}

// Renders the bill's tax rollup according to the location's configured display
// mode (inc-tax / ex-tax / both), using the API-provided AppointmentBillingTax.
function TaxSummaryLine({ tax, currencyCode }: { tax: AppointmentBillingTax; currencyCode: string }) {
  const label = tax.label?.trim() || 'Tax';
  const rate = `${tax.ratePercent}%`;
  const net = formatMoney(tax.netCents, currencyCode);
  const taxAmt = formatMoney(tax.taxCents, currencyCode);
  const gross = formatMoney(tax.grossCents, currencyCode);

  let detail: string;
  if (tax.displayMode === 'inc_tax') {
    detail = `Tax-inclusive — includes ${taxAmt} ${label} (net ${net})`;
  } else if (tax.displayMode === 'ex_tax') {
    detail = `Tax-exclusive — ${taxAmt} ${label} added → ${gross} inc. tax`;
  } else {
    detail = `Net ${net} · ${taxAmt} ${label} · ${gross} inc. tax`;
  }

  return (
    <div className="mt-2 flex items-center justify-between gap-3 rounded-input-lg border border-border bg-surface-alt/40 px-4 py-2.5 text-[12px]">
      <span className="font-medium text-text-primary">{label} ({rate})</span>
      <span className="text-text-secondary">{detail}</span>
    </div>
  );
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="px-4 py-12 text-center">
      <div className="text-[14px] font-medium text-text-primary">{title}</div>
      <div className="mt-1 text-[13px] text-text-secondary">{body}</div>
    </div>
  );
}

function RefreshIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.6} aria-hidden {...props}>
      <path d="M16.5 9a6.5 6.5 0 1 0-1.6 4.3" strokeLinecap="round" />
      <path d="M16.5 4v3.6H13" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function CloseIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.6} aria-hidden {...props}>
      <path d="m5 5 10 10M15 5 5 15" strokeLinecap="round" />
    </svg>
  );
}

const TOOLBAR_STORAGE_KEY = 'sheer.web.bookings.calendarToolbar';

const DEFAULT_TOOLBAR_STATE: CalendarToolbarState = {
  showAllTeamMembers: true,
  showTimeline: true,
  autoHideCalendar: false,
};

// The view toggles are a per-user preference, so persist them across sessions.
// Reads defensively — a corrupt / partial blob falls back to the defaults.
function loadToolbarState(): CalendarToolbarState {
  if (typeof window === 'undefined') return DEFAULT_TOOLBAR_STATE;
  try {
    const raw = window.localStorage.getItem(TOOLBAR_STORAGE_KEY);
    if (!raw) return DEFAULT_TOOLBAR_STATE;
    const parsed = JSON.parse(raw) as Partial<CalendarToolbarState>;
    return {
      showAllTeamMembers: parsed.showAllTeamMembers ?? DEFAULT_TOOLBAR_STATE.showAllTeamMembers,
      showTimeline: parsed.showTimeline ?? DEFAULT_TOOLBAR_STATE.showTimeline,
      autoHideCalendar: parsed.autoHideCalendar ?? DEFAULT_TOOLBAR_STATE.autoHideCalendar,
    };
  } catch {
    return DEFAULT_TOOLBAR_STATE;
  }
}

function saveToolbarState(state: CalendarToolbarState): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(TOOLBAR_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Best-effort — ignore storage failures (private mode, quota, etc.).
  }
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function formatStatus(status: string): string {
  return status
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function statusTone(status: StaffBookingSummary['status']): StatusTone {
  switch (status) {
    case 'confirmed':
    case 'checked_in':
    case 'in_progress':
    case 'in_service':
      return 'success';
    case 'pending':
    case 'draft':
    case 'booked':
      return 'warning';
    case 'cancelled':
    case 'no_show':
      return 'danger';
    default:
      return 'neutral';
  }
}


function isCompletionLocked(status: StaffBookingSummary['status']): boolean {
  return (
    status === 'paid' ||
    status === 'completed' ||
    status === 'cancelled' ||
    status === 'no_show' ||
    status === 'pending' ||
    status === 'draft' ||
    status === 'booked'
  );
}

function formatPaymentMethod(method: 'cash' | 'card_reader'): string {
  return method === 'card_reader' ? 'Card reader' : 'Cash';
}

function formatMoney(amountCents: number, currencyCode: string): string {
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: currencyCode,
  }).format(amountCents / 100);
}

function defaultRebookingInputValue(): string {
  const date = new Date(Date.now() + 6 * 7 * 24 * 60 * 60 * 1000);
  date.setMinutes(0, 0, 0);
  return toDatetimeLocalValue(date);
}

function toDatetimeLocalValue(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function toIsoFromLocalInput(value: string): string | undefined {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toISOString();
}
