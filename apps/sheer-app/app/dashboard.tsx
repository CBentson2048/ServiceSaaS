import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import type {
  CrmVisitSummary,
  MobileClientDashboardResponse,
  MobileManagerDashboardResponse,
  MobileOwnerDashboardResponse,
  MobileStylistDashboardResponse,
  StaffBookingSummary,
} from '@sheer/domain';
import { palette, radius, spacing } from '@sheer/design-tokens';
import { AppButton, Card, EmptyState, Screen } from '@sheer/ui-mobile';
import { ProtectedScreen } from '../src/auth/ProtectedScreen';
import { useAuth } from '../src/auth/AuthProvider';
import * as api from '../src/auth/api';

export default function DashboardScreen() {
  const auth = useAuth();
  const { signOut, user } = auth;
  const accessToken = auth.session?.accessToken ?? '';
  const [dashboard, setDashboard] = useState<api.MobileDashboardResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!accessToken || !user || !isMobileDashboardRole(user.role)) return;
    setLoading(true);
    setError(null);
    try {
      const result = await api.getMobileDashboard(accessToken, user.role);
      setDashboard(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load dashboard');
    } finally {
      setLoading(false);
    }
  }, [accessToken, user]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <ProtectedScreen allowedRoles={['owner', 'manager', 'stylist', 'client']}>
      <Screen>
        <DashboardHero name={firstName(user?.profile.fullName)} role={user?.role} />

        {error ? (
          <View style={styles.alertCard}>
            <Text style={styles.cardTitle}>Dashboard unavailable</Text>
            <Text style={styles.error}>{error}</Text>
            <AppButton label="Try again" variant="secondary" onPress={() => void load()} />
          </View>
        ) : null}

        {loading ? (
          <View style={styles.panel}>
            <View style={styles.loadingRow}>
              <ActivityIndicator color={palette.brand[300]} />
              <View style={styles.flex}>
                <Text style={styles.cardTitle}>Preparing your dashboard</Text>
                <Text style={styles.muted}>Loading your latest Sheer activity...</Text>
              </View>
            </View>
          </View>
        ) : dashboard?.role === 'client' ? (
          <ClientDashboard dashboard={dashboard} />
        ) : dashboard?.role === 'stylist' ? (
          <StylistDashboard dashboard={dashboard} />
        ) : dashboard?.role === 'manager' ? (
          <ManagerDashboard dashboard={dashboard} />
        ) : dashboard?.role === 'owner' ? (
          <OwnerDashboard dashboard={dashboard} />
        ) : null}

        <AppButton label="Logout" variant="secondary" onPress={() => void signOut()} />
      </Screen>
    </ProtectedScreen>
  );
}

function DashboardHero({ name, role }: { name: string; role: string | undefined }) {
  return (
    <View style={styles.hero}>
      <View style={styles.heroTopRow}>
        <Text style={styles.eyebrow}>{formatStatus(role ?? 'sheer')}</Text>
        <View style={styles.livePill}>
          <Text style={styles.livePillText}>Live</Text>
        </View>
      </View>
      <Text style={styles.heroTitle}>Hi {name}</Text>
      <Text style={styles.heroBody}>{roleSubtitle(role)}</Text>
    </View>
  );
}

function ClientDashboard({ dashboard }: { dashboard: MobileClientDashboardResponse }) {
  return (
    <>
      <SectionTitle title="Next appointment" subtitle="Your upcoming booking." />
      {dashboard.nextAppointment ? (
        <AppointmentCard appointment={dashboard.nextAppointment} featured />
      ) : (
        <EmptyState
          title="You don’t have any upcoming appointments."
          body="Book your next appointment when you are ready."
        />
      )}
      <AppButton label="Book an appointment" onPress={() => router.push('/booking/location')} />

      <SectionTitle title="Visit history" subtitle="Recent completed visits." />
      {dashboard.visitHistory.length === 0 ? (
        <EmptyState title="No visit history yet" body="Completed visits will appear here after your appointments." />
      ) : (
        <View style={styles.list}>
          {dashboard.visitHistory.map((visit) => (
            <VisitCard key={visit.id} visit={visit} />
          ))}
        </View>
      )}
    </>
  );
}

