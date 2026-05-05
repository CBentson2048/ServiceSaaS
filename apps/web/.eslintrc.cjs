module.exports = {
  root: true,
  extends: [require.resolve('@sheer/config/eslint-react')],
  parserOptions: {
    tsconfigRootDir: __dirname,
    project: ['./tsconfig.app.json'],
  },
  settings: {
    react: { version: 'detect' },
  },
};
