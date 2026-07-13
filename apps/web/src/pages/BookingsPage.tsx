import { useCallback, useEffect, useMemo, useState, type ReactNode, type SVGProps } from 'react';
import { useNavigate } from 'react-router-dom';
import type {
  AppointmentCompletionLineItem,
  AppointmentCompletionResponse,
  BookOutType,
  CreateStylistRebookingRequest,
  PublicBookingServiceSummary,
  RescheduleAppointmentRequest,
  RotaStaffSummary,
  StaffBookingServiceLine,
  StaffBookingSummary,
  WeeklyRotaResponse,
} from '@sheer/domain';
import { userHasAnyRole } from '@sheer/domain';
import { AppButton, AppCard, Pill, StatusBadge } from '../design';
import {
  acceptBooking,
  ApiRequestError,
  cancelBooking,
  checkInBooking,
  completeBooking,
  confirmBookingPayment,
  createStylistRebooking,
  getStaffBookingSelection,
  getWeeklyRota,
  listBookings,
  listBookOutTypes,
  listServiceCategories,
  listServices,
  markRotaAbsence,
  rejectBooking,
  rescheduleBooking,
} from '../auth/api';
import { useAuth } from '../auth/AuthProvider';
import { useLocationScope } from '../components/LocationScopeContext';
import {
  DayCalendarBoard,
  type AddAppointmentInput,
  type AddBookoutInput,
  type MoveBookingInput,
  type ResizeBookingInput,
} from '../components/bookings/DayCalendarBoard';
import { WeekStrip } from '../components/bookings/WeekStrip';
import { ClientProfileModal } from '../components/bookings/ClientProfileModal';
import type { CalendarToolbarKey, CalendarToolbarState } from '../components/bookings/CalendarToolbar';
import { isSameLocalDay, snapToMonday, toIsoDate } from '../components/rota/dateUtils';