function StylistDashboard({ dashboard }: { dashboard: MobileStylistDashboardResponse }) {
  return (
    <>
      <SectionTitle title="Next client" subtitle="Your next assigned appointment today." />
      {dashboard.today.nextAppointment ? (
        <AppointmentCard appointment={dashboard.today.nextAppointment} featured />
      ) : (
        <EmptyState
          title="You have no appointments scheduled for today."
          body="Assigned appointments will appear here when clients are booked in."
        />
      )}

      <View style={styles.metricGrid}>
        <MetricTile label="Today's appointments" value={String(dashboard.today.totalAppointments)} />
      </View>

      <SectionTitle title="Today’s schedule" subtitle="Assigned booking list for today." />
      <AppointmentList
        appointments={dashboard.today.appointments}
        emptyTitle="You have no appointments scheduled for today."
        emptyBody="Enjoy the quiet moment."
      />

      <SectionTitle title="Quick actions" />
      <View style={styles.actionGrid}>
        <QuickAction title="Schedule" subtitle="Today’s bookings" onPress={() => router.push('/bookings')} />
        <QuickAction title="Client notes" subtitle="Open profiles" onPress={() => router.push('/bookings')} />
        <QuickAction title="Rota" subtitle="Your week" onPress={() => router.push('/rota')} />
        <QuickAction title="Performance" subtitle="Your stats" onPress={() => router.push('/performance')} />
      </View>
    </>
  );
}

function ManagerDashboard({ dashboard }: { dashboard: MobileManagerDashboardResponse }) {
  return (
    <>
      <View style={styles.panelAccent}>
        <Text style={styles.eyebrow}>Location operations</Text>
        <Text style={styles.panelTitle}>{dashboard.location.name}</Text>
        <Text style={styles.muted}>Today’s live location summary.</Text>
      </View>
      <View style={styles.metricGrid}>
        <MetricTile label="Bookings" value={String(dashboard.today.bookingsCount)} />
        <MetricTile label="Completed" value={String(dashboard.today.completedBookingsCount)} />
        <MetricTile label="Upcoming" value={String(dashboard.today.upcomingBookingsCount)} />
        <MetricTile label="Stylists" value={String(dashboard.today.stylistsWorkingToday)} />
        <MetricTile label="Low stock" value={String(dashboard.today.lowStockAlertCount)} tone={dashboard.today.lowStockAlertCount > 0 ? 'warning' : 'default'} />
      </View>

      <SectionTitle title="Recent appointments" subtitle="Today’s latest operational view." />
      <AppointmentList
        appointments={dashboard.today.recentAppointments}
        emptyTitle="No appointments today"
        emptyBody="Bookings for this location will appear here."
      />

      <SectionTitle title="Quick actions" />
      <View style={styles.actionGrid}>
        <QuickAction title="Bookings" subtitle="Today’s diary" onPress={() => router.push('/bookings')} />
        <QuickAction title="Rota" subtitle="Team cover" onPress={() => router.push('/rota')} />
        <QuickAction title="Low stock" subtitle="Inventory alerts" onPress={() => router.push('/dashboard')} />
      </View>
    </>
  );
}

function OwnerDashboard({ dashboard }: { dashboard: MobileOwnerDashboardResponse }) {
  return (
    <>
      <View style={styles.panelAccent}>
        <Text style={styles.eyebrow}>Owner overview</Text>
        <Text style={styles.panelTitle}>Owner access</Text>
        <Text style={styles.muted}>
          {dashboard.message}
        </Text>
        <Text style={styles.metricHelper}>
          {dashboard.locations.length
            ? `${dashboard.locations.length} accessible location${dashboard.locations.length === 1 ? '' : 's'}`
            : 'No locations available in this session.'}
        </Text>
      </View>
      <SectionTitle title="Quick actions" />
      <QuickAction title="Operational dashboard" subtitle="Mobile overview" onPress={() => router.push('/dashboard')} />
    </>
  );
}

function SectionTitle({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <View style={styles.sectionTitle}>
      <Text style={styles.sectionTitleText}>{title}</Text>
      {subtitle ? <Text style={styles.muted}>{subtitle}</Text> : null}
    </View>
  );
}

function MetricTile({
  label,
  value,
  tone = 'default',
}: {
  label: string;
  value: string;
  tone?: 'default' | 'warning';
}) {
  return (
    <View style={[styles.metricTile, tone === 'warning' && styles.metricTileWarning]}>
      <Text style={[styles.metricValue, tone === 'warning' && styles.metricValueWarning]}>{value}</Text>
      <Text style={styles.metricLabel}>{label}</Text>
    </View>
  );
}

function QuickAction({ title, subtitle, onPress }: { title: string; subtitle: string; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => [styles.quickAction, pressed && styles.pressed]}>
      <View style={styles.quickActionIcon}>
        <Text style={styles.quickActionIconText}>{title.charAt(0).toUpperCase()}</Text>
      </View>
      <View style={styles.flex}>
        <Text style={styles.quickActionTitle}>{title}</Text>
        <Text style={styles.muted}>{subtitle}</Text>
      </View>
      <Text style={styles.chevron}>›</Text>
    </Pressable>
  );
}

