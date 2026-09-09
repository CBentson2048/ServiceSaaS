import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { router, usePathname } from 'expo-router';
import { radius, spacing } from '@sheer/design-tokens';
import { BORDER, BRAND, BRAND_LIGHT, CARD, TEXT_SUBTLE } from '../design/colors';
import { useNotifications } from '../notifications/NotificationsProvider';
import { useAppTabs } from './tabs';

/**
 * THE bottom navigation. One implementation for every role.
 *
 * Screens render `<AppTabBar />` with NO condition around it: which tabs to
 * show, and whether to show any at all, is decided once in `tabs.ts`. That is
 * the whole point — a screen should not be able to get the answer wrong, and
 * six screens previously did (three different gate expressions, two screens
 * with no gate at all, and four stylist screens that simply forgot the bar).
 *
 * Renders nothing when the current route has no tab navigation, so it is safe
 * to place at the bottom of any screen.
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
          const active = pathname === tab.href;
          const badged = tab.key === 'alerts' && unreadCount > 0;
          return (
            <Pressable
              key={tab.key}
              accessibilityRole="tab"
              accessibilityState={{ selected: active }}
              accessibilityLabel={
                badged ? `${tab.label}, ${unreadCount} unread` : tab.label
              }
              // Tabs replace the current route so the stack stays flat — there
              // is no "back" between top-level tabs, matching native tab UX.
              onPress={() => {
                if (!active) router.replace(tab.href);
              }}
              style={({ pressed }) => [s.item, pressed && s.pressed]}
            >
              <View>
                <Ionicons
                  name={active ? tab.activeIcon : tab.icon}
                  size={22}
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
              <Text style={[s.label, active && s.labelActive]}>{tab.label}</Text>
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
  },
  item: {
    flex: 1,
    alignItems: 'center',
    gap: 4,
    paddingVertical: spacing.xs,
    borderRadius: radius.input,
  },
  pressed: { opacity: 0.6 },
  label: {
    fontSize: 11,
    fontWeight: '700',
    color: TEXT_SUBTLE,
    letterSpacing: 0.3,
  },
  labelActive: { color: BRAND_LIGHT },
  badge: {
    position: 'absolute',
    top: -5,
    right: -9,
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
