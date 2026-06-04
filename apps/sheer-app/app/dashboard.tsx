import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Redirect, router } from 'expo-router';
import type {
  CrmVisitSummary,
  MobileClientDashboardResponse,
  MobileManagerDashboardResponse,
  MobileOwnerDashboardResponse,
  StaffBookingSummary,
} from '@sheer/domain';
import { palette, radius, spacing } from '@sheer/design-tokens';
import { ProtectedScreen } from '../src/auth/ProtectedScreen';
import { useAuth } from '../src/auth/AuthProvider';
import * as api from '../src/auth/api';

type BottomTab = 'home' | 'visits' | 'profile';

// ── Root screen ───────────────────────────────────────────────────────────────

export default function DashboardScreen() {
  const auth = useAuth();
  const { signOut, user } = auth;
  const accessToken = auth.session?.accessToken ?? '';
  const isClient = user?.role === 'client';

  const [dashboard, setDashboard] = useState<api.MobileDashboardResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<BottomTab>('home');

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

  useEffect(() => { void load(); }, [load]);

  // Tab navigation — visits tab pushes to dedicated page for non-clients too
  function handleTabPress(tab: BottomTab) {
    if (tab === 'profile') { router.push('/profile'); return; }
    if (tab === 'visits') { router.push('/client/visits'); return; }
    setActiveTab('home');
  }

  const name = firstName(user?.profile.fullName);

  // Stylists no longer have a dashboard — their home is the performance screen,
  // reached through the bottom tab bar.
  if (user?.role === 'stylist') {
    return <Redirect href="/performance" />;
  }

  return (
    <ProtectedScreen allowedRoles={['owner', 'manager', 'stylist', 'client']}>
      <SafeAreaView style={s.screen} edges={['top']}>

        {/* ── Top bar ── */}
        <View style={s.topBar}>
          <View>
            <Text style={s.topBarGreeting}>{greeting()}</Text>
            <Text style={s.topBarName}>{name}</Text>
          </View>
          <Pressable
            onPress={() => router.push('/profile')}
            style={({ pressed }) => [s.avatarBtn, pressed && s.pressed]}
          >
            <Text style={s.avatarBtnText}>{name.slice(0, 2).toUpperCase()}</Text>
          </Pressable>
        </View>

        {/* ── Content ── */}
        <ScrollView
          contentContainerStyle={s.scroll}
          showsVerticalScrollIndicator={false}
        >
          {error ? (
            <View style={s.errorCard}>
              <Text style={s.errorTitle}>Dashboard unavailable</Text>
              <Text style={s.errorBody}>{error}</Text>
              <Pressable
                onPress={() => void load()}
                style={({ pressed }) => [s.retryBtn, pressed && s.pressed]}
              >
                <Text style={s.retryBtnText}>Try again</Text>
              </Pressable>
            </View>
          ) : null}

          {loading ? (
            <View style={s.loadingCard}>
              <ActivityIndicator color={palette.brand[300]} size="small" />
              <Text style={s.loadingText}>Loading your dashboard…</Text>
            </View>
          ) : dashboard?.role === 'client' ? (
            <ClientDashboard dashboard={dashboard} />
          ) : dashboard?.role === 'manager' ? (
            <ManagerDashboard dashboard={dashboard} />
          ) : dashboard?.role === 'owner' ? (
            <OwnerDashboard dashboard={dashboard} />
          ) : null}

          {/* Logout — only for non-client roles where the bottom tab bar isn't shown */}
          {!isClient ? (
            <Pressable
              onPress={() => void signOut()}
              style={({ pressed }) => [s.logoutBtn, pressed && s.pressed]}
            >
              <Text style={s.logoutBtnText}>Sign out</Text>
            </Pressable>
          ) : null}
        </ScrollView>

        {/* ── Bottom tab bar (client only) ── */}
        {isClient ? (
          <SafeAreaView edges={['bottom']} style={s.tabBarSafe}>
            <View style={s.tabBar}>
              <TabBarItem
                icon="⊞"
                label="Home"
                active={activeTab === 'home'}
                onPress={() => handleTabPress('home')}
              />
              <TabBarItem
                icon="◷"
                label="Visits"
                active={activeTab === 'visits'}
                onPress={() => handleTabPress('visits')}
              />
              <TabBarItem
                icon="◉"
                label="Profile"
                active={activeTab === 'profile'}
                onPress={() => handleTabPress('profile')}
              />
            </View>
          </SafeAreaView>
        ) : null}

      </SafeAreaView>
    </ProtectedScreen>
  );
}