function AppointmentList({
  appointments,
  emptyTitle,
  emptyBody,
}: {
  appointments: StaffBookingSummary[];
  emptyTitle: string;
  emptyBody: string;
}) {
  if (appointments.length === 0) {
    return <EmptyState title={emptyTitle} body={emptyBody} />;
  }
  return (
    <View style={styles.list}>
      {appointments.map((appointment) => (
        <AppointmentCard key={appointment.id} appointment={appointment} />
      ))}
    </View>
  );
}

function AppointmentCard({ appointment, featured = false }: { appointment: StaffBookingSummary; featured?: boolean }) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={() => router.push('/bookings')}
      style={({ pressed }) => [styles.pressable, pressed && styles.pressed]}
    >
      <View style={[styles.appointmentCard, featured && styles.appointmentCardFeatured]}>
        <View style={styles.cardHeader}>
          <View style={styles.cardTitleBlock}>
            {featured ? <Text style={styles.eyebrow}>Up next</Text> : null}
            <Text style={styles.cardTitle}>{appointment.clientDisplayName}</Text>
            <Text style={styles.muted}>{appointment.serviceNames.join(', ') || 'Service'}</Text>
          </View>
          <StatusPill status={appointment.status} />
        </View>
        <View style={styles.detailRow}>
          <Detail label="Time" value={`${formatTime(appointment.startsAt)} - ${formatTime(appointment.endsAt)}`} />
          <Detail label="Date" value={formatDateShort(appointment.startsAt)} />
        </View>
        {appointment.clientNote ? <Text style={styles.warning}>Note: {appointment.clientNote}</Text> : null}
      </View>
    </Pressable>
  );
}

function VisitCard({ visit }: { visit: CrmVisitSummary }) {
  return (
    <View style={styles.appointmentCard}>
      <Text style={styles.cardTitle}>{visit.serviceSummary ?? visit.clientVisibleSummary ?? 'Visit'}</Text>
      <Text style={styles.muted}>{formatDate(visit.occurredAt)}</Text>
      <StatusLabel label={formatStatus(visit.status)} />
    </View>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.detailBox}>
      <Text style={styles.detailLabel}>{label}</Text>
      <Text style={styles.detailValue}>{value}</Text>
    </View>
  );
}

function StatusLabel({ label }: { label: string }) {
  return (
    <View style={styles.statusNeutral}>
      <Text style={styles.statusText}>{label}</Text>
    </View>
  );
}

function StatusPill({ status }: { status: StaffBookingSummary['status'] }) {
  return (
    <View style={[styles.statusPill, status === 'completed' ? styles.statusGood : styles.statusNeutral]}>
      <Text style={styles.statusText}>{formatStatus(status)}</Text>
    </View>
  );
}

function isMobileDashboardRole(role: string): role is 'owner' | 'manager' | 'stylist' | 'client' {
  return role === 'owner' || role === 'manager' || role === 'stylist' || role === 'client';
}

function roleSubtitle(role: string | undefined): string {
  if (role === 'client') return 'Book, view, and manage your appointments.';
  if (role === 'stylist') return 'Manage today’s assigned work clearly.';
  if (role === 'manager') return 'Lightweight location operations for today.';
  if (role === 'owner') return 'Mobile overview. Full controls live in the web dashboard.';
  return 'Your Sheer mobile dashboard.';
}

