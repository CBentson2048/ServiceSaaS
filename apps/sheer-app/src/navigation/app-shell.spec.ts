/**
 * THE app shell holds the bottom navigation exactly once.
 *
 * This is a STRUCTURAL test, and it is deliberate. The ticket asks us to prove
 * "the shared bar renders once" and "no duplicate navigation bars appear",
 * which would normally be a render assertion — but there is no React Native
 * renderer available in this monorepo (jest-expo, react-test-renderer and
 * @testing-library/react-native are absent and `pnpm install` fails
 * non-interactively on this machine). So instead of proving it at runtime,
 * this proves it at the only other place it can be broken: the source.
 *
 * It is a genuine tripwire rather than a tautology. Before this refactor it
 * would have failed loudly — 12 render sites across 11 screen files. Its real
 * job is the future: the moment someone adds `<AppTabBar />` back to a screen,
 * or moves the shell out of its providers, this goes red with a message saying
 * why.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';
import { CLIENT_TABS, STYLIST_TABS, TAB_BAR_ROUTES } from './tabs';

const ROOT = join(__dirname, '..', '..');
const APP_DIR = join(ROOT, 'app');
const SRC_DIR = join(ROOT, 'src');
const LAYOUT = join(APP_DIR, '_layout.tsx');
/** The one legal place the bar is defined. */
const DEFINITION = join(SRC_DIR, 'navigation', 'AppTabBar.tsx');

function sourceFilesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFilesUnder(full);
    return /\.tsx?$/.test(entry) && !/\.spec\.tsx?$/.test(entry) ? [full] : [];
  });
}

