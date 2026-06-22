import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { router } from 'expo-router';
import type { AppointmentCompletionResponse, CreateStylistRebookingRequest, StaffBookingSummary } from '@sheer/domain';
import { userHasRole } from '@sheer/domain';
import { palette, radius, spacing } from '@sheer/design-tokens';
import { AppButton, Card, EmptyState, Screen, SectionHeader } from '@sheer/ui-mobile';
import { ProtectedScreen } from '../src/auth/ProtectedScreen';
import { StylistTabBar } from '../src/navigation/StylistTabBar';
import { useAuth } from '../src/auth/AuthProvider';
import * as api from '../src/auth/api';

export default function BookingsScreen() {
  const auth = useAuth();
  const accessToken = auth.session?.accessToken ?? '';
  const [bookings, setBookings] = useState<StaffBookingSummary[]>([]);
  const [selectedBooking, setSelectedBooking] = useState<StaffBookingSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailLoadingId, setDetailLoadingId] = useState<string | null>(null);
  const [completionLoadingId, setCompletionLoadingId] = useState<string | null>(null);
  const [paymentLoadingId, setPaymentLoadingId] = useState<string | null>(null);
  const [paymentMethod, setPaymentMethod] = useState<'cash' | 'card_reader'>('card_reader');
  const [checkoutReady, setCheckoutReady] = useState<AppointmentCompletionResponse | null>(null);
  const [rebookingLoading, setRebookingLoading] = useState(false);
  const [rebookingSkipped, setRebookingSkipped] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!accessToken) return;
    setLoading(true);
    setError(null);
    try {
      const result = await api.getMyBookings(accessToken);
      setBookings(Array.isArray(result.bookings) ? result.bookings : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load bookings');
    } finally {
      setLoading(false);
    }
  }, [accessToken]);

  useEffect(() => {
    void load();
  }, [load]);

  async function openBooking(booking: StaffBookingSummary) {
    if (!accessToken) return;
    setDetailLoadingId(booking.id);
    setError(null);
    try {
      const detail = await api.getBookingDetail(accessToken, booking.id);
      setSelectedBooking(detail);
      setCheckoutReady(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not open booking');
    } finally {
      setDetailLoadingId(null);
    }
  }

  async function completeBooking(booking: StaffBookingSummary) {
    if (!accessToken || isCompletionLocked(booking.status)) return;
    setCompletionLoadingId(booking.id);
    setError(null);
    try {
      const result = await api.completeBooking(accessToken, booking.id);
      setCheckoutReady(result);
      setSelectedBooking(result.appointment);
      setBookings((current) =>
        current.map((entry) => (entry.id === booking.id ? { ...entry, ...result.appointment } : entry)),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not complete appointment');
    } finally {
      setCompletionLoadingId(null);
    }
  }

  async function confirmPayment(summary: AppointmentCompletionResponse) {
    if (!accessToken || summary.billing.balanceDueCents < 0) return;
    setPaymentLoadingId(summary.appointment.id);
    setError(null);
    try {
      const result = await api.confirmBookingPayment(accessToken, summary.appointment.id, {
        paymentMethod,
        amountCents: summary.billing.balanceDueCents,
      });
      setCheckoutReady(result);
      setSelectedBooking(result.appointment);
      setBookings((current) =>
        current.map((entry) => (entry.id === result.appointment.id ? { ...entry, ...result.appointment } : entry)),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not confirm payment');
    } finally {
      setPaymentLoadingId(null);
    }
  }

  async function createRebooking(summary: AppointmentCompletionResponse, payload: CreateStylistRebookingRequest) {
    if (!accessToken) return;
    setRebookingLoading(true);
    setError(null);
    try {
      const result = await api.createStylistRebooking(accessToken, summary.appointment.id, payload);
      setCheckoutReady(result);
      setRebookingSkipped((current) => ({ ...current, [summary.appointment.id]: false }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create rebooking');
    } finally {
      setRebookingLoading(false);
    }
  }

  const showStylistTabs = userHasRole(auth.user, 'stylist');

  return (
    <ProtectedScreen allowedRoles={['manager', 'stylist']}>
      <Screen>
        <AppButton label="+ New booking" onPress={() => router.push('/new-booking')} />

        {error ? (
          <Card>
            <Text style={styles.error}>{error}</Text>
            <AppButton label="Try again" variant="secondary" onPress={() => void load()} />
          </Card>
        ) : null}

        {loading ? (
          <Card>
            <ActivityIndicator color={palette.brand[300]} />
            <Text style={styles.muted}>Loading your bookings...</Text>
          </Card>
        ) : bookings.length === 0 ? (
          <EmptyState
            title="No bookings today"
            body="Assigned bookings for today will appear here when clients are booked in."
          />
        ) : (
          <View style={styles.list}>
            {bookings.map((booking) => (
              <BookingCard
                key={booking.id}
                booking={booking}
                loading={detailLoadingId === booking.id}
                completing={completionLoadingId === booking.id}
                onPress={() => void openBooking(booking)}
                onComplete={() => void completeBooking(booking)}
              />
            ))}
          </View>
        )}

        {selectedBooking ? (
          <Card>
            <SectionHeader
              title="Appointment Card"
              subtitle={`${formatTime(selectedBooking.startsAt)} with ${selectedBooking.clientDisplayName}`}
            />
            <Text style={styles.detailTitle}>{selectedBooking.serviceNames.join(', ') || 'Service'}</Text>
            <Text style={styles.muted}>Status: {formatStatus(selectedBooking.status)}</Text>
            {selectedBooking.durationMinutes ? (
              <Text style={styles.muted}>Duration: {selectedBooking.durationMinutes} min</Text>
            ) : null}
            {selectedBooking.clientNote ? (
              <Text style={styles.warningText}>Client note: {selectedBooking.clientNote}</Text>
            ) : null}
            {selectedBooking.status === 'paid' ? (
              <CompletionStatusBanner status={selectedBooking.status} />
            ) : (
              <AppButton
                label={
                  selectedBooking.status === 'awaiting_payment'
                    ? 'Open checkout'
                    : completionLoadingId === selectedBooking.id
                      ? 'Completing…'
                      : 'Complete'
                }
                disabled={isCompletionLocked(selectedBooking.status) || completionLoadingId === selectedBooking.id}
                onPress={() => void completeBooking(selectedBooking)}
              />
            )}
            {checkoutReady?.appointment.id === selectedBooking.id ? (
              <View
                style={[
                  styles.checkoutPanel,
                  checkoutReady.checkout.status === 'paid' && styles.checkoutPanelPaid,
                ]}
              >
                <View style={styles.checkoutHeaderRow}>
                  {checkoutReady.checkout.status === 'paid' ? (
                    <Text style={styles.checkoutCheck}>✓</Text>
                  ) : null}
                  <Text style={styles.detailTitle}>
                    {checkoutReady.checkout.status === 'paid' ? 'Payment confirmed' : 'Awaiting payment'}
                  </Text>
                </View>
                <Text style={styles.muted}>{checkoutReady.checkout.message}</Text>
                <BillingBreakdown billing={checkoutReady.billing} />
                {checkoutReady.checkout.status === 'paid' ? (
                  <RebookingPanel
                    summary={checkoutReady}
                    loading={rebookingLoading}
                    skipped={Boolean(rebookingSkipped[selectedBooking.id])}
                    onSkip={() => setRebookingSkipped((current) => ({ ...current, [selectedBooking.id]: true }))}
                    onCreate={(payload) => void createRebooking(checkoutReady, payload)}
                  />
                ) : (
                  <>
                    <View style={styles.methodRow}>
                      <PaymentMethodButton
                        label="Card reader"
                        selected={paymentMethod === 'card_reader'}
                        onPress={() => setPaymentMethod('card_reader')}
                      />
                      <PaymentMethodButton
                        label="Cash"
                        selected={paymentMethod === 'cash'}
                        onPress={() => setPaymentMethod('cash')}
                      />
                    </View>
                    <AppButton
                      label={paymentLoadingId === selectedBooking.id ? 'Confirming…' : 'Confirm in-salon payment'}
                      disabled={paymentLoadingId === selectedBooking.id}
                      onPress={() => void confirmPayment(checkoutReady)}
                    />
                  </>
                )}
              </View>
            ) : null}
          </Card>
        ) : null}
      </Screen>
      {showStylistTabs ? <StylistTabBar /> : null}
    </ProtectedScreen>
  );
}

function BookingCard({
  booking,
  loading,
  completing,
  onPress,
  onComplete,
}: {
  booking: StaffBookingSummary;
  loading: boolean;
  completing: boolean;
  onPress: () => void;
  onComplete: () => void;
}) {
  const hasDepositWarning =
    (booking.depositRequiredAmount ?? 0) > 0 &&
    booking.depositStatus !== undefined &&
    booking.depositStatus !== 'paid';

  const completionLocked = isCompletionLocked(booking.status);

  return (
    <Card>
      <Pressable
        accessibilityRole="button"
        onPress={onPress}
        disabled={loading || completing}
        style={({ pressed }) => [styles.pressable, pressed && styles.pressed, (loading || completing) && styles.disabled]}
      >
        <View style={styles.cardHeader}>
          <View style={styles.cardTitleBlock}>
            <Text style={styles.clientName}>{booking.clientDisplayName}</Text>
            <Text style={styles.serviceName}>{booking.serviceNames.join(', ') || 'Service'}</Text>
          </View>
          <StatusPill status={booking.status} />
        </View>

        <View style={styles.metaRow}>
          <Text style={styles.timeText}>
            {formatTime(booking.startsAt)} - {formatTime(booking.endsAt)}
          </Text>
          {booking.durationMinutes ? (
            <Text style={styles.muted}>{booking.durationMinutes} min</Text>
          ) : null}
        </View>

        {hasDepositWarning ? (
          <Text style={styles.warningText}>
            Deposit {booking.depositStatus ? formatStatus(booking.depositStatus) : 'required'}
          </Text>
        ) : null}
        {booking.clientNote ? <Text style={styles.muted}>Note: {booking.clientNote}</Text> : null}
        {loading ? <Text style={styles.muted}>Opening appointment...</Text> : null}
      </Pressable>
      {booking.status === 'paid' ? (
        <CompletionStatusBanner status={booking.status} />
      ) : (
        <AppButton
          label={booking.status === 'awaiting_payment' ? 'Open checkout' : completing ? 'Completing…' : 'Complete'}
          variant={booking.status === 'awaiting_payment' ? 'secondary' : 'primary'}
          disabled={completionLocked || completing || loading}
          onPress={onComplete}
        />
      )}
    </Card>
  );
}

function StatusPill({ status }: { status: StaffBookingSummary['status'] }) {
  return (
    <View style={[styles.statusPill, statusStyle(status)]}>
      <Text style={styles.statusText}>{formatStatus(status)}</Text>
    </View>
  );
}

// Settled/completed states are not actionable — render them as a confirmation
// banner rather than a (disabled) button so they don't read as a CTA.
function CompletionStatusBanner({ status: _status }: { status: StaffBookingSummary['status'] }) {
  const label = 'Paid';
  return (
    <View style={styles.statusBanner}>
      <Text style={styles.statusBannerCheck}>✓</Text>
      <Text style={styles.statusBannerText}>{label}</Text>
    </View>
  );
}

function BillingBreakdown({
  billing,
}: {
  billing: AppointmentCompletionResponse['billing'];
}) {
  const { currencyCode } = billing;
  const hasProduct = billing.productUsageTotalCents > 0;
  const hasDeposit = billing.depositPaidCents > 0;

  return (
    <View style={styles.billingBreakdown}>
      {/* Line items */}
      <BillRow label="Services" amount={billing.serviceTotalCents} currencyCode={currencyCode} />
      {hasProduct ? (
        <BillRow
          label="Product usage"
          amount={billing.productUsageTotalCents}
          currencyCode={currencyCode}
          highlight
        />
      ) : null}

      {/* Divider before totals */}
      <View style={styles.billDivider} />

      {/* Gross total */}
      <View style={styles.billTotalRow}>
        <Text style={styles.billTotalLabel}>Gross total</Text>
        <Text style={styles.billTotalValue}>{formatMoney(billing.totalCents, currencyCode)}</Text>
      </View>

      {/* Deposit */}
      {hasDeposit ? (
        <BillRow label="Deposit paid" amount={billing.depositPaidCents} currencyCode={currencyCode} />
      ) : null}

      {/* Balance due */}
      {billing.balanceDueCents > 0 ? (
        <View style={styles.balanceDueRow}>
          <Text style={styles.balanceDueLabel}>Balance due</Text>
          <Text style={styles.balanceDueValue}>
            {formatMoney(billing.balanceDueCents, currencyCode)}
          </Text>
        </View>
      ) : (
        <View style={styles.paidRow}>
          <Text style={styles.paidText}>✓ Paid in full</Text>
        </View>
      )}
    </View>
  );
}

function BillRow({
  label,
  amount,
  currencyCode,
  highlight = false,
}: {
  label: string;
  amount: number;
  currencyCode: string;
  highlight?: boolean;
}) {
  return (
    <View style={styles.billRow}>
      <Text style={styles.muted}>{label}</Text>
      <Text style={[styles.billAmount, highlight && styles.billAmountHighlight]}>
        {formatMoney(amount, currencyCode)}
      </Text>
    </View>
  );
}

function PaymentMethodButton({
  label,
  selected,
  onPress,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.methodButton, selected && styles.methodButtonSelected, pressed && styles.pressed]}
    >
      <Text style={[styles.methodButtonText, selected && styles.methodButtonTextSelected]}>{label}</Text>
    </Pressable>
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
  const initial = defaultRebookingDate();
  const [selectedDay, setSelectedDay] = useState<Date>(() => startOfDay(initial));
  const [selectedTime, setSelectedTime] = useState<string>(() => formatHm(initial));
  const [clientNote, setClientNote] = useState('');
  const rebooked = Boolean(summary.visit.rebooked);

  function submit() {
    const iso = combineDateAndTime(selectedDay, selectedTime);
    if (!iso) return;
    onCreate({
      sourceVisitId: summary.visit.id,
      selectedStartAt: iso,
      staffProfileId: summary.appointment.assignedStaffProfileId,
      clientNote: clientNote.trim() || undefined,
    });
  }

  return (
    <View style={styles.rebookingPanel}>
      <View style={styles.cardHeader}>
        <View style={styles.cardTitleBlock}>
          <Text style={styles.detailTitle}>Rebooking</Text>
          <Text style={styles.muted}>
            {rebooked
              ? `Linked follow-up appointment ${summary.visit.rebookedAppointmentId ?? ''}.`
              : skipped
                ? 'Skipped for this checkout. This visit is not counted as rebooked.'
                : 'Create a real follow-up appointment before this counts.'}
          </Text>
        </View>
        <StatusPill status={rebooked ? 'paid' : 'awaiting_payment'} />
      </View>
      {!rebooked && !skipped ? (
        <View style={styles.methodRow}>
          <AppButton label="Rebook now" onPress={() => setOpen(true)} />
          <AppButton label="Skip rebooking" variant="secondary" onPress={onSkip} />
        </View>
      ) : null}
      {open && !rebooked && !skipped ? (
        <View style={styles.quickForm}>
          <Text style={styles.fieldLabel}>Follow-up date</Text>
          <WeekCalendar selectedDate={selectedDay} onSelect={setSelectedDay} />
          <Text style={styles.fieldLabel}>Time</Text>
          <TimeSlots value={selectedTime} onChange={setSelectedTime} />
          <View style={styles.rebookSummaryRow}>
            <Text style={styles.muted}>Selected</Text>
            <Text style={styles.rebookSummaryValue}>{formatFollowUpSummary(selectedDay, selectedTime)}</Text>
          </View>
          <Text style={styles.fieldLabel}>Optional note</Text>
          <TextInput
            value={clientNote}
            onChangeText={setClientNote}
            placeholder="e.g. 8 week refresh"
            placeholderTextColor="rgba(255,255,255,0.45)"
            style={styles.input}
          />
          <AppButton
            label={loading ? 'Creating…' : 'Create rebooking'}
            disabled={loading}
            onPress={submit}
          />
        </View>
      ) : null}
    </View>
  );
}

function WeekCalendar({
  selectedDate,
  onSelect,
}: {
  selectedDate: Date;
  onSelect: (date: Date) => void;
}) {
  const [weekStart, setWeekStart] = useState<Date>(() => startOfWeek(selectedDate));
  const today = startOfDay(new Date());
  const days = Array.from({ length: 7 }, (_, index) => addDays(weekStart, index));

  return (
    <View style={styles.calendar}>
      <View style={styles.calendarHeader}>
        <Text style={styles.calendarMonth}>{monthYearLabel(addDays(weekStart, 3))}</Text>
        <View style={styles.calendarNav}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Previous week"
            onPress={() => setWeekStart((current) => addDays(current, -7))}
            style={({ pressed }) => [styles.calendarNavButton, pressed && styles.pressed]}
          >
            <Text style={styles.calendarNavText}>‹</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Next week"
            onPress={() => setWeekStart((current) => addDays(current, 7))}
            style={({ pressed }) => [styles.calendarNavButton, pressed && styles.pressed]}
          >
            <Text style={styles.calendarNavText}>›</Text>
          </Pressable>
        </View>
      </View>
      <View style={styles.calendarWeek}>
        {days.map((day) => {
          const isPast = day.getTime() < today.getTime();
          const isSelected = isSameDay(day, selectedDate);
          return (
            <Pressable
              key={day.toISOString()}
              accessibilityRole="button"
              accessibilityState={{ selected: isSelected, disabled: isPast }}
              disabled={isPast}
              onPress={() => onSelect(day)}
              style={[styles.dayCell, isSelected && styles.dayCellSelected, isPast && styles.dayCellDisabled]}
            >
              <Text style={[styles.dayWeekday, isSelected && styles.dayTextSelected]}>{weekdayLabel(day)}</Text>
              <Text style={[styles.dayNumber, isSelected && styles.dayTextSelected]}>{day.getDate()}</Text>
              <View
                style={[
                  styles.dayDot,
                  isSelected && styles.dayDotSelected,
                  isPast && styles.dayDotHidden,
                ]}
              />
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

function TimeSlots({ value, onChange }: { value: string; onChange: (time: string) => void }) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.timeSlots}
    >
      {TIME_SLOTS.map((slot) => {
        const selected = slot === value;
        return (
          <Pressable
            key={slot}
            accessibilityRole="button"
            accessibilityState={{ selected }}
            onPress={() => onChange(slot)}
            style={[styles.timeSlot, selected && styles.timeSlotSelected]}
          >
            <Text style={[styles.timeSlotText, selected && styles.timeSlotTextSelected]}>
              {formatTimeLabel(slot)}
            </Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

function statusStyle(status: StaffBookingSummary['status']) {
  switch (status) {
    case 'accepted':
    case 'checked_in':
      return styles.statusActive;
    case 'awaiting_payment':
    case 'pending':
      return styles.statusPending;
    case 'paid':
      return styles.statusComplete;
    case 'rejected':
    case 'cancelled':
    case 'no_show':
      return styles.statusDanger;
    default:
      return styles.statusComplete;
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

function isCompletionLocked(status: StaffBookingSummary['status']): boolean {
  return status === 'paid' || status === 'cancelled' || status === 'no_show' || status === 'rejected' || status === 'pending';
}

function formatMoney(amountCents: number, currencyCode: string): string {
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: currencyCode,
  }).format(amountCents / 100);
}

// --- Rebooking date/time helpers -------------------------------------------

const TIME_SLOTS = buildTimeSlots();

function buildTimeSlots(): string[] {
  const slots: string[] = [];
  for (let minutes = 8 * 60; minutes <= 20 * 60; minutes += 30) {
    slots.push(`${pad2(Math.floor(minutes / 60))}:${pad2(minutes % 60)}`);
  }
  return slots;
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function startOfDay(date: Date): Date {
  const next = new Date(date);
  next.setHours(0, 0, 0, 0);
  return next;
}

function startOfWeek(date: Date): Date {
  const next = startOfDay(date);
  const mondayIndex = (next.getDay() + 6) % 7; // Monday = 0
  next.setDate(next.getDate() - mondayIndex);
  return next;
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function isSameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function weekdayLabel(date: Date): string {
  return date.toLocaleDateString(undefined, { weekday: 'short' }).toUpperCase();
}

function monthYearLabel(date: Date): string {
  return date.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

function formatHm(date: Date): string {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

function formatTimeLabel(hm: string): string {
  const [hours, minutes] = hm.split(':').map(Number);
  const date = new Date();
  date.setHours(hours, minutes, 0, 0);
  return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

function defaultRebookingDate(): Date {
  const date = new Date(Date.now() + 6 * 7 * 24 * 60 * 60 * 1000);
  date.setHours(10, 0, 0, 0);
  return date;
}

function combineDateAndTime(day: Date, hm: string): string | undefined {
  const [hours, minutes] = hm.split(':').map(Number);
  if (Number.isNaN(hours) || Number.isNaN(minutes)) return undefined;
  const date = new Date(day);
  date.setHours(hours, minutes, 0, 0);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toISOString();
}

function formatFollowUpSummary(day: Date, hm: string): string {
  const iso = combineDateAndTime(day, hm);
  if (!iso) return '';
  const datePart = new Date(iso).toLocaleDateString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
  return `${datePart} · ${formatTimeLabel(hm)}`;
}

const styles = StyleSheet.create({
  list: {
    gap: spacing.base,
  },
  pressable: {
    borderRadius: radius.card,
  },
  pressed: {
    opacity: 0.78,
  },
  disabled: {
    opacity: 0.55,
  },
  cardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  cardTitleBlock: {
    flex: 1,
    gap: spacing.xs,
  },
  clientName: {
    color: palette.white,
    fontSize: 18,
    fontWeight: '700',
  },
  serviceName: {
    color: 'rgba(255,255,255,0.78)',
    fontSize: 14,
    fontWeight: '600',
  },
  metaRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: spacing.sm,
  },
  timeText: {
    color: palette.brand[300],
    fontSize: 16,
    fontWeight: '700',
  },
  muted: {
    color: 'rgba(255,255,255,0.68)',
    fontSize: 13,
  },
  error: {
    color: palette.danger[300],
    fontWeight: '700',
  },
  warningText: {
    color: palette.warning[300],
    fontWeight: '700',
  },
  detailTitle: {
    color: palette.white,
    fontSize: 16,
    fontWeight: '700',
  },
  statusPill: {
    alignSelf: 'flex-start',
    borderRadius: radius.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  statusText: {
    color: palette.white,
    fontSize: 11,
    fontWeight: '700',
  },
  statusActive: {
    backgroundColor: 'rgba(74,222,128,0.24)',
  },
  statusPending: {
    backgroundColor: 'rgba(251,191,36,0.24)',
  },
  statusDanger: {
    backgroundColor: 'rgba(248,113,113,0.24)',
  },
  statusComplete: {
    backgroundColor: 'rgba(148,163,184,0.24)',
  },
  checkoutPanel: {
    gap: spacing.sm,
    borderRadius: radius.cardLg,
    padding: spacing.base,
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
  },
  checkoutPanelPaid: {
    backgroundColor: 'rgba(74,222,128,0.10)',
    borderColor: 'rgba(74,222,128,0.28)',
  },
  checkoutHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  checkoutCheck: {
    color: palette.success[300],
    fontSize: 15,
    fontWeight: '900',
  },
  billingBreakdown: {
    gap: spacing.xs,
  },
  billRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  billAmount: {
    color: 'rgba(255,255,255,0.78)',
    fontSize: 13,
    fontWeight: '700',
  },
  billAmountHighlight: {
    color: palette.brand[300],
    fontWeight: '800',
  },
  billDivider: {
    height: 1,
    backgroundColor: 'rgba(255,255,255,0.12)',
    marginVertical: spacing.xs,
  },
  billTotalRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  billTotalLabel: {
    color: palette.white,
    fontSize: 13,
    fontWeight: '700',
  },
  billTotalValue: {
    color: palette.white,
    fontSize: 13,
    fontWeight: '900',
  },
  balanceDueRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: spacing.sm,
    marginTop: spacing.xs,
    padding: spacing.sm,
    borderRadius: radius.inputLg,
    backgroundColor: 'rgba(248,113,113,0.14)',
    borderWidth: 1,
    borderColor: 'rgba(248,113,113,0.32)',
  },
  balanceDueLabel: {
    color: palette.danger[300],
    fontSize: 12,
    fontWeight: '800',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  balanceDueValue: {
    color: palette.danger[300],
    fontSize: 16,
    fontWeight: '900',
  },
  paidRow: {
    alignItems: 'center',
    paddingVertical: spacing.xs,
  },
  paidText: {
    color: palette.success[300],
    fontSize: 13,
    fontWeight: '800',
  },
  methodRow: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  methodButton: {
    flex: 1,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.16)',
    alignItems: 'center',
  },
  methodButtonSelected: {
    backgroundColor: 'rgba(196,160,245,0.22)',
    borderColor: 'rgba(196,160,245,0.42)',
  },
  methodButtonText: {
    color: 'rgba(255,255,255,0.72)',
    fontSize: 12,
    fontWeight: '800',
  },
  methodButtonTextSelected: {
    color: palette.white,
  },
  rebookingPanel: {
    gap: spacing.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.14)',
    borderRadius: radius.card,
    padding: spacing.base,
    backgroundColor: 'rgba(255,255,255,0.04)',
  },
  quickForm: {
    gap: spacing.sm,
  },
  input: {
    minHeight: 44,
    borderRadius: radius.input,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.18)',
    paddingHorizontal: spacing.base,
    color: palette.white,
    backgroundColor: 'rgba(255,255,255,0.06)',
  },
  fieldLabel: {
    color: 'rgba(255,255,255,0.72)',
    fontSize: 12,
    fontWeight: '800',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginTop: spacing.xs,
  },
  calendar: {
    gap: spacing.sm,
    padding: spacing.sm,
    borderRadius: radius.card,
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.14)',
  },
  calendarHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  calendarMonth: {
    color: palette.white,
    fontSize: 14,
    fontWeight: '800',
  },
  calendarNav: {
    flexDirection: 'row',
    gap: spacing.xs,
  },
  calendarNavButton: {
    width: 30,
    height: 30,
    borderRadius: radius.full,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.16)',
  },
  calendarNavText: {
    color: palette.white,
    fontSize: 18,
    fontWeight: '900',
    lineHeight: 20,
  },
  calendarWeek: {
    flexDirection: 'row',
    gap: spacing.xs,
  },
  dayCell: {
    flex: 1,
    alignItems: 'center',
    gap: 3,
    paddingVertical: spacing.sm,
    borderRadius: radius.input,
    backgroundColor: 'transparent',
  },
  dayCellSelected: {
    backgroundColor: palette.brand[500],
  },
  dayCellDisabled: {
    opacity: 0.35,
  },
  dayWeekday: {
    color: 'rgba(255,255,255,0.55)',
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 0.4,
  },
  dayNumber: {
    color: palette.white,
    fontSize: 15,
    fontWeight: '800',
  },
  dayTextSelected: {
    color: palette.white,
  },
  dayDot: {
    width: 5,
    height: 5,
    borderRadius: radius.full,
    backgroundColor: palette.success[300],
  },
  dayDotSelected: {
    backgroundColor: palette.white,
  },
  dayDotHidden: {
    backgroundColor: 'transparent',
  },
  timeSlots: {
    gap: spacing.sm,
    paddingVertical: spacing.xs,
    paddingRight: spacing.base,
  },
  timeSlot: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.pill,
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.16)',
  },
  timeSlotSelected: {
    backgroundColor: 'rgba(196,160,245,0.22)',
    borderColor: 'rgba(196,160,245,0.5)',
  },
  timeSlotText: {
    color: 'rgba(255,255,255,0.75)',
    fontSize: 13,
    fontWeight: '800',
  },
  timeSlotTextSelected: {
    color: palette.white,
  },
  rebookSummaryRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.xs,
  },
  rebookSummaryValue: {
    color: palette.brand[300],
    fontSize: 13,
    fontWeight: '800',
  },
  statusBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.md,
    borderRadius: radius.input,
    backgroundColor: 'rgba(74,222,128,0.12)',
    borderWidth: 1,
    borderColor: 'rgba(74,222,128,0.30)',
  },
  statusBannerCheck: {
    color: palette.success[300],
    fontSize: 15,
    fontWeight: '900',
  },
  statusBannerText: {
    color: palette.success[300],
    fontSize: 14,
    fontWeight: '800',
    letterSpacing: 0.4,
  },
});
