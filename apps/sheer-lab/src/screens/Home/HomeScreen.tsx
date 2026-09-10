import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type {
  InventoryLocationStock,
  PinUnlockResponse,
  SheerLabAnalyticsResponse,
  StaffBookingSummary,
} from '@sheer/domain';
import type React from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';

import type { RootStackParamList } from '../../app/navigation/routes';
import { featureFlags } from '../../config/featureFlags';
import { getLabAnalyticsSummaryForSession } from '../../features/analytics/analyticsApi';
import { listTodaysLabAppointmentsForSession } from '../../features/appointments/appointmentsApi';
import { useBleScale } from '../../features/ble/hooks/useBleScale';
import { listLabInventoryStockForSession } from '../../features/inventory/productsApi';
import { getActiveLabSession } from '../../features/sheer-lab/labSession';
import { labTheme } from '../../theme/labTheme';
import { Icon } from '../../ui/icons/Icon';
import type { IconName } from '../../ui/icons/paths';
import { LabShell, useLabLayout } from '../shared/LabShell';
import {
  activeStatusBadge,
  completedStatusBadge,
  firstName,
  formatClock,
  formatGrams,
  formatMoney,
  formatPercent,
  formatRelativeTime,
  formatTimeOfDay,
  getInventoryTier,
  initials,
  isActiveBooking,
  isCompletedBooking,
  sortStockForDisplay,
  stockFill,
  sumProductUsageGrams,
  type StatusTone,
} from './dashboardHelpers';

const t = labTheme;
const c = t.colors;

type HomeScreenProps = NativeStackScreenProps<RootStackParamList, 'Home'>;

type WorkingRoute = 'NewMix' | 'Formula' | 'FormulaHistory' | 'Inventory' | 'BillingRules' | 'DevicePairing' | 'Settings';

type NavTarget = { kind: 'route'; route: WorkingRoute } | { kind: 'soon' };

interface NavEntry {
  key: string;
  label: string;
  icon: IconName;
  target: NavTarget;
}

