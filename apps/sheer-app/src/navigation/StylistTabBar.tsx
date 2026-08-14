import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { router, usePathname } from 'expo-router';
import { userHasPermission } from '@sheer/domain';
import { palette, radius, spacing } from '@sheer/design-tokens';
import { useAuth } from '../auth/AuthProvider';

type IoniconName = React.ComponentProps<typeof Ionicons>['name'];

interface StylistTab {
  key: string;
  label: string;
  href: string;
  icon: IoniconName;
  activeIcon: IoniconName;
}

// The stylist's primary navigation. Mirrors the old dashboard "quick actions"
// (Home/Performance, Schedule/Bookings, Rota, Profile) as a persistent bottom
// tab bar so the stylist never has to return to a separate dashboard.
const TABS: StylistTab[] = [
  { key: 'home', label: 'Home', href: '/performance', icon: 'home-outline', activeIcon: 'home' },
  { key: 'schedule', label: 'Schedule', href: '/bookings', icon: 'calendar-outline', activeIcon: 'calendar' },
  { key: 'rota', label: 'Rota', href: '/rota', icon: 'time-outline', activeIcon: 'time' },
  { key: 'profile', label: 'Profile', href: '/profile', icon: 'person-outline', activeIcon: 'person' },
];

// Shown to stylists holding the zac.access permission. Every staff role holds
// it by default since ZAC went generally available, so most stylists see this
// tab — an owner can still withdraw it per security level.
const ZAC_TAB: StylistTab = {
  key: 'zac',
  label: 'ZAC',
  href: '/zac',
  icon: 'sparkles-outline',
  activeIcon: 'sparkles',
};

export function StylistTabBar() {
  const pathname = usePathname();
  const { user } = useAuth();
  const tabs = userHasPermission(user, 'zac.access') ? [...TABS, ZAC_TAB] : TABS;

  return (
    <SafeAreaView edges={['bottom']} style={s.safe}>
      <View style={s.bar}>
        {tabs.map((tab) => {
          const active = pathname === tab.href;
          return (
            <Pressable
              key={tab.key}
              accessibilityRole="tab"
              accessibilityState={{ selected: active }}
              accessibilityLabel={tab.label}
              // Tabs replace the current route so the stack stays flat — there
              // is no "back" between top-level tabs, matching native tab UX.
              onPress={() => {
                if (!active) router.replace(tab.href);
              }}
              style={({ pressed }) => [s.item, pressed && s.pressed]}
            >
              <Ionicons
                name={active ? tab.activeIcon : tab.icon}
                size={22}
                color={active ? BRAND_LIGHT : INACTIVE}
              />
              <Text style={[s.label, active && s.labelActive]}>{tab.label}</Text>
            </Pressable>
          );
        })}
      </View>
    </SafeAreaView>
  );
}

const CARD = '#211A2E';
const BORDER = 'rgba(255,255,255,0.13)';
const BRAND_LIGHT = palette.brand[300];
const INACTIVE = 'rgba(255,255,255,0.4)';

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
    color: INACTIVE,
    letterSpacing: 0.3,
  },
  labelActive: { color: BRAND_LIGHT },
});
