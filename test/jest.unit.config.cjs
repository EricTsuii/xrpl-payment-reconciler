const shared = require('./jest.shared.cjs');

module.exports = {
  ...shared,
  displayName: 'unit',
  testMatch: ['<rootDir>/test/unit/**/*.spec.ts'],
};
