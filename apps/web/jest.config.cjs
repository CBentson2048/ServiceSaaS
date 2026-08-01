/**
 * Unit tests for pure logic in apps/web.
 *
 * Deliberately node-environment and DOM-free: there is no jsdom or
 * @testing-library in this repo, and adding them is its own decision. Logic that
 * must be tested is therefore extracted into pure modules (see
 * src/components/team/staffUpdatePayload.ts) and tested here. Uses the jest and
 * ts-jest already present at the workspace root, so this adds no dependency.
 *
 * @type {import('jest').Config}
 */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '.',
  moduleFileExtensions: ['ts', 'tsx', 'js', 'json'],
  testMatch: ['<rootDir>/src/**/*.spec.ts'],
  moduleNameMapper: {
    '^@sheer/domain$': '<rootDir>/../../packages/domain/src/index.ts',
    '^@sheer/utils$': '<rootDir>/../../packages/utils/src/index.ts',
  },
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: { jsx: 'react-jsx', esModuleInterop: true } }],
  },
};
