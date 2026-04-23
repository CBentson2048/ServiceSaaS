module.exports = {
  root: true,
  extends: ['@sheer/config/eslint-base'],
  parserOptions: {
    tsconfigRootDir: __dirname,
    project: './tsconfig.json',
  },
};
