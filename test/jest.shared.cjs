// Settings shared by the unit, integration and E2E Jest configurations.
const ESM_ONLY_SCOPES = '(@nestjs|@noble|@scure)';

module.exports = {
  rootDir: '..',
  testEnvironment: 'node',
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.json' }],
    '^.+/node_modules/.+\\.js$': '<rootDir>/test/esm-to-cjs.transform.cjs',
  },
  // Everything under node_modules stays untransformed except the ESM-only
  // scopes, in both the pnpm store layout and a flat layout.
  transformIgnorePatterns: [
    `/node_modules/(?!\\.pnpm/${ESM_ONLY_SCOPES}\\+|${ESM_ONLY_SCOPES}/)`,
  ],
  setupFiles: ['<rootDir>/test/support/quiet-logger.ts'],
  clearMocks: true,
};