export function BookingsPage() {
  const auth = useAuth();
  const navigate = useNavigate();
  const accessToken = auth.session?.accessToken;
  // The active location is owned by the sidebar's location picker (shared scope).
  // The day calendar board is single-location, so "All" resolves to the first
  // location rather than trying to render every salon at once.
  const { resolvedLocationId: selectedLocationId } = useLocationScope();

  const [bookings, setBookings] = useState<StaffBookingSummary[]>([]);
  // serviceId → category colour, so each appointment tile can be tinted by its
  // (first) service's category on the calendar. Cosmetic — failures are ignored.
  const [serviceColors, setServiceColors] = useState<Map<string, string>>(() => new Map());
  // Lower-cased service name → category colour. Fallback used when an
  // appointment's service rows carry only a name snapshot (no service id).
  const [serviceColorsByName, setServiceColorsByName] = useState<Map<string, string>>(() => new Map());
  // Categories that carry a colour, for the calendar legend (name + swatch).
  const [colorLegend, setColorLegend] = useState<{ id: string; name: string; colorHex: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [completionLoadingId, setCompletionLoadingId] = useState<string | null>(null);
  const [paymentLoadingId, setPaymentLoadingId] = useState<string | null>(null);
  const [checkoutSummary, setCheckoutSummary] = useState<AppointmentCompletionResponse | null>(null);
  const [paymentMethod, setPaymentMethod] = useState<'cash' | 'card_reader'>('card_reader');
  const [checkoutMessage, setCheckoutMessage] = useState<string | null>(null);
  const [rebookingLoading, setRebookingLoading] = useState(false);
  const [rebookingSkipped, setRebookingSkipped] = useState<Record<string, boolean>>({});
  const [reviewLoadingId, setReviewLoadingId] = useState<string | null>(null);
  const [actionLoadingId, setActionLoadingId] = useState<string | null>(null);
  const [rescheduleTarget, setRescheduleTarget] = useState<StaffBookingSummary | null>(null);
  const [rescheduleLoading, setRescheduleLoading] = useState(false);
  const [cancelTarget, setCancelTarget] = useState<StaffBookingSummary | null>(null);
  const [cancelLoading, setCancelLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isReviewer = userHasAnyRole(auth.user, ['owner', 'manager']);

  // Calendar state. The timetable spans the full page width and appointments
  // are selected straight from the board.
  const [day, setDay] = useState<Date>(() => new Date());
  const [rota, setRota] = useState<WeeklyRotaResponse | null>(null);
  const [rotaLoading, setRotaLoading] = useState(false);
  const [rotaError, setRotaError] = useState<string | null>(null);
  // Bumped to re-fetch the rota (e.g. after creating a bookout) so the board updates.
  const [rotaReloadNonce, setRotaReloadNonce] = useState(0);
  const [selectedBookingId, setSelectedBookingId] = useState<string | null>(null);
  // Configurable book-out reasons, powering the bookout picker + utilisation.
  const [bookOutTypes, setBookOutTypes] = useState<BookOutType[]>([]);
  // Double-tapping a tile opens this client's profile quick-look.
  const [profileClient, setProfileClient] = useState<{ id: string; name: string } | null>(null);
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

  const handleCheckIn = useCallback(
    async (booking: StaffBookingSummary) => {
      if (!accessToken || actionLoadingId) return;
      setActionLoadingId(booking.id);
      setCheckoutMessage(null);
      setError(null);
      try {
        const result = await checkInBooking(accessToken, booking.id);
        setBookings((current) =>
          current.map((entry) => (entry.id === booking.id ? { ...entry, ...result.appointment } : entry)),
        );
        setCheckoutMessage(
          `${result.appointment.clientDisplayName} is checked in. Their stylist will see them marked as arrived on the book.`,
        );
      } catch (err: unknown) {
        if (err instanceof ApiRequestError) setError(err.message);
        else if (err instanceof Error) setError(err.message);
        else setError('Could not check in the client');
      } finally {
        setActionLoadingId(null);
      }
    },
    [accessToken, actionLoadingId],
  );

  // Submits the cancellation once the owner/manager has confirmed a reason and (if
  // a deposit was paid) whether to refund or keep it. The choice is collected in
  // CancelModal — this only fires the request.
  const handleCancelBooking = useCallback(
    async (booking: StaffBookingSummary, input: { reason?: string; refundDeposit: boolean }) => {
      if (!accessToken || cancelLoading) return;
      setCancelLoading(true);
      setCheckoutMessage(null);
      setError(null);
      try {
        const result = await cancelBooking(accessToken, booking.id, {
          reason: input.reason,
          refundDeposit: input.refundDeposit,
        });
        setBookings((current) =>
          current.map((entry) => (entry.id === booking.id ? { ...entry, ...result.appointment } : entry)),
        );
        const refundNote = result.depositRefunded
          ? ' Deposit refunded.'
          : result.refundError
            ? ` Deposit refund failed: ${result.refundError}`
            : result.depositForfeited
              ? ' Deposit kept (not refunded).'
              : '';
        setCheckoutMessage(`Cancelled ${result.appointment.clientDisplayName}'s appointment.${refundNote}`);
        setCancelTarget(null);
      } catch (err: unknown) {
        if (err instanceof ApiRequestError) setError(err.message);
        else if (err instanceof Error) setError(err.message);
        else setError('Could not cancel the appointment');
      } finally {
        setCancelLoading(false);
      }
    },
    [accessToken, cancelLoading],
  );

  const handleReschedule = useCallback(
    async (
      booking: StaffBookingSummary,
      scheduledStartAt: string,
      staffProfileId?: string,
      serviceIds?: string[],
      durationMinutes?: number,
    ) => {
      if (!accessToken) return;
      setRescheduleLoading(true);
      setError(null);
      try {
        const result = await rescheduleBooking(accessToken, booking.id, {
          scheduledStartAt,
          staffProfileId,
          serviceIds,
          durationMinutes,
        });
        setBookings((current) =>
          current.map((entry) => (entry.id === booking.id ? { ...entry, ...result.appointment } : entry)),
        );
        setRescheduleTarget(null);
        // A pure length change (no time/stylist move) reads better as a resize.
        const timeChanged = new Date(result.appointment.startsAt).getTime() !== new Date(booking.startsAt).getTime();
        const staffChanged = Boolean(staffProfileId) && staffProfileId !== booking.assignedStaffProfileId;
        setCheckoutMessage(
          durationMinutes != null && !timeChanged && !staffChanged
            ? `Updated ${result.appointment.clientDisplayName}'s appointment length.`
            : `Moved ${result.appointment.clientDisplayName}'s appointment to ${formatDateTime(result.appointment.startsAt)}.`,
        );
      } catch (err: unknown) {
        if (err instanceof ApiRequestError) setError(err.message);
        else if (err instanceof Error) setError(err.message);
        else setError('Could not reschedule the appointment');
      } finally {
        setRescheduleLoading(false);
      }
    },
    [accessToken],
  );

  // Drag operations update the board OPTIMISTICALLY (the tile moves/resizes the
  // instant you drop it) and reconcile with the server response, reverting to the
  // pre-drag state on failure. This keeps the calendar smooth instead of waiting a
  // round-trip before the tile appears in its new place.
  const commitDrag = useCallback(
    async (
      booking: StaffBookingSummary,
      optimistic: StaffBookingSummary,
      payload: RescheduleAppointmentRequest,
      message: (appointment: StaffBookingSummary) => string,
    ) => {
      if (!accessToken) return;
      setError(null);
      setBookings((current) => current.map((entry) => (entry.id === booking.id ? optimistic : entry)));
      try {
        const result = await rescheduleBooking(accessToken, booking.id, payload);
        setBookings((current) =>
          current.map((entry) => (entry.id === booking.id ? { ...entry, ...result.appointment } : entry)),
        );
        setCheckoutMessage(message(result.appointment));
      } catch (err: unknown) {
        // Roll the tile back to exactly where it was before the drag.
        setBookings((current) => current.map((entry) => (entry.id === booking.id ? booking : entry)));
        if (err instanceof ApiRequestError) setError(err.message);
        else if (err instanceof Error) setError(err.message);
        else setError('Could not update the appointment');
      }
    },
    [accessToken],
  );

  // Drag-to-move / drag-to-reassign from the board.
  const handleMoveBooking = useCallback(
    (booking: StaffBookingSummary, input: MoveBookingInput) => {
      const staffChanged = Boolean(input.staffProfileId) && input.staffProfileId !== booking.assignedStaffProfileId;
      void commitDrag(
        booking,
        optimisticMove(booking, input.startAt, staffChanged ? input.staffProfileId : undefined),
        { scheduledStartAt: input.startAt, staffProfileId: input.staffProfileId },
        (appointment) => `Moved ${appointment.clientDisplayName}'s appointment to ${formatDateTime(appointment.startsAt)}.`,
      );
    },
    [commitDrag],
  );

  // Drag-to-resize (bottom edge) → keep the start, change the total duration. The API
  // grows/shrinks the last stylist-occupied segment to match.
  const handleResizeBooking = useCallback(
    (booking: StaffBookingSummary, input: ResizeBookingInput) => {
      void commitDrag(
        booking,
        optimisticResize(booking, input.durationMinutes),
        { scheduledStartAt: booking.startsAt, durationMinutes: input.durationMinutes },
        (appointment) => `Updated ${appointment.clientDisplayName}'s appointment length.`,
      );
    },
    [commitDrag],
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

  const handleAcceptRequest = useCallback(
    async (booking: StaffBookingSummary) => {
      if (!accessToken) return;
      setReviewLoadingId(booking.id);
      setError(null);
      setCheckoutMessage(null);
      try {
        const result = await acceptBooking(accessToken, booking.id);
        setBookings((current) =>
          current.map((entry) => (entry.id === booking.id ? { ...entry, ...result.appointment } : entry)),
        );
        setCheckoutMessage(`Accepted ${result.appointment.clientDisplayName}'s booking. They've been notified.`);
      } catch (err: unknown) {
        if (err instanceof ApiRequestError) setError(err.message);
        else if (err instanceof Error) setError(err.message);
        else setError('Could not accept booking');
      } finally {
        setReviewLoadingId(null);
      }
    },
    [accessToken],
  );

  const handleRejectRequest = useCallback(
    async (booking: StaffBookingSummary) => {
      if (!accessToken) return;
      const reason = window.prompt(`Reject ${booking.clientDisplayName}'s booking? Add an optional reason:`, '');
      // `null` means the prompt was cancelled — abort. An empty string is a valid "no reason".
      if (reason === null) return;
      setReviewLoadingId(booking.id);
      setError(null);
      setCheckoutMessage(null);
      try {
        const result = await rejectBooking(accessToken, booking.id, { reason: reason.trim() || undefined });
        setBookings((current) =>
          current.map((entry) => (entry.id === booking.id ? { ...entry, ...result.appointment } : entry)),
        );
        const refundNote = result.depositRefunded
          ? ' Deposit refunded.'
          : result.refundError
            ? ` Deposit refund failed: ${result.refundError}`
            : '';
        setCheckoutMessage(`Rejected ${result.appointment.clientDisplayName}'s booking.${refundNote}`);
      } catch (err: unknown) {
        if (err instanceof ApiRequestError) setError(err.message);
        else if (err instanceof Error) setError(err.message);
        else setError('Could not reject booking');
      } finally {
        setReviewLoadingId(null);
      }
    },
    [accessToken],
  );

  const handleCloseCheckout = useCallback(() => {
    setCheckoutSummary(null);
    setCheckoutMessage(null);
  }, []);

  // Primary "add from the book" flow: jump into the booking screen with the
  // clicked stylist, date and time prefilled.
  const handleAddAppointment = useCallback(
    (input: AddAppointmentInput) => {
      const params = new URLSearchParams({
        staffProfileId: input.staffProfileId,
        staffName: input.staffName,
        startAt: input.startAt,
      });
      if (selectedLocationId) params.set('locationId', selectedLocationId);
      navigate(`/bookings/new?${params.toString()}`);
    },
    [navigate, selectedLocationId],
  );

  // Bookout = a block of the stylist's time. Reuses the rota absence primitive
  // (type 'other'), which the availability engine already treats as busy.
  const handleAddBookout = useCallback(
    async (input: AddBookoutInput) => {
      if (!accessToken || !selectedLocationId) return;
      setError(null);
      setCheckoutMessage(null);
      try {
        await markRotaAbsence(accessToken, {
          staffProfileId: input.staffProfileId,
          locationId: selectedLocationId,
          absenceType: 'other',
          startsAt: input.startAt,
          endsAt: input.endsAt,
          notes: input.notes ?? 'Bookout',
          bookOutTypeId: input.bookOutTypeId,
        });
        setRotaReloadNonce((nonce) => nonce + 1);
        setCheckoutMessage(`Bookout added for ${input.staffName} at ${formatTime(input.startAt)}.`);
      } catch (err: unknown) {
        if (err instanceof ApiRequestError) setError(err.message);
        else if (err instanceof Error) setError(err.message);
        else setError('Could not add bookout');
      }
    },
    [accessToken, selectedLocationId],
  );

  useEffect(() => {
    void reload();
  }, [reload]);

  // Load configurable book-out types once (reviewers only) for the bookout
  // picker and the utilisation badge; failures degrade to a general book out.
  useEffect(() => {
    if (!accessToken || !isReviewer) return;
    let cancelled = false;
    void (async () => {
      try {
        const result = await listBookOutTypes(accessToken);
        if (!cancelled) setBookOutTypes(result.bookOutTypes);
      } catch {
        if (!cancelled) setBookOutTypes([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [accessToken, isReviewer]);

  // Build the serviceId → category-colour map once. Categories own the colour;
  // a service inherits its category's colour. Business-scoped, so location-agnostic.
  useEffect(() => {
    if (!accessToken) return;
    let cancelled = false;
    Promise.all([
      listServiceCategories(accessToken, { includeInactive: true }),
      listServices(accessToken, { includeInactive: true }),
    ])
      .then(([categoryResult, serviceResult]) => {
        if (cancelled) return;
        const colorByCategory = new Map<string, string>();
        const legend: { id: string; name: string; colorHex: string }[] = [];
        for (const category of categoryResult.categories) {
          if (category.colorHex) {
            colorByCategory.set(category.id, category.colorHex);
            legend.push({ id: category.id, name: category.name, colorHex: category.colorHex });
          }
        }
        const byId = new Map<string, string>();
        const byName = new Map<string, string>();
        // Names can collide across categories/locations; the name fallback must not
        // tint with an arbitrary winner, so a name that maps to two different colours
        // is dropped (stays neutral). The id map is preferred and unaffected.
        const nameConflicts = new Set<string>();
        for (const service of serviceResult.services) {
          const color = service.serviceCategoryId ? colorByCategory.get(service.serviceCategoryId) : undefined;
          if (!color) continue;
          byId.set(service.id, color);
          const nameKey = service.name.trim().toLowerCase();
          if (nameConflicts.has(nameKey)) continue;
          const existing = byName.get(nameKey);
          if (existing === undefined) byName.set(nameKey, color);
          else if (existing !== color) {
            byName.delete(nameKey);
            nameConflicts.add(nameKey);
          }
        }
        setServiceColors(byId);
        setServiceColorsByName(byName);
        setColorLegend(legend);
      })
      .catch(() => {
        // Tile colour is purely cosmetic; if the catalogue can't be loaded the
        // calendar simply falls back to neutral tiles.
      });
    return () => {
      cancelled = true;
    };
  }, [accessToken]);

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
  }, [accessToken, selectedLocationId, weekStartIso, rotaReloadNonce]);

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

  // Client-requested bookings awaiting owner/manager review (across all of the
  // signed-in user's locations, regardless of the day the calendar is showing).
  const pendingRequests = useMemo(
    () =>
      bookings
        .filter((booking) => booking.status === 'pending')
        .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt)),
    [bookings],
  );

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
    <div className="flex h-full min-h-0 w-full flex-col px-4 py-5 lg:px-6">
      {error ? (
        <div className="mb-4 shrink-0 rounded-input-lg border border-danger-border bg-danger-soft px-4 py-3 text-[13px] text-danger">
          {error}
        </div>
      ) : null}

      {checkoutMessage ? (
        <div className="mb-4 shrink-0 rounded-input-lg border border-success-border bg-success-soft px-4 py-3 text-[13px] text-success">
          {checkoutMessage}
        </div>
      ) : null}

      {isReviewer && pendingRequests.length > 0 ? (
        <PendingRequestsPanel
          requests={pendingRequests}
          reviewLoadingId={reviewLoadingId}
          onAccept={(booking) => void handleAcceptRequest(booking)}
          onReject={(booking) => void handleRejectRequest(booking)}
        />
      ) : null}

      {completionLoadingId && !checkoutSummary ? (
        <ModalScrim label="Opening checkout">
          <AppCard elevation="hero" padding="lg" className="rounded-card-lg">
            <div className="flex items-center justify-center gap-3 py-4 text-[14px] font-medium text-text-secondary">
              <span
                className="h-4 w-4 animate-spin rounded-full border-2 border-border border-t-primary"
                aria-hidden
              />
              Preparing checkout…
            </div>
          </AppCard>
        </ModalScrim>
      ) : null}

      {checkoutSummary ? (
        <ModalScrim onClose={handleCloseCheckout} label="Checkout">
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
        </ModalScrim>
      ) : null}

      {rescheduleTarget ? (
        <ModalScrim onClose={() => setRescheduleTarget(null)} label="Reschedule appointment">
          <RescheduleModal
            booking={rescheduleTarget}
            staff={rota?.staff ?? []}
            accessToken={accessToken ?? ''}
            loading={rescheduleLoading}
            onSubmit={(scheduledStartAt, staffProfileId, serviceIds) =>
              void handleReschedule(rescheduleTarget, scheduledStartAt, staffProfileId, serviceIds)
            }
            onClose={() => setRescheduleTarget(null)}
          />
        </ModalScrim>
      ) : null}

      {cancelTarget ? (
        <ModalScrim
          onClose={cancelLoading ? undefined : () => setCancelTarget(null)}
          label="Cancel appointment"
        >
          <CancelModal
            booking={cancelTarget}
            loading={cancelLoading}
            onSubmit={(input) => void handleCancelBooking(cancelTarget, input)}
            onClose={() => setCancelTarget(null)}
          />
        </ModalScrim>
      ) : null}

      <ClientProfileModal
        clientId={profileClient?.id ?? null}
        clientName={profileClient?.name}
        accessToken={accessToken}
        onClose={() => setProfileClient(null)}
      />

      {/* Calendar + timetable claim the full page width. Appointments are acted
          on directly from the board: clicking a tile opens an action menu (check
          in / out, edit, cancel). The location picker / refresh live in the toolbar. */}
      <div className="flex min-h-0 flex-1 flex-col gap-4">
        <div className="shrink-0">
          <WeekStrip
            day={day}
            onSelectDay={setDay}
            toolbar={toolbar}
            onToggleToolbar={toggleToolbar}
            toolbarTrailing={calendarControls}
          />
        </div>

        {colorLegend.length > 0 ? <CategoryLegend categories={colorLegend} /> : null}

        {!selectedLocationId ? (
          <AppCard padding="none" elevation="card" className="flex min-h-0 flex-1 items-center justify-center">
            <EmptyState title="No location available" body="A salon location is needed to show the calendar." />
          </AppCard>
        ) : rotaError ? (
          <div className="shrink-0 rounded-input-lg border border-danger-border bg-danger-soft px-4 py-3 text-[13px] text-danger">
            {rotaError}
          </div>
        ) : (loading || rotaLoading) && !rota ? (
          <AppCard padding="none" elevation="card" className="flex min-h-0 flex-1 items-center justify-center">
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
            bookOutTypes={bookOutTypes}
            serviceColors={serviceColors}
            serviceColorsByName={serviceColorsByName}
            selectedBookingId={selectedBookingId}
            onSelectBooking={(booking) => setSelectedBookingId(booking.id)}
            onViewClientProfile={(booking) =>
              setProfileClient({ id: booking.clientProfileId, name: booking.clientDisplayName })
            }
            onCheckIn={(booking) => void handleCheckIn(booking)}
            onCheckOut={(booking) => void handleComplete(booking)}
            onEditBooking={(booking) => setRescheduleTarget(booking)}
            // Cancelling can refund the deposit, so it's an owner/manager action (mirrors
            // reject). Opens a confirm modal where they add a reason and pick refund vs keep.
            onCancelBooking={isReviewer ? (booking) => setCancelTarget(booking) : undefined}
            showAllTeamMembers={toolbar.showAllTeamMembers}
            showTimeline={toolbar.showTimeline}
            onAddAppointment={handleAddAppointment}
            onAddBookout={(input) => void handleAddBookout(input)}
            onMoveBooking={handleMoveBooking}
            onResizeBooking={handleResizeBooking}
            onDragBlocked={(staffName) =>
              setError(`Can’t place the appointment outside ${staffName}’s working hours.`)
            }
          />
        )}
      </div>
    </div>
  );
}

function PendingRequestsPanel({
  requests,
  reviewLoadingId,
  onAccept,
  onReject,
}: {
  requests: StaffBookingSummary[];
  reviewLoadingId: string | null;
  onAccept: (booking: StaffBookingSummary) => void;
  onReject: (booking: StaffBookingSummary) => void;
}) {
  return (
    <AppCard elevation="hero" padding="lg" className="mb-4 rounded-card-lg border border-warning-border bg-warning-soft/40">
      <div className="flex items-center gap-2">
        <span className="inline-flex h-6 min-w-6 items-center justify-center rounded-pill bg-warning px-2 text-[12px] font-semibold text-text-on-primary">
          {requests.length}
        </span>
        <h2 className="text-[15px] font-semibold text-text-primary">
          New booking {requests.length === 1 ? 'request' : 'requests'} awaiting your review
        </h2>
      </div>
      <ul className="mt-3 flex flex-col gap-2">
        {requests.map((booking) => {
          const loading = reviewLoadingId === booking.id;
          return (
            <li
              key={booking.id}
              className="flex flex-col gap-3 rounded-input-lg border border-border bg-surface px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="min-w-0">
                <div className="truncate text-[14px] font-medium text-text-primary">{booking.clientDisplayName}</div>
                <div className="mt-0.5 truncate text-[12px] text-text-secondary">
                  {(booking.serviceNames.join(', ') || 'Service')} · {formatDateTime(booking.startsAt)}
                  {booking.depositRequiredAmount ? ' · deposit paid' : ''}
                </div>
                {booking.clientNote ? (
                  <div className="mt-0.5 truncate text-[12px] text-text-muted">“{booking.clientNote}”</div>
                ) : null}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <AppButton size="sm" variant="secondary" disabled={loading} onClick={() => onReject(booking)}>
                  Reject
                </AppButton>
                <AppButton size="sm" variant="primary" loading={loading} onClick={() => onAccept(booking)}>
                  Accept
                </AppButton>
              </div>
            </li>
          );
        })}
      </ul>
    </AppCard>
  );
}

// Centered modal scaffold used for the checkout "payment screen" and the
// reschedule editor. Clicking the dimmed backdrop closes it; clicks inside the
// card are kept. Tall content scrolls within the overlay rather than the page.
function ModalScrim({ onClose, label, children }: { onClose?: () => void; label: string; children: ReactNode }) {
  return (
    <div
      className="fixed inset-0 z-50 overflow-y-auto bg-black/40"
      role="dialog"
      aria-modal="true"
      aria-label={label}
      onClick={onClose}
    >
      <div className="flex min-h-full items-start justify-center p-4 sm:items-center">
        <div className="relative z-10 my-4 w-full max-w-2xl" onClick={(event) => event.stopPropagation()}>
          {children}
        </div>
      </div>
    </div>
  );
}

// Edit-appointment editor: pick a new start time, (optionally) reassign the
// stylist, and (optionally) change the services on the booking. Changing the
// services re-prices the appointment and recomputes its duration server-side; the
// assigned stylist must be able to perform every selected service.
function RescheduleModal({
  booking,
  staff,
  accessToken,
  loading,
  onSubmit,
  onClose,
}: {
  booking: StaffBookingSummary;
  staff: RotaStaffSummary[];
  accessToken: string;
  loading: boolean;
  onSubmit: (scheduledStartAt: string, staffProfileId?: string, serviceIds?: string[]) => void;
  onClose: () => void;
}) {
  const [startAt, setStartAt] = useState(() => toDatetimeLocalValue(new Date(booking.startsAt)));
  const [staffProfileId, setStaffProfileId] = useState(booking.assignedStaffProfileId ?? '');

  // The service list comes from the location catalogue, loaded lazily. Until it
  // arrives (or if it fails) the service editor is hidden and the modal behaves
  // exactly as before — only time/stylist can change.
  const originalServiceIds = useMemo(() => booking.serviceIds ?? [], [booking.serviceIds]);
  const [catalog, setCatalog] = useState<PublicBookingServiceSummary[] | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [selectedServiceIds, setSelectedServiceIds] = useState<string[]>(originalServiceIds);

  useEffect(() => {
    if (!accessToken) return;
    let cancelled = false;
    setCatalogError(null);
    getStaffBookingSelection(accessToken, { locationId: booking.locationId })
      .then((response) => {
        if (cancelled) return;
        setCatalog(response.services);
      })
      .catch(() => {
        if (!cancelled) {
          setCatalogError('Could not load the service list — you can still change the time and stylist.');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [accessToken, booking.locationId]);

  // Build options so the controlled <select> value always has a matching <option>
  // (otherwise the browser shows the first stylist while state stays '' and the
  // manager's pick is silently dropped). An unassigned booking keeps a real ''
  // "Unassigned" option; an off-rota assigned stylist stays selectable so a pure
  // time change never reassigns the booking.
  const options = useMemo(() => {
    const list = staff.map((member) => ({
      id: member.staffProfileId,
      name: member.displayName || member.fullName || 'Stylist',
    }));
    if (booking.assignedStaffProfileId && !list.some((option) => option.id === booking.assignedStaffProfileId)) {
      list.unshift({ id: booking.assignedStaffProfileId, name: 'Current stylist' });
    }
    if (!booking.assignedStaffProfileId) {
      list.unshift({ id: '', name: 'Unassigned' });
    }
    return list;
  }, [staff, booking.assignedStaffProfileId]);

  const selectedServices = useMemo(
    () => (catalog ?? []).filter((service) => selectedServiceIds.includes(service.id)),
    [catalog, selectedServiceIds],
  );
  const totalDurationMinutes = useMemo(
    () => selectedServices.reduce((sum, service) => sum + service.estimatedDurationMinutes, 0),
    [selectedServices],
  );
  const totalPriceAmount = useMemo(
    () => selectedServices.reduce((sum, service) => sum + service.startingPriceAmount, 0),
    [selectedServices],
  );
  const currencyCode = catalog?.[0]?.currencyCode ?? 'GBP';

  // Whether the chosen services differ from the appointment's current ones. Only
  // then do we send `serviceIds`, so an unchanged save stays a plain time/stylist
  // move and skips the server-side re-price/eligibility checks.
  const servicesChanged = useMemo(() => {
    if (!catalog) return false;
    const next = new Set(selectedServiceIds);
    const current = new Set(originalServiceIds);
    if (next.size !== current.size) return true;
    for (const id of next) {
      if (!current.has(id)) return true;
    }
    return false;
  }, [catalog, selectedServiceIds, originalServiceIds]);

  function toggleService(serviceId: string) {
    setSelectedServiceIds((current) =>
      current.includes(serviceId) ? current.filter((id) => id !== serviceId) : [...current, serviceId],
    );
  }

  function submit() {
    const iso = toIsoFromLocalInput(startAt);
    if (!iso) return;
    onSubmit(iso, staffProfileId || undefined, servicesChanged ? selectedServiceIds : undefined);
  }

  // Block saving an empty service list — an appointment must keep at least one
  // service. Time/stylist-only edits (catalogue still loading) stay allowed.
  const canSave = Boolean(startAt) && (catalog === null || selectedServiceIds.length > 0);

  return (
    <AppCard elevation="hero" padding="lg" className="rounded-card-lg">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[15px] font-semibold text-text-primary">Edit appointment</div>
          <div className="mt-1 truncate text-[13px] text-text-secondary">
            {booking.clientDisplayName} · {booking.serviceNames.join(', ') || 'Service'}
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-pill border border-border text-text-secondary transition hover:bg-surface-alt hover:text-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
        >
          <CloseIcon className="h-4 w-4" />
        </button>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <label className="block text-[12px] font-medium text-text-secondary">
          New date &amp; time
          <input
            type="datetime-local"
            value={startAt}
            onChange={(event) => setStartAt(event.target.value)}
            className="mt-1 h-10 w-full rounded-input border border-border bg-surface px-3 text-[13px] text-text-primary outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20"
          />
        </label>
        <label className="block text-[12px] font-medium text-text-secondary">
          Stylist
          <select
            value={staffProfileId}
            onChange={(event) => setStaffProfileId(event.target.value)}
            className="mt-1 h-10 w-full rounded-input border border-border bg-surface px-3 text-[13px] text-text-primary outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20"
          >
            {options.length === 0 ? <option value="">Keep current stylist</option> : null}
            {options.map((option) => (
              <option key={option.id || 'unassigned'} value={option.id}>
                {option.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="mt-4">
        <div className="flex items-baseline justify-between gap-3">
          <div className="text-[12px] font-medium text-text-secondary">Services</div>
          {catalog ? (
            <div className="text-[12px] text-text-secondary">
              {selectedServiceIds.length} selected · {totalDurationMinutes} min ·{' '}
              {formatServicePrice(totalPriceAmount, currencyCode)}
            </div>
          ) : null}
        </div>

        {catalogError ? (
          <div className="mt-2 rounded-input-lg border border-warning-border bg-warning-soft px-3 py-2 text-[12px] text-warning">
            {catalogError}
          </div>
        ) : !catalog ? (
          <div className="mt-2 text-[12px] text-text-muted">Loading services…</div>
        ) : catalog.length === 0 ? (
          <div className="mt-2 text-[12px] text-text-muted">No bookable services for this location.</div>
        ) : (
          <ul className="mt-2 grid max-h-56 gap-2 overflow-y-auto pr-1 sm:grid-cols-2">
            {catalog.map((service) => {
              const checked = selectedServiceIds.includes(service.id);
              return (
                <li key={service.id}>
                  <label
                    className={`flex cursor-pointer items-start gap-3 rounded-input-lg border px-3 py-2.5 transition ${
                      checked
                        ? 'border-primary bg-primary/5'
                        : 'border-border-strong bg-surface hover:bg-surface-alt'
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleService(service.id)}
                      className="mt-0.5 h-4 w-4 rounded border-border-strong text-primary focus:ring-primary/20"
                    />
                    <span className="flex-1">
                      <span className="block text-[13px] font-medium text-text-primary">{service.name}</span>
                      <span className="block text-[12px] text-text-secondary">
                        {service.estimatedDurationMinutes} min ·{' '}
                        {formatServicePrice(service.startingPriceAmount, service.currencyCode)}
                      </span>
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="mt-3 text-[12px] text-text-muted">
        {servicesChanged
          ? 'Services changed — the price and duration update to match, and the stylist must be able to perform every selected service.'
          : 'Adjust the time, stylist, or services. Changing the services re-prices the appointment.'}
      </div>

      <div className="mt-4 flex items-center justify-end gap-2">
        <AppButton variant="secondary" onClick={onClose}>
          Cancel
        </AppButton>
        <AppButton variant="primary" loading={loading} disabled={!canSave} onClick={submit}>
          Save changes
        </AppButton>
      </div>
    </AppCard>
  );
}

// Cancel-appointment confirmation. Owner/manager adds an optional reason and — when
// a deposit has been paid — decides whether to refund it or keep it (forfeited).
// When no deposit was paid there's nothing to decide, so the refund choice is hidden
// and the request is sent with refundDeposit=true (a harmless no-op).
function CancelModal({
  booking,
  loading,
  onSubmit,
  onClose,
}: {
  booking: StaffBookingSummary;
  loading: boolean;
  onSubmit: (input: { reason?: string; refundDeposit: boolean }) => void;
  onClose: () => void;
}) {
  const hasPaidDeposit = booking.depositStatus === 'paid';
  const [reason, setReason] = useState('');
  const [refundDeposit, setRefundDeposit] = useState(true);

  function submit() {
    onSubmit({ reason: reason.trim() || undefined, refundDeposit: hasPaidDeposit ? refundDeposit : true });
  }

  const refundOptions = [
    {
      value: true,
      title: 'Refund the deposit',
      body: 'Return the paid deposit to the client via the original payment.',
    },
    {
      value: false,
      title: 'Keep the deposit',
      body: 'Cancel without refunding — the deposit is forfeited by the client.',
    },
  ];

  return (
    <AppCard elevation="hero" padding="lg" className="rounded-card-lg">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[15px] font-semibold text-text-primary">Cancel appointment</div>
          <div className="mt-1 truncate text-[13px] text-text-secondary">
            {booking.clientDisplayName} · {booking.serviceNames.join(', ') || 'Service'}
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-pill border border-border text-text-secondary transition hover:bg-surface-alt hover:text-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
        >
          <CloseIcon className="h-4 w-4" />
        </button>
      </div>

      <div className="mt-4 rounded-input-lg border border-warning-border bg-warning-soft/60 px-3 py-2 text-[12px] text-warning">
        The client will be notified that this appointment has been cancelled. This can’t be undone.
      </div>

      <label className="mt-4 block text-[12px] font-medium text-text-secondary">
        Reason (optional — shared with the client)
        <textarea
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          rows={2}
          maxLength={500}
          placeholder="e.g. Stylist unavailable"
          className="mt-1 w-full rounded-input border border-border bg-surface px-3 py-2 text-[13px] text-text-primary outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20"
        />
      </label>

      {hasPaidDeposit ? (
        <fieldset className="mt-4">
          <legend className="text-[12px] font-medium text-text-secondary">Deposit</legend>
          <div className="mt-2 grid gap-2">
            {refundOptions.map((option) => {
              const selected = refundDeposit === option.value;
              return (
                <label
                  key={String(option.value)}
                  className={`flex cursor-pointer items-start gap-3 rounded-input-lg border px-3 py-2.5 transition ${
                    selected ? 'border-primary bg-primary/5' : 'border-border-strong bg-surface hover:bg-surface-alt'
                  }`}
                >
                  <input
                    type="radio"
                    name="refund-deposit"
                    checked={selected}
                    onChange={() => setRefundDeposit(option.value)}
                    className="mt-0.5 h-4 w-4 border-border-strong text-primary focus:ring-primary/20"
                  />
                  <span className="flex-1">
                    <span className="block text-[13px] font-medium text-text-primary">{option.title}</span>
                    <span className="block text-[12px] text-text-secondary">{option.body}</span>
                  </span>
                </label>
              );
            })}
          </div>
        </fieldset>
      ) : (
        <div className="mt-4 text-[12px] text-text-muted">No deposit was paid for this appointment.</div>
      )}

      <div className="mt-5 flex items-center justify-end gap-2">
        <AppButton variant="secondary" onClick={onClose}>
          Keep appointment
        </AppButton>
        <AppButton variant="danger" loading={loading} onClick={submit}>
          Cancel appointment
        </AppButton>
      </div>
    </AppCard>
  );
}

// Catalogue prices are in major currency units (e.g. pounds), unlike the cents-based
// `formatMoney` used for billing totals elsewhere on this page.
function formatServicePrice(amount: number, currencyCode: string): string {
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: currencyCode,
  }).format(amount);
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
    <AppCard elevation="hero" padding="lg" className="rounded-card-lg">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="text-[15px] font-semibold text-text-primary">
            {isPaid ? 'Payment confirmed' : 'Checkout'}
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

      <ItemisedBill billing={summary.billing} />

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

  const clientName = summary.appointment.clientDisplayName;
  return (
    <div className="mt-4 rounded-input-lg border border-border bg-surface-alt p-3">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <div className="text-[13px] font-semibold text-text-primary">Book the next visit</div>
          <div className="mt-1 text-[12px] text-text-secondary">
            {rebooked
              ? `${clientName}'s next visit is booked in — they're all set.`
              : skipped
                ? 'No next visit booked. You can still book one before they leave.'
                : `Book ${clientName}'s next visit now so they leave with their next appointment in the diary.`}
          </div>
        </div>
        <StatusBadge
          label={rebooked ? 'Next visit booked' : skipped ? 'Skipped' : 'Not booked yet'}
          tone={rebooked ? 'success' : skipped ? 'neutral' : 'warning'}
        />
      </div>
      {!rebooked && !skipped ? (
        <div className="mt-3 flex flex-wrap gap-2">
          <AppButton size="sm" variant="primary" onClick={() => setOpen(true)}>
            Book next visit
          </AppButton>
          <AppButton size="sm" variant="secondary" onClick={onSkip}>
            Not today
          </AppButton>
        </div>
      ) : null}
      {open && !rebooked && !skipped ? (
        <div className="mt-3 grid gap-3 rounded-input-lg border border-border bg-surface p-3 lg:grid-cols-[1fr_1fr_auto] lg:items-end">
          <label className="block text-[12px] font-medium text-text-secondary">
            Next visit date &amp; time
            <input
              type="datetime-local"
              value={selectedStartAt}
              onChange={(event) => setSelectedStartAt(event.target.value)}
              className="mt-1 h-10 w-full rounded-input border border-border bg-surface px-3 text-[13px] text-text-primary outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20"
            />
          </label>
          <label className="block text-[12px] font-medium text-text-secondary">
            Note for the visit (optional)
            <input
              value={clientNote}
              onChange={(event) => setClientNote(event.target.value)}
              placeholder="e.g. 8 week toner refresh"
              className="mt-1 h-10 w-full rounded-input border border-border bg-surface px-3 text-[13px] text-text-primary outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20"
            />
          </label>
          <AppButton variant="primary" loading={loading} disabled={!selectedStartAt} onClick={submit}>
            Book it in
          </AppButton>
        </div>
      ) : null}
    </div>
  );
}

// Itemised checkout bill — a clean, receipt-style summary of what the salon
// collects at the till. Each service and each colour charge is its own line; a
// deposit already taken shows as a credit with a running subtotal, then the
// balance to collect stands alone in the footer.
//
// VAT is handled automatically server-side: the API still computes the tax
// rollup in billing.tax for records/reporting, but it is intentionally not shown
// here — staff and clients see clean, all-in prices, never a tax breakdown. The
// headline stays exactly billing.balanceDueCents, the only amount the
// confirm-payment endpoint accepts, so the bill and the charge can never diverge.
function ItemisedBill({ billing }: { billing: AppointmentCompletionResponse['billing'] }) {
  const cc = billing.currencyCode;
  const hasDeposit = billing.depositPaidCents > 0;

  // Group the API line items into the bill's sections. Anything that isn't a
  // service or colour charge is bucketed into "Other" so no line silently drops.
  const serviceLines = billing.lineItems.filter((line) => line.lineType === 'service');
  const colourLines = billing.lineItems.filter((line) => line.lineType === 'product_usage');
  const otherLines = billing.lineItems.filter(
    (line) => line.lineType !== 'service' && line.lineType !== 'product_usage',
  );

  return (
    <div className="mt-4 overflow-hidden rounded-input-lg border border-border bg-surface-alt/40">
      <div className="flex flex-col gap-5 px-5 py-4">
        <BillGroup
          title="Services"
          lines={serviceLines}
          fallbackLabel="Services"
          fallbackCents={billing.serviceTotalCents}
          currencyCode={cc}
        />

        <BillGroup
          title="Colour charge"
          note="Includes the salon's colour pricing policy."
          lines={colourLines}
          fallbackLabel="Colour charges"
          fallbackCents={billing.productUsageTotalCents}
          currencyCode={cc}
          hideWhenEmpty
        />

        {otherLines.length > 0 ? (
          <BillGroup title="Other charges" lines={otherLines} currencyCode={cc} />
        ) : null}

        {/* With a deposit taken, show the running subtotal and the credit so the
            arithmetic down to the balance stays transparent. */}
        {hasDeposit ? (
          <dl className="flex flex-col gap-1.5 border-t border-border/60 pt-3 text-[13px]">
            <BillRow label="Subtotal" value={formatMoney(billing.totalCents, cc)} />
            <BillRow label="Deposit paid" value={`− ${formatMoney(billing.depositPaidCents, cc)}`} />
          </dl>
        ) : null}
      </div>

      {/* The single figure the salon charges — exactly what confirm-payment expects. */}
      <div className="flex items-center justify-between gap-3 border-t border-border px-5 py-3.5">
        <span className="text-[13px] font-medium text-text-secondary">Total to collect</span>
        <span className="text-[22px] font-semibold text-text-primary tabular-nums">
          {formatMoney(billing.balanceDueCents, cc)}
        </span>
      </div>
    </div>
  );
}

// One labelled group of bill lines (Services / Colour charge / Other). Prefers the
// API's itemised lines; when a completion predates line items it falls back to the
// rolled-up category total so the figure is never lost. An optional group with no
// lines and a zero total is hidden rather than shown empty.
function BillGroup({
  title,
  note,
  lines,
  fallbackLabel,
  fallbackCents = 0,
  currencyCode,
  hideWhenEmpty = false,
}: {
  title: string;
  note?: string;
  lines: AppointmentCompletionLineItem[];
  fallbackLabel?: string;
  fallbackCents?: number;
  currencyCode: string;
  hideWhenEmpty?: boolean;
}) {
  const hasLines = lines.length > 0;
  if (!hasLines && (hideWhenEmpty || fallbackLabel === undefined) && fallbackCents <= 0) {
    return null;
  }
  return (
    <div>
      <span className="text-[12px] font-semibold uppercase tracking-[0.06em] text-text-secondary">{title}</span>
      {note ? <p className="mt-0.5 text-[11px] text-text-muted">{note}</p> : null}
      <dl className="mt-1.5 flex flex-col gap-1.5 text-[13px]">
        {hasLines ? (
          lines.map((line, index) => (
            <BillRow
              key={`${line.lineType}-${index}`}
              label={line.description}
              value={formatMoney(line.amountCents, currencyCode)}
            />
          ))
        ) : (
          <BillRow label={fallbackLabel ?? title} value={formatMoney(fallbackCents, currencyCode)} />
        )}
      </dl>
    </div>
  );
}

function BillRow({
  label,
  value,
  strong = false,
  muted = false,
  hint,
}: {
  label: string;
  value: string;
  strong?: boolean;
  muted?: boolean;
  hint?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className={muted ? 'text-text-muted' : strong ? 'font-semibold text-text-primary' : 'text-text-secondary'}>
        {label}
        {hint ? <span className="ml-1.5 text-[11px] text-text-muted">· {hint}</span> : null}
      </dt>
      <dd className={`tabular-nums ${muted ? 'text-text-muted' : strong ? 'font-semibold text-text-primary' : 'text-text-primary'}`}>
        {value}
      </dd>
    </div>
  );
}

// Compact colour key for the calendar — one swatch per category that carries a
// colour, so staff can read what each tile tint means. Wraps and scrolls rather
// than pushing the board down on small screens.
function CategoryLegend({ categories }: { categories: { id: string; name: string; colorHex: string }[] }) {
  return (
    <div className="shrink-0 flex flex-wrap items-center gap-x-3 gap-y-1.5 px-1">
      <span className="text-[11px] font-medium uppercase tracking-[0.06em] text-text-muted">Categories</span>
      {categories.map((category) => (
        <span key={category.id} className="inline-flex items-center gap-1.5 text-[11px] text-text-secondary">
          <span
            className="h-2.5 w-2.5 rounded-sm ring-1 ring-black/10"
            style={{ backgroundColor: category.colorHex }}
            aria-hidden
          />
          <span className="truncate">{category.name}</span>
        </span>
      ))}
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

// Build the optimistically-updated booking for a drag MOVE / reassign: shift the
// appointment (and every per-service window) by the drop delta, and reassign it when
// it landed on another stylist — so the tile jumps to its new place instantly, before
// the server confirms.
function optimisticMove(
  booking: StaffBookingSummary,
  startAt: string,
  staffProfileId: string | undefined,
): StaffBookingSummary {
  const deltaMs = new Date(startAt).getTime() - new Date(booking.startsAt).getTime();
  const shift = (iso: string) => new Date(new Date(iso).getTime() + deltaMs).toISOString();
  return {
    ...booking,
    startsAt: startAt,
    endsAt: shift(booking.endsAt),
    assignedStaffProfileId: staffProfileId ?? booking.assignedStaffProfileId,
    services: booking.services?.map((service) => ({
      ...service,
      startsAt: shift(service.startsAt),
      endsAt: shift(service.endsAt),
    })),
  };
}

// Minimum a service/segment can shrink to on resize — mirrors the API.
const RESIZE_MIN_UNIT_MINUTES = 5;

// Build the optimistically-resized booking, mirroring the API: the delta versus the
// current total is applied to the LAST stylist-occupied segment (development time
// stays fixed), then per-service windows cascade from the start. The server response
// reconciles any difference; a wholly-free appointment is left unchanged (as the API
// does). Falls back to just the header end when there is no per-service data.
function optimisticResize(booking: StaffBookingSummary, durationMinutes: number): StaffBookingSummary {
  const startMs = new Date(booking.startsAt).getTime();
  const services = booking.services ?? [];
  if (services.length === 0) {
    return { ...booking, endsAt: new Date(startMs + durationMinutes * 60_000).toISOString(), durationMinutes };
  }
  const currentTotal = services.reduce((sum, service) => sum + service.durationMinutes, 0);
  const delta = durationMinutes - currentTotal;

  // Locate the last stylist-occupied target, scanning from the end (a segment-less
  // service is wholly occupied; otherwise its last non-free segment).
  let targetService = -1;
  let targetSegment = -1;
  for (let i = services.length - 1; i >= 0 && targetService === -1; i -= 1) {
    const segments = services[i].segments ?? [];
    if (segments.length === 0) {
      targetService = i;
    } else {
      for (let j = segments.length - 1; j >= 0; j -= 1) {
        if (!segments[j].isStylistFree) {
          targetService = i;
          targetSegment = j;
          break;
        }
      }
    }
  }
  if (targetService === -1) return booking; // wholly stylist-free — the API leaves it as is

  const nextServices: StaffBookingServiceLine[] = services.map((service, i) => {
    if (i !== targetService) return { ...service };
    if (targetSegment === -1) {
      return { ...service, durationMinutes: Math.max(RESIZE_MIN_UNIT_MINUTES, service.durationMinutes + delta) };
    }
    const segments = (service.segments ?? []).map((segment, j) =>
      j === targetSegment
        ? { ...segment, durationMinutes: Math.max(RESIZE_MIN_UNIT_MINUTES, segment.durationMinutes + delta) }
        : segment,
    );
    return { ...service, segments, durationMinutes: segments.reduce((sum, seg) => sum + seg.durationMinutes, 0) };
  });

  // Cascade per-service windows contiguously from the appointment start.
  let cursor = startMs;
  for (const service of nextServices) {
    service.startsAt = new Date(cursor).toISOString();
    cursor += service.durationMinutes * 60_000;
    service.endsAt = new Date(cursor).toISOString();
  }
  const newTotal = nextServices.reduce((sum, service) => sum + service.durationMinutes, 0);
  return {
    ...booking,
    endsAt: new Date(startMs + newTotal * 60_000).toISOString(),
    durationMinutes: newTotal,
    services: nextServices,
  };
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function isCompletionLocked(status: StaffBookingSummary['status']): boolean {
  return (
    status === 'paid' ||
    status === 'cancelled' ||
    status === 'no_show' ||
    status === 'rejected' ||
    status === 'pending'
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
