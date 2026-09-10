import type { IconName } from '../ui/icons/paths';
import { featureFlags } from '../config/featureFlags';

/**
 * THE Lab station navigation model — destinations, visibility, active state.
 *
 * A pure module with no `react-native` and no `@react-navigation` import, so
 * every rule below is unit-testable in the Node test environment. `LabShell`
 * renders this; nothing else defines it.
 *
 * WHAT THIS REPLACED. The destination list existed in SEVEN near-identical
 * copies — `LabShell.tsx` plus a private one inside each of the six screens
 * that had forked the shell (Home, Formula, FormulaHistory, BuildFormula,
 * UpdateFormula, MixFinalized). They had drifted in ways that were visible to
 * the operator:
 *
 *   - ACTIVE STATE. Each fork computed `active` as `target.kind === 'current'`,
 *     and only Home ever declared a `'current'` item — so on the five
 *     formula-flow screens no nav item was highlighted at all. Active state is
 *     now derived from the route (see `navKeyForRoute`), which is the one thing
 *     a screen cannot get wrong about itself.
 *
 *   - REACHABILITY. The forks hardcoded Inventory as `{ kind: 'soon' }`, so an
 *     owner looking at the weighing console was told Inventory was unavailable,
 *     while the same owner on the Inventory or New Mix screen saw it as a live
 *     destination. One list, one answer.
 *
 *   - GATING SHAPE. `LabShell` filtered the list with
 *     `item.key !== 'inventory' || canManageOps` while its own `isManagedNav`
 *     covered inventory AND billing, so the two never agreed on what billing
 *     should do. `visibleNavItems` is now the single filter.
 *
 * VISIBILITY RULE, stated once. A destination the viewer cannot use is HIDDEN,
 * not shown-and-disabled. That is what the old sidebar and nav scroller
 * actually did for Inventory (both filtered it out), despite a comment claiming
 * stylists "keep the Soon affordance" — the comment was stale. Hiding is also
 * the kinder behaviour: a row that exists only to be refused is noise.
 *
 * The "Soon" affordance therefore now means exactly one thing: a destination
 * with no route yet (Audit Trail).
 */

export type NavKey = 'dashboard' | 'new-mix' | 'history' | 'inventory' | 'billing' | 'audit';

/**
 * Routes the nav can reach. All take `undefined` params, so a bare
 * `navigation.navigate(route)` stays type-safe.
 */
export type NavRoute = 'Home' | 'NewMix' | 'FormulaHistory' | 'Inventory' | 'BillingRules';

export interface NavSpec {
  key: NavKey;
  label: string;
  /**
   * A vector icon from `src/ui/icons`. These were emoji (▦ 🧪 🕘 📦 🧾 🛡️),
   * which on iOS render as full-colour Apple glyphs: they cannot take the
   * rail's tint, share no stroke weight or baseline with each other, change
   * between iOS versions, and VoiceOver announces them as "test tube" rather
   * than the destination. The monochrome ones were worse — `▦` carried no
   * colour at all, so it drew near-black on a near-black rail.
   */
  icon: IconName;
  /** Absent for a destination that does not exist yet; renders as "Soon". */
  route?: NavRoute;
  /** Owner/manager only. Hidden from everyone else. */
  managed?: boolean;
  /** Hidden entirely until this build-time flag is on. */
  flag?: keyof typeof featureFlags;
}

export const NAV_ITEMS: readonly NavSpec[] = [
  { key: 'dashboard', label: 'Dashboard', icon: 'dashboard', route: 'Home' },
  { key: 'new-mix', label: 'New Mix', icon: 'flask', route: 'NewMix' },
  { key: 'history', label: 'History', icon: 'history', route: 'FormulaHistory' },
  { key: 'inventory', label: 'Inventory', icon: 'box', route: 'Inventory', managed: true },
  { key: 'billing', label: 'Billing Rules', icon: 'receipt', route: 'BillingRules', managed: true, flag: 'billingRules' },
  { key: 'audit', label: 'Audit Trail', icon: 'shield', flag: 'auditTrail' },
] as const;

/**
 * Which station each route belongs to. The formula-flow screens all map to
 * `new-mix` because that is the station the operator started from — the flow
 * has no nav entry of its own, and leaving them unmapped is what left five
 * screens with nothing highlighted.
 *
 * Routes absent from this map (Auth, Settings, the Device* screens) render
 * inside `LabScreen`, which has no station nav.
 */
const ROUTE_NAV_KEY: Readonly<Record<string, NavKey>> = {
  Home: 'dashboard',
  NewMix: 'new-mix',
  BuildFormula: 'new-mix',
  UpdateFormula: 'new-mix',
  Formula: 'new-mix',
  MixFinalized: 'new-mix',
  FormulaHistory: 'history',
  Inventory: 'inventory',
  BillingRules: 'billing',
};

/** The station a route belongs to, or undefined for a route with no station nav. */
export function navKeyForRoute(routeName: string): NavKey | undefined {
  return ROUTE_NAV_KEY[routeName];
}

/** True when `item` is the station the given route belongs to. */
export function isNavItemActive(item: NavSpec, routeName: string): boolean {
  return navKeyForRoute(routeName) === item.key;
}

/**
 * The destinations this viewer may see, in order. The ONE visibility filter —
 * both the sidebar rail and the phone chip row render exactly this.
 */
export function visibleNavItems({ canManageOps }: { canManageOps: boolean }): NavSpec[] {
  return NAV_ITEMS.filter((item) => {
    if (item.flag && !featureFlags[item.flag]) return false;
    if (item.managed && !canManageOps) return false;
    return true;
  });
}

/** True for a destination that has no route yet — rendered disabled, tagged "Soon". */
export function isNavItemSoon(item: NavSpec): boolean {
  return item.route === undefined;
}

/** Owner and manager can reach the operations destinations; stylists cannot. */
export function canManageOps(role: string | undefined): boolean {
  return role === 'owner' || role === 'manager';
}
