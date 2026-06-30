import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type {
  PinUnlockResponse,
  SheerLabAnalyticsResponse,
  StaffBookingSummary,
} from '@sheer/domain';
import type React from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import type { RootStackParamList } from '../../app/navigation/routes';
import { getLabAnalyticsSummaryForSession } from '../../features/analytics/analyticsApi';
import {
  type LabCustomRange,
  type LabPeriod,
  periodPossessive,
  periodSuffix,
  resolveLabCustomWindow,
} from '../../features/analytics/period';
import { listLabAppointmentsForSession } from '../../features/appointments/appointmentsApi';
import { PeriodSelector } from './PeriodSelector';
import {
  getLabSessionBillingBreakdown,
  type LabSessionBillingBreakdown,
} from '../../features/formulas/formulasApi';
import { formulaDraftStore } from '../../features/formulas/formulaDraftStore';
import { getActiveLabSession, logoutLabSession } from '../../features/sheer-lab/labSession';
import { appConfig } from '../../config/appConfig';
import {
  activeStatusBadge,
  completedStatusBadge,
  formatClock,
  formatGrams,
  formatMoney,
  formatPercent,
  formatRelativeTime,
  formatTimeOfDay,
  initials,
  isActiveBooking,
  isCompletedBooking,
  sumProductUsageGrams,
  type StatusTone,
} from '../Home/dashboardHelpers';
import { featureFlags } from '../../config/featureFlags';
import { labTheme } from '../../theme/labTheme';
import { useBleScale } from '../../features/ble/hooks/useBleScale';
import { TopBar } from '../shared/LabShell';

const T = labTheme;
const C = T.colors;

const PAGE_SIZE_OPTIONS = [5, 10, 15, 20, 50] as const;
const DEFAULT_PAGE_SIZE = 20;

interface SessionPaginationState {
  page: number;
  pageSize: number;
  total: number;
  pageCount: number;
}

type FormulaHistoryScreenProps = NativeStackScreenProps<RootStackParamList, 'FormulaHistory'>;
type ChipTone = StatusTone;

// ---------------------------------------------------------------------------
// Real-data note
//
// The lab-session token can only reach two history-relevant endpoints, both
// scoped to the active chair and to the selected period (day / week / month /
// custom):
//   • lab appointments over a range  (listLabAppointmentsForSession)
//   • colour-bar analytics           (getLabAnalyticsSummaryForSession, owner/manager)
// Per-formula breakdowns / grams / activity live in a JWT-only store that this
// station cannot read, so this screen never fabricates them — sessions are
// derived from real appointments and the metrics from real analytics, with
// honest empty / locked states where the backend exposes nothing.
// ---------------------------------------------------------------------------

interface SessionGroupView {
  key: 'active' | 'completed';
  label: string;
  bookings: StaffBookingSummary[];
}

interface ActivityEntry {
  label: string;
  time: string;
  iso: string;
}

interface HistoryMetric {
  key: string;
  label: string;
  value: string;
  hint?: string;
  glyph: string;
  tone?: ChipTone;
  locked?: boolean;
}

// ---------------------------------------------------------------------------
// Responsive layout — mirrors the Formula console breakpoints.
// ---------------------------------------------------------------------------

interface HistoryLayout {
  mode: 'phone' | 'tablet' | 'wide';
  sidebarWidth: number;
  railWidth: number;
  pad: number;
  gap: number;
  showSidebar: boolean;
  showRail: boolean;
}

