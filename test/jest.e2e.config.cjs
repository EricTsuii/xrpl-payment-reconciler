const shared = require('./jest.shared.cjs');

// E2E tests boot the full application against real PostgreSQL 17.11 and Redis
// 7.4.11 with the FakeLedgerClient. No public XRPL network is ever contacted.
module.exports = {
  ...shared,
  displayName: 'e2e',
  testMatch: ['<rootDir>/test/e2e/**/*.spec.ts'],
  testTimeout: 30000,
  setupFiles: [...shared.setupFiles, '<rootDir>/test/support/test-env.ts'],
};
