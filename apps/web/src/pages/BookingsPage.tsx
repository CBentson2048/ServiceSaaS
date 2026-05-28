import { useCallback, useEffect, useMemo, useState, type SVGProps } from 'react';
import type {
  AppointmentCompletionResponse,
  CreateStylistRebookingRequest,
  StaffBookingSummary,
  WeeklyRotaResponse,
} from '@sheer/domain';
import { AppButton, AppCard, AppText, Pill, StatusBadge } from '../design';
import {
  ApiRequestError,
  completeBooking,
  confirmBookingPayment,
  createStylistRebooking,
  getWeeklyRota,
  listBookings,
} from '../auth/api';
import { useAuth } from '../auth/AuthProvider';
import { DayCalendarBoard } from '../components/bookings/DayCalendarBoard';
import { addDays, isSameLocalDay, snapToMonday, toIsoDate } from '../components/rota/dateUtils';

type StatusFilter = 'all' | StaffBookingSummary['status'];
type StatusTone = 'success' | 'warning' | 'danger' | 'neutral';
type BookingsView = 'calendar' | 'list';

const STATUS_FILTERS: StatusFilter[] = [
  'all',
  'pending',
  'confirmed',
  'checked_in',
  'in_progress',
  'completed',
  'cancelled',
  'no_show',
];

