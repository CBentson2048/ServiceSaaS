/**
 * The station navigation has ONE definition, and it cannot disagree with itself.
 *
 * The destination list used to exist in seven near-identical copies — LabShell
 * plus a private one inside each of the six screens that had forked the shell.
 * Every rule these tests pin is one those copies got wrong in at least one
 * place: which item is highlighted, whether Inventory is reachable, and whether
 * a hidden destination is hidden consistently.
 */

import { featureFlags } from '../config/featureFlags';
import {
  NAV_ITEMS,
  canManageOps,
  isNavItemActive,
  isNavItemSoon,
  navKeyForRoute,
  visibleNavItems,
  type NavKey,
} from './labNav';

const OWNER = { canManageOps: true };
const STYLIST = { canManageOps: false };

const keys = (items: { key: NavKey }[]) => items.map((item) => item.key);

describe('the destination list', () => {
  it('has one entry per station, in a stable order', () => {
    expect(keys([...NAV_ITEMS])).toEqual([
      'dashboard',
      'new-mix',
      'history',
      'inventory',
      'billing',
      'audit',
    ]);
  });

  it('gives every reachable destination a route', () => {
    // A destination without a route renders as "Soon". Only Audit Trail is.
    const routeless = NAV_ITEMS.filter((item) => item.route === undefined).map((item) => item.key);
    expect(routeless).toEqual(['audit']);
  });

  it('has no duplicate keys or labels', () => {
    expect(new Set(NAV_ITEMS.map((i) => i.key)).size).toBe(NAV_ITEMS.length);
    expect(new Set(NAV_ITEMS.map((i) => i.label)).size).toBe(NAV_ITEMS.length);
  });
});

describe('active state is derived from the route', () => {
  it('maps every station route to its own key', () => {
    expect(navKeyForRoute('Home')).toBe('dashboard');
    expect(navKeyForRoute('NewMix')).toBe('new-mix');
    expect(navKeyForRoute('FormulaHistory')).toBe('history');
    expect(navKeyForRoute('Inventory')).toBe('inventory');
    expect(navKeyForRoute('BillingRules')).toBe('billing');
  });

  it('maps the whole formula flow to the New Mix station', () => {
    // THE BUG THIS FIXES. Each fork computed active as `target.kind ===
    // 'current'` and only Home ever declared a 'current' item, so on these four
    // screens no nav item was highlighted at all.
    for (const route of ['BuildFormula', 'UpdateFormula', 'Formula', 'MixFinalized']) {
      expect(navKeyForRoute(route)).toBe('new-mix');
    }
  });

  it('leaves the LabScreen routes without a station', () => {
    // Auth, Settings and the Device* screens render in LabScreen, which has no
    // station nav. A key here would highlight a nav that is not on screen.
    for (const route of ['Auth', 'Settings', 'DeviceResolving', 'DeviceRegistration', 'DeviceBlocked', 'DevicePairing']) {
      expect(navKeyForRoute(route)).toBeUndefined();
    }
  });

  it('returns undefined for an unknown route rather than guessing', () => {
    expect(navKeyForRoute('NotARoute')).toBeUndefined();
    expect(navKeyForRoute('')).toBeUndefined();
  });

  it('marks exactly one item active for any station route', () => {
    for (const route of ['Home', 'NewMix', 'Formula', 'FormulaHistory', 'Inventory']) {
      const active = NAV_ITEMS.filter((item) => isNavItemActive(item, route));
      expect({ route, activeCount: active.length }).toEqual({ route, activeCount: 1 });
    }
  });

  it('marks nothing active on a screen with no station', () => {
    const active = NAV_ITEMS.filter((item) => isNavItemActive(item, 'Settings'));
    expect(active).toEqual([]);
  });
});

describe('visibility is decided in one place', () => {
  it('hides a destination the viewer cannot use, rather than teasing them with it', () => {
    // The rule: hidden, not shown-and-disabled. Inventory is owner/manager only.
    expect(keys(visibleNavItems(STYLIST))).not.toContain('inventory');
    expect(keys(visibleNavItems(OWNER))).toContain('inventory');
  });

  it('gives a stylist exactly the stations they can use', () => {
    // Concrete list, not a count: a count passes even if the wrong item drops.
    expect(keys(visibleNavItems(STYLIST))).toEqual(['dashboard', 'new-mix', 'history']);
  });

  it('gives an owner or manager the operations stations too', () => {
    const expected: NavKey[] = ['dashboard', 'new-mix', 'history', 'inventory'];
    // Billing is managed AND flagged; it only appears when the flag is on.
    if (featureFlags.billingRules) expected.push('billing');
    if (featureFlags.auditTrail) expected.push('audit');
    expect(keys(visibleNavItems(OWNER))).toEqual(expected);
  });

  it('respects the build-time flags for every role', () => {
    for (const viewer of [OWNER, STYLIST]) {
      const visible = keys(visibleNavItems(viewer));
      expect(visible.includes('billing')).toBe(featureFlags.billingRules && viewer.canManageOps);
      expect(visible.includes('audit')).toBe(featureFlags.auditTrail);
    }
  });

  it('never returns a destination that is both visible and unreachable-by-role', () => {
    // The old code filtered on `inventory` only while its isManagedNav covered
    // inventory AND billing, so the two never agreed about billing.
    for (const item of visibleNavItems(STYLIST)) {
      expect(item.managed).not.toBe(true);
    }
  });

  it('returns a fresh array so a caller cannot mutate the source list', () => {
    const first = visibleNavItems(OWNER);
    first.pop();
    expect(keys(visibleNavItems(OWNER))).toEqual(keys(visibleNavItems(OWNER)));
    expect(visibleNavItems(OWNER).length).toBeGreaterThan(first.length);
  });
});

describe('the Soon affordance means one thing', () => {
  it('is exactly "this destination has no route yet"', () => {
    const soon = NAV_ITEMS.filter(isNavItemSoon).map((item) => item.key);
    expect(soon).toEqual(['audit']);
  });

  it('is never true for a destination that has a route', () => {
    for (const item of NAV_ITEMS.filter((i) => i.route !== undefined)) {
      expect(isNavItemSoon(item)).toBe(false);
    }
  });
});

describe('canManageOps', () => {
  it('admits owners and managers only', () => {
    expect(canManageOps('owner')).toBe(true);
    expect(canManageOps('manager')).toBe(true);
    expect(canManageOps('stylist')).toBe(false);
  });

  it('refuses an absent or unrecognised role', () => {
    expect(canManageOps(undefined)).toBe(false);
    expect(canManageOps('')).toBe(false);
    expect(canManageOps('admin')).toBe(false);
  });
});