// ── Tab bar item ──────────────────────────────────────────────────────────────

function TabBarItem({
  icon,
  label,
  active,
  onPress,
}: {
  icon: string;
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [s.tabItem, pressed && s.pressed]}
      accessibilityRole="tab"
      accessibilityState={{ selected: active }}
    >
      <Text style={[s.tabIcon, active && s.tabIconActive]}>{icon}</Text>
      <Text style={[s.tabLabel, active && s.tabLabelActive]}>{label}</Text>
      {active ? <View style={s.tabDot} /> : null}
    </Pressable>
  );
}

// ── Client dashboard ──────────────────────────────────────────────────────────

function ClientDashboard({ dashboard }: { dashboard: MobileClientDashboardResponse }) {
  const visits = dashboard.visitHistory.slice(0, 3);

  return (
    <>
      {/* Next appointment hero card */}
      {dashboard.nextAppointment ? (
        <NextAppointmentCard appointment={dashboard.nextAppointment} />
      ) : (
        <View style={s.emptyApptCard}>
          <Text style={s.emptyApptTitle}>No upcoming appointments</Text>
          <Text style={s.emptyApptBody}>Book your next visit whenever you're ready.</Text>
        </View>
      )}

      {/* Book CTA */}
      <Pressable
        onPress={() => router.push('/booking/location')}
        style={({ pressed }) => [s.bookBtn, pressed && s.pressed]}
      >
        <Text style={s.bookBtnIcon}>＋</Text>
        <Text style={s.bookBtnText}>Book an appointment</Text>
      </Pressable>

      {/* Recent visits */}
      <View style={s.sectionHeader}>
        <Text style={s.sectionTitle}>Recent Visits</Text>
        <Pressable
          onPress={() => router.push('/client/visits')}
          style={({ pressed }) => [s.viewAllBtn, pressed && s.pressed]}
        >
          <Text style={s.viewAllText}>View all</Text>
          <Text style={s.viewAllChevron}>›</Text>
        </Pressable>
      </View>

      {visits.length === 0 ? (
        <View style={s.emptyVisits}>
          <Text style={s.emptyVisitsText}>No visits recorded yet.</Text>
        </View>
      ) : (
        <View style={s.visitList}>
          {visits.map((visit, idx) => (
            <VisitRow key={visit.id} visit={visit} isLast={idx === visits.length - 1} />
          ))}
        </View>
      )}
    </>
  );
}

// ── Next appointment card (client hero) ───────────────────────────────────────

function NextAppointmentCard({ appointment }: { appointment: StaffBookingSummary }) {
  return (
    <Pressable
      onPress={() => router.push('/bookings')}
      style={({ pressed }) => [s.apptCard, pressed && s.pressed]}
    >
      <Text style={s.apptEyebrow}>YOUR NEXT APPOINTMENT</Text>
      <Text style={s.apptTitle}>
        {formatDayFull(appointment.startsAt)} · {formatTime(appointment.startsAt)}
      </Text>
      <Text style={s.apptService}>
        {appointment.serviceNames.join(' · ') || 'Appointment'}
        {appointment.durationMinutes ? ` · ${appointment.durationMinutes / 60} hours` : ''}
        {appointment.assignedStaffProfileId ? ' · with stylist' : ''}
      </Text>

      {/* Location tag */}
      <View style={s.apptFooter}>
        <View style={s.apptLocationTag}>
          <Text style={s.apptLocationText}>Pinner</Text>
        </View>
        <View style={s.apptActions}>
          <Pressable style={s.apptActionBtn}>
            <Text style={s.apptActionBtnText}>Directions</Text>
          </Pressable>
          <Pressable
            onPress={() => router.push('/bookings')}
            style={s.apptManageBtn}
          >
            <Text style={s.apptManageBtnText}>Manage</Text>
          </Pressable>
        </View>
      </View>
    </Pressable>
  );
}