export function BookingsPage() {
  const auth = useAuth();
  const accessToken = auth.session?.accessToken;
  const locations = useMemo(() => auth.user?.locations ?? [], [auth.user?.locations]);

  const [bookings, setBookings] = useState<StaffBookingSummary[]>([]);
  const [scope, setScope] = useState<'owner' | 'manager' | 'stylist' | null>(null);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [loading, setLoading] = useState(true);
  const [completionLoadingId, setCompletionLoadingId] = useState<string | null>(null);
  const [paymentLoadingId, setPaymentLoadingId] = useState<string | null>(null);
  const [checkoutSummary, setCheckoutSummary] = useState<AppointmentCompletionResponse | null>(null);
  const [paymentMethod, setPaymentMethod] = useState<'cash' | 'card_reader'>('card_reader');
  const [checkoutMessage, setCheckoutMessage] = useState<string | null>(null);
  const [rebookingLoading, setRebookingLoading] = useState(false);
  const [rebookingSkipped, setRebookingSkipped] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);

  // Calendar view state
  const [view, setView] = useState<BookingsView>('calendar');
  const [selectedLocationId, setSelectedLocationId] = useState(() => auth.user?.locations?.[0]?.id ?? '');
  const [day, setDay] = useState<Date>(() => new Date());
  const [rota, setRota] = useState<WeeklyRotaResponse | null>(null);
  const [rotaLoading, setRotaLoading] = useState(false);
  const [rotaError, setRotaError] = useState<string | null>(null);
  const [selectedBookingId, setSelectedBookingId] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!accessToken) return;
    setLoading(true);
    setError(null);
    try {
      const result = await listBookings(accessToken);
      setBookings(result.bookings);
      setScope(result.scope);
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

  // Default the calendar to the first available location once the user loads.
  useEffect(() => {
    if (!selectedLocationId && locations.length > 0) setSelectedLocationId(locations[0].id);
  }, [locations, selectedLocationId]);

  const weekStartIso = useMemo(() => toIsoDate(snapToMonday(day)), [day]);

  // Load rota (column roster + working hours + leave/absence) for the calendar.
  useEffect(() => {
    if (view !== 'calendar' || !accessToken || !selectedLocationId) return;
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
  }, [view, accessToken, selectedLocationId, weekStartIso]);

  // A selected appointment should not linger when the day / location / view changes.
  useEffect(() => {
    setSelectedBookingId(null);
  }, [day, selectedLocationId, view]);

  const visibleBookings = useMemo(() => {
    const term = search.trim().toLowerCase();
    return bookings.filter((booking) => {
      if (statusFilter !== 'all' && booking.status !== statusFilter) return false;
      if (!term) return true;
      return [
        booking.clientDisplayName,
        booking.serviceNames.join(' '),
        booking.status,
        booking.locationId,
      ]
        .join(' ')
        .toLowerCase()
        .includes(term);
    });
  }, [bookings, search, statusFilter]);

  const calendarBookings = useMemo(
    () => bookings.filter((booking) => booking.locationId === selectedLocationId && isSameLocalDay(booking.startsAt, day)),
    [bookings, selectedLocationId, day],
  );

  const selectedBooking = useMemo(
    () => (selectedBookingId ? bookings.find((booking) => booking.id === selectedBookingId) ?? null : null),
    [bookings, selectedBookingId],
  );

  const subtitle =
    scope === 'owner'
      ? 'Showing bookings across your business.'
      : scope === 'manager'
        ? 'Showing bookings for your assigned location scope.'
        : 'Showing bookings in your permitted scope.';

  const hasResults = !loading && visibleBookings.length > 0;
  const showSelectedStrip =
    selectedBooking && (!checkoutSummary || checkoutSummary.appointment.id !== selectedBooking.id);

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-8 lg:px-8">
      <header className="mb-7 flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <AppText as="h1" variant="heading" weight="medium" className="text-[22px] text-text-primary">
            Bookings
          </AppText>
          <p className="mt-1 text-[13px] text-text-secondary">{subtitle}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2.5">
          <div
            role="tablist"
            aria-label="View mode"
            className="flex items-center rounded-pill border border-border bg-surface p-0.5 shadow-sm"
          >
            {(['calendar', 'list'] as const).map((v) => (
              <button
                key={v}
                type="button"
                role="tab"
                aria-selected={view === v}
                onClick={() => setView(v)}
                className={`h-7 rounded-pill px-4 text-[12px] font-medium transition-all ${
                  view === v
                    ? 'bg-text-primary text-white shadow-sm'
                    : 'text-text-secondary hover:text-text-primary'
                }`}
              >
                {v.charAt(0).toUpperCase() + v.slice(1)}
              </button>
            ))}
          </div>
          <AppButton
            variant="secondary"
            leadingIcon={<RefreshIcon className="h-3.5 w-3.5" />}
            onClick={() => void reload()}
          >
            Refresh
          </AppButton>
        </div>
      </header>

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

      {view === 'calendar' ? (
        <>
          <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-1">
              <button
                type="button"
                aria-label="Previous day"
                onClick={() => setDay((current) => addDays(current, -1))}
                className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-border bg-surface text-text-secondary shadow-sm transition hover:bg-surface-alt hover:text-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
              >
                <ChevronLeftIcon className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={() => setDay(new Date())}
                className="h-8 rounded-full border border-border bg-surface px-3 text-[12px] font-medium text-text-secondary shadow-sm transition hover:bg-surface-alt hover:text-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
              >
                Today
              </button>
              <button
                type="button"
                aria-label="Next day"
                onClick={() => setDay((current) => addDays(current, 1))}
                className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-border bg-surface text-text-secondary shadow-sm transition hover:bg-surface-alt hover:text-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
              >
                <ChevronRightIcon className="h-4 w-4" />
              </button>
              <span className="ml-2 text-[15px] font-semibold text-text-primary">{formatDayHeading(day)}</span>
            </div>
            {locations.length > 1 ? (
              <label className="flex items-center gap-2 text-[12px] text-text-muted">
                <span className="font-medium uppercase tracking-[0.08em]">Location</span>
                <select
                  value={selectedLocationId}
                  onChange={(event) => setSelectedLocationId(event.target.value)}
                  className="h-8 rounded-full border border-border bg-surface px-3 text-[12px] font-medium text-text-primary shadow-sm outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20"
                >
                  {locations.map((location) => (
                    <option key={location.id} value={location.id}>
                      {location.name}
                    </option>
                  ))}
                </select>
              </label>
            ) : locations[0] ? (
              <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface px-3.5 py-1.5 text-[12px] font-medium text-text-secondary shadow-sm">
                {locations[0].name}
              </span>
            ) : null}
          </div>

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
            />
          )}
        </>
      ) : (
        <>
          <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div className="relative w-full lg:w-96">
              <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted" />
              <input
                type="search"
                placeholder="Search client, service, status, or location"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                className="h-10 w-full rounded-input-lg border border-border-strong bg-surface pl-9 pr-3 text-[13px] text-text-primary outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20"
              />
            </div>
            <div
              role="tablist"
              aria-label="Filter by status"
              className="-mx-1 flex flex-nowrap items-center gap-1.5 overflow-x-auto px-1 pb-1 lg:mx-0 lg:flex-wrap lg:overflow-visible lg:pb-0"
            >
              {STATUS_FILTERS.map((status) => (
                <Pill
                  key={status}
                  label={status === 'all' ? 'All' : formatStatus(status)}
                  active={statusFilter === status}
                  tone="ink"
                  className="shrink-0"
                  onClick={() => setStatusFilter(status)}
                />
              ))}
            </div>
          </div>

          {hasResults ? (
            <p className="mb-3 text-[12px] text-text-secondary">
              Showing {visibleBookings.length} of {bookings.length} booking
              {bookings.length === 1 ? '' : 's'}.
            </p>
          ) : null}

          {loading ? (
            <AppCard padding="none" elevation="card">
              <EmptyState title="Loading bookings…" body="Fetching the latest appointment list." />
            </AppCard>
          ) : visibleBookings.length === 0 ? (
            <AppCard padding="none" elevation="card">
              <EmptyState
                title={bookings.length === 0 ? 'No bookings yet' : 'No bookings match these filters'}
                body={
                  bookings.length === 0
                    ? 'Bookings will appear here as clients schedule appointments.'
                    : 'Try clearing the search or switching to All.'
                }
              />
            </AppCard>
          ) : (
            <>
              {/* Desktop: dense management table */}
              <AppCard padding="none" elevation="card" className="hidden overflow-hidden lg:block">
                <table className="w-full text-left text-[13px]">
                  <thead className="bg-surface-alt text-[11px] font-medium uppercase tracking-[0.08em] text-text-secondary">
                    <tr>
                      <th className="border-l-[3px] border-l-transparent px-4 py-3">Client</th>
                      <th className="px-4 py-3">Service</th>
                      <th className="px-4 py-3">Date &amp; time</th>
                      <th className="px-4 py-3">Duration</th>
                      <th className="px-4 py-3">Status</th>
                      <th className="px-4 py-3">Deposit</th>
                      <th className="px-4 py-3 text-right">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {visibleBookings.map((booking) => (
                      <BookingRow
                        key={booking.id}
                        booking={booking}
                        completing={completionLoadingId === booking.id}
                        onComplete={() => void handleComplete(booking)}
                      />
                    ))}
                  </tbody>
                </table>
              </AppCard>

              {/* Mobile / tablet: stacked booking cards */}
              <div className="grid gap-3 lg:hidden">
                {visibleBookings.map((booking) => (
                  <BookingCard
                    key={booking.id}
                    booking={booking}
                    completing={completionLoadingId === booking.id}
                    onComplete={() => void handleComplete(booking)}
                  />
                ))}
              </div>
            </>
          )}
        </>
      )}
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

