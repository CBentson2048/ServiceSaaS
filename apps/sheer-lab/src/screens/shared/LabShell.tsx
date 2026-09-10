import { useNavigation, useRoute } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { PinUnlockResponse } from '@sheer/domain';
import type React from 'react';
import { useCallback } from 'react';
import {
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import type { RootStackParamList } from '../../app/navigation/routes';
import type { BleConnectionStatus } from '../../features/ble/types';
import { logoutLabSession } from '../../features/sheer-lab/labSession';
import {
  canManageOps as roleCanManageOps,
  isNavItemActive,
  isNavItemSoon,
  visibleNavItems,
  type NavSpec,
} from '../../navigation/labNav';
import { labTheme } from '../../theme/labTheme';
import { Icon } from '../../ui/icons/Icon';
import { BrandMark } from './BrandMark';
import { BrandWordmark } from './BrandWordmark';

export const t = labTheme;
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
  /**
   * Cap for a reading-width column, in px; 0 means unbounded. A dashboard wants
   * the full 1600 so its tiles can spread, but a report page (Mix Finalized,
   * Update Formula) is one column of prose and numbers, and 1600px of it is
   * unreadable. Those two screens each carried their own copy of these numbers.
   */
  readingWidth: number;
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
      readingWidth: 920,
    };
  }
  if (width >= 700) {
    return {
      mode: 'tablet',
      sidebarWidth: 208,
      pad: t.spacing.base,
      gap: t.spacing.base,
      isWide: false,
      isTablet: true,
      readingWidth: 720,
    };
  }
  return {
    mode: 'phone',
    sidebarWidth: 0,
    pad: t.spacing.base,
    gap: t.spacing.base,
    isWide: false,
    isTablet: false,
    readingWidth: 0,
  };
}

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------
//
// The destination list, the visibility rule and the active-state derivation all
// live in `src/navigation/labNav.ts` — a pure module, so they are unit-tested.
// This file only renders them. Re-declaring any of it here is how the seven
// divergent copies happened.

export type { NavKey } from '../../navigation/labNav';

// ---------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------

export interface LabShellProps {
  session?: PinUnlockResponse;
  /** Live Bluetooth/scale connection state — drives the header status badge. */
  bleStatus: BleConnectionStatus;
  /**
   * A lab session id the screen knows SYNCHRONOUSLY — from route params, or a
   * draft. Sign-out uses `session.sessionId` when it has it and falls back to
   * this otherwise.
   *
   * This is load-bearing, not a convenience. `session` arrives from an async
   * getActiveLabSession() call, so a shell that only knew about `session` would
   * navigate an operator to the lock screen WITHOUT invalidating the
   * server-side session whenever they signed out before that call landed — or
   * whenever it failed. The formula-flow screens all carry the id in their
   * route params from first render, which is exactly why their own handlers
   * used it. Pass it wherever you have it.
   */
  labSessionId?: string;
  refreshing?: boolean;
  onRefresh?: () => void;
  /** Scrolls with the content. Defaults to the system-status band. */
  footer?: React.ReactNode;
  /**
   * PINNED below the scroll area, inside the main column so it clears the
   * sidebar. This is the slot whose absence forced Formula, BuildFormula and
   * UpdateFormula to fork the whole shell: their live grams/charge bar has to
   * stay visible while the operator weighs, and `footer` scrolls away.
   */
  bottomBar?: React.ReactNode;
  /**
   * `full` (default) spreads to 1600px — right for a dashboard of tiles.
   * `reading` caps to `layout.readingWidth` — right for a one-column report.
   */
  contentWidth?: 'full' | 'reading';
  children: React.ReactNode;
}

