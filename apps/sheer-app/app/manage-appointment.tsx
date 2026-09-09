import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Alert, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router, useLocalSearchParams } from 'expo-router';
import type { StaffBookingSummary } from '@sheer/domain';
import { palette, radius, spacing } from '@sheer/design-tokens';
import { AppButton } from '@sheer/ui-mobile';
import { ProtectedScreen } from '../src/auth/ProtectedScreen';
import { useAuth } from '../src/auth/AuthProvider';
import * as api from '../src/auth/api';
import { formatDuration } from '../src/booking/bookingStyles';
import { BG, BRAND_LIGHT } from '../src/design/colors';
import { ScreenHeader } from '../src/navigation/ScreenHeader';

// Statuses the customer can still act on online; once they've arrived
// (checked_in) the salon owns the booking. Mirrors the API guards.
const CLIENT_CANCELLABLE = ['pending', 'accepted'];
const CLIENT_REBOOKABLE = ['pending', 'accepted'];

export default function ManageAppointmentScreen() {
  const auth = useAuth();
  const accessToken = auth.session?.accessToken ?? '';
  const { id } = useLocalSearchParams<{ id?: string }>();

  const [appointment, setAppointment] = useState<StaffBookingSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!accessToken || !id) return;
    setLoading(true);
    setError(null);
    try {
      const dashboard = await api.getMobileDashboard(accessToken, 'client');
      if (dashboard.role !== 'client') throw new Error('Only clients can manage appointments');
      const found = [dashboard.nextAppointment, ...dashboard.upcomingAppointments].find(
        (appt): appt is StaffBookingSummary => Boolean(appt) && appt!.id === id,
      );
      if (!found) throw new Error('This appointment could no longer be found.');
      setAppointment(found);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load this appointment');
    } finally {
      setLoading(false);
    }
  }, [accessToken, id]);

  useEffect(() => {
    void load();
  }, [load]);

  // Refund cut-off the salon set for this location. Cancelling/rebooking at or
  // before it keeps the deposit + allows rebooking; after it the deposit is lost.
  const refundCutoff = useMemo(
    () => (appointment?.refundCutoffAt ? new Date(appointment.refundCutoffAt) : null),
    [appointment?.refundCutoffAt],
  );
  const outsideWindow = !refundCutoff || Date.now() <= refundCutoff.getTime();
  const hasPaidDeposit = appointment?.depositStatus === 'paid';
  const windowDays = appointment?.cancellationWindowHours
    ? Math.max(1, Math.round(appointment.cancellationWindowHours / 24))
    : null;
  const canCancel = appointment ? CLIENT_CANCELLABLE.includes(appointment.status) : false;
  const canRebook = appointment ? CLIENT_REBOOKABLE.includes(appointment.status) && outsideWindow : false;

  const onCancel = useCallback(() => {
    if (!appointment) return;
    const refundLine = !hasPaidDeposit
      ? ''
      : outsideWindow
        ? '\n\nYour deposit will be refunded to your card.'
        : "\n\nThis is inside the salon's cancellation window, so your deposit will NOT be refunded.";
    Alert.alert(
      'Cancel appointment?',
      `This will cancel your ${formatDayFull(appointment.startsAt)} appointment.${refundLine}`,
      [
        { text: 'Keep appointment', style: 'cancel' },
        {
          text: 'Cancel appointment',
          style: 'destructive',
          onPress: () => {
            void (async () => {
              if (!accessToken) return;
              setBusy(true);
              try {
                const result = await api.cancelAppointment(accessToken, appointment.id);
                const message = result.depositRefunded
                  ? 'Your appointment is cancelled and your deposit has been refunded to your card.'
                  : result.depositForfeited
                    ? 'Your appointment is cancelled. As this was inside the cancellation window, the deposit was not refunded.'
                    : 'Your appointment has been cancelled.';
                Alert.alert('Appointment cancelled', message, [
                  { text: 'Done', onPress: () => router.replace('/dashboard') },
                ]);
              } catch (err) {
                Alert.alert('Could not cancel', err instanceof Error ? err.message : 'Please try again.');
              } finally {
                setBusy(false);
              }
            })();
          },
        },
      ],
    );
  }, [accessToken, appointment, hasPaidDeposit, outsideWindow]);

  const onRebook = useCallback(() => {
    if (!appointment) return;
    const params = new URLSearchParams();
    params.set('id', appointment.id);
    params.set('locationId', appointment.locationId);
    if (appointment.serviceIds?.length) params.set('serviceIds', appointment.serviceIds.join(','));
    if (appointment.assignedStaffProfileId) params.set('stylistId', appointment.assignedStaffProfileId);
    params.set('label', appointment.serviceNames.join(' · ') || 'Appointment');
    router.push(`/reschedule?${params.toString()}`);
  }, [appointment]);

  return (
    <ProtectedScreen allowedRoles={['client']}>
      <SafeAreaView style={s.screen} edges={['top']}>
        <ScreenHeader title="Manage appointment" />

        <ScrollView contentContainerStyle={s.scroll} showsVerticalScrollIndicator={false}>
          {loading ? (
            <View style={s.loadingCard}>
              <ActivityIndicator color={palette.brand[300]} />
              <Text style={s.loadingText}>Loading your appointment…</Text>
            </View>
          ) : error || !appointment ? (
            <View style={s.card}>
              <Text style={s.cardTitle}>Appointment unavailable</Text>
              <Text style={s.muted}>{error ?? 'This appointment could not be loaded.'}</Text>
              <AppButton label="Back to home" variant="secondary" onPress={() => router.replace('/dashboard')} />
            </View>
          ) : (
            <>
              {/* Appointment summary */}
              <View style={s.card}>
                <Text style={s.eyebrow}>YOUR APPOINTMENT</Text>
                <Text style={s.apptTitle}>
                  {formatDayFull(appointment.startsAt)} · {formatTime(appointment.startsAt)}
                </Text>
                <Text style={s.apptService}>
                  {appointment.serviceNames.join(' · ') || 'Appointment'}
                  {appointment.durationMinutes ? ` · ${formatDuration(appointment.durationMinutes)}` : ''}
                </Text>
                {appointment.assignedStaffProfileId ? (
                  <Text style={s.muted}>With your stylist</Text>
                ) : null}
              </View>

              {/* Cancellation policy */}
              <View style={s.card}>
                {outsideWindow ? (
                  <>
                    <Text style={s.cardTitle}>Free to change</Text>
                    <Text style={s.muted}>
                      You can cancel or rebook until {refundCutoff ? formatDateTime(refundCutoff) : 'your appointment'}.
                      {hasPaidDeposit ? ' Cancelling now refunds your deposit to your card.' : ''}
                    </Text>
                  </>
                ) : (
                  <>
                    <Text style={s.cardTitle}>Within the cancellation window</Text>
                    <Text style={s.muted}>
                      {windowDays
                        ? `This appointment is within ${windowDays} day${windowDays === 1 ? '' : 's'} of starting. `
                        : 'This appointment is close to its start time. '}
                      {hasPaidDeposit ? 'Cancelling now will not refund your deposit. ' : ''}
                      Online rebooking isn’t available — please contact the salon to make changes.
                    </Text>
                  </>
                )}
              </View>

              {!canCancel ? (
                <Text style={s.contactNote}>
                  This appointment can’t be changed online. Please contact the salon for help.
                </Text>
              ) : null}
            </>
          )}
        </ScrollView>

        {appointment && !loading && !error && canCancel ? (
          <SafeAreaView edges={['bottom']} style={s.footer}>
            {canRebook ? (
              <AppButton label="Rebook" variant="secondary" onPress={onRebook} disabled={busy} />
            ) : null}
            <AppButton
              label={busy ? 'Cancelling…' : 'Cancel appointment'}
              onPress={onCancel}
              disabled={busy}
            />
          </SafeAreaView>
        ) : null}
      </SafeAreaView>
    </ProtectedScreen>
  );
}