function BookingRow({
  booking,
  completing,
  onComplete,
}: {
  booking: StaffBookingSummary;
  completing: boolean;
  onComplete: () => void;
}) {
  const tone = statusTone(booking.status);
  const accent = statusAccent(tone);
  return (
    <tr className={`transition-colors hover:bg-surface-alt/40 ${booking.status === 'paid' ? 'bg-surface-alt/60' : ''}`}>
      <td className={`border-l-[3px] ${accent.border} px-4 py-3`}>
        <div className="font-medium text-text-primary">{booking.clientDisplayName}</div>
        {booking.clientNote ? (
          <div className="mt-0.5 max-w-xs truncate text-[12px] text-warning">Note: {booking.clientNote}</div>
        ) : null}
      </td>
      <td className="px-4 py-3 text-text-secondary">{booking.serviceNames.join(', ') || 'Service'}</td>
      <td className="px-4 py-3 text-text-secondary">
        <div>{formatDate(booking.startsAt)}</div>
        <div className="text-[12px]">
          {formatTime(booking.startsAt)} – {formatTime(booking.endsAt)}
        </div>
      </td>
      <td className="px-4 py-3 text-text-secondary">
        {booking.durationMinutes ? `${booking.durationMinutes} min` : 'Not set'}
      </td>
      <td className="px-4 py-3">
        <StatusBadge label={formatStatus(booking.status)} tone={tone} />
      </td>
      <td className="px-4 py-3 text-text-secondary">{depositLabel(booking)}</td>
      <td className="px-4 py-3 text-right">
        <CompleteButton booking={booking} completing={completing} onComplete={onComplete} />
      </td>
    </tr>
  );
}

