/**
 * THE APP CHROME HAS ONE HOME. This test is what stops it having eight again.
 *
 * Structural, by necessity: there is no renderer in this test environment (see
 * jest.config.js), so this reads the source as text. That is weaker than a
 * render test, but it catches precisely the thing that actually went wrong here
 * — a screen quietly growing its own copy of the shell — and it catches it in
 * the diff rather than on a tablet six weeks later.
 *
 * The state it is protecting against returning: LabShell existed and only 3 of
 * 15 screens used it, while six of the largest screens each carried a private
 * Sidebar, a private NavScroller, a private nav list, a private breakpoint
 * resolver and 32-41 duplicated style keys. That drift was operator-visible —
 * no nav item highlighted on five screens, and Inventory shown as "Soon" to
 * owners who could in fact use it.
 *
 * If you are here because a test failed: the fix is almost always to render
 * <LabShell> (or <LabScreen> for a pre-auth device screen) rather than to add
 * your file to an allow-list below.
 */

import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

const SCREENS = join(__dirname, '..');
const SRC = join(__dirname, '..', '..');

/** Every .tsx under src/screens, as repo-relative paths. */
function screenFiles(dir = SCREENS, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) screenFiles(full, out);
    else if (entry.endsWith('.tsx')) out.push(full);
  }
  return out;
}

const rel = (path: string) => path.slice(SRC.length + 1).replace(/\\/g, '/');

