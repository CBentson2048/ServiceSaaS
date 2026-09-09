import type { Ionicons } from '@expo/vector-icons';
import { usePathname } from 'expo-router';
import type { AuthUser, Permission } from '@sheer/domain';
import { userHasPermission, userHasRole } from '@sheer/domain';
import { useAuth } from '../auth/AuthProvider';

type IoniconName = React.ComponentProps<typeof Ionicons>['name'];

export interface AppTab {
  key: string;
  label: string;
  href: string;
  icon: IoniconName;
  activeIcon: IoniconName;
  /** Tab is shown only when the actor holds this permission. */
  permission?: Permission;
}

/**
 * THE navigation registry.
 *
 * Two roles have genuinely different primary navigation, so there are two tab
 * sets — but ONE component renders them (`AppTabBar`) and ONE list decides
 * where each appears. Before this file the stylist bar lived in
 * `StylistTabBar` while the client bar was a private `TabBarItem` inside
 * `dashboard.tsx`, built from text glyphs rather than icons, with its own
 * active-state logic that never resynced with the route.
 */

/**
 * The stylist's primary navigation. Mirrors the old dashboard quick actions as
 * a persistent bottom bar so a stylist never returns to a separate dashboard —
 * they are redirected off `/dashboard` to `/performance` entirely.
 */
const STYLIST_TABS: AppTab[] = [
  { key: 'home', label: 'Home', href: '/performance', icon: 'home-outline', activeIcon: 'home' },
  {
    key: 'schedule',
    label: 'Schedule',
    href: '/bookings',
    icon: 'calendar-outline',
    activeIcon: 'calendar',
  },
  { key: 'rota', label: 'Rota', href: '/rota', icon: 'time-outline', activeIcon: 'time' },
  // Arrival alerts (Wrike 4507284172) live here rather than behind a bell in a
  // header: this app has no persistent header, and a tab carrying a badge is
  // the only surface a stylist sees from every screen.
  {
    key: 'alerts',
    label: 'Alerts',
    href: '/notifications',
    icon: 'notifications-outline',
    activeIcon: 'notifications',
  },
  {
    key: 'profile',
    label: 'Profile',
    href: '/profile',
    icon: 'person-outline',
    activeIcon: 'person',
  },
  // Every staff role holds zac.access by default since ZAC went generally
  // available, so most stylists see this; an owner can withdraw it per
  // security level.
  {
    key: 'zac',
    label: 'ZAC',
    href: '/zac',
    icon: 'sparkles-outline',
    activeIcon: 'sparkles',
    permission: 'zac.access',
  },
];

/**
 * The client's primary navigation. Previously hand-built inside
 * `dashboard.tsx` with the glyphs "⊞ ◷ ◉" and a local `activeTab` state that
 * stayed on "Home" after pushing to Profile — so the bar lied about where the
 * client was. Driving it from the route fixes that by construction.
 */
const CLIENT_TABS: AppTab[] = [
  { key: 'home', label: 'Home', href: '/dashboard', icon: 'grid-outline', activeIcon: 'grid' },
  {
    key: 'visits',
    label: 'Visits',
    href: '/client/visits',
    icon: 'time-outline',
    activeIcon: 'time',
  },
  {
    key: 'profile',
    label: 'Profile',
    href: '/profile',
    icon: 'person-outline',
    activeIcon: 'person',
  },
];

/**
 * Routes that carry a tab bar. A route absent from this set gets none — that
 * is how the booking flow, the auth screens and the pushed detail screens
 * (`/manage-appointment`, `/reschedule`, `/salon-detail`,
 * `/client/visit-detail`) stay full-bleed.
 *
 * `/my-pay` and `/pay-summary` are IN the set deliberately. They are pushed
 * from Profile and previously rendered no bar at all, which left a stylist on
 * a dead-end screen with only the back gesture out. Keeping the bar on a
 * pushed screen is standard native tab behaviour.
 */
const TAB_BAR_ROUTES: ReadonlySet<string> = new Set([
  '/performance',
  '/bookings',
  '/rota',
  '/notifications',
  '/profile',
  '/zac',
  '/my-pay',
  '/pay-summary',
  '/new-booking',
  '/dashboard',
  '/client/visits',
]);

/** The tab set for an actor, or `null` when their role has no tab navigation. */
export function resolveTabsFor(user: AuthUser | null | undefined): AppTab[] | null {
  if (!user) return null;
  if (userHasRole(user, 'stylist')) {
    return STYLIST_TABS.filter((tab) => !tab.permission || userHasPermission(user, tab.permission));
  }
  // Owners and managers reach this app's screens directly and have no bottom
  // navigation of their own — they had none before either. Their home is the
  // web dashboard.
  if (user.primaryRole === 'client') return CLIENT_TABS;
  return null;
}

/**
 * The tabs to render on the CURRENT route, or `null` for none.
 *
 * Screens call `<AppTabBar />` unconditionally and this decides. Before, each
 * screen carried its own gate — `showStylistTabs`, `showTabs` and `isStylist`
 * were three names for `userHasRole(user, 'stylist')` copied into six files,
 * while `/performance` and `/notifications` rendered the STYLIST bar with no
 * role check at all, showing it to clients.
 */
export function useAppTabs(): AppTab[] | null {
  const pathname = usePathname();
  const { user } = useAuth();
  if (!TAB_BAR_ROUTES.has(pathname)) return null;
  const tabs = resolveTabsFor(user);
  return tabs && tabs.length > 0 ? tabs : null;
}
