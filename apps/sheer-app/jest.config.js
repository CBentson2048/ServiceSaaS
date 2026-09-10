/**
 * Tests for apps/sheer-app.
 *
 * NODE ENVIRONMENT, PURE LOGIC ONLY. There is no renderer here: jest-expo,
 * react-test-renderer and @testing-library/react-native are all absent from
 * this monorepo, and `pnpm install` cannot add them on the current machine
 * (ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY, which reproduces on a clean
 * tree, so it predates this work). What IS available is the hoisted root
 * install — jest 29 + ts-jest — so this config adds NO dependency to
 * package.json and leaves pnpm-lock.yaml untouched.
 *
 * The consequence is a real boundary, stated once here: every rule the shared
 * bottom navigation obeys is unit-tested through the pure module
 * `src/navigation/tabs.ts`, and nothing about how `AppTabBar.tsx` RENDERS that
 * data is. Visual fidelity, safe-area insets and real router behaviour are
 * manual UAT — see docs in the refactor PR.
 *
 * @type {import('jest').Config}
 */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '.',
  moduleFileExtensions: ['ts', 'tsx', 'js', 'json'],
  // src/ ONLY, and deliberately not app/: expo-router's require.context
  // collects every .ts/.tsx under the app root except +api/+html/+middleware
  // (node_modules/expo-router/_ctx.js), with no exclusion for .spec. files — so
  // a spec placed in app/ would become a navigable route bundled into the
  // shipping app. Specs live in src/.
  //
  // Both extensions, though: with `*.spec.ts` alone, the eventual render test
  // (AppTabBar.spec.tsx) would be collected by nothing and silently report
  // nothing. Paired with dropping --passWithNoTests from the test script, an
  // empty run now fails instead of going green.
  testMatch: ['<rootDir>/src/**/*.spec.{ts,tsx}'],
  moduleNameMapper: {
    '^@sheer/design-tokens$': '<rootDir>/../../packages/design-tokens/src/index.ts',
    '^@sheer/domain$': '<rootDir>/../../packages/domain/src/index.ts',
  },
  transform: {
    // tsconfig.jest.json relaxes only `jsx`/`moduleResolution` for the Node
    // runner; everything else is inherited so specs are type-checked exactly
    // as `pnpm typecheck` checks the app.
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.jest.json' }],
  },
};
