import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { router, usePathname } from 'expo-router';
import { radius, spacing } from '@sheer/design-tokens';
import { BORDER, BRAND, BRAND_LIGHT, CARD, TEXT_SUBTLE } from '../design/colors';
import { useNotifications } from '../notifications/NotificationsProvider';
import { isTabActive } from './tabs';
import { useAppTabs } from './useAppTabs';

/** Brand tint behind the active tab's icon. */
const ACTIVE_PILL = 'rgba(166,124,245,0.18)';

/**
 * THE bottom navigation. One implementation, one mount, every role.
 *
 * MOUNTED ONCE, BY THE APP SHELL — app/_layout.tsx, inside AuthProvider and
 * NotificationsProvider. A screen must never render or import this: it is a
 * flex sibling of <Stack>, so a second copy inside a screen would stack two
 * bars. `app-shell.spec.ts` enforces both halves of that (exactly one render
 * site, and no screen importing it).
 *
 * Returns null when the current route/role carries no bar, which is what keeps
 * the auth screens, the booking flow and the pushed detail screens full-bleed
 * without the shell needing to know anything about routes. All of that is
 * decided in tabs.ts and is unit-tested there; this file only draws.
 *
 * ACTIVE STATE. The selected tab's icon sits in a filled pill. Before, active
 * was signalled by colour alone — a purple icon among grey ones — which is the
 * one cue a colour-blind user cannot rely on and which reads weakly at 22px on
 * a dark ground. The pill gives it a second, non-colour cue; the label still
 * changes colour and weight as well.
 */
export function AppTabBar() {
  const pathname = usePathname();
  const tabs = useAppTabs();
  const { unreadCount } = useNotifications();

  if (!tabs) return null;

  return (
    <SafeAreaView edges={['bottom']} style={s.safe}>
      <View style={s.bar} accessibilityRole="tablist">
        {tabs.map((tab) => {
          const active = isTabActive(pathname, tab);
          const badged = tab.key === 'alerts' && unreadCount > 0;
          return (
            <Pressable
              key={tab.key}
              accessibilityRole="tab"
              accessibilityState={{ selected: active }}
              accessibilityLabel={badged ? `${tab.label}, ${unreadCount} unread` : tab.label}
              // Tabs replace the current route so the stack stays flat — there
              // is no "back" between top-level tabs, matching native tab UX.
              onPress={() => {
                if (!active) router.replace(tab.href);
              }}
              style={({ pressed }) => [s.item, pressed && s.pressed]}
            >
              <View style={[s.iconWrap, active && s.iconWrapActive]}>
                <Ionicons
                  name={active ? tab.activeIcon : tab.icon}
                  size={21}
                  color={active ? BRAND_LIGHT : TEXT_SUBTLE}
                />
                {badged ? (
                  // Hidden from the accessibility tree because the count is
                  // already in the tab's accessibilityLabel above; announcing
                  // it twice is worse than not announcing it.
                  <View style={s.badge} accessibilityElementsHidden>
                    <Text style={s.badgeText}>{unreadCount > 9 ? '9+' : unreadCount}</Text>
                  </View>
                ) : null}
              </View>
              <Text style={[s.label, active && s.labelActive]} numberOfLines={1}>
                {tab.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  safe: { backgroundColor: CARD },
  bar: {
    flexDirection: 'row',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: BORDER,
    backgroundColor: CARD,
    paddingTop: spacing.sm,
    paddingBottom: spacing.xs,
    paddingHorizontal: spacing.xs,
  },
  item: {
    flex: 1,
    alignItems: 'center',
    gap: 3,
    // A 44pt-tall target, which is Apple's minimum and what the old 8px-padded
    // row fell short of.
    minHeight: 44,
    justifyContent: 'center',
  },
  pressed: { opacity: 0.6 },
  iconWrap: {
    paddingHorizontal: spacing.md,
    paddingVertical: 3,
    borderRadius: radius.pill,
  },
  iconWrapActive: { backgroundColor: ACTIVE_PILL },
  label: {
    fontSize: 11,
    fontWeight: '600',
    color: TEXT_SUBTLE,
    letterSpacing: 0.2,
  },
  labelActive: { color: BRAND_LIGHT, fontWeight: '700' },
  badge: {
    position: 'absolute',
    top: -4,
    right: 4,
    minWidth: 16,
    height: 16,
    paddingHorizontal: 4,
    borderRadius: 8,
    backgroundColor: BRAND,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: { color: '#FFFFFF', fontSize: 10, fontWeight: '800' },
});
