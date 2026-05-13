import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import type { StaffBookingSummary } from '@sheer/domain';
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
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not open booking');
    } finally {
      setDetailLoadingId(null);
    }
  }

  return (
    <ProtectedScreen allowedRoles={['stylist']}>
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
                onPress={() => void openBooking(booking)}
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
          </Card>
        ) : null}
      </Screen>
    </ProtectedScreen>
  );
}

function BookingCard({
  booking,
  loading,
  onPress,
}: {
  booking: StaffBookingSummary;
  loading: boolean;
  onPress: () => void;
}) {
  const hasDepositWarning =
    (booking.depositRequiredAmount ?? 0) > 0 &&
    booking.depositStatus !== undefined &&
    booking.depositStatus !== 'paid';

  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      disabled={loading}
      style={({ pressed }) => [styles.pressable, pressed && styles.pressed, loading && styles.disabled]}
    >
      <Card>
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
      </Card>
    </Pressable>
  );
}

function StatusPill({ status }: { status: StaffBookingSummary['status'] }) {
  return (
    <View style={[styles.statusPill, statusStyle(status)]}>
      <Text style={styles.statusText}>{formatStatus(status)}</Text>
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
});