/** Source with comments stripped, so prose cannot satisfy — or break — a match. */
function code(path: string): string {
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

const FILES = screenFiles().map((path) => ({ path: rel(path), src: code(path) }));

/** The two shells, and the one screen that predates both. */
const SHELL = 'screens/shared/LabShell.tsx';
const LAB_SCREEN = 'screens/shared/LabScreen.tsx';
/**
 * The PIN lock screen is a bespoke full-bleed keypad with no station nav and no
 * back affordance, so it owns its own safe area. It is the ONE exception, named
 * here so a second one cannot appear silently.
 */
const AUTH = 'screens/Auth/AuthScreen.tsx';

describe('the file list itself', () => {
  it('found the screens, so an empty sweep cannot pass vacuously', () => {
    expect(FILES.length).toBeGreaterThan(15);
    expect(FILES.map((f) => f.path)).toContain(SHELL);
  });
});

describe('only the shells own the app chrome', () => {
  it('renders SafeAreaView in the shells and the lock screen only', () => {
    const owners = FILES.filter((f) => /<SafeAreaView\b/.test(f.src)).map((f) => f.path).sort();
    expect(owners).toEqual([AUTH, LAB_SCREEN, SHELL].sort());
  });

  it('renders the TopBar in exactly one place', () => {
    const owners = FILES.filter((f) => /<TopBar\b/.test(f.src)).map((f) => f.path);
    expect(owners).toEqual([SHELL]);
  });

  it('defines the sidebar rail and the phone chip row in exactly one place', () => {
    for (const component of ['Sidebar', 'NavScroller']) {
      const owners = FILES.filter((f) =>
        new RegExp(`function ${component}\\s*\\(`).test(f.src),
      ).map((f) => f.path);
      expect({ component, owners }).toEqual({ component, owners: [SHELL] });
    }
  });

  it('leaves the StatusBar entirely to the app root', () => {
    // `AppProviders` sets it once for the whole app. Every fork set it again
    // anyway, and two of them painted `surface` where the shell painted
    // `background` — pure drift, invisible until you looked at two screens side
    // by side. No screen should set it at all now.
    const owners = FILES.filter((f) => /<StatusBar\b/.test(f.src)).map((f) => f.path);
    expect(owners).toEqual([]);

    const providers = readFileSync(join(SRC, 'app', 'providers', 'AppProviders.tsx'), 'utf8');
    expect(providers).toMatch(/<StatusBar/);
  });
});

describe('the nav destination list has one home', () => {
  it('is declared only in the pure nav module', () => {
    // Seven copies all began with this line.
    const owners = FILES.filter((f) => /label: 'Dashboard'/.test(f.src)).map((f) => f.path);
    expect(owners).toEqual([]);

    const navModule = code(join(SRC, 'navigation', 'labNav.ts'));
    expect(navModule).toMatch(/label: 'Dashboard'/);
  });

  it('is not re-declared under a different shape either', () => {
    // A fork could rename the field and still be a second list.
    for (const f of FILES) {
      const forked = /(?:NAV_ITEMS|VISIBLE_NAV_ITEMS|buildNavItems)\s*[:=]/.test(f.src);
      expect({ file: f.path, declaresNavList: forked }).toEqual({
        file: f.path,
        declaresNavList: false,
      });
    }
  });

  it('keeps the nav module free of react-native, so its rules stay testable', () => {
    // code(), not readFileSync: the module's own docblock says it has no
    // react-native import, and prose must not be able to fail the assertion it
    // describes. (It did, first time round.)
    const navModule = code(join(SRC, 'navigation', 'labNav.ts'));
    expect(navModule).not.toMatch(/from 'react-native'/);
    expect(navModule).not.toMatch(/@react-navigation/);
  });
});

describe('active state cannot be declared by a screen', () => {
  it('takes no `active` prop', () => {
    // It was `active: NavKey`, so every screen asserted which station it was —
    // and the forks either got it wrong or omitted it.
    const shell = code(join(SRC, SHELL.replace('screens/', 'screens/')));
    expect(shell).not.toMatch(/\bactive:\s*NavKey/);
  });

  it('is derived from the route inside the shell', () => {
    const shell = code(join(SRC, SHELL));
    expect(shell).toMatch(/useRoute\(\)/);
    expect(shell).toMatch(/isNavItemActive/);
  });

  it('has no call site still passing one', () => {
    for (const f of FILES) {
      const passes = /<LabShell[\s\S]{0,400}?\bactive=/.test(f.src);
      expect({ file: f.path, passesActive: passes }).toEqual({ file: f.path, passesActive: false });
    }
  });
});

describe('every station screen renders a shell', () => {
  /** Screens registered in RootNavigator, and which shell each should use. */
  const STATION_SCREENS = [
    'screens/Home/HomeScreen.tsx',
    'screens/NewMix/NewMixScreen.tsx',
    'screens/Formula/FormulaScreen.tsx',
    'screens/BuildFormula/BuildFormulaScreen.tsx',
    'screens/UpdateFormula/UpdateFormulaScreen.tsx',
    'screens/MixFinalized/MixFinalizedScreen.tsx',
    'screens/FormulaHistory/FormulaHistoryScreen.tsx',
    'screens/Inventory/InventoryScreen.tsx',
    'screens/BillingRules/BillingRulesScreen.tsx',
  ];

  it.each(STATION_SCREENS)('%s renders LabShell', (path) => {
    const file = FILES.find((f) => f.path === path);
    expect(file).toBeDefined();
    expect(file!.src).toMatch(/<LabShell\b/);
  });

  it('accounts for every screen: it renders a shell, or it is a named exception', () => {
    const unaccounted = FILES.filter((f) => {
      if (f.path.startsWith('screens/shared/')) return false;
      if (f.path === AUTH) return false;
      // Modals and sub-components render inside a screen, not beside it.
      if (/Modal\.tsx$|PeriodSelector\.tsx$/.test(f.path)) return false;
      return !/<LabShell\b|<LabScreen\b/.test(f.src);
    }).map((f) => f.path);
    expect(unaccounted).toEqual([]);
  });
});

describe('the shell provides what the forks left to fork for', () => {
  const shell = code(join(SRC, SHELL));

  it('has a pinned bottom-bar slot, rendered outside the ScrollView', () => {
    // Three screens forked the shell because `footer` scrolls and their live
    // grams/charge bar has to stay put while the operator weighs.
    expect(shell).toMatch(/bottomBar\?: React\.ReactNode/);
    // The bar must be a sibling of the ScrollView, not a child of it.
    const main = shell.slice(shell.indexOf('<View style={styles.mainArea}>'));
    expect(main.indexOf('{bottomBar}')).toBeGreaterThan(main.indexOf('</ScrollView>'));
  });

  it('has a reading-width mode, so a report page need not fork for its cap', () => {
    expect(shell).toMatch(/contentWidth\?: 'full' \| 'reading'/);
    expect(shell).toMatch(/readingWidth/);
  });

  it('owns sign-out, with the guard that Home had lost', () => {
    const signOut = shell.slice(shell.indexOf('handleSignOut'));
    expect(signOut).toMatch(/try\s*\{/);
    expect(signOut).toMatch(/navigation\.reset\(/);
  });
});

describe('sign-out always reaches the server', () => {
  const shell = code(join(SRC, SHELL));

  it('does not gate the logout call on the async session alone', () => {
    // THE REGRESSION THIS CATCHES. Consolidating the six forked sign-out
    // handlers into the shell briefly made the logout call `if (session)`.
    // `session` arrives from an async getActiveLabSession(), while the
    // formula-flow screens have the id in their route params from first render
    // — so an operator signing out during that load was navigated to the lock
    // screen with the server-side session still open.
    expect(shell).toMatch(/session\?\.sessionId \?\? labSessionId/);
    expect(shell).not.toMatch(/if \(session\) \{\s*try/);
  });

  it('accepts a synchronously known session id', () => {
    expect(shell).toMatch(/labSessionId\?: string/);
  });

  it('is passed that id by every screen that has one', () => {
    // The four formula-flow screens carry it in route params or the draft.
    const withSyncId = [
      'screens/Formula/FormulaScreen.tsx',
      'screens/BuildFormula/BuildFormulaScreen.tsx',
      'screens/UpdateFormula/UpdateFormulaScreen.tsx',
      'screens/MixFinalized/MixFinalizedScreen.tsx',
    ];
    for (const path of withSyncId) {
      const file = FILES.find((f) => f.path === path);
      expect(file).toBeDefined();
      expect({ file: path, passesId: /labSessionId=\{/.test(file!.src) }).toEqual({
        file: path,
        passesId: true,
      });
    }
  });

  it('navigates to the lock screen even when the logout throws', () => {
    // The reset must be outside the try, not in it.
    const handler = shell.slice(shell.indexOf('const handleSignOut'), shell.indexOf('return (\n    <SafeAreaView'));
    const catchEnd = handler.lastIndexOf('}');
    expect(handler.indexOf('navigation.reset(')).toBeGreaterThan(handler.indexOf('catch'));
    expect(catchEnd).toBeGreaterThan(0);
  });
});

describe('the default footer does not claim more than it knows', () => {
  it('renders nothing while the session is still loading', () => {
    // It used to print "SESSION ENDED" whenever `session` was undefined, which
    // includes every screen's first load — so a spinner came with a footer
    // announcing the session was over.
    const shell = code(join(SRC, SHELL));
    const footer = shell.slice(shell.indexOf('function DefaultFooter'));
    expect(footer).toMatch(/if \(!session\) return null/);
  });
});
