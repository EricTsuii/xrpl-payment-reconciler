const shared = require('./jest.shared.cjs');

// Integration tests need a real PostgreSQL 17.11 and Redis 7.4.11
// (docker compose up -d postgres redis).
module.exports = {
  ...shared,
  displayName: 'integration',
  testMatch: ['<rootDir>/test/integration/**/*.spec.ts'],
  testTimeout: 30000,
  setupFiles: [...shared.setupFiles, '<rootDir>/test/support/test-env.ts'],
};