function BookingCard({
  booking,
  completing,
  onComplete,
}: {
  booking: StaffBookingSummary;
  completing: boolean;
  onComplete: () => void;
}) {
  const tone = statusTone(booking.status);
  const accent = statusAccent(tone);
  return (
    <AppCard padding="none" elevation="card" className="overflow-hidden">
      <div className="flex">
        <div className={`w-1 shrink-0 ${accent.bar}`} aria-hidden />
        <div className="min-w-0 flex-1 p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="truncate font-medium text-text-primary">{booking.clientDisplayName}</div>
              <div className="mt-0.5 truncate text-[13px] text-text-secondary">
                {booking.serviceNames.join(', ') || 'Service'}
              </div>
            </div>
            <StatusBadge label={formatStatus(booking.status)} tone={tone} />
          </div>
          {booking.clientNote ? (
            <div className="mt-2 rounded-input border border-border bg-surface-alt px-2.5 py-1.5 text-[12px] text-warning">
              Note: {booking.clientNote}
            </div>
          ) : null}
          <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2">
            <Field
              label="Date & time"
              value={`${formatDate(booking.startsAt)} · ${formatTime(booking.startsAt)} – ${formatTime(booking.endsAt)}`}
            />
            <Field label="Duration" value={booking.durationMinutes ? `${booking.durationMinutes} min` : 'Not set'} />
            <Field label="Deposit" value={depositLabel(booking)} />
          </dl>
          <div className="mt-3">
            <CompleteButton booking={booking} completing={completing} onComplete={onComplete} fullWidth />
          </div>
        </div>
      </div>
    </AppCard>
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
        <BillMetric label="Colour/formula" value={formatMoney(summary.billing.formulaColourTotalCents, summary.billing.currencyCode)} />
        <BillMetric label="Gross total" value={formatMoney(summary.billing.totalCents, summary.billing.currencyCode)} />
        <BillMetric label="Deposit paid" value={formatMoney(summary.billing.depositPaidCents, summary.billing.currencyCode)} />
        <BillMetric label="Balance due" value={formatMoney(summary.billing.balanceDueCents, summary.billing.currencyCode)} strong />
      </div>

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

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] font-medium uppercase tracking-[0.08em] text-text-muted">{label}</dt>
      <dd className="mt-0.5 text-[13px] text-text-primary">{value}</dd>
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

function SearchIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.6} aria-hidden {...props}>
      <circle cx="9" cy="9" r="6" />
      <path d="m17 17-3.5-3.5" strokeLinecap="round" />
    </svg>
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

function ChevronLeftIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden {...props}>
      <path d="M12 5 7 10l5 5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ChevronRightIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden {...props}>
      <path d="m8 5 5 5-5 5" strokeLinecap="round" strokeLinejoin="round" />
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

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  });
}

function formatDayHeading(day: Date): string {
  return day.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
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

function statusAccent(tone: StatusTone): { bar: string; border: string } {
  switch (tone) {
    case 'success':
      return { bar: 'bg-success-fill', border: 'border-l-success-fill' };
    case 'warning':
      return { bar: 'bg-warning-fill', border: 'border-l-warning-fill' };
    case 'danger':
      return { bar: 'bg-danger-fill', border: 'border-l-danger-fill' };
    default:
      return { bar: 'bg-border-strong', border: 'border-l-border-strong' };
  }
}

function depositLabel(booking: StaffBookingSummary): string {
  if (!booking.depositRequiredAmount) return 'None';
  return booking.depositStatus ? formatStatus(booking.depositStatus) : 'Required';
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
