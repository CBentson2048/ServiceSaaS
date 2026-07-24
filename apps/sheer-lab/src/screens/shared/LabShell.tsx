import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { PinUnlockResponse } from '@sheer/domain';
import type React from 'react';
import { useCallback } from 'react';
import {
  Pressable,
  RefreshControl,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import type { RootStackParamList } from '../../app/navigation/routes';
import { featureFlags } from '../../config/featureFlags';
import type { BleConnectionStatus } from '../../features/ble/types';
import { logoutLabSession } from '../../features/sheer-lab/labSession';
import { labLightTheme } from '../../theme/labTheme';
import { BrandMark } from './BrandMark';
import { BrandWordmark } from './BrandWordmark';

export const t = labLightTheme;
export const c = t.colors;

export type StatusTone = 'success' | 'warning' | 'danger' | 'neutral' | 'brand';

// ---------------------------------------------------------------------------
// Responsive layout (shared across every Lab dashboard-style screen)
// ---------------------------------------------------------------------------

export type LayoutMode = 'phone' | 'tablet' | 'wide';

export interface LabLayout {
  mode: LayoutMode;
  sidebarWidth: number;
  pad: number;
  gap: number;
  isWide: boolean;
  isTablet: boolean;
}

export function useLabLayout(): LabLayout {
  const { width } = useWindowDimensions();
  return resolveLayout(width);
}

function resolveLayout(width: number): LabLayout {
  if (width >= 1024) {
    const large = width >= 1280;
    return {
      mode: 'wide',
      sidebarWidth: large ? 248 : 216,
      pad: large ? t.spacing.xl : t.spacing.base,
      gap: t.spacing.lg,
      isWide: true,
      isTablet: true,
    };
  }
  if (width >= 700) {
    return { mode: 'tablet', sidebarWidth: 208, pad: t.spacing.base, gap: t.spacing.base, isWide: false, isTablet: true };
  }
  return { mode: 'phone', sidebarWidth: 0, pad: t.spacing.base, gap: t.spacing.base, isWide: false, isTablet: false };
}

// ---------------------------------------------------------------------------
// Navigation model
// ---------------------------------------------------------------------------

export type NavKey = 'dashboard' | 'new-mix' | 'history' | 'inventory' | 'billing' | 'audit';

// Routes the sidebar can reach. All have `undefined` params so a bare
// navigation.navigate(route) is type-safe.
type DirectRoute = 'Home' | 'NewMix' | 'FormulaHistory' | 'Inventory' | 'BillingRules';

interface NavSpec {
  key: NavKey;
  label: string;
  glyph: string;
  route?: DirectRoute;
}

const NAV_ITEMS: NavSpec[] = [
  { key: 'dashboard', label: 'Dashboard', glyph: '▦', route: 'Home' },
  { key: 'new-mix', label: 'New Mix', glyph: '🧪', route: 'NewMix' },
  { key: 'history', label: 'History', glyph: '🕘', route: 'FormulaHistory' },
  { key: 'inventory', label: 'Inventory', glyph: '📦', route: 'Inventory' },
  { key: 'billing', label: 'Billing Rules', glyph: '🧾', route: 'BillingRules' },
  { key: 'audit', label: 'Audit Trail', glyph: '🛡️' },
];

// Billing Rules and Audit Trail are hidden from the UI behind their feature
// flags; the screens/routes stay intact, they are simply dropped from the
// sidebar/nav for every role until the flags are flipped on.
const VISIBLE_NAV_ITEMS = NAV_ITEMS.filter(
  (item) =>
    (item.key !== 'billing' || featureFlags.billingRules) && (item.key !== 'audit' || featureFlags.auditTrail),
);

// Destinations restricted to owners/managers — stylists see them disabled.
function isManagedNav(key: NavKey): boolean {
  return key === 'inventory' || key === 'billing';
}

// ---------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------

export interface LabShellProps {
  active: NavKey;
  session?: PinUnlockResponse;
  /** Live Bluetooth/scale connection state — drives the header status badge. */
  bleStatus: BleConnectionStatus;
  refreshing?: boolean;
  onRefresh?: () => void;
  footer?: React.ReactNode;
  children: React.ReactNode;
}

export function LabShell({
  active,
  session,
  bleStatus,
  refreshing,
  onRefresh,
  footer,
  children,
}: LabShellProps): React.JSX.Element {
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const layout = useLabLayout();
  const showSidebar = layout.mode !== 'phone';

  // Inventory and Billing Rules are owner/manager-only (stylists get a lock
  // screen), so those destinations are only live for those roles — stylists keep
  // the "Soon" affordance rather than being routed to a wall.
  const canManageOps = session?.role === 'owner' || session?.role === 'manager';

  const navigate = useCallback(
    (item: NavSpec) => {
      if (!item.route || item.key === active) return;
      navigation.navigate(item.route);
    },
    [active, navigation],
  );

  const handleSignOut = useCallback(async () => {
    if (session) {
      try {
        await logoutLabSession(session.sessionId);
      } catch {
        // Best effort — always return the device to the lock screen.
      }
    }
    navigation.reset({ index: 0, routes: [{ name: 'Auth' }] });
  }, [navigation, session]);

  return (
    <SafeAreaView style={styles.screen} edges={['top', 'bottom']}>
      <StatusBar barStyle="light-content" backgroundColor={c.background} />
      <TopBar
        session={session}
        bleStatus={bleStatus}
        onRefresh={onRefresh}
        onSettings={() => navigation.navigate('Settings')}
      />

      <View style={[styles.body, showSidebar ? styles.bodyRow : styles.bodyColumn]}>
        {showSidebar ? (
          <Sidebar
            active={active}
            width={layout.sidebarWidth}
            canManageOps={canManageOps}
            onNav={navigate}
            onSignOut={handleSignOut}
          />
        ) : null}

        <ScrollView
          style={styles.scroll}
          contentContainerStyle={{ padding: layout.pad, paddingBottom: t.spacing['3xl'] }}
          showsVerticalScrollIndicator={false}
          refreshControl={
            onRefresh ? <RefreshControl refreshing={Boolean(refreshing)} onRefresh={onRefresh} tintColor={c.primary} /> : undefined
          }
        >
          <View style={[styles.contentWrap, { gap: layout.gap }]}>
            {!showSidebar ? (
              <NavScroller active={active} canManageOps={canManageOps} onNav={navigate} onSignOut={handleSignOut} />
            ) : null}
            {children}
            {footer ?? <DefaultFooter session={session} />}
          </View>
        </ScrollView>
      </View>
    </SafeAreaView>
  );
}

// ---------------------------------------------------------------------------
// Chrome pieces
// ---------------------------------------------------------------------------

// Shared top bar for every Lab screen, kept to a single row. Left: a stack with
// the QLOOQO LAB title on top and the Bluetooth scale-state badge beneath it.
// Right (vertically centred): the optional reload, the settings button, then the
// user avatar at the far end. There is intentionally no session/online badge, and
// the user's name is not shown — just the avatar. `onSettings` is optional — when
// omitted the bar navigates to Settings itself, so screens that don't manage
// navigation can still drop it in with just session + bleStatus.
export function TopBar({
  session,
  bleStatus,
  onRefresh,
  onSettings,
}: {
  session?: PinUnlockResponse;
  bleStatus: BleConnectionStatus;
  onRefresh?: () => void;
  onSettings?: () => void;
}): React.JSX.Element {
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const scale = bleBadge(bleStatus);
  const handleSettings = onSettings ?? (() => navigation.navigate('Settings'));
  return (
    <View style={styles.topBar}>
      <View style={styles.brandBlock}>
        <View style={styles.brandRow}>
          <BrandMark size={30} />
          <BrandWordmark height={20} />
        </View>
        <Pill label={scale.label} tone={scale.tone} subtle />
      </View>

      <View style={styles.topActions}>
        {onRefresh ? (
          <Pressable accessibilityRole="button" onPress={onRefresh} style={styles.iconButton} hitSlop={8}>
            <Text style={styles.iconButtonGlyph}>⟳</Text>
          </Pressable>
        ) : null}
        <Pressable accessibilityRole="button" onPress={handleSettings} style={styles.iconButton} hitSlop={8}>
          <Text style={styles.iconButtonGlyph}>⚙︎</Text>
        </Pressable>
        {session ? (
          <View style={styles.avatar}>
            <Text style={styles.avatarText}>{initials(session.displayName)}</Text>
          </View>
        ) : null}
      </View>
    </View>
  );
}

function Sidebar({
  active,
  width,
  canManageOps,
  onNav,
  onSignOut,
}: {
  active: NavKey;
  width: number;
  canManageOps: boolean;
  onNav: (item: NavSpec) => void;
  onSignOut: () => void;
}): React.JSX.Element {
  return (
    <View style={[styles.sidebar, { width }]}>
      <View style={styles.sidebarNav}>
        {VISIBLE_NAV_ITEMS.filter((item) => item.key !== 'inventory' || canManageOps).map((item) => {
          const isActive = item.key === active;
          const soon = !item.route || (isManagedNav(item.key) && !canManageOps);
          return (
            <Pressable
              key={item.key}
              accessibilityRole="button"
              disabled={soon || isActive}
              onPress={() => onNav(item)}
              style={[styles.navItem, isActive && styles.navItemActive, soon && styles.navItemSoon]}
            >
              <Text style={[styles.navGlyph, styles.sidebarGlyph, isActive && styles.sidebarGlyphActive]}>{item.glyph}</Text>
              <Text style={[styles.navLabel, isActive && styles.navLabelActive]} numberOfLines={1}>
                {item.label}
              </Text>
              {soon ? <Text style={styles.sidebarSoonTag}>Soon</Text> : null}
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
  active,
  canManageOps,
  onNav,
  onSignOut,
}: {
  active: NavKey;
  canManageOps: boolean;
  onNav: (item: NavSpec) => void;
  onSignOut: () => void;
}): React.JSX.Element {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.navScroller}
      style={styles.navScrollerWrap}
    >
      {VISIBLE_NAV_ITEMS.filter((item) => item.key !== 'inventory' || canManageOps).map((item) => {
        const isActive = item.key === active;
        const soon = !item.route || (isManagedNav(item.key) && !canManageOps);
        return (
          <Pressable
            key={item.key}
            accessibilityRole="button"
            disabled={soon || isActive}
            onPress={() => onNav(item)}
            style={[styles.navChip, isActive && styles.navChipActive, soon && styles.navItemSoon]}
          >
            <Text style={styles.navGlyph}>{item.glyph}</Text>
            <Text style={[styles.navChipLabel, isActive && styles.navLabelActive]}>{item.label}</Text>
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

function DefaultFooter({ session }: { session?: PinUnlockResponse }): React.JSX.Element {
  const live = session?.status === 'active';
  return (
    <View style={styles.footer}>
      <Text style={styles.footerTextStrong}>{live ? 'SYSTEM LIVE' : 'SESSION ENDED'}</Text>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

export function Pill({
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

// Maps the live BLE connection state to a header badge. Single source of truth
// so the dashboard (HomeScreen) and every LabShell screen render identical copy.
export function bleBadge(status: BleConnectionStatus): { label: string; tone: StatusTone } {
  switch (status) {
    case 'connected':
      return { label: 'Scale connected', tone: 'success' };
    case 'scanning':
      return { label: 'Scanning…', tone: 'warning' };
    case 'connecting':
    case 'discovering':
      return { label: 'Connecting…', tone: 'warning' };
    case 'reconnecting':
      return { label: 'Reconnecting…', tone: 'warning' };
    case 'error':
      return { label: 'Scale error', tone: 'danger' };
    default:
      return { label: 'Scale off', tone: 'neutral' };
  }
}

export function toneStyle(tone: StatusTone): { text: string; bg: string; border: string } {
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

export function initials(displayName: string): string {
  const parts = displayName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function roleLabel(role: 'owner' | 'manager' | 'stylist'): string {
  switch (role) {
    case 'owner':
      return 'Owner';
    case 'manager':
      return 'Manager';
    default:
      return 'Stylist';
  }
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: c.background },
  body: { flex: 1 },
  bodyRow: { flexDirection: 'row' },
  bodyColumn: { flexDirection: 'column' },
  scroll: { flex: 1 },
  contentWrap: { width: '100%', maxWidth: 1600, alignSelf: 'center' },

  // Single row — never wraps. Items are vertically centred, so the right-hand
  // controls sit centred against the taller brand block on the left.
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: t.spacing.base,
    paddingVertical: t.spacing.md,
    backgroundColor: c.surface,
    borderBottomWidth: 1,
    borderBottomColor: c.border,
    gap: t.spacing.sm,
  },
  // Left stack: title row on top, scale-state badge beneath it.
  brandBlock: { alignItems: 'flex-start', gap: 4 },
  brandRow: { flexDirection: 'row', alignItems: 'center', gap: t.spacing.sm },
  // Right controls: reload, settings, then the avatar at the far end.
  topActions: { flexDirection: 'row', alignItems: 'center', gap: t.spacing.sm },
  iconButton: {
    width: 36,
    height: 36,
    borderRadius: t.radius.full,
    borderWidth: 1,
    borderColor: c.border,
    backgroundColor: c.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconButtonGlyph: { fontSize: 16, color: c.textSecondary },
  userRow: { flexDirection: 'row', alignItems: 'center', gap: t.spacing.sm, maxWidth: 200 },
  avatar: {
    width: 34,
    height: 34,
    borderRadius: t.radius.full,
    backgroundColor: c.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: { color: c.primary, fontWeight: '700', fontSize: t.typography.fontSize.caption },
  userName: { color: c.textPrimary, fontWeight: '600', fontSize: t.typography.fontSize.small },
  userRole: { color: c.textMuted, fontSize: t.typography.fontSize.micro },

  sidebar: {
    backgroundColor: c.sidebar,
    borderRightWidth: 1,
    borderRightColor: c.sidebarBorder,
    paddingVertical: t.spacing.lg,
    paddingHorizontal: t.spacing.md,
    justifyContent: 'space-between',
  },
  sidebarNav: { gap: t.spacing.xs },
  navItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: t.spacing.md,
    paddingVertical: t.spacing.md,
    paddingHorizontal: t.spacing.md,
    borderRadius: t.radius.card,
  },
  // Active item reads as a solid brand pill (rounded via `navItem.borderRadius`)
  // with white text/glyph, rather than the older soft-tinted fill.
  navItemActive: { backgroundColor: c.sidebarActive },
  navItemSoon: { opacity: 0.55 },
  navGlyph: { fontSize: 16 },
  // Lightens non-emoji glyphs (e.g. the ▦ dashboard mark) on the dark rail;
  // colour emoji ignore the tint either way.
  sidebarGlyph: { color: c.sidebarText },
  // On the filled active pill the ▦-style glyph flips to white to match the label.
  sidebarGlyphActive: { color: c.sidebarActiveText },
  navLabel: { flex: 1, color: c.sidebarText, fontSize: t.typography.fontSize.small, fontWeight: '600' },
  navLabelActive: { color: c.sidebarActiveText, fontWeight: '700' },
  soonTag: { color: c.textMuted, fontSize: t.typography.fontSize.micro, fontWeight: '600' },
  // Light variant for the deep-purple sidebar rail; `soonTag` above stays dark
  // for the mobile nav scroller chips that sit on the light canvas.
  sidebarSoonTag: { color: c.sidebarTextMuted, fontSize: t.typography.fontSize.micro, fontWeight: '600' },
  signOut: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: t.spacing.md,
    paddingVertical: t.spacing.md,
    paddingHorizontal: t.spacing.md,
    borderRadius: t.radius.card,
    borderWidth: 1,
    borderColor: c.sidebarBorder,
  },
  signOutGlyph: { fontSize: 16, color: c.sidebarText },
  signOutLabel: { color: c.sidebarText, fontWeight: '600', fontSize: t.typography.fontSize.small },

  navScrollerWrap: { marginBottom: t.spacing.xs },
  navScroller: { flexDirection: 'row', gap: t.spacing.sm, paddingVertical: t.spacing.xs },
  navChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: t.spacing.xs,
    paddingVertical: t.spacing.sm,
    paddingHorizontal: t.spacing.md,
    borderRadius: t.radius.full,
    borderWidth: 1,
    borderColor: c.border,
    backgroundColor: c.surface,
  },
  navChipActive: { backgroundColor: c.primarySoft, borderColor: c.primarySoft },
  navChipLabel: { color: c.textSecondary, fontSize: t.typography.fontSize.small, fontWeight: '600' },

  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: t.spacing.md,
    marginTop: t.spacing.xs,
    borderTopWidth: 1,
    borderTopColor: c.border,
  },
  footerTextStrong: { color: c.textSecondary, fontSize: t.typography.fontSize.micro, fontWeight: '700', letterSpacing: 1 },

  pill: {
    paddingHorizontal: t.spacing.sm,
    paddingVertical: 4,
    borderRadius: t.radius.full,
    borderWidth: 1,
    alignSelf: 'flex-start',
  },
  pillSubtle: { paddingVertical: 3 },
  pillText: { fontSize: t.typography.fontSize.micro, fontWeight: '700', letterSpacing: 0.3 },
});