// ── Date helpers ──────────────────────────────────────────────────────────────

function formatDayFull(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  });
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function formatDateTime(date: Date): string {
  return `${date.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })} at ${date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`;
}

// ── Styles ──────────────────────────────────────────────────────────────────────

const BORDER_MED = 'rgba(255,255,255,0.11)';
const CARD_BG = 'rgba(255,255,255,0.05)';

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: BG },
  pressed: { opacity: 0.72 },


  scroll: { gap: spacing.lg, padding: spacing.lg, paddingBottom: spacing.xl },

  loadingCard: { alignItems: 'center', gap: spacing.md, padding: spacing.xl },
  loadingText: { color: 'rgba(255,255,255,0.6)', fontSize: 14 },

  card: {
    gap: spacing.sm,
    padding: spacing.lg,
    borderRadius: radius.card,
    backgroundColor: CARD_BG,
    borderWidth: 1,
    borderColor: BORDER_MED,
  },
  eyebrow: { color: BRAND_LIGHT, fontSize: 12, fontWeight: '800', letterSpacing: 1 },
  apptTitle: { color: palette.white, fontSize: 22, fontWeight: '700', letterSpacing: -0.4 },
  apptService: { color: 'rgba(255,255,255,0.8)', fontSize: 15 },
  cardTitle: { color: palette.white, fontSize: 16, fontWeight: '700' },
  muted: { color: 'rgba(255,255,255,0.65)', fontSize: 14, lineHeight: 20 },
  contactNote: { color: 'rgba(255,255,255,0.55)', fontSize: 13, lineHeight: 19, textAlign: 'center' },

  footer: {
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: BORDER_MED,
    backgroundColor: BG,
  },
});
