const base = require('./base.cjs');

module.exports = {
  ...base,
  env: {
    browser: true,
    es2022: true,
  },
  plugins: [...base.plugins, 'react', 'react-hooks'],
  extends: [
    ...base.extends,
    'plugin:react/recommended',
    'plugin:react-hooks/recommended',
    'plugin:react/jsx-runtime',
  ],
  settings: {
    react: { version: 'detect' },
  },
  rules: {
    ...base.rules,
    'react/prop-types': 'off',
  },
};
