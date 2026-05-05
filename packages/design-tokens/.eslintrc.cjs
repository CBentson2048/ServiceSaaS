/** ESLint must resolve the shareable config via `require.resolve` so CI
 * (pnpm + Turbo) always finds `@sheer/config` through package exports. */
module.exports = {
  root: true,
  extends: [require.resolve('@sheer/config/eslint-base')],
  parserOptions: {
    tsconfigRootDir: __dirname,
    project: './tsconfig.json',
  },
};
