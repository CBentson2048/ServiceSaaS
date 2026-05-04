module.exports = {
  root: true,
  extends: ['@sheer/config/eslint-react'],
  parserOptions: {
    tsconfigRootDir: __dirname,
    project: './tsconfig.json',
  },
  env: {
    'react-native/react-native': true,
    node: true,
  },
  settings: {
    react: { version: 'detect' },
  },
  ignorePatterns: ['.expo/', 'ios/', 'android/', 'dist/'],
};
