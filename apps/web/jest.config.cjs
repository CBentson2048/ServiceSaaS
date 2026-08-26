/**
 * Tests for apps/web.
 *
 * Most behaviour still lives in pure, DOM-free modules (filters, movement
 * presentation, form validation, camera decisions) and is tested as such.
 * The Product Management redesign added jsdom + @testing-library/react as
 * DEV dependencies so the interaction boundaries that cannot be expressed
 * purely — focus behaviour, drawers, the scan dialog, mocked camera — are
 * covered too. Nothing here ships in the bundle.
 *
 * @type {import('jest').Config}
 */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'jsdom',
  rootDir: '.',
  moduleFileExtensions: ['ts', 'tsx', 'js', 'json'],
  testMatch: ['<rootDir>/src/**/*.spec.ts', '<rootDir>/src/**/*.spec.tsx'],
  moduleNameMapper: {
    // Workspace sources use ESM-style './x.js' specifiers that resolve to .ts
    // on disk; jest needs the extension stripped to find them.
    '^(\\.{1,2}/.*)\\.js$': '$1',
    '^@sheer/domain$': '<rootDir>/../../packages/domain/src/index.ts',
    '^@sheer/utils$': '<rootDir>/../../packages/utils/src/index.ts',
  },
  transform: {
    // Uses tsconfig.jest.json, which extends the app's tsconfig so specs are
    // type-checked exactly as the build checks them (see that file).
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.jest.json' }],
  },
};