/** Source with block and line comments stripped, so prose cannot match code. */
function code(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

/** Every source file that could render a bar: routes AND shared components. */
const ALL_SOURCE = [...sourceFilesUnder(APP_DIR), ...sourceFilesUnder(SRC_DIR)];
const RENDERABLE = ALL_SOURCE.filter((f) => f !== DEFINITION);
const SCREENS = ALL_SOURCE.filter((f) => f !== LAYOUT && f !== DEFINITION);
const rel = (f: string) => relative(ROOT, f);

describe('the shared bottom navigation is mounted exactly once', () => {
  it('finds every route and shared-component file, so this cannot pass by looking at nothing', () => {
    // Guards the guard: a broken walk would make every assertion below vacuous.
    expect(SCREENS.length).toBeGreaterThanOrEqual(30);
    expect(ALL_SOURCE).toContain(LAYOUT);
    expect(ALL_SOURCE).toContain(DEFINITION);
  });

  it('renders <AppTabBar /> exactly once across routes AND shared components', () => {
    // src/ is walked too: a bar added to a shared wrapper like
    // src/design/components/Screen.tsx would appear on every screen at once.
    const sites = RENDERABLE.flatMap((file) => {
      const hits = code(file).match(/<AppTabBar\b/g) ?? [];
      return hits.map(() => rel(file));
    });
    expect(sites).toEqual(['app/_layout.tsx']);
  });

  it('has exactly one tablist in the app, so no hand-rolled second bar can hide', () => {
    // The duplication this refactor removed included a hand-rolled client bar
    // under a different name (a private TabBarItem inside dashboard.tsx). A
    // name-based check cannot see that recur; the a11y role can.
    const tablists = ALL_SOURCE.flatMap((file) => {
      const hits = code(file).match(/accessibilityRole=\{?["']tablist["']\}?/g) ?? [];
      return hits.map(() => rel(file));
    });
    expect(tablists).toEqual(['src/navigation/AppTabBar.tsx']);
  });

  it('renders it from the app shell, not from a screen', () => {
    expect(code(LAYOUT)).toMatch(/<AppTabBar\s*\/>/);
  });

  it('has nothing but the shell importing AppTabBar', () => {
    // The duplication this refactor removed. If anything imports the bar again,
    // name it here so the failure says which file.
    const offenders = SCREENS.filter((f) => /import\s*\{[^}]*AppTabBar/.test(code(f))).map(rel);
    expect(offenders).toEqual([]);
  });
});

describe('the shell keeps the bar in the position its hooks require', () => {
  const layout = code(LAYOUT);

  it('places the bar after the routed content, as the last child of the shell', () => {
    // Order matters: the bar must paint over the stack edge, not under it.
    expect(layout.indexOf('</Stack>')).toBeGreaterThan(-1);
    expect(layout.indexOf('<AppTabBar')).toBeGreaterThan(layout.indexOf('</Stack>'));
  });

  it('keeps the bar inside AuthProvider — useAuth() throws outside it', () => {
    const open = layout.indexOf('<AuthProvider>');
    const close = layout.indexOf('</AuthProvider>');
    const bar = layout.indexOf('<AppTabBar');
    expect(open).toBeGreaterThan(-1);
    expect(bar).toBeGreaterThan(open);
    expect(bar).toBeLessThan(close);
  });

  it('keeps the bar inside NotificationsProvider — the badge dies silently outside it', () => {
    // useNotifications() does NOT throw when its context is missing; it returns
    // a dormant { unreadCount: 0 } stub. Mounting the shell above this provider
    // would stop the Alerts badge appearing with no crash, no console error and
    // a green typecheck. This assertion is the only thing that catches it.
    const open = layout.indexOf('<NotificationsProvider>');
    const close = layout.indexOf('</NotificationsProvider>');
    const bar = layout.indexOf('<AppTabBar');
    expect(open).toBeGreaterThan(-1);
    expect(bar).toBeGreaterThan(open);
    expect(bar).toBeLessThan(close);
  });

  it('wraps the shell in a plain flex View, with no SafeAreaView anywhere in the layout', () => {
    // expo-router already mounts SafeAreaProvider above this layout and
    // AppTabBar takes its own bottom inset, so ANY inset in this file
    // double-counts it. The earlier version of this test sliced from the shell
    // DOWNWARD — i.e. the <Stack> block — so a SafeAreaView wrapped AROUND the
    // shell passed it. Assert over the whole file instead.
    expect(layout).toContain('<View style={s.shell}>');
    expect(layout.match(/<SafeAreaView\b/g) ?? []).toEqual([]);
  });

  it('gives the shell flex:1 so the bar takes layout height instead of overlaying content', () => {
    // This is what satisfies "content must not be obscured" with zero
    // per-screen bottom padding: the bar is a flex sibling, so <Stack> is laid
    // out at shell height minus bar height. An absolutely-positioned bar would
    // silently cover the last ~50pt of every screen.
    expect(layout).toMatch(/shell:\s*\{[^}]*flex:\s*1/);
    expect(layout).not.toMatch(/shell:\s*\{[^}]*position:\s*['"]absolute['"]/);
  });
});

describe('every navigation destination is a real route', () => {
  // The one high-value non-renderer assertion the pure spec cannot make: its
  // route expectations compare literals in tabs.ts against literals in the
  // spec, so both sides move together. A typo'd href, or a renamed route file,
  // yields a tab that navigates nowhere and stays green. This checks the
  // registry against the actual expo-router file tree.
  const routeFileFor = (href: string) => join(APP_DIR, href.replace(/^\//, '') + '.tsx');
  const layoutSrc = code(LAYOUT);

  it('maps every tab href to a route file that exists', () => {
    const hrefs = [...STYLIST_TABS, ...CLIENT_TABS].map((t) => t.href);
    expect(hrefs.length).toBeGreaterThan(0);
    const broken = hrefs.filter((h) => !existsSync(routeFileFor(h)));
    expect(broken).toEqual([]);
  });

  it('maps every bar-carrying route to a route file that exists', () => {
    const routes = [...TAB_BAR_ROUTES];
    expect(routes.length).toBeGreaterThan(0);
    const broken = routes.filter((r) => !existsSync(routeFileFor(r)));
    expect(broken).toEqual([]);
  });

  it('registers every bar-carrying route as a Stack.Screen in the shell', () => {
    const missing = [...TAB_BAR_ROUTES].filter(
      (r) => !layoutSrc.includes('name="' + r.replace(/^\//, '') + '"'),
    );
    expect(missing).toEqual([]);
  });
});