function firstName(value: string | undefined): string {
  return value?.split(' ')[0] || 'there';
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

function formatDateShort(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

function formatStatus(value: string): string {
  return value
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

const styles = StyleSheet.create({
  list: {
    gap: spacing.base,
  },
  flex: { flex: 1, gap: spacing.xs },
  hero: {
    gap: spacing.sm,
    padding: spacing.xl,
    borderRadius: radius.cardLg,
    borderWidth: 1,
    borderColor: 'rgba(196,160,245,0.28)',
    backgroundColor: palette.ink[700],
  },
  heroTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
  },
  eyebrow: {
    color: palette.brand[300],
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 1.2,
    textTransform: 'uppercase',
  },
  heroTitle: {
    color: palette.white,
    fontSize: 30,
    fontWeight: '800',
    letterSpacing: -0.5,
  },
  heroBody: {
    color: 'rgba(255,255,255,0.72)',
    fontSize: 14,
    lineHeight: 21,
  },
  livePill: {
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    backgroundColor: 'rgba(74,222,128,0.16)',
    borderWidth: 1,
    borderColor: 'rgba(74,222,128,0.36)',
  },
  livePillText: {
    color: palette.success[300],
    fontSize: 12,
    fontWeight: '800',
  },
  sectionTitle: {
    gap: spacing.xs,
    marginTop: spacing.sm,
  },
  sectionTitleText: {
    color: palette.white,
    fontSize: 20,
    fontWeight: '800',
  },
  panel: {
    gap: spacing.sm,
    padding: spacing.base,
    borderRadius: radius.cardLg,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
    backgroundColor: 'rgba(255,255,255,0.055)',
  },
  panelAccent: {
    gap: spacing.sm,
    padding: spacing.lg,
    borderRadius: radius.cardLg,
    borderWidth: 1,
    borderColor: 'rgba(196,160,245,0.28)',
    backgroundColor: 'rgba(166,124,245,0.12)',
  },
  panelTitle: {
    color: palette.white,
    fontSize: 22,
    fontWeight: '800',
  },
  alertCard: {
    gap: spacing.sm,
    padding: spacing.base,
    borderRadius: radius.cardLg,
    borderWidth: 1,
    borderColor: 'rgba(248,113,113,0.34)',
    backgroundColor: 'rgba(248,113,113,0.09)',
  },
  loadingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.base,
  },
  metricGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  metricTile: {
    minWidth: '31%',
    flexGrow: 1,
    gap: spacing.xs,
    padding: spacing.base,
    borderRadius: radius.cardLg,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
    backgroundColor: 'rgba(255,255,255,0.055)',
  },
  metricTileWarning: {
    borderColor: 'rgba(245,158,11,0.38)',
    backgroundColor: 'rgba(245,158,11,0.11)',
  },
  metricValue: {
    color: palette.brand[300],
    fontSize: 26,
    fontWeight: '800',
  },
  metricValueWarning: {
    color: palette.warning[300],
  },
  metricLabel: {
    color: 'rgba(255,255,255,0.64)',
    fontSize: 12,
    fontWeight: '700',
  },
  metricHelper: {
    color: palette.brand[300],
    fontSize: 13,
    fontWeight: '800',
  },
  actionGrid: {
    gap: spacing.sm,
  },
  quickAction: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.base,
    borderRadius: radius.cardLg,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
    backgroundColor: 'rgba(255,255,255,0.055)',
  },
  quickActionIcon: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.full,
    backgroundColor: 'rgba(196,160,245,0.18)',
    borderWidth: 1,
    borderColor: 'rgba(196,160,245,0.32)',
  },
  quickActionIconText: {
    color: palette.white,
    fontSize: 16,
    fontWeight: '800',
  },
  quickActionTitle: {
    color: palette.white,
    fontSize: 15,
    fontWeight: '800',
  },
  chevron: {
    color: palette.brand[300],
    fontSize: 28,
    fontWeight: '300',
  },
  pressable: {
    borderRadius: radius.cardLg,
  },
  pressed: {
    opacity: 0.78,
  },
  cardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: spacing.md,
  },
  cardTitleBlock: {
    flex: 1,
    gap: spacing.xs,
  },
  cardTitle: {
    color: palette.white,
    fontSize: 17,
    fontWeight: '800',
  },
  muted: {
    color: 'rgba(255,255,255,0.68)',
    fontSize: 13,
  },
  appointmentCard: {
    gap: spacing.base,
    padding: spacing.base,
    borderRadius: radius.cardLg,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
    backgroundColor: 'rgba(255,255,255,0.055)',
  },
  appointmentCardFeatured: {
    borderColor: 'rgba(196,160,245,0.32)',
    backgroundColor: 'rgba(166,124,245,0.13)',
  },
  detailRow: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  detailBox: {
    flex: 1,
    gap: spacing.xs,
    padding: spacing.sm,
    borderRadius: radius.inputLg,
    backgroundColor: 'rgba(24,20,31,0.58)',
  },
  detailLabel: {
    color: 'rgba(255,255,255,0.48)',
    fontSize: 10,
    fontWeight: '800',
    textTransform: 'uppercase',
  },
  detailValue: {
    color: palette.white,
    fontSize: 12,
    fontWeight: '700',
  },
  warning: {
    color: palette.warning[300],
    fontWeight: '700',
  },
  error: {
    color: palette.danger[300],
    fontWeight: '700',
  },
  statusPill: {
    alignSelf: 'flex-start',
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  statusGood: {
    backgroundColor: 'rgba(74,222,128,0.24)',
  },
  statusNeutral: {
    backgroundColor: 'rgba(148,163,184,0.24)',
  },
  statusText: {
    color: palette.white,
    fontSize: 11,
    fontWeight: '700',
  },
});
