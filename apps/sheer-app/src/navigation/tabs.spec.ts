/**
 * THE shared bottom navigation's rules.
 *
 * Every assertion the navigation refactor's ticket asks for that can be proven
 * without a renderer is proven here, against the pure module the bar reads
 * from. `AppTabBar.tsx` contributes only JSX: it maps over `useAppTabs()` and
 * calls `isTabActive` for the selected pill, both of which are exercised below.
 *
 * WHAT THIS DELIBERATELY DOES NOT COVER, because it cannot on this machine
 * (no jest-expo / react-test-renderer / @testing-library/react-native, and
 * `pnpm install` fails non-interactively): the rendered output — the purple
 * active pill, the icon swap, the badge bubble, safe-area insets, real
 * `router.replace` behaviour, and that the bar is physically painted once.
 * Those are manual UAT. `app-shell.spec.ts` covers single-render structurally.
 */

import type { AuthUser, Permission, UserRole } from '@sheer/domain';
import type { AppTab } from './tabs';
import {
  CLIENT_TABS,
  STYLIST_TABS,
  TAB_BAR_ROUTES,
  isTabActive,
  isTabBarRoute,
  resolveTabsFor,
  resolveTabsForRoute,
} from './tabs';

/**
 * Local, on purpose: production computes the selected tab with `isTabActive`
 * (AppTabBar.tsx), so the spec must go through the same function rather than a
 * parallel exported helper that only tests use.
 */
function activeKey(pathname: string, tabs: readonly AppTab[]): string | null {
  const match = tabs.find((tab) => isTabActive(pathname, tab));
  return match ? match.key : null;
}

// ── Actors ────────────────────────────────────────────────────────────────────

function actor(roles: UserRole[], permissions: Permission[] = []): AuthUser {
  const [primaryRole] = roles;
  return {
    id: 'u1',
    roles,
    primaryRole,
    businessId: 'b1',
    allowedLocationIds: [],
    locations: [],
    permissions,
    profile: { id: 'p1', email: 'a@b.c', fullName: 'Test Actor' },
  } as unknown as AuthUser;
}

const stylist = actor(['stylist'], ['zac.access']);
const stylistNoZac = actor(['stylist'], []);
const client = actor(['client']);
const owner = actor(['owner']);
const manager = actor(['manager']);

/**
 * Labels of a resolved tab set. THROWS on null rather than returning [] —
 * otherwise a bar that is dead for every role satisfies any equality between
 * two of these calls, and the strongest-sounding tests in this file become
 * vacuous. (Verified: with resolveTabsFor stubbed to null, the `[]`-returning
 * version left several tests passing having asserted nothing.)
 */
function labels(tabs: { label: string }[] | null): string[] {
  if (tabs === null) throw new Error('expected a resolved tab set, got null');
  return tabs.map((t) => t.label);
}

// ── 1. The registry: items, order, destinations ───────────────────────────────

describe('navigation registry', () => {
  it('gives a stylist the six destinations in the accepted order', () => {
    expect(labels(resolveTabsFor(stylist))).toEqual([
      'Home',
      'Schedule',
      'Rota',
      'Alerts',
      'Profile',
      'ZAC',
    ]);
  });

  it('gives a client the three destinations in the accepted order', () => {
    expect(labels(resolveTabsFor(client))).toEqual(['Home', 'Visits', 'Profile']);
  });

  it('routes each stylist tab to its accepted destination', () => {
    expect(resolveTabsFor(stylist)?.map((t) => [t.key, t.href])).toEqual([
      ['home', '/performance'],
      ['schedule', '/bookings'],
      ['rota', '/rota'],
      ['alerts', '/notifications'],
      ['profile', '/profile'],
      ['zac', '/zac'],
    ]);
  });

  it('routes each client tab to its accepted destination', () => {
    expect(resolveTabsFor(client)?.map((t) => [t.key, t.href])).toEqual([
      ['home', '/dashboard'],
      ['visits', '/client/visits'],
      ['profile', '/profile'],
    ]);
  });

  it('gives every tab a distinct key and a distinct destination', () => {
    for (const set of [STYLIST_TABS, CLIENT_TABS]) {
      expect(new Set(set.map((t) => t.key)).size).toBe(set.length);
      expect(new Set(set.map((t) => t.href)).size).toBe(set.length);
    }
  });

  it('gives every tab both an inactive and an active icon', () => {
    for (const tab of [...STYLIST_TABS, ...CLIENT_TABS]) {
      expect(tab.icon.length).toBeGreaterThan(0);
      expect(tab.activeIcon.length).toBeGreaterThan(0);
    }
  });
});

