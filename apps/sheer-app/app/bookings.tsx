import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import type { AppointmentCompletionResponse, CreateStylistRebookingRequest, StaffBookingSummary } from '@sheer/domain';
import { palette, radius, spacing } from '@sheer/design-tokens';
import { AppButton, Card, EmptyState, Screen, SectionHeader } from '@sheer/ui-mobile';
import { ProtectedScreen } from '../src/auth/ProtectedScreen';
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

  return (
    <ProtectedScreen allowedRoles={['manager', 'stylist']}>
      <Screen>
        <SectionHeader title="Today's Bookings" subtitle="Your assigned appointments for today." />

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
            <AppButton
              label={selectedBooking.status === 'awaiting_payment' ? 'Open checkout' : selectedBooking.status === 'paid' ? 'Paid' : 'Complete'}
              disabled={isCompletionLocked(selectedBooking.status) || completionLoadingId === selectedBooking.id}
              onPress={() => void completeBooking(selectedBooking)}
            />
            {checkoutReady?.appointment.id === selectedBooking.id ? (
              <View style={styles.checkoutPanel}>
                <Text style={styles.detailTitle}>
                  {checkoutReady.checkout.status === 'paid' ? 'Payment confirmed' : 'Awaiting payment'}
                </Text>
                <Text style={styles.muted}>{checkoutReady.checkout.message}</Text>
                <BillRow label="Services" amount={checkoutReady.billing.serviceTotalCents} currencyCode={checkoutReady.billing.currencyCode} />
                <BillRow label="Colour/formula" amount={checkoutReady.billing.formulaColourTotalCents} currencyCode={checkoutReady.billing.currencyCode} />
                <BillRow label="Gross total" amount={checkoutReady.billing.totalCents} currencyCode={checkoutReady.billing.currencyCode} />
                <BillRow label="Deposit paid" amount={checkoutReady.billing.depositPaidCents} currencyCode={checkoutReady.billing.currencyCode} />
                <Text style={styles.muted}>
                  Balance due: {formatMoney(checkoutReady.billing.balanceDueCents, checkoutReady.billing.currencyCode)}
                </Text>
                <RebookingPanel
                  summary={checkoutReady}
                  loading={rebookingLoading}
                  skipped={Boolean(rebookingSkipped[selectedBooking.id])}
                  onSkip={() => setRebookingSkipped((current) => ({ ...current, [selectedBooking.id]: true }))}
                  onCreate={(payload) => void createRebooking(checkoutReady, payload)}
                />
                {checkoutReady.checkout.status !== 'paid' ? (
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
                      label={paymentLoadingId === selectedBooking.id ? 'Confirming...' : 'Confirm in-salon payment'}
                      disabled={paymentLoadingId === selectedBooking.id}
                      onPress={() => void confirmPayment(checkoutReady)}
                    />
                  </>
                ) : null}
              </View>
            ) : null}
          </Card>
        ) : null}
      </Screen>
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
      <AppButton
        label={booking.status === 'awaiting_payment' ? 'Open checkout' : booking.status === 'paid' ? 'Paid' : completing ? 'Completing...' : 'Complete'}
        variant={booking.status === 'awaiting_payment' || booking.status === 'paid' ? 'secondary' : 'primary'}
        disabled={completionLocked || completing || loading}
        onPress={onComplete}
      />
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

function BillRow({ label, amount, currencyCode }: { label: string; amount: number; currencyCode: string }) {
  return (
    <View style={styles.billRow}>
      <Text style={styles.muted}>{label}</Text>
      <Text style={styles.billAmount}>{formatMoney(amount, currencyCode)}</Text>
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
          <Text style={styles.muted}>Follow-up time</Text>
          <TextInput
            value={selectedStartAt}
            onChangeText={setSelectedStartAt}
            placeholder="YYYY-MM-DDTHH:mm"
            placeholderTextColor="rgba(255,255,255,0.45)"
            style={styles.input}
          />
          <Text style={styles.muted}>Optional note</Text>
          <TextInput
            value={clientNote}
            onChangeText={setClientNote}
            placeholder="e.g. 8 week refresh"
            placeholderTextColor="rgba(255,255,255,0.45)"
            style={styles.input}
          />
          <AppButton
            label={loading ? 'Creating...' : 'Create rebooking'}
            disabled={loading || !selectedStartAt}
            onPress={submit}
          />
        </View>
      ) : null}
    </View>
  );
}

function statusStyle(status: StaffBookingSummary['status']) {
  switch (status) {
    case 'confirmed':
    case 'checked_in':
    case 'in_progress':
    case 'in_service':
      return styles.statusActive;
    case 'awaiting_payment':
      return styles.statusPending;
    case 'paid':
      return styles.statusComplete;
    case 'pending':
    case 'draft':
    case 'booked':
      return styles.statusPending;
    case 'cancelled':
    case 'no_show':
      return styles.statusDanger;
    case 'completed':
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
  return status === 'paid' || status === 'completed' || status === 'cancelled' || status === 'no_show' || status === 'pending' || status === 'draft' || status === 'booked';
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
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function toIsoFromLocalInput(value: string): string | undefined {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toISOString();
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
    gap: spacing.xs,
    borderRadius: radius.cardLg,
    padding: spacing.base,
    backgroundColor: 'rgba(74,222,128,0.12)',
    borderWidth: 1,
    borderColor: 'rgba(74,222,128,0.28)',
  },
  billRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  billAmount: {
    color: palette.white,
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
});
