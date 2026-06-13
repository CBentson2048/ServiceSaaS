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
import { logoutLabSession } from '../../features/sheer-lab/labSession';
import { labLightTheme } from '../../theme/labTheme';

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
type DirectRoute = 'Home' | 'NewMix' | 'FormulaHistory';

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
  { key: 'inventory', label: 'Inventory', glyph: '📦' },
  { key: 'billing', label: 'Billing Rules', glyph: '🧾' },
  { key: 'audit', label: 'Audit Trail', glyph: '🛡️' },
];

// ---------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------

export interface LabShellProps {
  active: NavKey;
  session?: PinUnlockResponse;
  bleConnected: boolean;
  refreshing?: boolean;
  onRefresh?: () => void;
  footer?: React.ReactNode;
  children: React.ReactNode;
}

export function LabShell({
  active,
  session,
  bleConnected,
  refreshing,
  onRefresh,
  footer,
  children,
}: LabShellProps): React.JSX.Element {
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const layout = useLabLayout();
  const showSidebar = layout.mode !== 'phone';

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
      <StatusBar barStyle="dark-content" backgroundColor={c.background} />
      <TopBar
        session={session}
        bleConnected={bleConnected}
        onRefresh={onRefresh}
        onSettings={() => navigation.navigate('Settings')}
      />

      <View style={[styles.body, showSidebar ? styles.bodyRow : styles.bodyColumn]}>
        {showSidebar ? (
          <Sidebar active={active} width={layout.sidebarWidth} onNav={navigate} onSignOut={handleSignOut} />
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
            {!showSidebar ? <NavScroller active={active} onNav={navigate} onSignOut={handleSignOut} /> : null}
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

function TopBar({
  session,
  bleConnected,
  onRefresh,
  onSettings,
}: {
  session?: PinUnlockResponse;
  bleConnected: boolean;
  onRefresh?: () => void;
  onSettings: () => void;
}): React.JSX.Element {
  const online = session?.status === 'active';
  return (
    <View style={styles.topBar}>
      <View style={styles.brandRow}>
        <View style={styles.brandMark}>
          <Text style={styles.brandMarkText}>Q</Text>
        </View>
        <Text style={styles.brandText}>QLOOQO LAB</Text>
        <Pill label={online ? 'Connected' : 'Offline'} tone={online ? 'success' : 'neutral'} subtle />
      </View>

      <View style={styles.topActions}>
        <Pill label={bleConnected ? 'Scale linked' : 'Scale off'} tone={bleConnected ? 'success' : 'neutral'} subtle />
        {onRefresh ? (
          <Pressable accessibilityRole="button" onPress={onRefresh} style={styles.iconButton} hitSlop={8}>
            <Text style={styles.iconButtonGlyph}>⟳</Text>
          </Pressable>
        ) : null}
        <Pressable accessibilityRole="button" onPress={onSettings} style={styles.iconButton} hitSlop={8}>
          <Text style={styles.iconButtonGlyph}>⚙︎</Text>
        </Pressable>
        {session ? (
          <View style={styles.userRow}>
            <View style={styles.avatar}>
              <Text style={styles.avatarText}>{initials(session.displayName)}</Text>
            </View>
            <View>
              <Text style={styles.userName} numberOfLines={1}>
                {session.displayName}
              </Text>
              <Text style={styles.userRole}>{roleLabel(session.role)}</Text>
            </View>
          </View>
        ) : null}
      </View>
    </View>
  );
}

function Sidebar({
  active,
  width,
  onNav,
  onSignOut,
}: {
  active: NavKey;
  width: number;
  onNav: (item: NavSpec) => void;
  onSignOut: () => void;
}): React.JSX.Element {
  return (
    <View style={[styles.sidebar, { width }]}>
      <View style={styles.sidebarNav}>
        {NAV_ITEMS.map((item) => {
          const isActive = item.key === active;
          const soon = !item.route;
          return (
            <Pressable
              key={item.key}
              accessibilityRole="button"
              disabled={soon || isActive}
              onPress={() => onNav(item)}
              style={[styles.navItem, isActive && styles.navItemActive, soon && styles.navItemSoon]}
            >
              <Text style={styles.navGlyph}>{item.glyph}</Text>
              <Text style={[styles.navLabel, isActive && styles.navLabelActive]} numberOfLines={1}>
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
  active,
  onNav,
  onSignOut,
}: {
  active: NavKey;
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
      {NAV_ITEMS.map((item) => {
        const isActive = item.key === active;
        const soon = !item.route;
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

  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: t.spacing.base,
    paddingVertical: t.spacing.md,
    backgroundColor: c.surface,
    borderBottomWidth: 1,
    borderBottomColor: c.border,
    flexWrap: 'wrap',
    gap: t.spacing.sm,
  },
  brandRow: { flexDirection: 'row', alignItems: 'center', gap: t.spacing.sm },
  brandMark: {
    width: 30,
    height: 30,
    borderRadius: t.radius.sm,
    backgroundColor: c.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  brandMarkText: { color: c.textOnPrimary, fontSize: 16, fontWeight: '700' },
  brandText: { color: c.textPrimary, fontSize: t.typography.fontSize.subtitle, fontWeight: '700', letterSpacing: 1 },
  topActions: { flexDirection: 'row', alignItems: 'center', gap: t.spacing.sm, flexWrap: 'wrap' },
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
    backgroundColor: c.surface,
    borderRightWidth: 1,
    borderRightColor: c.border,
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
  navItemActive: { backgroundColor: c.primarySoft },
  navItemSoon: { opacity: 0.55 },
  navGlyph: { fontSize: 16 },
  navLabel: { flex: 1, color: c.textSecondary, fontSize: t.typography.fontSize.small, fontWeight: '600' },
  navLabelActive: { color: c.primary },
  soonTag: { color: c.textMuted, fontSize: t.typography.fontSize.micro, fontWeight: '600' },
  signOut: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: t.spacing.md,
    paddingVertical: t.spacing.md,
    paddingHorizontal: t.spacing.md,
    borderRadius: t.radius.card,
    borderWidth: 1,
    borderColor: c.border,
  },
  signOutGlyph: { fontSize: 16, color: c.dangerText },
  signOutLabel: { color: c.textPrimary, fontWeight: '600', fontSize: t.typography.fontSize.small },

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