// ── 2. Role and permission visibility, decided centrally ──────────────────────

describe('role and permission visibility', () => {
  it('hides the ZAC tab from a stylist without zac.access', () => {
    expect(labels(resolveTabsFor(stylistNoZac))).toEqual([
      'Home',
      'Schedule',
      'Rota',
      'Alerts',
      'Profile',
    ]);
  });

  it('keeps every non-permissioned tab for a stylist without zac.access', () => {
    // Losing zac.access must remove exactly one tab, never reorder the rest.
    const withZac = labels(resolveTabsFor(stylist));
    const withoutZac = labels(resolveTabsFor(stylistNoZac));
    expect(withoutZac).toEqual(withZac.filter((l) => l !== 'ZAC'));
  });

  it('gives owners and managers no bottom navigation at all', () => {
    // They reach these screens directly; their home is the web dashboard.
    expect(resolveTabsFor(owner)).toBeNull();
    expect(resolveTabsFor(manager)).toBeNull();
  });

  it('gives a signed-out actor no bottom navigation', () => {
    expect(resolveTabsFor(null)).toBeNull();
    expect(resolveTabsFor(undefined)).toBeNull();
  });

  it('gives an owner-primary actor who is also a stylist the stylist set', () => {
    // The REACHABLE multi-role shape. primaryRole is always roles[0] after a
    // priority sort (owner < manager < stylist < client, see ROLE_PRIORITY), so
    // a client-primary stylist cannot exist — but an owner- or manager-primary
    // stylist can, and resolveTabsFor keys off the roles ARRAY while
    // dashboard.tsx keys off primaryRole. Asserted against the concrete list,
    // not against another resolveTabsFor call, so it cannot pass by both sides
    // being empty.
    expect(labels(resolveTabsFor(actor(['owner', 'stylist'], ['zac.access'])))).toEqual([
      'Home',
      'Schedule',
      'Rota',
      'Alerts',
      'Profile',
      'ZAC',
    ]);
    expect(labels(resolveTabsFor(actor(['manager', 'stylist'])))).toEqual([
      'Home',
      'Schedule',
      'Rota',
      'Alerts',
      'Profile',
    ]);
  });
});

// ── 3. Which routes carry the bar ─────────────────────────────────────────────

describe('tab-bar routes', () => {
  it('carries the bar on every tab destination', () => {
    for (const tab of [...STYLIST_TABS, ...CLIENT_TABS]) {
      expect(isTabBarRoute(tab.href)).toBe(true);
    }
  });

  it('carries the bar on the pushed staff screens that keep it', () => {
    // Deliberate: these are not tab destinations, but leaving them bare left a
    // stylist on a dead end with only the back gesture out.
    for (const route of ['/my-pay', '/pay-summary', '/new-booking']) {
      expect(isTabBarRoute(route)).toBe(true);
    }
  });

  it('carries no bar on the auth screens, the booking flow or pushed details', () => {
    for (const route of [
      '/',
      '/login',
      '/signup',
      '/booking/location',
      '/booking/services',
      '/booking/date-time',
      '/booking/review',
      '/booking/success',
      '/salon-detail',
      '/manage-appointment',
      '/reschedule',
      '/client/visit-detail',
    ]) {
      expect(isTabBarRoute(route)).toBe(false);
    }
  });

  it('exposes no route the registry does not account for', () => {
    const accounted = new Set([
      ...STYLIST_TABS.map((t) => t.href),
      ...CLIENT_TABS.map((t) => t.href),
      '/my-pay',
      '/pay-summary',
      '/new-booking',
    ]);
    expect([...TAB_BAR_ROUTES].filter((r) => !accounted.has(r))).toEqual([]);
  });
});

// ── 4. Active state derives from the route, never from page state ─────────────

