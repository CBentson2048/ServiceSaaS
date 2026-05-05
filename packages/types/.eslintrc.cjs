module.exports = {
  root: true,
  extends: [require.resolve('@sheer/config/eslint-base')],
  parserOptions: {
    tsconfigRootDir: __dirname,
    project: './tsconfig.json',
  },
};
