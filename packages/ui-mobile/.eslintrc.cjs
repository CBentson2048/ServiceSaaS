module.exports = {
  root: true,
  extends: [require.resolve('@sheer/config/eslint-react')],
  parserOptions: {
    tsconfigRootDir: __dirname,
    project: './tsconfig.json',
  },
  env: {
    node: true,
  },
  settings: {
    react: { version: 'detect' },
  },
};
