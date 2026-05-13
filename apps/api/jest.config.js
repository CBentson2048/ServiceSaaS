/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '.',
  moduleFileExtensions: ['ts', 'js', 'json'],
  testMatch: ['<rootDir>/src/**/*.spec.ts'],
  moduleNameMapper: {
    '^@sheer/auth$': '<rootDir>/../../packages/auth/src/index.ts',
    '^@sheer/booking-core$': '<rootDir>/../../packages/booking-core/src/index.ts',
    '^@sheer/config$': '<rootDir>/../../packages/config/src/index.ts',
    '^@sheer/domain$': '<rootDir>/../../packages/domain/src/index.ts',
    '^@sheer/lab-core$': '<rootDir>/../../packages/lab-core/src/index.ts',
    '^@sheer/types$': '<rootDir>/../../packages/types/src/index.ts',
  },
};
