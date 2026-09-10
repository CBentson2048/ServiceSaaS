import type { Ionicons } from '@expo/vector-icons';
import type { AuthUser, Permission } from '@sheer/domain';
import { userHasPermission, userHasRole } from '@sheer/domain';

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
export const STYLIST_TABS: AppTab[] = [
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
  //
  // THIS IS THE SIXTH TAB, and Apple's guidance is five. On a 390pt screen six
  // tabs leave ~65pt each, which the redesigned bar fits but does not flatter —
  // "Schedule" is the label that gets closest to its neighbour. Deleting this
  // entry moves ZAC out of the bar and the other five breathe; the cost is
  // discoverability. (ZAC does have two other entry points, but only for roles
  // that have no tab bar at all: the owner and manager dashboards each push
  // /zac from a QuickAction — app/dashboard.tsx — and that is their ONLY route
  // in, since resolveTabsFor returns null for both. So for a STYLIST this tab
  // really is the only way to ZAC.) Left in deliberately — removing a feature's
  // only route is a product call, not a layout one.
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
export const CLIENT_TABS: AppTab[] = [
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
export const TAB_BAR_ROUTES: ReadonlySet<string> = new Set([
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
  // Owners and managers get NO bottom navigation — they had none before this
  // was centralised either, and their home is the web dashboard. Worth stating
  // now that it is one rule rather than scattered per-screen gates: a
  // manager-only actor is authorised on /notifications, /bookings, /rota, /zac,
  // /my-pay and /pay-summary (see each screen's ProtectedScreen) but has no
  // in-app route to them. That is pre-existing and unchanged here; giving
  // managers a tab set is a product decision, not a layout one.
  if (user.primaryRole === 'client') return CLIENT_TABS;
  return null;
}

/**
 * True when `pathname` is a route that carries the shared bottom bar.
 *
 * Exact match, so it needs a QUERY-FREE pathname. `/pay-summary` is only ever
 * navigated to as `/pay-summary?id=…`, and this returns true for it only
 * because `usePathname()` strips the query. AppTabBar must therefore keep using
 * `usePathname()` — switching it to a params-carrying href would silently drop
 * the bar on that screen. Pinned in tabs.spec.ts.
 */
export function isTabBarRoute(pathname: string): boolean {
  return TAB_BAR_ROUTES.has(pathname);
}

/**
 * THE pure core of the shared bottom navigation: the tabs to render on
 * `pathname` for `user`, or `null` when this route/role combination carries no
 * bar at all.
 *
 * `useAppTabs` (src/navigation/useAppTabs.ts) is a three-line wrapper that
 * feeds this the live pathname and the signed-in actor. The split exists so
 * this — every rule the bottom navigation obeys — is testable: the hook itself
 * cannot be, because this module previously imported `usePathname` from
 * expo-router, which drags untransformed JSX out of node_modules and makes the
 * module unloadable in a Node test process.
 *
 * NOTE what is deliberately NOT checked here: whether any tab in the returned
 * set actually matches `pathname`. `/my-pay`, `/pay-summary` and `/new-booking`
 * are pushed screens that keep the bar without being a tab destination, so "no
 * tab matches" is a legitimate state, not an error.
 */
export function resolveTabsForRoute(
  pathname: string,
  user: AuthUser | null | undefined,
): AppTab[] | null {
  if (!isTabBarRoute(pathname)) return null;
  const tabs = resolveTabsFor(user);
  return tabs && tabs.length > 0 ? tabs : null;
}

/**
 * True when `tab` is the selected tab on `pathname`. Exact-match by design:
 * every tab href is a distinct top-level route, and a prefix match would light
 * two pills at once (`/client/visits` starts with nothing else, but a future
 * `/profile/settings` would wrongly light Profile AND itself).
 */
export function isTabActive(pathname: string, tab: AppTab): boolean {
  return pathname === tab.href;
}