function buildQuickTools(canManageOps: boolean): NavEntry[] {
  const inventoryTarget: NavTarget = canManageOps ? { kind: 'route', route: 'Inventory' } : { kind: 'soon' };
  const billingTarget: NavTarget = canManageOps ? { kind: 'route', route: 'BillingRules' } : { kind: 'soon' };
  const tools: NavEntry[] = [
    { key: 'reweigh', label: 'Reweigh Tool', icon: 'scale', target: { kind: 'route', route: 'DevicePairing' } },
    { key: 'formula-search', label: 'Formula Search', icon: 'search', target: { kind: 'route', route: 'FormulaHistory' } },
    { key: 'add-inventory', label: 'Add Inventory', icon: 'plus', target: inventoryTarget },
    { key: 'billing-settings', label: 'Billing Rules', icon: 'receipt', target: billingTarget },
    { key: 'lab-audit', label: 'Lab Audit', icon: 'shield', target: { kind: 'soon' } },
  ];
  // Billing Rules and the Lab Audit tool are hidden behind their feature flags
  // for every role until the flags are flipped on.
  return tools.filter(
    (tool) =>
      (tool.key !== 'add-inventory' || canManageOps) &&
      (tool.key !== 'billing-settings' || featureFlags.billingRules) &&
      (tool.key !== 'lab-audit' || featureFlags.auditTrail),
  );
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function HomeScreen({ navigation }: HomeScreenProps): React.JSX.Element {
  const { width } = useWindowDimensions();
  // The shell owns the breakpoints (phone <700pt, tablet 700-1023pt, wide
  // >=1024pt) and the sidebar width and padding they imply. The two below are
  // Home's own content layout, derived from the same width so they still
  // follow rotation: the right rail exists only in the wide layout and scales
  // with the viewport, so it breathes from a 1024pt iPad up to a
  // 12.9"/desktop; the insight tiles flow into a row on a tablet with room for
  // it (>=880pt), while the wide layout stacks them inside the narrow rail.
  const layout = useLabLayout();
  const isWide = layout.mode === 'wide';
  const showSidebar = layout.mode !== 'phone';
  const railWidth = isWide ? clampNumber(Math.round(width * 0.3), 300, 380) : 0;
  const insightsRow = layout.mode === 'tablet' && width >= 880;
  const ble = useBleScale();

  const [session, setSession] = useState<PinUnlockResponse | undefined>();
  const [bookings, setBookings] = useState<StaffBookingSummary[]>([]);
  const [stock, setStock] = useState<InventoryLocationStock[]>([]);
  const [stockFailed, setStockFailed] = useState(false);
  // `null` = analytics deliberately withheld (stylist session, 403);
  // `undefined` = not loaded yet or failed to load.
  const [insights, setInsights] = useState<SheerLabAnalyticsResponse | null | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [now, setNow] = useState<Date>(() => new Date());

  const load = useCallback(async () => {
    setError(undefined);
    try {
      const activeSession = await getActiveLabSession();
      if (!activeSession) {
        navigation.replace('Auth');
        return;
      }
      setSession(activeSession);

      const [appointments, stockResult, analytics] = await Promise.allSettled([
        listTodaysLabAppointmentsForSession(activeSession.sessionId),
        listLabInventoryStockForSession(activeSession.sessionId),
        getLabAnalyticsSummaryForSession(activeSession.sessionId, 'today'),
      ]);

      setBookings(appointments.status === 'fulfilled' ? appointments.value.bookings : []);
      setStock(stockResult.status === 'fulfilled' ? stockResult.value.stock : []);
      setStockFailed(stockResult.status === 'rejected');
      setInsights(analytics.status === 'fulfilled' ? analytics.value : undefined);

      // Surface load failures rather than letting a failed fetch read as empty
      // data. Stock failures also get a dedicated note inside the panel.
      const failures: string[] = [];
      if (appointments.status === 'rejected') failures.push("today's schedule");
      if (stockResult.status === 'rejected') failures.push('inventory');
      if (failures.length > 0) {
        setError(`Could not load ${failures.join(' and ')}. Pull to refresh to try again.`);
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not load the lab dashboard');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [navigation]);

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

  const goToRoute = useCallback(
    (route: WorkingRoute) => {
      switch (route) {
        case 'NewMix':
          navigation.navigate('NewMix');
          break;
        case 'Formula':
          navigation.navigate('Formula');
          break;
        case 'FormulaHistory':
          navigation.navigate('FormulaHistory');
          break;
        case 'Inventory':
          navigation.navigate('Inventory');
          break;
        case 'BillingRules':
          navigation.navigate('BillingRules');
          break;
        case 'DevicePairing':
          navigation.navigate('DevicePairing');
          break;
      }
    },
    [navigation],
  );

  const handleNav = useCallback(
    (target: NavTarget) => {
      if (target.kind === 'route') goToRoute(target.route);
    },
    [goToRoute],
  );

  const openFormulaForBooking = useCallback(
    (booking: StaffBookingSummary) => {
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
    },
    [navigation, session],
  );

  const activeBookings = useMemo(() => bookings.filter(isActiveBooking), [bookings]);
  const completedBookings = useMemo(() => bookings.filter(isCompletedBooking), [bookings]);
  const displayStock = useMemo(() => sortStockForDisplay(stock), [stock]);

  const scale = mapScaleState(ble);
  const canSeeInsights = session?.role === 'owner' || session?.role === 'manager';
  const canManageOps = session?.role === 'owner' || session?.role === 'manager';
  const quickTools = useMemo(() => buildQuickTools(canManageOps), [canManageOps]);

  // The first load still takes over the whole screen rather than showing empty
  // chrome. The safe area and the StatusBar are not this screen's to set — the
  // shell owns them once there is a session, and AppProviders already declares
  // the same light-content/background pair app-wide.
  if (loading && !session) {
    return (
      <View style={styles.screen}>
        <View style={styles.centerFill}>
          <ActivityIndicator color={c.primary} />
          <Text style={styles.mutedText}>Loading your lab…</Text>
        </View>
      </View>
    );
  }

  const rail = (
    <>
      <ScalePanel scale={scale} onPair={() => goToRoute('DevicePairing')} />
      <ManagerInsights insights={insights} canSee={Boolean(canSeeInsights)} horizontal={insightsRow} />
      <InventoryStatusPanel items={displayStock} hasStock={stock.length > 0} failed={stockFailed} />
    </>
  );

  const main = (
    <>
      <ActiveSessionsPanel bookings={activeBookings} onOpen={openFormulaForBooking} />
      <CompletedTodayPanel bookings={completedBookings} isWide={isWide} onOpen={openFormulaForBooking} />
      <QuickToolsPanel fixedTiles={showSidebar} tools={quickTools} onSelect={handleNav} />
    </>
  );

  return (
    <LabShell
      session={session}
      bleStatus={ble.status}
      refreshing={refreshing}
      onRefresh={handleRefresh}
      footer={<Footer session={session} now={now} bleConnected={scale.connected} />}
    >
      {error ? <Text style={styles.errorText}>{error}</Text> : null}

      <WelcomeHero session={session} scale={scale} stockCount={stock.length} onStartMix={() => goToRoute('NewMix')} />

      {isWide ? (
        <View style={[styles.mainRow, { gap: layout.gap }]}>
          <View style={styles.mainColumn}>{main}</View>
          <View style={[styles.rightRail, { width: railWidth }]}>{rail}</View>
        </View>
      ) : (
        <View style={[styles.stack, { gap: layout.gap }]}>
          {main}
          {rail}
        </View>
      )}
    </LabShell>
  );
}

// ---------------------------------------------------------------------------
// Scale view-model
// ---------------------------------------------------------------------------

interface ScaleView {
  connected: boolean;
  statusLabel: string;
  statusTone: StatusTone;
  deviceName: string;
  liveGrams?: number;
  stable?: boolean;
  lastSyncIso?: string;
}

function mapScaleState(ble: ReturnType<typeof useBleScale>): ScaleView {
  const connected = ble.status === 'connected';
  let statusLabel = 'Offline';
  let statusTone: StatusTone = 'neutral';
  if (connected) {
    statusLabel = 'Ready';
    statusTone = 'success';
  } else if (ble.status === 'error') {
    statusLabel = 'Error';
    statusTone = 'danger';
  } else if (
    ble.status === 'connecting' ||
    ble.status === 'scanning' ||
    ble.status === 'discovering' ||
    ble.status === 'reconnecting'
  ) {
    statusLabel = 'Connecting';
    statusTone = 'warning';
  }
  return {
    connected,
    statusLabel,
    statusTone,
    deviceName: ble.connectedDevice?.name ?? 'Lab scale',
    liveGrams: ble.liveWeight?.grams,
    stable: ble.liveWeight?.stable,
    lastSyncIso: ble.lastPacketAt ?? ble.lastConnectedAt,
  };
}

// ---------------------------------------------------------------------------
// Hero / Welcome
// ---------------------------------------------------------------------------

function WelcomeHero({
  session,
  scale,
  stockCount,
  onStartMix,
}: {
  session?: PinUnlockResponse;
  scale: ScaleView;
  stockCount: number;
  onStartMix: () => void;
}): React.JSX.Element {
  const name = session ? firstName(session.displayName) : 'there';
  const stockLine = stockCount > 0 ? `${stockCount} products in stock` : 'Inventory syncing';
  const scaleLine = scale.connected ? 'Scale connected' : 'Scale not paired';
  return (
    <View style={styles.hero}>
      <View style={styles.heroBody}>
        <Pill label="Ready to work" tone="success" onDark />
        <Text style={styles.heroTitle}>Welcome back, {name}.</Text>
        <Text style={styles.heroSubtitle}>
          {scaleLine} · {stockLine}. Ready for the next masterpiece.
        </Text>
        <Pressable accessibilityRole="button" onPress={onStartMix} style={styles.heroButton}>
          <Icon name="plus" size="sm" tone="inherit" color={c.onHeroButtonText} />
          <Text style={styles.heroButtonText}>Start new mix</Text>
        </Pressable>
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Right rail panels
// ---------------------------------------------------------------------------

function ScalePanel({ scale, onPair }: { scale: ScaleView; onPair: () => void }): React.JSX.Element {
  return (
    <View style={styles.card}>
      <View style={styles.cardHeaderRow}>
        <View style={styles.cardHeaderText}>
          <Text style={styles.eyebrow}>BLE Scale</Text>
          <Text style={styles.cardTitle} numberOfLines={1}>
            {scale.deviceName}
          </Text>
        </View>
        <Pill label={scale.statusLabel} tone={scale.statusTone} />
      </View>

      {scale.connected ? (
        <>
          <View style={styles.scaleWeightBlock}>
            <Text style={styles.scaleWeight}>{scale.liveGrams != null ? scale.liveGrams.toFixed(1) : '—'}</Text>
            <Text style={styles.scaleWeightUnit}>g</Text>
          </View>
          <View style={styles.statRow}>
            <MiniStat label="Stability" value={scale.stable == null ? '—' : scale.stable ? 'Stable' : 'Settling'} />
            <MiniStat label="Last sync" value={formatRelativeTime(scale.lastSyncIso)} />
          </View>
        </>
      ) : (
        <>
          <Text style={styles.mutedText}>The scale is not connected. Pair it to capture live weights.</Text>
          <Pressable accessibilityRole="button" onPress={onPair} style={styles.outlineButton}>
            <Text style={styles.outlineButtonText}>Pair scale</Text>
          </Pressable>
        </>
      )}
    </View>
  );
}

function ManagerInsights({
  insights,
  canSee,
  horizontal,
}: {
  insights: SheerLabAnalyticsResponse | null | undefined;
  canSee: boolean;
  horizontal: boolean;
}): React.JSX.Element {
  return (
    <View style={styles.card}>
      <Text style={styles.eyebrow}>Manager Insights</Text>
      {insights == null ? (
        <Text style={styles.mutedText}>
          {canSee
            ? 'Insights are unavailable right now. Pull to refresh.'
            : 'Colour-bar insights are available to managers and owners.'}
        </Text>
      ) : (
        <View style={horizontal ? styles.insightRow : styles.insightStack}>
          <StatTile
            label="Top products used"
            value={formatGrams(sumProductUsageGrams(insights))}
            hint={`${insights.summary.formulasMixed} ${insights.summary.formulasMixed === 1 ? 'mix' : 'mixes'} today`}
            flexible={horizontal}
          />
          <StatTile
            label="Total lab cost"
            value={formatMoney(insights.summary.formulaCostCents, insights.summary.currencyCode)}
            hint="Wholesale value"
            flexible={horizontal}
          />
          <StatTile
            label="Total billing value"
            value={formatMoney(insights.summary.colourRevenueCents, insights.summary.currencyCode)}
            hint={`${formatPercent(insights.summary.grossMarginPercent)} margin`}
            tone="success"
            flexible={horizontal}
          />
        </View>
      )}
    </View>
  );
}

function InventoryStatusPanel({
  items,
  hasStock,
  failed,
}: {
  items: InventoryLocationStock[];
  hasStock: boolean;
  failed: boolean;
}): React.JSX.Element {
  return (
    <View style={styles.card}>
      <Text style={styles.eyebrow}>Inventory Status</Text>
      {failed ? (
        <Text style={styles.mutedText}>Stock levels could not be loaded. Pull to refresh to try again.</Text>
      ) : !hasStock ? (
        <Text style={styles.mutedText}>No stock has been initialised for this location yet.</Text>
      ) : items.length === 0 ? (
        <Text style={styles.mutedText}>Stock levels are healthy.</Text>
      ) : (
        <View style={styles.inventoryList}>
          {items.map((item) => {
            const tier = getInventoryTier(item);
            return (
              <View key={item.id} style={styles.inventoryRow}>
                <View style={styles.inventoryInfo}>
                  <Text style={styles.inventoryName} numberOfLines={1}>
                    {item.brand ? `${item.brand} ` : ''}
                    {item.productName}
                  </Text>
                  <Text style={styles.inventorySub}>{formatGrams(item.quantityOnHandGrams)} remaining</Text>
                  <View style={styles.track}>
                    <View style={[styles.trackFill, { width: `${Math.round(stockFill(item) * 100)}%` }, tierBarStyle(tier.tone)]} />
                  </View>
                </View>
                <Pill label={tier.label} tone={tier.tone} />
              </View>
            );
          })}
        </View>
      )}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Main column panels
// ---------------------------------------------------------------------------

function ActiveSessionsPanel({
  bookings,
  onOpen,
}: {
  bookings: StaffBookingSummary[];
  onOpen: (booking: StaffBookingSummary) => void;
}): React.JSX.Element {
  return (
    <View style={styles.card}>
      <SectionHeading title="Active Sessions" count={bookings.length} />
      {bookings.length === 0 ? (
        <Text style={styles.mutedText}>No clients are in the chair right now.</Text>
      ) : (
        <View style={styles.sessionList}>
          {bookings.map((booking) => {
            const badge = activeStatusBadge(booking.status);
            return (
              <Pressable
                key={booking.id}
                accessibilityRole="button"
                onPress={() => onOpen(booking)}
                style={styles.sessionRow}
              >
                <View style={styles.sessionAvatar}>
                  <Text style={styles.sessionAvatarText}>{initials(booking.clientDisplayName)}</Text>
                </View>
                <View style={styles.sessionInfo}>
                  <Text style={styles.sessionName} numberOfLines={1}>
                    {booking.clientDisplayName}
                  </Text>
                  <Text style={styles.sessionService} numberOfLines={1}>
                    {booking.serviceNames.join(' + ') || 'Colour service'} · since {formatRelativeTime(booking.startsAt)}
                  </Text>
                </View>
                <Pill label={badge.label} tone={badge.tone} />
              </Pressable>
            );
          })}
        </View>
      )}
    </View>
  );
}

function CompletedTodayPanel({
  bookings,
  isWide,
  onOpen,
}: {
  bookings: StaffBookingSummary[];
  isWide: boolean;
  onOpen: (booking: StaffBookingSummary) => void;
}): React.JSX.Element {
  return (
    <View style={styles.card}>
      <SectionHeading title="Completed Today" count={bookings.length} />
      {bookings.length === 0 ? (
        <Text style={styles.mutedText}>No appointments have been completed yet today.</Text>
      ) : (
        <View>
          {isWide ? (
            <View style={styles.tableHeader}>
              <Text style={[styles.th, styles.colClient]}>Client</Text>
              <Text style={[styles.th, styles.colService]}>Service</Text>
              <Text style={[styles.th, styles.colTime]}>Time</Text>
              <Text style={[styles.th, styles.colStatus]}>Status</Text>
            </View>
          ) : null}
          {bookings.map((booking) => {
            const badge = completedStatusBadge(booking.status);
            const time = formatTimeOfDay(booking.completedAt ?? booking.endsAt ?? booking.startsAt);
            if (isWide) {
              return (
                <Pressable
                  key={booking.id}
                  accessibilityRole="button"
                  onPress={() => onOpen(booking)}
                  style={styles.tableRow}
                >
                  <Text style={[styles.td, styles.colClient]} numberOfLines={1}>
                    {booking.clientDisplayName}
                  </Text>
                  <Text style={[styles.tdMuted, styles.colService]} numberOfLines={1}>
                    {booking.serviceNames.join(' + ') || 'Colour service'}
                  </Text>
                  <Text style={[styles.tdMuted, styles.colTime]}>{time}</Text>
                  <View style={styles.colStatus}>
                    <Pill label={badge.label} tone={badge.tone} />
                  </View>
                </Pressable>
              );
            }
            return (
              <Pressable
                key={booking.id}
                accessibilityRole="button"
                onPress={() => onOpen(booking)}
                style={styles.completedCard}
              >
                <View style={styles.completedCardTop}>
                  <Text style={styles.sessionName} numberOfLines={1}>
                    {booking.clientDisplayName}
                  </Text>
                  <Pill label={badge.label} tone={badge.tone} />
                </View>
                <Text style={styles.sessionService} numberOfLines={1}>
                  {booking.serviceNames.join(' + ') || 'Colour service'} · {time}
                </Text>
              </Pressable>
            );
          })}
        </View>
      )}
    </View>
  );
}

function QuickToolsPanel({
  fixedTiles,
  tools,
  onSelect,
}: {
  fixedTiles: boolean;
  tools: NavEntry[];
  onSelect: (target: NavTarget) => void;
}): React.JSX.Element {
  return (
    <View style={styles.card}>
      <Text style={styles.eyebrow}>Quick Lab Tools</Text>
      <View style={styles.toolGrid}>
        {tools.map((tool) => {
          const soon = tool.target.kind === 'soon';
          return (
            <Pressable
              key={tool.key}
              accessibilityRole="button"
              disabled={soon}
              onPress={() => onSelect(tool.target)}
              style={[styles.toolTile, fixedTiles ? styles.toolTileTablet : styles.toolTilePhone, soon && styles.navItemSoon]}
            >
              <Icon name={tool.icon} size={22} tone="primary" />
              <Text style={styles.toolLabel} numberOfLines={2}>
                {tool.label}
              </Text>
              {soon ? <Text style={styles.soonTagInline}>Soon</Text> : null}
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

function Footer({
  session,
  now,
  bleConnected,
}: {
  session?: PinUnlockResponse;
  now: Date;
  bleConnected: boolean;
}): React.JSX.Element {
  const live = session?.status === 'active';
  return (
    <View style={styles.footer}>
      <View style={styles.footerSide}>
        <Text style={styles.footerText}>{formatClock(now)}</Text>
        <View style={[styles.dot, { backgroundColor: bleConnected ? c.successText : c.textMuted }]} />
        <Text style={styles.footerText}>{bleConnected ? 'Scale live' : 'Scale idle'}</Text>
      </View>
      <View style={styles.footerSide}>
        <Text style={styles.footerTextStrong}>{live ? 'SYSTEM LIVE' : 'SESSION ENDED'}</Text>
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

function SectionHeading({ title, count }: { title: string; count?: number }): React.JSX.Element {
  return (
    <View style={styles.sectionHeading}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {count != null ? (
        <View style={styles.countBadge}>
          <Text style={styles.countBadgeText}>{count}</Text>
        </View>
      ) : null}
    </View>
  );
}

function StatTile({
  label,
  value,
  hint,
  tone = 'neutral',
  flexible = false,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: StatusTone;
  flexible?: boolean;
}): React.JSX.Element {
  return (
    <View style={[styles.statTile, flexible && styles.statTileFlex]}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={[styles.statValue, tone === 'success' && { color: c.successText }]}>{value}</Text>
      {hint ? <Text style={styles.statHint}>{hint}</Text> : null}
    </View>
  );
}

function MiniStat({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <View style={styles.miniStat}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={styles.miniStatValue}>{value}</Text>
    </View>
  );
}

function Pill({
  label,
  tone,
  subtle,
  onDark,
}: {
  label: string;
  tone: StatusTone;
  subtle?: boolean;
  onDark?: boolean;
}): React.JSX.Element {
  const palette = toneStyle(tone);
  return (
    <View
      style={[
        styles.pill,
        { backgroundColor: onDark ? c.heroSoft : palette.bg, borderColor: onDark ? c.heroBorder : palette.border },
        subtle && styles.pillSubtle,
      ]}
    >
      <Text style={[styles.pillText, { color: onDark ? c.heroText : palette.text }]}>{label}</Text>
    </View>
  );
}

function toneStyle(tone: StatusTone): { text: string; bg: string; border: string } {
  switch (tone) {
    case 'success':
      return { text: c.successText, bg: c.successBg, border: c.successBorder };
    case 'warning':
      return { text: c.warningText, bg: c.warningBg, border: c.warningBorder };
    case 'danger':
      return { text: c.dangerText, bg: c.dangerBg, border: c.dangerBorder };
    case 'brand':
      return { text: c.primary, bg: c.primarySoft, border: c.primarySoft };
    default:
      return { text: c.textSecondary, bg: c.surfaceAlt, border: c.border };
  }
}

function tierBarStyle(tone: StatusTone): { backgroundColor: string } {
  switch (tone) {
    case 'danger':
      return { backgroundColor: c.dangerText };
    case 'warning':
      return { backgroundColor: c.warningText };
    case 'success':
      return { backgroundColor: c.successText };
    default:
      return { backgroundColor: c.primary };
  }
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: c.background,
  },
  centerFill: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: t.spacing.sm,
  },
  stack: {
    gap: t.spacing.base,
  },
  mainRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
  },
  mainColumn: {
    flex: 1,
    gap: t.spacing.lg,
  },
  rightRail: {
    gap: t.spacing.lg,
  },

  // All that survives of the old private nav: it now only dims a Quick Tools
  // tile whose destination does not exist yet.
  navItemSoon: {
    opacity: 0.55,
  },

  // Hero
  hero: {
    backgroundColor: c.hero,
    borderRadius: t.radius.cardLg,
    padding: t.spacing.xl,
    overflow: 'hidden',
  },
  heroBody: {
    gap: t.spacing.md,
    alignItems: 'flex-start',
  },
  heroTitle: {
    color: c.heroText,
    fontSize: t.typography.fontSize.display,
    lineHeight: t.typography.lineHeight.display,
    fontWeight: '700',
  },
  heroSubtitle: {
    color: c.heroTextMuted,
    fontSize: t.typography.fontSize.bodyLg,
    lineHeight: t.typography.lineHeight.bodyLg,
    maxWidth: 520,
  },
  heroButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: t.spacing.sm,
    backgroundColor: c.onHeroButtonBg,
    paddingVertical: t.spacing.md,
    paddingHorizontal: t.spacing.lg,
    borderRadius: t.radius.full,
    marginTop: t.spacing.xs,
  },
  heroButtonText: {
    color: c.onHeroButtonText,
    fontSize: t.typography.fontSize.body,
    fontWeight: '700',
  },

  // Cards
  card: {
    backgroundColor: c.surface,
    borderRadius: t.radius.cardLg,
    borderWidth: 1,
    borderColor: c.border,
    padding: t.spacing.lg,
    gap: t.spacing.md,
    ...t.cardShadow,
  },
  cardHeaderRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: t.spacing.sm,
  },
  cardHeaderText: {
    flex: 1,
    gap: 2,
  },
  eyebrow: {
    color: c.textMuted,
    fontSize: t.typography.fontSize.micro,
    fontWeight: '700',
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  cardTitle: {
    color: c.textPrimary,
    fontSize: t.typography.fontSize.subtitle,
    fontWeight: '700',
  },
  sectionHeading: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: t.spacing.sm,
  },
  sectionTitle: {
    color: c.textPrimary,
    fontSize: t.typography.fontSize.subtitle,
    fontWeight: '700',
  },
  countBadge: {
    minWidth: 22,
    height: 22,
    paddingHorizontal: 6,
    borderRadius: t.radius.full,
    backgroundColor: c.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  countBadgeText: {
    color: c.primary,
    fontSize: t.typography.fontSize.micro,
    fontWeight: '700',
  },
  mutedText: {
    color: c.textMuted,
    fontSize: t.typography.fontSize.small,
    lineHeight: t.typography.lineHeight.small,
  },
  errorText: {
    color: c.dangerText,
    fontSize: t.typography.fontSize.small,
    fontWeight: '600',
  },

  // Scale
  scaleWeightBlock: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: t.spacing.xs,
  },
  scaleWeight: {
    color: c.textPrimary,
    fontSize: 40,
    fontWeight: '700',
    lineHeight: 44,
  },
  scaleWeightUnit: {
    color: c.textMuted,
    fontSize: t.typography.fontSize.subtitle,
    marginBottom: 6,
  },
  statRow: {
    flexDirection: 'row',
    gap: t.spacing.sm,
  },
  miniStat: {
    flex: 1,
    backgroundColor: c.surfaceAlt,
    borderRadius: t.radius.card,
    padding: t.spacing.md,
    gap: 2,
  },
  miniStatValue: {
    color: c.textPrimary,
    fontSize: t.typography.fontSize.body,
    fontWeight: '700',
  },
  outlineButton: {
    borderWidth: 1,
    borderColor: c.borderStrong,
    borderRadius: t.radius.full,
    paddingVertical: t.spacing.sm,
    alignItems: 'center',
  },
  outlineButtonText: {
    color: c.textPrimary,
    fontSize: t.typography.fontSize.small,
    fontWeight: '700',
  },

  // Insights
  insightStack: {
    gap: t.spacing.sm,
  },
  // On wider full-width panels (iPad portrait) the three tiles flow in a row.
  insightRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: t.spacing.sm,
  },
  statTile: {
    backgroundColor: c.surfaceAlt,
    borderRadius: t.radius.card,
    padding: t.spacing.md,
    gap: 2,
  },
  statTileFlex: {
    flex: 1,
    minWidth: 150,
  },
  statLabel: {
    color: c.textMuted,
    fontSize: t.typography.fontSize.micro,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  statValue: {
    color: c.textPrimary,
    fontSize: t.typography.fontSize.heading,
    fontWeight: '700',
  },
  statHint: {
    color: c.textSecondary,
    fontSize: t.typography.fontSize.caption,
  },

  // Inventory
  inventoryList: {
    gap: t.spacing.md,
  },
  inventoryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: t.spacing.sm,
  },
  inventoryInfo: {
    flex: 1,
    gap: 4,
  },
  inventoryName: {
    color: c.textPrimary,
    fontSize: t.typography.fontSize.small,
    fontWeight: '600',
  },
  inventorySub: {
    color: c.textMuted,
    fontSize: t.typography.fontSize.caption,
  },
  track: {
    height: 6,
    borderRadius: t.radius.full,
    backgroundColor: c.surfaceAlt,
    overflow: 'hidden',
  },
  trackFill: {
    height: 6,
    borderRadius: t.radius.full,
  },

  // Active sessions
  sessionList: {
    gap: t.spacing.sm,
  },
  sessionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: t.spacing.md,
    padding: t.spacing.md,
    borderRadius: t.radius.card,
    borderWidth: 1,
    borderColor: c.border,
    backgroundColor: c.surfaceAlt,
  },
  sessionAvatar: {
    width: 40,
    height: 40,
    borderRadius: t.radius.full,
    backgroundColor: c.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sessionAvatarText: {
    color: c.primary,
    fontWeight: '700',
    fontSize: t.typography.fontSize.small,
  },
  sessionInfo: {
    flex: 1,
    gap: 2,
  },
  sessionName: {
    color: c.textPrimary,
    fontSize: t.typography.fontSize.body,
    fontWeight: '700',
  },
  sessionService: {
    color: c.textSecondary,
    fontSize: t.typography.fontSize.caption,
  },

  // Completed table
  tableHeader: {
    flexDirection: 'row',
    paddingBottom: t.spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: c.border,
  },
  th: {
    color: c.textMuted,
    fontSize: t.typography.fontSize.micro,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  tableRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: t.spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: c.border,
  },
  td: {
    color: c.textPrimary,
    fontSize: t.typography.fontSize.small,
    fontWeight: '600',
  },
  tdMuted: {
    color: c.textSecondary,
    fontSize: t.typography.fontSize.small,
  },
  colClient: { flex: 1.4 },
  colService: { flex: 1.6 },
  colTime: { flex: 1 },
  colStatus: { flex: 1, alignItems: 'flex-start' },
  completedCard: {
    paddingVertical: t.spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: c.border,
    gap: 4,
  },
  completedCardTop: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: t.spacing.sm,
  },

  // Quick tools
  toolGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: t.spacing.sm,
  },
  toolTile: {
    backgroundColor: c.surfaceAlt,
    borderRadius: t.radius.card,
    borderWidth: 1,
    borderColor: c.border,
    paddingVertical: t.spacing.base,
    paddingHorizontal: t.spacing.md,
    alignItems: 'center',
    gap: t.spacing.xs,
  },
  toolTileTablet: {
    width: 132,
  },
  toolTilePhone: {
    flexBasis: '47%',
    flexGrow: 1,
  },
  toolLabel: {
    color: c.textPrimary,
    fontSize: t.typography.fontSize.caption,
    fontWeight: '600',
    textAlign: 'center',
  },
  soonTagInline: {
    color: c.textMuted,
    fontSize: t.typography.fontSize.micro,
    fontWeight: '600',
  },

  // Pills
  pill: {
    paddingHorizontal: t.spacing.sm,
    paddingVertical: 4,
    borderRadius: t.radius.full,
    borderWidth: 1,
    alignSelf: 'flex-start',
  },
  pillSubtle: {
    paddingVertical: 3,
  },
  pillText: {
    fontSize: t.typography.fontSize.micro,
    fontWeight: '700',
    letterSpacing: 0.3,
  },

  // Footer
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: t.spacing.md,
    marginTop: t.spacing.xs,
    borderTopWidth: 1,
    borderTopColor: c.border,
  },
  footerSide: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: t.spacing.sm,
  },
  footerText: {
    color: c.textMuted,
    fontSize: t.typography.fontSize.caption,
  },
  footerTextStrong: {
    color: c.textSecondary,
    fontSize: t.typography.fontSize.micro,
    fontWeight: '700',
    letterSpacing: 1,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: t.radius.full,
  },
});
