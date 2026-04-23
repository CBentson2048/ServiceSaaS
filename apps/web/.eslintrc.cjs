module.exports = {
  root: true,
  extends: ['@sheer/config/eslint-react'],
  parserOptions: {
    tsconfigRootDir: __dirname,
    project: ['./tsconfig.app.json'],
  },
  settings: {
    react: { version: 'detect' },
  },
};
