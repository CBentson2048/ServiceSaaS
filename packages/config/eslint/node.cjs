const base = require('./base.cjs');

module.exports = {
  ...base,
  env: {
    node: true,
    es2022: true,
  },
  extends: [...base.extends],
  rules: {
    ...base.rules,
  },
};
