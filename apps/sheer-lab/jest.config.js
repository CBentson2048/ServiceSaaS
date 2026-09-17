/**
 * Tests for apps/sheer-lab.
 *
 * NODE ENVIRONMENT, PURE LOGIC AND SOURCE-STRUCTURE ONLY. There is no renderer
 * available: jest-expo, react-test-renderer and @testing-library/react-native
 * are all absent from this monorepo, and `pnpm install` cannot add them on this
 * machine (ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY, which reproduces on a
 * clean tree, so it predates this work). What IS available is the hoisted root
 * install — jest 29 + ts-jest — so this config adds NO dependency to
 * package.json and leaves pnpm-lock.yaml untouched.
 *
 * The consequence, stated once: a module that imports `react-native` cannot be
 * imported by a test here. That is why the rules worth protecting live in pure
 * modules (`src/lib/decimal.ts`, `src/navigation/labNav.ts`) and why the shell
 * and nav invariants are checked STRUCTURALLY — by reading the source as text.
 * Structural tests are weaker than render tests, but they catch the thing that
 * actually regressed in this app: a screen quietly growing its own copy of the
 * shared chrome. Visual fidelity remains manual UAT.
 *
 * @type {import('jest').Config}
 */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '.',
  moduleFileExtensions: ['ts', 'tsx', 'js', 'json'],
  // Both extensions: with `*.spec.ts` alone an eventual `.spec.tsx` would be
  // collected by nothing and silently report nothing. Paired with the absence
  // of --passWithNoTests in the `test` script, an empty run fails.
  testMatch: ['<rootDir>/src/**/*.spec.{ts,tsx}'],
  moduleNameMapper: {
    '^@sheer/api-client$': '<rootDir>/../../packages/api-client/src/index.ts',
    '^@sheer/auth$': '<rootDir>/../../packages/auth/src/index.ts',
    '^@sheer/design-tokens$': '<rootDir>/../../packages/design-tokens/src/index.ts',
    '^@sheer/domain$': '<rootDir>/../../packages/domain/src/index.ts',
    '^@sheer/lab-core$': '<rootDir>/../../packages/lab-core/src/index.ts',
    '^@sheer/utils$': '<rootDir>/../../packages/utils/src/index.ts',
  },
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.jest.json' }],
  },
};
