import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { PinUnlockResponse, StaffBookingSummary } from '@sheer/domain';
import type React from 'react';
import { useCallback, useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { RootStackParamList } from '../../app/navigation/routes';
import { listTodaysLabAppointmentsForSession } from '../../features/appointments/appointmentsApi';
import { getActiveLabSession, logoutLabSession } from '../../features/sheer-lab/labSession';
import { labTheme } from '../../theme/labTheme';
import { LabButton } from '../shared/LabButton';
import { LabScreen } from '../shared/LabScreen';

type HomeScreenProps = NativeStackScreenProps<RootStackParamList, 'Home'>;

export function HomeScreen({ navigation }: HomeScreenProps): React.JSX.Element {
  const [session, setSession] = useState<PinUnlockResponse | undefined>();
  const [bookings, setBookings] = useState<StaffBookingSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();

  const loadBookings = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const activeSession = await getActiveLabSession();
      if (!activeSession) {
        navigation.replace('Auth');
        return;
      }
      setSession(activeSession);
      const response = await listTodaysLabAppointmentsForSession(activeSession.sessionId);
      setBookings(response.bookings);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not load scheduled clients');
    } finally {
      setLoading(false);
    }
  }, [navigation]);

  useEffect(() => {
    void loadBookings();
  }, [loadBookings]);

  async function handleLogout(): Promise<void> {
    if (session) await logoutLabSession(session.sessionId);
    navigation.replace('Auth');
  }

  function openFormula(booking: StaffBookingSummary): void {
    if (!session) return;
    navigation.navigate('Formula', {
      entryContext: {
        labSessionId: session.sessionId,
        appointmentId: booking.id,
        clientProfileId: booking.clientProfileId,
        clientName: booking.clientDisplayName,
        serviceType: booking.serviceNames.join(' + ') || 'Colour service',
        startsAt: booking.startsAt,
        patchTest: booking.patchTest,
      },
    });
  }

  return (
    <LabScreen title="Scheduled clients" eyebrow={session ? `Unlocked as ${session.displayName}` : 'Sheer Lab'}>
      <View style={styles.toolbar}>
        <LabButton label="Refresh" onPress={loadBookings} variant="secondary" disabled={loading} />
        <LabButton label="Lock" onPress={handleLogout} variant="secondary" />
      </View>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {loading ? <Text style={styles.meta}>Loading today&apos;s clients...</Text> : null}
      {!loading && bookings.length === 0 ? (
        <View style={styles.emptyCard}>
          <Text style={styles.emptyTitle}>No scheduled clients</Text>
          <Text style={styles.meta}>Only your appointments at this Lab station&apos;s location appear here.</Text>
        </View>
      ) : null}
      {bookings.map((booking) => (
        <ScheduledClientCard key={booking.id} booking={booking} onPress={() => openFormula(booking)} />
      ))}
      <LabButton label="Pair BLE scale" onPress={() => navigation.navigate('DevicePairing')} variant="secondary" />
      <LabButton label="Settings" variant="secondary" onPress={() => navigation.navigate('Settings')} />
    </LabScreen>
  );
}

function ScheduledClientCard({
  booking,
  onPress,
}: {
  booking: StaffBookingSummary;
  onPress: () => void;
}): React.JSX.Element {
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={styles.clientCard}>
      <View style={styles.clientHeader}>
        <View style={styles.timeBlock}>
          <Text style={styles.time}>{formatTime(booking.startsAt)}</Text>
          <Text style={styles.duration}>{booking.durationMinutes ? `${booking.durationMinutes} min` : ''}</Text>
        </View>
        <View style={styles.clientText}>
          <Text style={styles.clientName}>{booking.clientDisplayName}</Text>
          <Text style={styles.services}>{booking.serviceNames.join(' + ') || 'Service'}</Text>
          <Text style={styles.meta}>Status: {booking.status.replace(/_/g, ' ')}</Text>
        </View>
      </View>
      <View style={styles.alertRow}>
        <Text style={[styles.patchPill, patchToneStyle(booking.patchTest?.status)]}>
          Patch test: {booking.patchTest?.status ?? 'unknown'}
        </Text>
        <Text style={styles.openText}>Open formula</Text>
      </View>
    </Pressable>
  );
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function patchToneStyle(status?: string) {
  if (status === 'failed' || status === 'expired') return styles.patchDanger;
  if (status === 'passed') return styles.patchOk;
  return styles.patchWarn;
}

const styles = StyleSheet.create({
  toolbar: {
    flexDirection: 'row',
    gap: labTheme.spacing.sm,
  },
  clientCard: {
    gap: labTheme.spacing.md,
    padding: labTheme.spacing.md,
    borderWidth: 1,
    borderColor: labTheme.colors.border,
    borderRadius: labTheme.radius.cardLg,
    backgroundColor: labTheme.colors.card,
  },
  clientHeader: {
    flexDirection: 'row',
    gap: labTheme.spacing.md,
  },
  timeBlock: {
    minWidth: 74,
  },
  time: {
    color: labTheme.colors.primary,
    fontSize: 20,
    fontWeight: '900',
  },
  duration: {
    color: labTheme.colors.textMuted,
    fontSize: 12,
  },
  clientText: {
    flex: 1,
    gap: 3,
  },
  clientName: {
    color: labTheme.colors.textPrimary,
    fontSize: 20,
    fontWeight: '900',
  },
  services: {
    color: labTheme.colors.textSecondary,
    fontSize: 15,
    fontWeight: '700',
  },
  alertRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: labTheme.spacing.sm,
  },
  patchPill: {
    overflow: 'hidden',
    paddingHorizontal: labTheme.spacing.sm,
    paddingVertical: 6,
    borderRadius: labTheme.radius.full,
    fontSize: 12,
    fontWeight: '800',
    textTransform: 'capitalize',
  },
  patchOk: {
    color: '#bbf7d0',
    backgroundColor: 'rgba(34,197,94,0.16)',
  },
  patchWarn: {
    color: '#fde68a',
    backgroundColor: 'rgba(245,158,11,0.16)',
  },
  patchDanger: {
    color: '#fecaca',
    backgroundColor: 'rgba(239,68,68,0.18)',
  },
  openText: {
    color: labTheme.colors.primary,
    fontSize: 13,
    fontWeight: '900',
  },
  emptyCard: {
    gap: labTheme.spacing.xs,
    padding: labTheme.spacing.md,
    borderWidth: 1,
    borderColor: labTheme.colors.border,
    borderRadius: labTheme.radius.card,
    backgroundColor: labTheme.colors.card,
  },
  emptyTitle: {
    color: labTheme.colors.textPrimary,
    fontSize: 17,
    fontWeight: '900',
  },
  error: {
    color: '#fca5a5',
    fontSize: 14,
    fontWeight: '700',
  },
  meta: {
    color: labTheme.colors.textMuted,
    fontSize: 13,
  },
});