describe('route-derived active state', () => {
  const cases: [string, string][] = [
    ['/performance', 'home'],
    ['/bookings', 'schedule'],
    ['/rota', 'rota'],
    ['/notifications', 'alerts'],
    ['/profile', 'profile'],
    ['/zac', 'zac'],
  ];

  it.each(cases)('lights exactly the right stylist tab on %s', (pathname, expectedKey) => {
    const tabs = resolveTabsForRoute(pathname, stylist);
    expect(tabs).not.toBeNull();
    expect(activeKey(pathname, tabs!)).toBe(expectedKey);
    // Exactly one pill, never two.
    expect(tabs!.filter((t) => isTabActive(pathname, t))).toHaveLength(1);
  });

  it.each([
    ['/dashboard', 'home'],
    ['/client/visits', 'visits'],
    ['/profile', 'profile'],
  ])('lights exactly the right client tab on %s', (pathname, expectedKey) => {
    const tabs = resolveTabsForRoute(pathname, client);
    expect(tabs).not.toBeNull();
    expect(activeKey(pathname, tabs!)).toBe(expectedKey);
    expect(tabs!.filter((t) => isTabActive(pathname, t))).toHaveLength(1);
  });

  it('lights no tab on a pushed screen that merely keeps the bar', () => {
    for (const route of ['/my-pay', '/pay-summary', '/new-booking']) {
      const tabs = resolveTabsForRoute(route, stylist);
      expect(tabs).not.toBeNull();
      expect(activeKey(route, tabs!)).toBeNull();
    }
  });

  it('matches a destination exactly, never by prefix', () => {
    const profileTab = STYLIST_TABS.find((t) => t.key === 'profile')!;
    expect(isTabActive('/profile', profileTab)).toBe(true);
    expect(isTabActive('/profile/settings', profileTab)).toBe(false);
  });

  it('resolves the same active tab whichever route the app was entered at', () => {
    // Deep-link entry: active state is a pure function of the pathname, so
    // arriving cold at /rota is indistinguishable from tabbing to it.
    for (const [pathname, expectedKey] of cases) {
      expect(activeKey(pathname, resolveTabsForRoute(pathname, stylist)!)).toBe(
        expectedKey,
      );
    }
  });
});

// ── 5. No bar where there should be none ──────────────────────────────────────

describe('resolveTabsForRoute', () => {
  it('returns null off a tab-bar route even for a signed-in stylist', () => {
    expect(resolveTabsForRoute('/login', stylist)).toBeNull();
    expect(resolveTabsForRoute('/booking/review', stylist)).toBeNull();
    expect(resolveTabsForRoute('/salon-detail', client)).toBeNull();
  });

  it('returns null on a tab-bar route for a role with no navigation', () => {
    expect(resolveTabsForRoute('/zac', owner)).toBeNull();
    expect(resolveTabsForRoute('/my-pay', manager)).toBeNull();
  });

  it('returns null while no actor is resolved, whatever the route', () => {
    for (const route of [...TAB_BAR_ROUTES]) {
      expect(resolveTabsForRoute(route, null)).toBeNull();
    }
  });

  it('never returns an empty array — null is the only "no bar" answer', () => {
    const answers = [...TAB_BAR_ROUTES].flatMap((r) =>
      [stylist, stylistNoZac, client, owner, manager, null].map((u) => resolveTabsForRoute(r, u)),
    );
    const shown = answers.filter((a) => a !== null);
    // Guard the guard: without this the assertion below runs zero times if the
    // bar is dead for everyone, and jest reports a pass.
    expect(shown.length).toBeGreaterThan(0);
    for (const a of shown) expect(a!.length).toBeGreaterThan(0);
  });

  it('needs a query-free pathname — the bar depends on usePathname() stripping params', () => {
    // /pay-summary is only ever pushed as `/pay-summary?id=…` (app/my-pay.tsx).
    // It carries a bar today only because usePathname() drops the query. If
    // AppTabBar ever switched to a params-carrying href, the bar would silently
    // vanish on that screen — this is the tripwire for that.
    expect(isTabBarRoute('/pay-summary')).toBe(true);
    expect(isTabBarRoute('/pay-summary?id=abc')).toBe(false);
  });
});