// ── Visit row (compact, list style) ───────────────────────────────────────────

function VisitRow({ visit, isLast }: { visit: CrmVisitSummary; isLast: boolean }) {
  return (
    <View style={[s.visitRow, isLast && s.visitRowLast]}>
      <View style={s.visitRowMain}>
        <Text style={s.visitRowTitle}>
          {visit.serviceSummary ?? visit.clientVisibleSummary ?? 'Visit'}
        </Text>
        <Text style={s.visitRowMeta}>
          {formatDate(visit.occurredAt)}
          {visit.stylistName ? ` · with ${visit.stylistName}` : ''}
        </Text>
      </View>
      <View style={s.visitRowRight}>
        <Text style={s.visitRowLocation}>Pinner</Text>
        <Text style={s.visitRowChevron}>›</Text>
      </View>
    </View>
  );
}

// ── Staff dashboards (unchanged logic, upgraded style) ────────────────────────

function ManagerDashboard({ dashboard }: { dashboard: MobileManagerDashboardResponse }) {
  return (
    <>
      <View style={s.accentPanel}>
        <Text style={s.accentPanelEyebrow}>LOCATION OPERATIONS</Text>
        <Text style={s.accentPanelTitle}>{dashboard.location.name}</Text>
        <Text style={s.accentPanelBody}>Today's live location summary.</Text>
      </View>

      <View style={s.metricRow}>
        <MetricTile label="Bookings" value={String(dashboard.today.bookingsCount)} />
        <MetricTile label="Completed" value={String(dashboard.today.completedBookingsCount)} />
        <MetricTile label="Upcoming" value={String(dashboard.today.upcomingBookingsCount)} />
        <MetricTile label="Stylists" value={String(dashboard.today.stylistsWorkingToday)} />
        <MetricTile
          label="Low stock"
          value={String(dashboard.today.lowStockAlertCount)}
          tone={dashboard.today.lowStockAlertCount > 0 ? 'warning' : 'default'}
        />
      </View>

      <SectionRow title="Recent appointments" />
      <StaffAppointmentList
        appointments={dashboard.today.recentAppointments}
        emptyTitle="No appointments today"
        emptyBody="Bookings will appear here."
      />

      <SectionRow title="Quick actions" />
      <View style={s.quickGrid}>
        <QuickAction icon="P" title="Profile" subtitle="Your details" onPress={() => router.push('/profile')} />
        <QuickAction icon="B" title="Bookings" subtitle="Today's diary" onPress={() => router.push('/bookings')} />
        <QuickAction icon="R" title="Rota" subtitle="Team cover" onPress={() => router.push('/rota')} />
      </View>
    </>
  );
}

function OwnerDashboard({ dashboard }: { dashboard: MobileOwnerDashboardResponse }) {
  return (
    <>
      <View style={s.accentPanel}>
        <Text style={s.accentPanelEyebrow}>OWNER OVERVIEW</Text>
        <Text style={s.accentPanelTitle}>Owner access</Text>
        <Text style={s.accentPanelBody}>{dashboard.message}</Text>
        {dashboard.locations.length > 0 ? (
          <Text style={s.accentPanelMeta}>
            {dashboard.locations.length} accessible location{dashboard.locations.length === 1 ? '' : 's'}
          </Text>
        ) : null}
      </View>
      <SectionRow title="Quick actions" />
      <View style={s.quickGrid}>
        <QuickAction icon="P" title="Profile" subtitle="Your details" onPress={() => router.push('/profile')} />
        <QuickAction icon="D" title="Dashboard" subtitle="Mobile overview" onPress={() => router.push('/dashboard')} />
      </View>
    </>
  );
}

