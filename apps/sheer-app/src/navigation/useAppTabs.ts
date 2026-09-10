import { usePathname } from 'expo-router';
import { useAuth } from '../auth/AuthProvider';
import { resolveTabsForRoute, type AppTab } from './tabs';

/**
 * The tabs to render on the CURRENT route, or `null` for none.
 *
 * A three-line wrapper over `resolveTabsForRoute`. It lives in its OWN module,
 * apart from `tabs.ts`, and `tabs.ts` must never re-export it: importing
 * `expo-router` drags untransformed JSX out of node_modules, which makes any
 * module that touches it unloadable in a Node test process. Keeping the two
 * apart is what lets every rule the bottom navigation obeys be unit-tested
 * (see tabs.spec.ts) even though the bar itself cannot be rendered in a test
 * on this machine.
 *
 * `usePathname` is backed by a module-global store rather than React context,
 * so this resolves identically wherever it is mounted — which is why the
 * single shared `<AppTabBar />` can live at app-shell level in app/_layout.tsx
 * instead of being rendered by each screen.
 */
export function useAppTabs(): AppTab[] | null {
  const pathname = usePathname();
  const { user } = useAuth();
  return resolveTabsForRoute(pathname, user);
}