export function LabShell({
  session,
  bleStatus,
  labSessionId,
  refreshing,
  onRefresh,
  footer,
  bottomBar,
  contentWidth = 'full',
  children,
}: LabShellProps): React.JSX.Element {
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const layout = useLabLayout();
  const showSidebar = layout.mode !== 'phone';

  // ACTIVE STATE IS DERIVED, NOT DECLARED. It used to be an `active: NavKey`
  // prop, which meant every screen asserted which station it was — and the six
  // forked screens either got it wrong or omitted it, leaving nothing
  // highlighted. A route cannot disagree with itself.
  const routeName = useRoute().name;
  const canManageOps = roleCanManageOps(session?.role);
  const items = visibleNavItems({ canManageOps });

  const navigate = useCallback(
    (item: NavSpec) => {
      if (!item.route || isNavItemActive(item, routeName)) return;
      navigation.navigate(item.route);
    },
    [navigation, routeName],
  );

  const handleSignOut = useCallback(async () => {
    // `session.sessionId` is authoritative (it comes from getActiveLabSession);
    // `labSessionId` is the synchronous fallback so a sign-out during the load
    // still reaches the server. The forks disagreed on this ordering — Formula
    // preferred the route param, MixFinalized preferred the session — and two
    // of them had no fallback at all.
    const sid = session?.sessionId ?? labSessionId;
    if (sid) {
      try {
        await logoutLabSession(sid);
      } catch {
        // Best effort — always return the device to the lock screen.
      }
    }
    navigation.reset({ index: 0, routes: [{ name: 'Auth' }] });
  }, [labSessionId, navigation, session]);

  return (
    <SafeAreaView style={styles.screen} edges={['top', 'bottom']}>
      <TopBar
        session={session}
        bleStatus={bleStatus}
        onRefresh={onRefresh}
        onSettings={() => navigation.navigate('Settings')}
      />

      <View style={[styles.body, showSidebar ? styles.bodyRow : styles.bodyColumn]}>
        {showSidebar ? (
          <Sidebar
            items={items}
            routeName={routeName}
            width={layout.sidebarWidth}
            onNav={navigate}
            onSignOut={handleSignOut}
          />
        ) : null}

        {/* The pinned bar is a sibling of the ScrollView inside this column, so
            it clears the sidebar rail and never overlaps scrolling content. */}
        <View style={styles.mainArea}>
          <ScrollView
            style={styles.scroll}
            contentContainerStyle={{ padding: layout.pad, paddingBottom: t.spacing['3xl'] }}
            showsVerticalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
            refreshControl={
              onRefresh ? <RefreshControl refreshing={Boolean(refreshing)} onRefresh={onRefresh} tintColor={c.primary} /> : undefined
            }
          >
            <View
              style={[
                styles.contentWrap,
                { gap: layout.gap },
                contentWidth === 'reading' && layout.readingWidth > 0 ? { maxWidth: layout.readingWidth } : null,
              ]}
            >
              {!showSidebar ? (
                <NavScroller
                  items={items}
                  routeName={routeName}
                  onNav={navigate}
                  onSignOut={handleSignOut}
                />
              ) : null}
              {children}
              {footer ?? <DefaultFooter session={session} />}
            </View>
          </ScrollView>
          {bottomBar}
        </View>
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
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Refresh"
            onPress={onRefresh}
            style={styles.iconButton}
            hitSlop={8}
          >
            <Icon name="refresh" size="sm" tone="secondary" />
          </Pressable>
        ) : null}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Settings"
          onPress={handleSettings}
          style={styles.iconButton}
          hitSlop={8}
        >
          <Icon name="settings" size="sm" tone="secondary" />
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
  items,
  routeName,
  width,
  onNav,
  onSignOut,
}: {
  items: NavSpec[];
  routeName: string;
  width: number;
  onNav: (item: NavSpec) => void;
  onSignOut: () => void;
}): React.JSX.Element {
  return (
    <View style={[styles.sidebar, { width }]}>
      <View style={styles.sidebarNav}>
        {items.map((item) => {
          const isActive = isNavItemActive(item, routeName);
          const soon = isNavItemSoon(item);
          return (
            <Pressable
              key={item.key}
              accessibilityRole="button"
              accessibilityState={{ selected: isActive, disabled: soon }}
              disabled={soon || isActive}
              onPress={() => onNav(item)}
              style={[styles.navItem, isActive && styles.navItemActive, soon && styles.navItemSoon]}
            >
              <Icon name={item.icon} size="sm" tone="inherit" color={isActive ? c.sidebarActiveText : c.sidebarText} />
              <Text style={[styles.navLabel, isActive && styles.navLabelActive]} numberOfLines={1}>
                {item.label}
              </Text>
              {soon ? <Text style={styles.sidebarSoonTag}>Soon</Text> : null}
            </Pressable>
          );
        })}
      </View>

      <Pressable accessibilityRole="button" onPress={onSignOut} style={styles.signOut}>
        <Icon name="signOut" size="sm" tone="inherit" color={c.sidebarText} />
        <Text style={styles.signOutLabel}>Sign Out</Text>
      </Pressable>
    </View>
  );
}

function NavScroller({
  items,
  routeName,
  onNav,
  onSignOut,
}: {
  items: NavSpec[];
  routeName: string;
  onNav: (item: NavSpec) => void;
  onSignOut: () => void;
}): React.JSX.Element {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.navScroller}
      style={styles.navScrollerWrap}
      accessibilityRole="tablist"
    >
      {items.map((item) => {
        const isActive = isNavItemActive(item, routeName);
        const soon = isNavItemSoon(item);
        return (
          <Pressable
            key={item.key}
            accessibilityRole="button"
            accessibilityState={{ selected: isActive, disabled: soon }}
            disabled={soon || isActive}
            onPress={() => onNav(item)}
            style={[styles.navChip, isActive && styles.navChipActive, soon && styles.navItemSoon]}
          >
            <Icon name={item.icon} size="sm" tone="inherit" color={isActive ? c.sidebarActiveText : c.textSecondary} />
            <Text style={[styles.navChipLabel, isActive && styles.navLabelActive]}>{item.label}</Text>
            {soon ? <Text style={styles.soonTag}>Soon</Text> : null}
          </Pressable>
        );
      })}
      <Pressable accessibilityRole="button" onPress={onSignOut} style={styles.navChip}>
        <Icon name="signOut" size="sm" tone="inherit" color={c.textSecondary} />
        <Text style={styles.navChipLabel}>Sign Out</Text>
      </Pressable>
    </ScrollView>
  );
}

function DefaultFooter({ session }: { session?: PinUnlockResponse }): React.JSX.Element | null {
  // UNKNOWN IS NOT ENDED. This used to print "SESSION ENDED" whenever `session`
  // was undefined, which includes every screen's initial load — so a spinner
  // came with a footer announcing the session was over. Say nothing until we
  // know.
  if (!session) return null;
  return (
    <View style={styles.footer}>
      <Text style={styles.footerTextStrong}>
        {session.status === 'active' ? 'SYSTEM LIVE' : 'SESSION ENDED'}
      </Text>
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
  // Holds the ScrollView and the pinned bottomBar as siblings.
  mainArea: { flex: 1 },
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