// ── Shared sub-components ─────────────────────────────────────────────────────

function SectionRow({ title }: { title: string }) {
  return (
    <View style={s.sectionRowOnly}>
      <Text style={s.sectionTitle}>{title}</Text>
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
    <View style={[s.metricTile, tone === 'warning' && s.metricTileWarning]}>
      <Text style={[s.metricValue, tone === 'warning' && s.metricValueWarning]}>{value}</Text>
      <Text style={s.metricLabel}>{label}</Text>
    </View>
  );
}

function QuickAction({
  icon,
  title,
  subtitle,
  onPress,
}: {
  icon: string;
  title: string;
  subtitle: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={({ pressed }) => [s.quickAction, pressed && s.pressed]}
    >
      <View style={s.quickActionIcon}>
        <Text style={s.quickActionIconText}>{icon}</Text>
      </View>
      <View style={s.quickActionInfo}>
        <Text style={s.quickActionTitle}>{title}</Text>
        <Text style={s.quickActionSub}>{subtitle}</Text>
      </View>
      <Text style={s.quickActionChevron}>›</Text>
    </Pressable>
  );
}

function StaffAppointmentList({
  appointments,
  emptyTitle,
  emptyBody,
}: {
  appointments: StaffBookingSummary[];
  emptyTitle: string;
  emptyBody: string;
}) {
  if (appointments.length === 0) {
    return (
      <View style={s.emptyApptCard}>
        <Text style={s.emptyApptTitle}>{emptyTitle}</Text>
        <Text style={s.emptyApptBody}>{emptyBody}</Text>
      </View>
    );
  }
  return (
    <View style={s.staffApptList}>
      {appointments.map((a) => (
        <StaffAppointmentCard key={a.id} appointment={a} />
      ))}
    </View>
  );
}

function StaffAppointmentCard({
  appointment,
  featured = false,
}: {
  appointment: StaffBookingSummary;
  featured?: boolean;
}) {
  return (
    <Pressable
      onPress={() => router.push('/bookings')}
      style={({ pressed }) => [s.staffApptCard, featured && s.staffApptCardFeatured, pressed && s.pressed]}
    >
      <View style={s.staffApptHeader}>
        <View style={s.staffApptInfo}>
          {featured ? <Text style={s.staffApptEyebrow}>UP NEXT</Text> : null}
          <Text style={s.staffApptTitle}>{appointment.clientDisplayName}</Text>
          <Text style={s.staffApptService}>{appointment.serviceNames.join(', ') || 'Service'}</Text>
        </View>
        <View style={[s.statusPill, appointment.status === 'completed' ? s.statusGood : s.statusNeutral]}>
          <Text style={s.statusText}>{formatStatus(appointment.status)}</Text>
        </View>
      </View>
      <View style={s.staffApptDetails}>
        <DetailChip label="Time" value={`${formatTime(appointment.startsAt)} – ${formatTime(appointment.endsAt)}`} />
        <DetailChip label="Date" value={formatDateShort(appointment.startsAt)} />
      </View>
    </Pressable>
  );
}