function getLayout(width: number): HistoryLayout {
  if (width >= 1024) {
    const large = width >= 1280;
    return {
      mode: 'wide',
      sidebarWidth: large ? 248 : 216,
      railWidth: clampNumber(Math.round(width * 0.32), 340, 420),
      pad: large ? T.spacing.xl : T.spacing.base,
      gap: T.spacing.lg,
      showSidebar: true,
      showRail: true,
    };
  }
  if (width >= 700) {
    return {
      mode: 'tablet',
      sidebarWidth: 208,
      railWidth: 0,
      pad: T.spacing.base,
      gap: T.spacing.base,
      showSidebar: true,
      showRail: false,
    };
  }
  return {
    mode: 'phone',
    sidebarWidth: 0,
    railWidth: 0,
    pad: T.spacing.base,
    gap: T.spacing.base,
    showSidebar: false,
    showRail: false,
  };
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

// ---------------------------------------------------------------------------
// Sidebar navigation model (dark shell) — History is the current screen.
// ---------------------------------------------------------------------------

type WorkingRoute = 'Home' | 'NewMix' | 'FormulaHistory' | 'Inventory';
type NavTarget = { kind: 'route'; route: WorkingRoute } | { kind: 'soon' } | { kind: 'current' };

interface NavEntry {
  key: string;
  label: string;
  glyph: string;
  target: NavTarget;
}

// Inventory management is owner/manager-only (stylists get a lock screen), so it
// only becomes a live destination for those roles.
function buildNavItems(canManageInventory: boolean): NavEntry[] {
  return ([
    { key: 'dashboard', label: 'Dashboard', glyph: '▦', target: { kind: 'route', route: 'Home' } },
    { key: 'new-mix', label: 'New Mix', glyph: '🧪', target: { kind: 'route', route: 'NewMix' } },
    { key: 'history', label: 'History', glyph: '🕘', target: { kind: 'current' } },
    {
      key: 'inventory',
      label: 'Inventory',
      glyph: '📦',
      target: canManageInventory ? { kind: 'route', route: 'Inventory' } : { kind: 'soon' },
    },
    { key: 'billing', label: 'Billing Rules', glyph: '🧾', target: { kind: 'soon' } },
    { key: 'audit', label: 'Audit Trail', glyph: '🛡️', target: { kind: 'soon' } },
    // Billing Rules and Audit Trail are hidden from the nav behind feature flags
    // for every role; their entries stay so the feature can be restored later.
  ] satisfies NavEntry[]).filter(
    (item) =>
      (item.key !== 'inventory' || canManageInventory) &&
      (item.key !== 'billing' || featureFlags.billingRules) &&
      (item.key !== 'audit' || featureFlags.auditTrail),
  );
}

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

export function FormulaHistoryScreen({ navigation }: FormulaHistoryScreenProps): React.JSX.Element {
  const { width } = useWindowDimensions();
  const layout = getLayout(width);

  const [session, setSession] = useState<PinUnlockResponse | undefined>();
  const ble = useBleScale();
  const [bookings, setBookings] = useState<StaffBookingSummary[]>([]);
  // `null` = analytics deliberately withheld (stylist session, 403);
  // `undefined` = not loaded yet or failed to load.
  const [analytics, setAnalytics] = useState<SheerLabAnalyticsResponse | null | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<number>(DEFAULT_PAGE_SIZE);
  const [period, setPeriod] = useState<LabPeriod>('today');
  const [customRange, setCustomRange] = useState<LabCustomRange>({ from: '', to: '' });
  const [selectedId, setSelectedId] = useState<string | undefined>();
  const [now, setNow] = useState<Date>(() => new Date());
  // Real billing breakdowns, cached per appointment id. `'loading'`/`'error'`
  // are transient markers so the audit panel can show state without refetching
  // when the user toggles back to an already-loaded session.
  const [billingByAppt, setBillingByAppt] = useState<
    Record<string, LabSessionBillingBreakdown | 'loading' | 'error'>
  >({});

  // Period-aware copy ("today" / "this week" / …) and a flag for the in-between
  // state where Custom is picked but both dates aren't chosen yet.
  const suffix = periodSuffix(period);
  const awaitingCustom = period === 'custom' && !resolveLabCustomWindow(customRange);

  const load = useCallback(async () => {
    setError(undefined);
    try {
      const activeSession = await getActiveLabSession();
      if (!activeSession) {
        navigation.reset({ index: 0, routes: [{ name: 'Auth' }] });
        return;
      }
      setSession(activeSession);

      // Custom period needs both ends chosen; until then, hold off fetching and
      // present an empty view rather than a misleading partial window.
      const customWindow = period === 'custom' ? resolveLabCustomWindow(customRange) : undefined;
      if (period === 'custom' && !customWindow) {
        setBookings([]);
        setAnalytics(undefined);
        return;
      }

      const [appointments, analyticsResult] = await Promise.allSettled([
        listLabAppointmentsForSession(activeSession.sessionId, period, customWindow ?? undefined),
        getLabAnalyticsSummaryForSession(activeSession.sessionId, period, customWindow ?? undefined),
      ]);

      setBookings(appointments.status === 'fulfilled' ? appointments.value.bookings : []);
      setAnalytics(analyticsResult.status === 'fulfilled' ? analyticsResult.value : undefined);

      if (appointments.status === 'rejected') {
        setError('Could not load sessions for this period. Pull to refresh to try again.');
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not load formula history');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [navigation, period, customRange]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 60000);
    return () => clearInterval(timer);
  }, []);

  const handleRefresh = useCallback(() => {
    setRefreshing(true);
    void load();
  }, [load]);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    // Only completed or in-the-chair appointments are "sessions" — upcoming
    // bookings have no mix yet, so they are not part of the history view.
    const sessions = bookings.filter((b) => isCompletedBooking(b) || isActiveBooking(b));
    if (!term) return sessions;
    return sessions.filter((entry) =>
      [entry.clientDisplayName, ...entry.serviceNames].some((field) => field.toLowerCase().includes(term)),
    );
  }, [bookings, search]);

  // One canonical order — live "in the chair" sessions first, then completed
  // (most recent first) — so client-side pagination slices a stable list.
  const orderedSessions = useMemo(() => {
    const active = filtered.filter(isActiveBooking);
    const completed = filtered
      .filter(isCompletedBooking)
      .sort((a, b) => completedSortKey(b) - completedSortKey(a));
    return [...active, ...completed];
  }, [filtered]);

  const total = orderedSessions.length;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));

  // The visible page, re-split into the familiar In-the-chair / Completed
  // groups so the list keeps its headers. Counts shown per group reflect the
  // current page; the "Showing X–Y of N" line gives the full total.
  const groups = useMemo<SessionGroupView[]>(() => {
    const start = (page - 1) * pageSize;
    const slice = orderedSessions.slice(start, start + pageSize);
    const active = slice.filter(isActiveBooking);
    const completed = slice.filter(isCompletedBooking);
    const result: SessionGroupView[] = [
      { key: 'active', label: 'In the chair', bookings: active },
      { key: 'completed', label: `Completed ${suffix}`, bookings: completed },
    ];
    return result.filter((group) => group.bookings.length > 0);
  }, [orderedSessions, page, pageSize, suffix]);

  const pagination = useMemo<SessionPaginationState>(
    () => ({ page, pageSize, total, pageCount }),
    [page, pageSize, total, pageCount],
  );

  // A new search / period changes the result set — restart at page 1.
  useEffect(() => {
    setPage(1);
  }, [search, period, customRange]);

  // Safety net: if the data shrank below the current page, snap back.
  useEffect(() => {
    if (page > pageCount) setPage(pageCount);
  }, [page, pageCount]);

  const selected = useMemo(
    () => filtered.find((entry) => entry.id === selectedId) ?? filtered[0],
    [filtered, selectedId],
  );

  // Appointments we've already kicked off a breakdown fetch for. Kept in a ref
  // (not the state map) so it can't appear in the effect deps — depending on
  // `billingByAppt` re-ran the effect the moment we wrote the 'loading' marker,
  // and its cleanup cancelled the in-flight request, wedging it on 'loading'.
  const requestedBillingRef = useRef<Set<string>>(new Set());

  // Fetch the real billing breakdown for the selected session, once per
  // appointment. Only completed sessions can have a finalized, billed mix.
  useEffect(() => {
    const apptId = selected?.id;
    const sid = session?.sessionId;
    if (!apptId || !sid || !selected || !isCompletedBooking(selected)) return;
    if (requestedBillingRef.current.has(apptId)) return;
    requestedBillingRef.current.add(apptId);

    let cancelled = false;
    setBillingByAppt((current) => ({ ...current, [apptId]: 'loading' }));
    void (async () => {
      try {
        const result = await getLabSessionBillingBreakdown(sid, apptId);
        if (!cancelled) setBillingByAppt((current) => ({ ...current, [apptId]: result }));
      } catch {
        // Allow a later retry (e.g. on refresh / reselect) after a failure.
        requestedBillingRef.current.delete(apptId);
        if (!cancelled) setBillingByAppt((current) => ({ ...current, [apptId]: 'error' }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selected, session?.sessionId]);

  const selectedBilling = selected ? billingByAppt[selected.id] : undefined;

  const canSeeFinance = session?.role === 'owner' || session?.role === 'manager';

  // A session whose colour charge was sent to the desk but not yet settled
  // ('awaiting_payment') can still be re-mixed. The previous mix's full rows are
  // only reachable from the in-memory draft store (keyed by client), so the
  // action is enabled only when that source formula is present on this device.
  const remixSourceId = useMemo(() => {
    if (!selected || selected.status !== 'awaiting_payment' || !selected.clientProfileId) return undefined;
    const history = formulaDraftStore.getHistoryForClient(selected.clientProfileId);
    const match = history.find((record) => record.visit.appointmentId === selected.id) ?? history[0];
    return match?.id;
  }, [selected]);

  const handleUpdateFormula = useCallback(() => {
    const sid = session?.sessionId;
    if (!sid || !selected || !remixSourceId) return;
    navigation.navigate('UpdateFormula', {
      entryContext: {
        labSessionId: sid,
        appointmentId: selected.id,
        clientProfileId: selected.clientProfileId,
        clientName: selected.clientDisplayName,
        serviceType: serviceLabel(selected),
        startsAt: selected.startsAt,
        patchTest: selected.patchTest,
      },
      sourceFormulaId: remixSourceId,
    });
  }, [navigation, remixSourceId, selected, session?.sessionId]);

  const metrics = useMemo<HistoryMetric[]>(
    () =>
      buildMetrics(
        filtered.filter(isActiveBooking).length,
        filtered.filter(isCompletedBooking).length,
        analytics,
        Boolean(canSeeFinance),
        suffix,
      ),
    [filtered, analytics, canSeeFinance, suffix],
  );

  const canManageInventory = session?.role === 'owner' || session?.role === 'manager';
  const navItems = useMemo(() => buildNavItems(canManageInventory), [canManageInventory]);

  const goToRoute = useCallback(
    (target: NavTarget) => {
      if (target.kind !== 'route') return;
      navigation.navigate(target.route);
    },
    [navigation],
  );

  const handleSignOut = useCallback(async () => {
    const sid = session?.sessionId;
    if (sid) {
      try {
        await logoutLabSession(sid);
      } catch {
        // Best effort — always return the device to the lock screen.
      }
    }
    navigation.reset({ index: 0, routes: [{ name: 'Auth' }] });
  }, [navigation, session?.sessionId]);

  if (loading && !session) {
    return (
      <SafeAreaView style={styles.screen} edges={['top', 'bottom']}>
        <StatusBar barStyle="light-content" backgroundColor={C.surface} />
        <View style={styles.centerFill}>
          <ActivityIndicator color={C.primary} />
          <Text style={styles.emptyText}>Loading formula history…</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.screen} edges={['top', 'bottom']}>
      <StatusBar barStyle="light-content" backgroundColor={C.surface} />
      <TopBar session={session} bleStatus={ble.status} />

      <View style={[styles.body, layout.showSidebar ? styles.bodyRow : styles.bodyColumn]}>
        {layout.showSidebar ? (
          <Sidebar width={layout.sidebarWidth} items={navItems} onNav={goToRoute} onSignOut={handleSignOut} />
        ) : null}

        <View style={styles.mainArea}>
          <ScrollView
            style={styles.scroll}
            contentContainerStyle={{ padding: layout.pad, paddingBottom: T.spacing.xl }}
            showsVerticalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
            refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor={C.primary} />}
          >
            <View style={[styles.contentWrap, { gap: layout.gap }]}>
              {!layout.showSidebar ? <NavScroller items={navItems} onNav={goToRoute} onSignOut={handleSignOut} /> : null}

              <HistoryHeader
                search={search}
                onSearchChange={setSearch}
                onRefresh={handleRefresh}
                period={period}
                onPeriodChange={setPeriod}
                customRange={customRange}
                onCustomRangeChange={setCustomRange}
                subtitle={`Review ${periodPossessive(period)} mixing sessions, appointment status, and billing performance.`}
              />

              {error ? <Text style={styles.errorText}>{error}</Text> : null}

              {layout.showRail ? (
                <View style={[styles.columns, { gap: layout.gap }]}>
                  <View style={styles.listColumn}>
                    <SessionList
                    groups={groups}
                    pagination={pagination}
                    pageSizeOptions={PAGE_SIZE_OPTIONS}
                    onPageChange={setPage}
                    onPageSizeChange={(size) => {
                      setPageSize(size);
                      setPage(1);
                    }}
                    selectedId={selected?.id}
                    onSelect={setSelectedId}
                    periodSuffix={suffix}
                    awaitingCustom={awaitingCustom}
                  />
                  </View>
                  <View style={{ width: layout.railWidth }}>
                    <SessionAuditCard
                      booking={selected}
                      now={now}
                      billing={selectedBilling}
                      remixSourceId={remixSourceId}
                      onUpdateFormula={handleUpdateFormula}
                    />
                  </View>
                </View>
              ) : (
                <View style={[styles.column, { gap: layout.gap }]}>
                  <SessionList
                    groups={groups}
                    pagination={pagination}
                    pageSizeOptions={PAGE_SIZE_OPTIONS}
                    onPageChange={setPage}
                    onPageSizeChange={(size) => {
                      setPageSize(size);
                      setPage(1);
                    }}
                    selectedId={selected?.id}
                    onSelect={setSelectedId}
                    periodSuffix={suffix}
                    awaitingCustom={awaitingCustom}
                  />
                  <SessionAuditCard
                    booking={selected}
                    now={now}
                    billing={selectedBilling}
                    remixSourceId={remixSourceId}
                    onUpdateFormula={handleUpdateFormula}
                  />
                </View>
              )}

              <MetricsRow metrics={metrics} />

              <Footer now={now} online={session?.status === 'active'} />
            </View>
          </ScrollView>
        </View>
      </View>
    </SafeAreaView>
  );
}

// ---------------------------------------------------------------------------
// Chrome — top bar, sidebar, mobile nav, footer
// ---------------------------------------------------------------------------


function Sidebar({
  width,
  items,
  onNav,
  onSignOut,
}: {
  width: number;
  items: NavEntry[];
  onNav: (target: NavTarget) => void;
  onSignOut: () => void;
}): React.JSX.Element {
  return (
    <View style={[styles.sidebar, { width }]}>
      <View style={styles.sidebarNav}>
        {items.map((item) => {
          const active = item.target.kind === 'current';
          const soon = item.target.kind === 'soon';
          return (
            <Pressable
              key={item.key}
              accessibilityRole="button"
              disabled={soon || active}
              onPress={() => onNav(item.target)}
              style={[styles.navItem, active && styles.navItemActive, soon && styles.navItemSoon]}
            >
              <Text style={styles.navGlyph}>{item.glyph}</Text>
              <Text style={[styles.navLabel, active && styles.navLabelActive]} numberOfLines={1}>
                {item.label}
              </Text>
              {soon ? <Text style={styles.soonTag}>Soon</Text> : null}
            </Pressable>
          );
        })}
      </View>
      <Pressable accessibilityRole="button" onPress={onSignOut} style={styles.signOut}>
        <Text style={styles.signOutGlyph}>⏻</Text>
        <Text style={styles.signOutLabel}>Sign Out</Text>
      </Pressable>
    </View>
  );
}

function NavScroller({
  items,
  onNav,
  onSignOut,
}: {
  items: NavEntry[];
  onNav: (target: NavTarget) => void;
  onSignOut: () => void;
}): React.JSX.Element {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.navScroller}
      style={styles.navScrollerWrap}
    >
      {items.map((item) => {
        const active = item.target.kind === 'current';
        const soon = item.target.kind === 'soon';
        return (
          <Pressable
            key={item.key}
            accessibilityRole="button"
            disabled={soon || active}
            onPress={() => onNav(item.target)}
            style={[styles.navChip, active && styles.navChipActive, soon && styles.navItemSoon]}
          >
            <Text style={styles.navGlyph}>{item.glyph}</Text>
            <Text style={[styles.navChipLabel, active && styles.navLabelActive]}>{item.label}</Text>
            {soon ? <Text style={styles.soonTag}>Soon</Text> : null}
          </Pressable>
        );
      })}
      <Pressable accessibilityRole="button" onPress={onSignOut} style={styles.navChip}>
        <Text style={styles.navGlyph}>⏻</Text>
        <Text style={styles.navChipLabel}>Sign Out</Text>
      </Pressable>
    </ScrollView>
  );
}

function HistoryHeader({
  search,
  onSearchChange,
  onRefresh,
  period,
  onPeriodChange,
  customRange,
  onCustomRangeChange,
  subtitle,
}: {
  search: string;
  onSearchChange: (value: string) => void;
  onRefresh: () => void;
  period: LabPeriod;
  onPeriodChange: (next: LabPeriod) => void;
  customRange: LabCustomRange;
  onCustomRangeChange: (next: LabCustomRange) => void;
  subtitle: string;
}): React.JSX.Element {
  return (
    <View style={styles.header}>
      <View style={styles.headerTitleRow}>
        <View style={styles.headerGlyph}>
          <Text style={styles.headerGlyphText}>🕘</Text>
        </View>
        <View style={styles.flexItem}>
          <Text style={styles.headerTitle}>Formula History</Text>
          <Text style={styles.headerSubtitle}>{subtitle}</Text>
        </View>
      </View>

      <PeriodSelector
        period={period}
        onPeriodChange={onPeriodChange}
        customRange={customRange}
        onCustomRangeChange={onCustomRangeChange}
      />

      <View style={styles.searchRow}>
        <View style={styles.searchField}>
          <Text style={styles.searchGlyph}>⌕</Text>
          <TextInput
            autoCapitalize="none"
            onChangeText={onSearchChange}
            placeholder="Search by client or service…"
            placeholderTextColor={C.inputPlaceholder}
            style={styles.searchInput}
            value={search}
          />
        </View>
        <IconButton glyph="⟳" onPress={onRefresh} />
      </View>
    </View>
  );
}

function Footer({ now, online }: { now: Date; online: boolean }): React.JSX.Element {
  return (
    <View style={styles.footer}>
      <View style={styles.footerSide}>
        <Text style={styles.footerText}>{formatClock(now)}</Text>
        <View style={[styles.dot, { backgroundColor: online ? C.success.text : C.textMuted }]} />
        <Text style={styles.footerText}>Salon Secure</Text>
      </View>
      <View style={styles.footerSide}>
        <Text style={styles.footerText}>{appConfig.environment.toUpperCase()}</Text>
        <Text style={styles.footerTextStrong}>{online ? 'SYSTEM LIVE' : 'SESSION ENDED'}</Text>
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Session list
// ---------------------------------------------------------------------------

function SessionList({
  groups,
  pagination,
  pageSizeOptions,
  onPageChange,
  onPageSizeChange,
  selectedId,
  onSelect,
  periodSuffix,
  awaitingCustom,
}: {
  groups: SessionGroupView[];
  pagination: SessionPaginationState;
  pageSizeOptions: readonly number[];
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: number) => void;
  selectedId?: string;
  onSelect: (id: string) => void;
  periodSuffix: string;
  awaitingCustom: boolean;
}): React.JSX.Element {
  return (
    <View style={styles.listCard}>
      {pagination.total === 0 ? (
        <Text style={styles.emptyText}>
          {awaitingCustom
            ? 'Choose a start and end date to view that period.'
            : `No mixing sessions ${periodSuffix}. Completed and in-progress appointments will appear here.`}
        </Text>
      ) : (
        <>
          {groups.map((group) => (
            <View key={group.key} style={styles.group}>
              <View style={styles.groupHead}>
                <Text style={styles.groupLabel}>{group.label}</Text>
                <Text style={styles.groupCount}>{group.bookings.length}</Text>
              </View>
              <View style={styles.groupList}>
                {group.bookings.map((entry) => (
                  <SessionRow
                    key={entry.id}
                    booking={entry}
                    active={entry.id === selectedId}
                    onPress={() => onSelect(entry.id)}
                  />
                ))}
              </View>
            </View>
          ))}
          <SessionPagination
            pagination={pagination}
            pageSizeOptions={pageSizeOptions}
            onPageChange={onPageChange}
            onPageSizeChange={onPageSizeChange}
          />
        </>
      )}
    </View>
  );
}

// Client-side pager for the session list: a rows-per-page selector plus a
// windowed set of page buttons (with ellipses) and the visible range. The data
// for a period is fetched whole, so paging is purely local.
function SessionPagination({
  pagination,
  pageSizeOptions,
  onPageChange,
  onPageSizeChange,
}: {
  pagination: SessionPaginationState;
  pageSizeOptions: readonly number[];
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: number) => void;
}): React.JSX.Element {
  const { page, pageSize, total, pageCount } = pagination;
  const firstRow = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const lastRow = Math.min(page * pageSize, total);
  const pages = pageWindow(page, pageCount);

  return (
    <View style={styles.pagination}>
      <View style={styles.pageSizeRow}>
        <Text style={styles.pageSizeLabel}>Rows per page</Text>
        <View style={styles.pageSizeChips}>
          {pageSizeOptions.map((option) => {
            const active = option === pageSize;
            return (
              <Pressable
                key={option}
                accessibilityRole="button"
                onPress={() => onPageSizeChange(option)}
                style={[styles.pageSizeChip, active && styles.pageSizeChipActive]}
              >
                <Text style={[styles.pageSizeChipText, active && styles.pageSizeChipTextActive]}>
                  {option}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </View>

      <View style={styles.pageNavRow}>
        <Text style={styles.pageInfo}>
          Showing {firstRow}–{lastRow} of {total}
        </Text>
        <View style={styles.pageNav}>
          <PageNavButton label="‹" disabled={page <= 1} onPress={() => onPageChange(page - 1)} />
          {pages.map((entry, index) =>
            entry === 'ellipsis' ? (
              <Text key={`gap-${index}`} style={styles.pageEllipsis}>
                …
              </Text>
            ) : (
              <PageNavButton
                key={entry}
                label={String(entry)}
                active={entry === page}
                onPress={() => onPageChange(entry)}
              />
            ),
          )}
          <PageNavButton
            label="›"
            disabled={page >= pageCount}
            onPress={() => onPageChange(page + 1)}
          />
        </View>
      </View>
    </View>
  );
}

function PageNavButton({
  label,
  active = false,
  disabled = false,
  onPress,
}: {
  label: string;
  active?: boolean;
  disabled?: boolean;
  onPress: () => void;
}): React.JSX.Element {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={[styles.pageBtn, active && styles.pageBtnActive, disabled && styles.pageBtnDisabled]}
    >
      <Text style={[styles.pageBtnText, active && styles.pageBtnTextActive]}>{label}</Text>
    </Pressable>
  );
}

// Compact page list: first & last, the current page and its neighbours, and
// 'ellipsis' markers for the gaps. Mirrors the web Client Hub pager.
function pageWindow(current: number, pageCount: number): Array<number | 'ellipsis'> {
  if (pageCount <= 7) {
    return Array.from({ length: pageCount }, (_, i) => i + 1);
  }
  const wanted = new Set<number>([1, pageCount, current, current - 1, current + 1]);
  const sorted = [...wanted].filter((p) => p >= 1 && p <= pageCount).sort((a, b) => a - b);
  const result: Array<number | 'ellipsis'> = [];
  let previous = 0;
  for (const p of sorted) {
    if (p - previous > 1) result.push('ellipsis');
    result.push(p);
    previous = p;
  }
  return result;
}

function SessionRow({
  booking,
  active,
  onPress,
}: {
  booking: StaffBookingSummary;
  active: boolean;
  onPress: () => void;
}): React.JSX.Element {
  const badge = statusBadge(booking);
  const completed = isCompletedBooking(booking);
  const time = completed
    ? formatTimeOfDay(booking.completedAt ?? booking.endsAt ?? booking.startsAt)
    : `since ${formatRelativeTime(booking.startsAt)}`;
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={[styles.sessionRow, active && styles.sessionRowActive]}
    >
      <View style={styles.sessionAvatar}>
        <Text style={styles.sessionAvatarText}>{initials(booking.clientDisplayName)}</Text>
      </View>
      <View style={styles.sessionInfo}>
        <Text style={styles.sessionName} numberOfLines={1}>
          {booking.clientDisplayName}
        </Text>
        <Text style={styles.sessionMeta} numberOfLines={1}>
          {serviceLabel(booking)} · {time}
        </Text>
      </View>
      <View style={styles.sessionTrailing}>
        <StatusChip label={badge.label} tone={badge.tone} />
      </View>
    </Pressable>
  );
}

// ---------------------------------------------------------------------------
// Session audit rail — only real appointment fields, no invented breakdowns.
// ---------------------------------------------------------------------------

function SessionAuditCard({
  booking,
  now,
  billing,
  remixSourceId,
  onUpdateFormula,
}: {
  booking?: StaffBookingSummary;
  now: Date;
  billing?: LabSessionBillingBreakdown | 'loading' | 'error';
  remixSourceId?: string;
  onUpdateFormula?: () => void;
}): React.JSX.Element {
  if (!booking) {
    return (
      <View style={styles.auditCard}>
        <Text style={styles.cardEyebrow}>Session audit</Text>
        <Text style={styles.emptyText}>Select a session to review its appointment and activity log.</Text>
      </View>
    );
  }

  const badge = statusBadge(booking);
  const patch = booking.patchTest;
  const activity = buildActivity(booking);
  const detailRows = buildDetailRows(booking, now);

  return (
    <View style={styles.auditCard}>
      <View style={styles.cardHeadRow}>
        <Text style={styles.cardEyebrow}>Session audit</Text>
        <StatusChip label={badge.label} tone={badge.tone} />
      </View>

      <View style={styles.auditClientRow}>
        <View style={styles.flexItem}>
          <Text style={styles.auditClientName}>{booking.clientDisplayName}</Text>
          <Text style={styles.auditClientMeta}>{serviceLabel(booking)}</Text>
        </View>
      </View>

      {booking.status === 'awaiting_payment' ? (
        <View style={styles.updateBlock}>
          <Pressable
            accessibilityRole="button"
            disabled={!remixSourceId}
            onPress={onUpdateFormula}
            style={({ pressed }) => [
              styles.updateButton,
              pressed && remixSourceId && styles.updateButtonPressed,
              !remixSourceId && styles.updateButtonDisabled,
            ]}
          >
            <Text style={styles.updateButtonText}>Update Formula →</Text>
          </Pressable>
          <Text style={styles.updateHint}>
            {remixSourceId
              ? 'Billing not settled yet — re-mix a percentage of this formula.'
              : "Last formula isn't available on this device to continue from."}
          </Text>
        </View>
      ) : null}

      {patch ? (
        <View style={styles.auditSection}>
          <Text style={styles.sectionLabel}>Patch test</Text>
          <View style={styles.patchRow}>
            <StatusChip label={patchTestLabel(patch.status)} tone={patchTestTone(patch.status)} />
            {patch.performedAt ? (
              <Text style={styles.patchMeta}>Performed {formatTimeOfDay(patch.performedAt)}</Text>
            ) : null}
          </View>
        </View>
      ) : null}

      <View style={styles.auditSection}>
        <Text style={styles.sectionLabel}>Activity log</Text>
        {activity.length === 0 ? (
          <Text style={styles.emptyText}>No timeline events recorded for this appointment.</Text>
        ) : (
          <View style={styles.timeline}>
            {activity.map((entry, index) => (
              <ActivityRow
                key={`${entry.label}-${entry.iso}`}
                entry={entry}
                first={index === 0}
                last={index === activity.length - 1}
              />
            ))}
          </View>
        )}
      </View>

      {detailRows.length > 0 ? (
        <View style={styles.auditSection}>
          <Text style={styles.sectionLabel}>Appointment details</Text>
          <View style={styles.detailList}>
            {detailRows.map((row) => (
              <View key={row.label} style={styles.detailRow}>
                <Text style={styles.detailLabel}>{row.label}</Text>
                <Text style={styles.detailValue}>{row.value}</Text>
              </View>
            ))}
          </View>
        </View>
      ) : null}

      {isCompletedBooking(booking) ? <ProductUsageSection billing={billing} /> : null}

      <Text style={styles.auditNote}>
        {'Product usage is captured from the formula at finalize, aggregated across every mix on this visit.'}
      </Text>
    </View>
  );
}

function ProductUsageSection({
  billing,
}: {
  billing?: LabSessionBillingBreakdown | 'loading' | 'error';
}): React.JSX.Element {
  let body: React.JSX.Element;
  if (billing === 'loading' || billing === undefined) {
    body = <Text style={styles.emptyText}>Loading mix details…</Text>;
  } else if (billing === 'error') {
    body = <Text style={styles.emptyText}>{"Couldn't load product usage for this session."}</Text>;
  } else if (billing.productUsage.length === 0) {
    body = <Text style={styles.emptyText}>No finalized mix has been recorded for this appointment yet.</Text>;
  } else {
    const totalGrams = billing.productUsage.reduce((sum, entry) => sum + entry.grams, 0);
    body = (
      <View style={styles.usageList}>
        {billing.productUsage.map((entry) => (
          <View key={entry.productName} style={styles.usageRow}>
            <Text style={styles.usageName} numberOfLines={1}>
              {entry.productName}
            </Text>
            <Text style={styles.usageGrams}>{formatGrams(entry.grams)}</Text>
          </View>
        ))}
        <View style={[styles.usageRow, styles.usageTotalRow]}>
          <Text style={styles.usageTotalLabel}>Total</Text>
          <Text style={styles.usageTotalValue}>{formatGrams(totalGrams)}</Text>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.auditSection}>
      <Text style={styles.sectionLabel}>Products used</Text>
      {body}
    </View>
  );
}

function ActivityRow({
  entry,
  first,
  last,
}: {
  entry: ActivityEntry;
  first: boolean;
  last: boolean;
}): React.JSX.Element {
  return (
    <View style={styles.activityRow}>
      <View style={styles.activityMarker}>
        <View style={[styles.activityLine, first && styles.activityLineHidden]} />
        <View style={[styles.activityDot, first && styles.activityDotActive]} />
        <View style={[styles.activityLine, last && styles.activityLineHidden]} />
      </View>
      <View style={styles.activityBody}>
        <Text style={styles.activityLabel}>{entry.label}</Text>
      </View>
      <Text style={styles.activityTime}>{entry.time}</Text>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Metrics row
// ---------------------------------------------------------------------------

function MetricsRow({ metrics }: { metrics: HistoryMetric[] }): React.JSX.Element {
  return (
    <View style={styles.metricsRow}>
      {metrics.map((metric) => (
        <View key={metric.key} style={styles.metricCard}>
          <View style={styles.metricGlyph}>
            <Text style={styles.metricGlyphText}>{metric.glyph}</Text>
          </View>
          <View style={styles.flexItem}>
            <Text style={styles.metricLabel}>{metric.label}</Text>
            <Text style={[styles.metricValue, metric.locked && styles.metricValueLocked]}>{metric.value}</Text>
            {metric.hint ? (
              <Text style={[styles.metricHint, { color: deltaColor(metric.tone) }]}>{metric.hint}</Text>
            ) : null}
          </View>
        </View>
      ))}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Real-data derivations
// ---------------------------------------------------------------------------

function buildMetrics(
  activeCount: number,
  completedCount: number,
  analytics: SheerLabAnalyticsResponse | null | undefined,
  canSeeFinance: boolean,
  suffix: string,
): HistoryMetric[] {
  const metrics: HistoryMetric[] = [
    { key: 'active', label: 'In the chair', value: String(activeCount), glyph: '◷', tone: 'brand' },
    { key: 'completed', label: `Completed ${suffix}`, value: String(completedCount), glyph: '✓', tone: 'success' },
  ];

  if (analytics) {
    const grams = sumProductUsageGrams(analytics);
    metrics.push({
      key: 'grams',
      label: 'Product used',
      value: formatGrams(grams),
      hint: `${analytics.summary.formulasMixed} ${analytics.summary.formulasMixed === 1 ? 'mix' : 'mixes'}`,
      glyph: '⚗',
    });
    metrics.push({
      key: 'billed',
      label: `Billed ${suffix}`,
      value: formatMoney(analytics.summary.colourRevenueCents, analytics.summary.currencyCode),
      hint: `${formatPercent(analytics.summary.grossMarginPercent)} margin`,
      tone: 'success',
      glyph: '▤',
    });
  } else {
    metrics.push({
      key: 'grams',
      label: 'Product used',
      value: 'Managers only',
      glyph: '⚗',
      locked: true,
    });
    metrics.push({
      key: 'billed',
      label: `Billed ${suffix}`,
      value: canSeeFinance ? 'Unavailable' : 'Managers only',
      glyph: '▤',
      locked: true,
    });
  }

  return metrics;
}

function buildActivity(booking: StaffBookingSummary): ActivityEntry[] {
  const events: ActivityEntry[] = [];
  if (booking.startsAt) {
    events.push({ label: 'Appointment scheduled', iso: booking.startsAt, time: formatTimeOfDay(booking.startsAt) });
  }
  if (booking.patchTest?.performedAt) {
    events.push({
      label: `Patch test ${booking.patchTest.status}`,
      iso: booking.patchTest.performedAt,
      time: formatTimeOfDay(booking.patchTest.performedAt),
    });
  }
  if (booking.completedAt) {
    events.push({ label: 'Session completed', iso: booking.completedAt, time: formatTimeOfDay(booking.completedAt) });
  }
  return events.sort((a, b) => new Date(a.iso).getTime() - new Date(b.iso).getTime());
}

function buildDetailRows(booking: StaffBookingSummary, now: Date): Array<{ label: string; value: string }> {
  const rows: Array<{ label: string; value: string }> = [];
  rows.push({ label: 'Scheduled', value: scheduleLabel(booking, now) });
  if (booking.durationMinutes != null) {
    rows.push({ label: 'Duration', value: `${booking.durationMinutes} min` });
  }
  if (booking.depositStatus) {
    rows.push({ label: 'Deposit', value: depositLabel(booking) });
  }
  if (booking.clientNote && booking.clientNote.trim().length > 0) {
    rows.push({ label: 'Client note', value: booking.clientNote.trim() });
  }
  return rows;
}

function scheduleLabel(booking: StaffBookingSummary, now: Date): string {
  const start = formatTimeOfDay(booking.startsAt);
  const end = booking.endsAt ? formatTimeOfDay(booking.endsAt) : undefined;
  const today = new Date(booking.startsAt).toDateString() === now.toDateString();
  const day = today ? 'Today' : new Date(booking.startsAt).toLocaleDateString();
  return end ? `${day} · ${start}–${end}` : `${day} · ${start}`;
}

function depositLabel(booking: StaffBookingSummary): string {
  const status = booking.depositStatus ?? '—';
  if (booking.depositRequiredAmount != null) {
    return `${humanize(status)} · ${formatMoney(Math.round(booking.depositRequiredAmount * 100))}`;
  }
  return humanize(status);
}

function completedSortKey(booking: StaffBookingSummary): number {
  return new Date(booking.completedAt ?? booking.endsAt ?? booking.startsAt).getTime();
}

function serviceLabel(booking: StaffBookingSummary): string {
  return booking.serviceNames.join(' + ') || 'Colour service';
}

function statusBadge(booking: StaffBookingSummary): { label: string; tone: ChipTone } {
  return isActiveBooking(booking) ? activeStatusBadge(booking.status) : completedStatusBadge(booking.status);
}

function patchTestLabel(status: NonNullable<StaffBookingSummary['patchTest']>['status']): string {
  return humanize(status);
}

function patchTestTone(status: NonNullable<StaffBookingSummary['patchTest']>['status']): ChipTone {
  switch (status) {
    case 'passed':
      return 'success';
    case 'failed':
    case 'expired':
      return 'danger';
    case 'pending':
      return 'warning';
    default:
      return 'neutral';
  }
}

function humanize(value: string): string {
  return value
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

function chipToneStyle(tone: ChipTone): { text: string; bg: string; border: string } {
  switch (tone) {
    case 'brand':
      return { text: C.primary, bg: C.primarySoft, border: C.primary };
    case 'success':
      return { text: C.success.text, bg: C.success.bg, border: C.success.border };
    case 'warning':
      return { text: C.warning.text, bg: C.warning.bg, border: C.warning.border };
    case 'danger':
      return { text: C.danger.text, bg: C.danger.bg, border: C.danger.border };
    default:
      return { text: C.textSecondary, bg: C.inputBg, border: C.borderStrong };
  }
}

function deltaColor(tone?: ChipTone): string {
  return chipToneStyle(tone ?? 'neutral').text;
}

function StatusChip({ label, tone }: { label: string; tone: ChipTone }): React.JSX.Element {
  const palette = chipToneStyle(tone);
  return (
    <View style={[styles.chip, { backgroundColor: palette.bg, borderColor: palette.border }]}>
      <View style={[styles.chipDot, { backgroundColor: palette.text }]} />
      <Text style={[styles.chipText, { color: palette.text }]} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

function IconButton({ glyph, onPress }: { glyph: string; onPress: () => void }): React.JSX.Element {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.iconButton, pressed && styles.iconButtonPressed]}
      hitSlop={6}
    >
      <Text style={styles.iconButtonGlyph}>{glyph}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.background },
  centerFill: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: T.spacing.sm },
  body: { flex: 1 },
  bodyRow: { flexDirection: 'row' },
  bodyColumn: { flexDirection: 'column' },
  mainArea: { flex: 1 },
  scroll: { flex: 1 },
  contentWrap: { width: '100%', maxWidth: 1600, alignSelf: 'center' },
  column: { width: '100%' },
  columns: { flexDirection: 'row', alignItems: 'flex-start' },
  listColumn: { flex: 1 },
  flexItem: { flex: 1 },

  // Top bar
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: T.spacing.base,
    paddingVertical: T.spacing.md,
    backgroundColor: C.surface,
    borderBottomWidth: 1,
    borderBottomColor: C.border,
  },
  topSideLeft: { flex: 1, alignItems: 'flex-start' },
  topSideRight: { flex: 1, alignItems: 'flex-end' },
  brandRow: { flexDirection: 'row', alignItems: 'center', gap: T.spacing.sm },
  brandText: { color: C.textPrimary, fontSize: 17, fontWeight: '800', letterSpacing: 1 },
  userRow: { flexDirection: 'row', alignItems: 'center', gap: T.spacing.sm, maxWidth: 220 },
  userText: { alignItems: 'flex-end' },
  userName: { color: C.textPrimary, fontWeight: '700', fontSize: 13 },
  userRole: { color: C.textMuted, fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5 },
  avatar: {
    width: 36,
    height: 36,
    borderRadius: T.radius.full,
    backgroundColor: C.primarySoft,
    borderWidth: 1,
    borderColor: C.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: { color: C.primary, fontWeight: '800', fontSize: 13 },

  // Sidebar
  sidebar: {
    backgroundColor: C.surface,
    borderRightWidth: 1,
    borderRightColor: C.border,
    paddingVertical: T.spacing.lg,
    paddingHorizontal: T.spacing.md,
    justifyContent: 'space-between',
  },
  sidebarNav: { gap: T.spacing.xs },
  navItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: T.spacing.md,
    paddingVertical: T.spacing.md,
    paddingHorizontal: T.spacing.md,
    borderRadius: T.radius.card,
  },
  // Active item reads as a solid brand pill (rounded via `navItem.borderRadius`)
  // with white text, rather than the older soft-tinted fill.
  navItemActive: { backgroundColor: C.sidebarActive },
  navItemSoon: { opacity: 0.5 },
  navGlyph: { fontSize: 16 },
  navLabel: { flex: 1, color: C.textSecondary, fontSize: 13, fontWeight: '700' },
  navLabelActive: { color: C.sidebarActiveText },
  soonTag: { color: C.textMuted, fontSize: 11, fontWeight: '700' },
  signOut: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: T.spacing.md,
    paddingVertical: T.spacing.md,
    paddingHorizontal: T.spacing.md,
    borderRadius: T.radius.card,
    borderWidth: 1,
    borderColor: C.border,
  },
  signOutGlyph: { fontSize: 16, color: C.danger.text },
  signOutLabel: { color: C.textPrimary, fontWeight: '700', fontSize: 13 },

  navScrollerWrap: { marginBottom: T.spacing.xs },
  navScroller: { flexDirection: 'row', gap: T.spacing.sm, paddingVertical: T.spacing.xs },
  navChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: T.spacing.xs,
    paddingVertical: T.spacing.sm,
    paddingHorizontal: T.spacing.md,
    borderRadius: T.radius.full,
    borderWidth: 1,
    borderColor: C.border,
    backgroundColor: C.surface,
  },
  navChipActive: { backgroundColor: C.primarySoft, borderColor: C.primary },
  navChipLabel: { color: C.textSecondary, fontSize: 13, fontWeight: '700' },

  // Header
  header: { gap: T.spacing.md },
  headerTitleRow: { flexDirection: 'row', alignItems: 'center', gap: T.spacing.md },
  headerGlyph: {
    width: 40,
    height: 40,
    borderRadius: T.radius.card,
    backgroundColor: C.primarySoft,
    borderWidth: 1,
    borderColor: C.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerGlyphText: { fontSize: 18 },
  headerTitle: { color: C.textPrimary, fontSize: 26, fontWeight: '800', letterSpacing: -0.5 },
  headerSubtitle: { color: C.textMuted, fontSize: 13, marginTop: 2 },

  searchRow: { flexDirection: 'row', alignItems: 'center', gap: T.spacing.sm, flexWrap: 'wrap' },
  searchField: {
    flex: 1,
    minWidth: 200,
    flexDirection: 'row',
    alignItems: 'center',
    gap: T.spacing.sm,
    minHeight: 48,
    paddingHorizontal: T.spacing.md,
    borderWidth: 1,
    borderColor: C.inputBorder,
    borderRadius: T.radius.inputLg,
    backgroundColor: C.inputBg,
  },
  searchGlyph: { color: C.textMuted, fontSize: 16, fontWeight: '700' },
  searchInput: { flex: 1, color: C.textPrimary, fontSize: 15 },

  // Session list
  listCard: {
    gap: T.spacing.lg,
    padding: T.spacing.lg,
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: T.radius.cardLg,
    backgroundColor: C.card,
  },
  group: { gap: T.spacing.sm },
  groupHead: { flexDirection: 'row', alignItems: 'center', gap: T.spacing.sm },
  groupLabel: { color: C.textMuted, fontSize: 11, fontWeight: '800', letterSpacing: 1, textTransform: 'uppercase' },
  groupCount: {
    minWidth: 20,
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: T.radius.full,
    backgroundColor: C.primarySoft,
    color: C.primary,
    fontSize: 11,
    fontWeight: '800',
    textAlign: 'center',
    overflow: 'hidden',
  },
  groupList: { gap: T.spacing.sm },
  sessionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: T.spacing.md,
    padding: T.spacing.md,
    borderRadius: T.radius.card,
    borderWidth: 1,
    borderColor: C.border,
    backgroundColor: C.inputBg,
  },
  sessionRowActive: { borderColor: C.primary, backgroundColor: C.primarySoft },
  sessionAvatar: {
    width: 40,
    height: 40,
    borderRadius: T.radius.full,
    backgroundColor: C.primarySoft,
    borderWidth: 1,
    borderColor: C.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sessionAvatarText: { color: C.primary, fontWeight: '800', fontSize: 14 },
  sessionInfo: { flex: 1, gap: 2 },
  sessionName: { color: C.textPrimary, fontSize: 15, fontWeight: '700' },
  sessionMeta: { color: C.textMuted, fontSize: 12 },
  sessionTrailing: { alignItems: 'flex-end', gap: 4 },

  emptyText: { color: C.textMuted, fontSize: 13, lineHeight: 19 },
  errorText: { color: C.danger.text, fontSize: 13, fontWeight: '700' },

  // Pagination
  pagination: {
    gap: T.spacing.md,
    paddingTop: T.spacing.md,
    borderTopWidth: 1,
    borderTopColor: C.border,
  },
  pageSizeRow: { flexDirection: 'row', alignItems: 'center', gap: T.spacing.sm, flexWrap: 'wrap' },
  pageSizeLabel: { color: C.textMuted, fontSize: 12, fontWeight: '700' },
  pageSizeChips: { flexDirection: 'row', gap: T.spacing.xs, flexWrap: 'wrap' },
  pageSizeChip: {
    minWidth: 36,
    paddingHorizontal: T.spacing.sm,
    paddingVertical: 6,
    borderRadius: T.radius.full,
    borderWidth: 1,
    borderColor: C.borderStrong,
    backgroundColor: C.inputBg,
    alignItems: 'center',
  },
  pageSizeChipActive: { borderColor: C.primary, backgroundColor: C.primarySoft },
  pageSizeChipText: { color: C.textSecondary, fontSize: 13, fontWeight: '700' },
  pageSizeChipTextActive: { color: C.primary },
  pageNavRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: T.spacing.md,
    flexWrap: 'wrap',
  },
  pageInfo: { color: C.textMuted, fontSize: 12, fontWeight: '600' },
  pageNav: { flexDirection: 'row', alignItems: 'center', gap: T.spacing.xs, flexWrap: 'wrap' },
  pageBtn: {
    minWidth: 36,
    height: 36,
    paddingHorizontal: T.spacing.sm,
    borderRadius: T.radius.card,
    borderWidth: 1,
    borderColor: C.borderStrong,
    backgroundColor: C.inputBg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pageBtnActive: { borderColor: C.primary, backgroundColor: C.primary },
  pageBtnDisabled: { opacity: 0.4 },
  pageBtnText: { color: C.textSecondary, fontSize: 14, fontWeight: '700' },
  pageBtnTextActive: { color: C.textOnPrimary },
  pageEllipsis: { color: C.textMuted, fontSize: 14, paddingHorizontal: 2 },

  // Audit rail
  auditCard: {
    gap: T.spacing.lg,
    padding: T.spacing.lg,
    borderWidth: 1,
    borderColor: C.primary,
    borderRadius: T.radius.cardLg,
    backgroundColor: C.card,
  },
  cardHeadRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: T.spacing.sm,
  },
  cardEyebrow: { color: C.textMuted, fontSize: 11, fontWeight: '800', letterSpacing: 1, textTransform: 'uppercase' },
  auditClientRow: { flexDirection: 'row', alignItems: 'center', gap: T.spacing.md },
  auditClientName: { color: C.textPrimary, fontSize: 20, fontWeight: '800', letterSpacing: -0.4 },
  auditClientMeta: { color: C.textMuted, fontSize: 12, marginTop: 2 },

  // Update / re-mix action
  updateBlock: { gap: T.spacing.xs },
  updateButton: {
    minHeight: 48,
    borderRadius: T.radius.inputLg,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: C.primary,
  },
  updateButtonPressed: { backgroundColor: C.primaryPressed },
  updateButtonDisabled: { backgroundColor: C.textSecondary },
  updateButtonText: { color: C.textOnPrimary, fontSize: 14, fontWeight: '800' },
  updateHint: { color: C.textMuted, fontSize: 11, lineHeight: 16 },

  auditSection: {
    gap: T.spacing.sm,
    paddingTop: T.spacing.md,
    borderTopWidth: 1,
    borderTopColor: C.border,
  },
  sectionLabel: { color: C.textMuted, fontSize: 11, fontWeight: '800', letterSpacing: 0.8, textTransform: 'uppercase' },

  patchRow: { flexDirection: 'row', alignItems: 'center', gap: T.spacing.sm, flexWrap: 'wrap' },
  patchMeta: { color: C.textSecondary, fontSize: 12, fontWeight: '600' },

  // Timeline
  timeline: { marginTop: 2 },
  activityRow: { flexDirection: 'row', alignItems: 'stretch', gap: T.spacing.md },
  activityMarker: { width: 12, alignItems: 'center' },
  activityLine: { width: 2, flex: 1, backgroundColor: C.border },
  activityLineHidden: { backgroundColor: 'transparent' },
  activityDot: {
    width: 10,
    height: 10,
    borderRadius: T.radius.full,
    backgroundColor: C.borderStrong,
    marginVertical: 2,
  },
  activityDotActive: { backgroundColor: C.primary },
  activityBody: { flex: 1, paddingVertical: T.spacing.xs },
  activityLabel: { color: C.textPrimary, fontSize: 13, fontWeight: '700' },
  activityTime: { color: C.textMuted, fontSize: 11, fontWeight: '700', paddingVertical: T.spacing.xs },

  // Product usage
  usageList: {
    gap: T.spacing.xs,
    padding: T.spacing.md,
    borderRadius: T.radius.card,
    borderWidth: 1,
    borderColor: C.border,
    backgroundColor: C.inputBg,
  },
  usageRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: T.spacing.md },
  usageName: { flex: 1, color: C.textPrimary, fontSize: 13, fontWeight: '600' },
  usageGrams: { color: C.textSecondary, fontSize: 13, fontWeight: '700' },
  usageTotalRow: { marginTop: T.spacing.xs, paddingTop: T.spacing.sm, borderTopWidth: 1, borderTopColor: C.border },
  usageTotalLabel: { color: C.textMuted, fontSize: 11, fontWeight: '800', letterSpacing: 0.5, textTransform: 'uppercase' },
  usageTotalValue: { color: C.textPrimary, fontSize: 16, fontWeight: '800', letterSpacing: -0.3 },

  // Appointment detail rows
  detailList: { gap: 6 },
  detailRow: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: T.spacing.md },
  detailLabel: { color: C.textMuted, fontSize: 12, fontWeight: '600' },
  detailValue: { flex: 1, color: C.textPrimary, fontSize: 13, fontWeight: '600', textAlign: 'right' },
  auditNote: { color: C.textMuted, fontSize: 11, lineHeight: 16, fontStyle: 'italic' },

  // Metrics
  metricsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: T.spacing.md },
  metricCard: {
    flexGrow: 1,
    flexBasis: 200,
    flexDirection: 'row',
    alignItems: 'center',
    gap: T.spacing.md,
    padding: T.spacing.lg,
    borderRadius: T.radius.cardLg,
    borderWidth: 1,
    borderColor: C.border,
    backgroundColor: C.card,
  },
  metricGlyph: {
    width: 40,
    height: 40,
    borderRadius: T.radius.card,
    backgroundColor: C.inputBg,
    borderWidth: 1,
    borderColor: C.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  metricGlyphText: { fontSize: 18, color: C.primary },
  metricLabel: { color: C.textMuted, fontSize: 11, fontWeight: '700', letterSpacing: 0.4, textTransform: 'uppercase' },
  metricValue: { color: C.textPrimary, fontSize: 22, fontWeight: '800', letterSpacing: -0.5, marginTop: 2 },
  metricValueLocked: { color: C.textMuted, fontSize: 13, fontWeight: '700', letterSpacing: 0 },
  metricHint: { fontSize: 11, fontWeight: '800', marginTop: 2 },

  // Footer
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: T.spacing.md,
    marginTop: T.spacing.xs,
    borderTopWidth: 1,
    borderTopColor: C.border,
    flexWrap: 'wrap',
    gap: T.spacing.sm,
  },
  footerSide: { flexDirection: 'row', alignItems: 'center', gap: T.spacing.sm },
  footerText: { color: C.textMuted, fontSize: 12 },
  footerTextStrong: { color: C.textSecondary, fontSize: 11, fontWeight: '800', letterSpacing: 1 },
  dot: { width: 8, height: 8, borderRadius: T.radius.full },

  // Chip
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: T.spacing.sm,
    paddingVertical: 4,
    borderRadius: T.radius.full,
    borderWidth: 1,
    alignSelf: 'flex-start',
  },
  chipDot: { width: 6, height: 6, borderRadius: T.radius.full },
  chipText: { fontSize: 11, fontWeight: '800', letterSpacing: 0.4, textTransform: 'uppercase' },

  // Icon button
  iconButton: {
    width: 48,
    height: 48,
    borderRadius: T.radius.inputLg,
    borderWidth: 1,
    borderColor: C.borderStrong,
    backgroundColor: C.card,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconButtonPressed: { opacity: 0.7 },
  iconButtonGlyph: { color: C.textSecondary, fontSize: 18, fontWeight: '700' },
});