function DetailChip({ label, value }: { label: string; value: string }) {
  return (
    <View style={s.detailChip}>
      <Text style={s.detailChipLabel}>{label}</Text>
      <Text style={s.detailChipValue}>{value}</Text>
    </View>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function isMobileDashboardRole(role: string): role is 'owner' | 'manager' | 'stylist' | 'client' {
  return ['owner', 'manager', 'stylist', 'client'].includes(role);
}

function greeting(): string {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
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

function formatDayFull(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
}

function formatStatus(value: string): string {
  return value.split('_').map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
}

// ── Styles ────────────────────────────────────────────────────────────────────

const BG = '#18141F';
const CARD = '#211A2E';
const CARD2 = '#271F38';
const BORDER = 'rgba(255,255,255,0.08)';
const BORDER2 = 'rgba(255,255,255,0.13)';
const BRAND = palette.brand[500];
const BRAND_LIGHT = palette.brand[300];

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: BG },
  pressed: { opacity: 0.74 },

  // ── Top bar
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  topBarGreeting: {
    color: 'rgba(255,255,255,0.48)',
    fontSize: 13,
    fontWeight: '500',
  },
  topBarName: {
    color: palette.white,
    fontSize: 26,
    fontWeight: '800',
    letterSpacing: -0.5,
    marginTop: 1,
  },
  avatarBtn: {
    width: 42,
    height: 42,
    borderRadius: radius.full,
    backgroundColor: BRAND,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: 'rgba(196,160,245,0.4)',
  },
  avatarBtnText: {
    color: palette.white,
    fontSize: 14,
    fontWeight: '800',
  },

  // ── Scroll
  scroll: {
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing['4xl'],
    gap: spacing.base,
  },

  // ── Loading / error
  loadingCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.lg,
    borderRadius: radius.cardLg,
    backgroundColor: CARD,
    borderWidth: 1,
    borderColor: BORDER2,
  },
  loadingText: {
    color: 'rgba(255,255,255,0.55)',
    fontSize: 14,
    fontWeight: '600',
  },
  errorCard: {
    gap: spacing.sm,
    padding: spacing.base,
    borderRadius: radius.cardLg,
    borderWidth: 1,
    borderColor: 'rgba(248,113,113,0.3)',
    backgroundColor: 'rgba(248,113,113,0.08)',
  },
  errorTitle: { color: palette.white, fontSize: 15, fontWeight: '800' },
  errorBody: { color: palette.danger[300], fontSize: 13 },
  retryBtn: {
    alignSelf: 'flex-start',
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: 'rgba(248,113,113,0.4)',
  },
  retryBtnText: { color: palette.danger[300], fontSize: 12, fontWeight: '700' },

  // ── Next appointment card (client hero)
  apptCard: {
    padding: spacing.lg,
    borderRadius: radius.cardLg,
    borderWidth: 1,
    borderColor: 'rgba(196,160,245,0.28)',
    backgroundColor: '#261D37',
    gap: spacing.sm,
  },
  apptEyebrow: {
    color: BRAND_LIGHT,
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 1.4,
  },
  apptTitle: {
    color: palette.white,
    fontSize: 20,
    fontWeight: '800',
    letterSpacing: -0.3,
    lineHeight: 26,
  },
  apptService: {
    color: 'rgba(255,255,255,0.6)',
    fontSize: 13,
    lineHeight: 18,
  },
  apptFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: spacing.xs,
  },
  apptLocationTag: {
    paddingHorizontal: spacing.md,
    paddingVertical: 4,
    borderRadius: radius.pill,
    backgroundColor: 'rgba(255,255,255,0.07)',
    borderWidth: 1,
    borderColor: BORDER2,
  },
  apptLocationText: { color: 'rgba(255,255,255,0.6)', fontSize: 12, fontWeight: '600' },
  apptActions: { flexDirection: 'row', gap: spacing.sm },
  apptActionBtn: {
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: BORDER2,
  },
  apptActionBtnText: { color: 'rgba(255,255,255,0.72)', fontSize: 12, fontWeight: '700' },
  apptManageBtn: {
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    borderRadius: radius.pill,
    backgroundColor: BRAND,
  },
  apptManageBtnText: { color: palette.white, fontSize: 12, fontWeight: '800' },

  // ── Empty appointment state
  emptyApptCard: {
    padding: spacing.xl,
    borderRadius: radius.cardLg,
    borderWidth: 1,
    borderColor: BORDER,
    backgroundColor: CARD,
    alignItems: 'center',
    gap: spacing.xs,
  },
  emptyApptTitle: { color: palette.white, fontSize: 15, fontWeight: '700' },
  emptyApptBody: { color: 'rgba(255,255,255,0.45)', fontSize: 13, textAlign: 'center' },

  // ── Book button
  bookBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    padding: spacing.base,
    borderRadius: radius.cardLg,
    backgroundColor: BRAND,
    shadowColor: BRAND,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.38,
    shadowRadius: 12,
    elevation: 5,
  },
  bookBtnIcon: { color: palette.white, fontSize: 18, fontWeight: '300', marginTop: -1 },
  bookBtnText: { color: palette.white, fontSize: 15, fontWeight: '800', letterSpacing: 0.2 },

  // ── Section header with View all
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: spacing.sm,
  },
  sectionRowOnly: {
    marginTop: spacing.sm,
  },
  sectionTitle: {
    color: palette.white,
    fontSize: 17,
    fontWeight: '800',
    letterSpacing: -0.2,
  },
  viewAllBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: 'rgba(196,160,245,0.25)',
    backgroundColor: 'rgba(166,124,245,0.08)',
  },
  viewAllText: { color: BRAND_LIGHT, fontSize: 12, fontWeight: '700' },
  viewAllChevron: { color: BRAND_LIGHT, fontSize: 16, lineHeight: 18 },

  // ── Visit list
  visitList: {
    borderRadius: radius.cardLg,
    backgroundColor: CARD,
    borderWidth: 1,
    borderColor: BORDER2,
    overflow: 'hidden',
  },
  visitRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.base,
    paddingVertical: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: BORDER2,
  },
  visitRowLast: { borderBottomWidth: 0 },
  visitRowMain: { flex: 1, gap: 3 },
  visitRowTitle: { color: palette.white, fontSize: 14, fontWeight: '700' },
  visitRowMeta: { color: 'rgba(255,255,255,0.48)', fontSize: 12 },
  visitRowRight: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  visitRowLocation: {
    color: 'rgba(255,255,255,0.48)',
    fontSize: 12,
    fontWeight: '600',
  },
  visitRowChevron: { color: 'rgba(255,255,255,0.28)', fontSize: 18 },

  // ── Empty visits
  emptyVisits: {
    padding: spacing.lg,
    borderRadius: radius.cardLg,
    borderWidth: 1,
    borderColor: BORDER,
    backgroundColor: CARD,
    alignItems: 'center',
  },
  emptyVisitsText: { color: 'rgba(255,255,255,0.4)', fontSize: 13 },

  // ── Bottom tab bar
  tabBarSafe: { backgroundColor: CARD },
  tabBar: {
    flexDirection: 'row',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: BORDER2,
    backgroundColor: CARD,
    paddingTop: spacing.sm,
    paddingBottom: spacing.xs,
  },
  tabItem: {
    flex: 1,
    alignItems: 'center',
    gap: 3,
    paddingVertical: spacing.xs,
    position: 'relative',
  },
  tabIcon: {
    fontSize: 20,
    color: 'rgba(255,255,255,0.3)',
  },
  tabIconActive: { color: BRAND_LIGHT },
  tabLabel: {
    fontSize: 10,
    fontWeight: '700',
    color: 'rgba(255,255,255,0.3)',
    letterSpacing: 0.4,
  },
  tabLabelActive: { color: BRAND_LIGHT },
  tabDot: {
    position: 'absolute',
    bottom: -4,
    width: 4,
    height: 4,
    borderRadius: 2,
    backgroundColor: BRAND,
  },

  // ── Logout
  logoutBtn: {
    marginTop: spacing.base,
    padding: spacing.base,
    borderRadius: radius.cardLg,
    borderWidth: 1,
    borderColor: BORDER2,
    alignItems: 'center',
  },
  logoutBtnText: { color: 'rgba(255,255,255,0.45)', fontSize: 14, fontWeight: '600' },

  // ── Accent panel (staff / manager / owner)
  accentPanel: {
    gap: spacing.sm,
    padding: spacing.lg,
    borderRadius: radius.cardLg,
    borderWidth: 1,
    borderColor: 'rgba(196,160,245,0.28)',
    backgroundColor: 'rgba(166,124,245,0.11)',
  },
  accentPanelEyebrow: {
    color: BRAND_LIGHT,
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 1.3,
  },
  accentPanelTitle: { color: palette.white, fontSize: 22, fontWeight: '800' },
  accentPanelBody: { color: 'rgba(255,255,255,0.65)', fontSize: 13, lineHeight: 19 },
  accentPanelMeta: { color: BRAND_LIGHT, fontSize: 13, fontWeight: '700' },

  // ── Metric row
  metricRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  metricTile: {
    minWidth: '30%',
    flexGrow: 1,
    gap: spacing.xs,
    padding: spacing.base,
    borderRadius: radius.cardLg,
    borderWidth: 1,
    borderColor: BORDER2,
    backgroundColor: CARD2,
  },
  metricTileWarning: {
    borderColor: 'rgba(245,158,11,0.35)',
    backgroundColor: 'rgba(245,158,11,0.09)',
  },
  metricValue: { color: BRAND_LIGHT, fontSize: 26, fontWeight: '800' },
  metricValueWarning: { color: palette.warning[300] },
  metricLabel: { color: 'rgba(255,255,255,0.55)', fontSize: 11, fontWeight: '700' },

  // ── Quick actions
  quickGrid: { gap: spacing.sm },
  quickAction: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.base,
    borderRadius: radius.cardLg,
    borderWidth: 1,
    borderColor: BORDER2,
    backgroundColor: CARD,
  },
  quickActionIcon: {
    width: 38,
    height: 38,
    borderRadius: radius.full,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(196,160,245,0.15)',
    borderWidth: 1,
    borderColor: 'rgba(196,160,245,0.3)',
  },
  quickActionIconText: { color: palette.white, fontSize: 15, fontWeight: '800' },
  quickActionInfo: { flex: 1, gap: 2 },
  quickActionTitle: { color: palette.white, fontSize: 14, fontWeight: '700' },
  quickActionSub: { color: 'rgba(255,255,255,0.45)', fontSize: 12 },
  quickActionChevron: { color: BRAND_LIGHT, fontSize: 22, fontWeight: '300' },

  // ── Staff appointment cards
  staffApptList: { gap: spacing.sm },
  staffApptCard: {
    gap: spacing.sm,
    padding: spacing.base,
    borderRadius: radius.cardLg,
    borderWidth: 1,
    borderColor: BORDER2,
    backgroundColor: CARD,
  },
  staffApptCardFeatured: {
    borderColor: 'rgba(196,160,245,0.3)',
    backgroundColor: 'rgba(166,124,245,0.11)',
  },
  staffApptHeader: { flexDirection: 'row', justifyContent: 'space-between', gap: spacing.md },
  staffApptInfo: { flex: 1, gap: 3 },
  staffApptEyebrow: { color: BRAND_LIGHT, fontSize: 10, fontWeight: '800', letterSpacing: 1.2 },
  staffApptTitle: { color: palette.white, fontSize: 16, fontWeight: '800' },
  staffApptService: { color: 'rgba(255,255,255,0.55)', fontSize: 13 },
  staffApptDetails: { flexDirection: 'row', gap: spacing.sm },
  statusPill: {
    alignSelf: 'flex-start',
    borderRadius: radius.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
  },
  statusGood: { backgroundColor: 'rgba(74,222,128,0.2)' },
  statusNeutral: { backgroundColor: 'rgba(148,163,184,0.2)' },
  statusText: { color: palette.white, fontSize: 11, fontWeight: '700' },
  detailChip: {
    flex: 1,
    gap: 3,
    padding: spacing.sm,
    borderRadius: radius.input,
    backgroundColor: 'rgba(24,20,31,0.55)',
  },
  detailChipLabel: {
    color: 'rgba(255,255,255,0.4)',
    fontSize: 9,
    fontWeight: '800',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  detailChipValue: { color: palette.white, fontSize: 12, fontWeight: '700' },
});
