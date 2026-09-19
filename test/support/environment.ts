import { PRIMARY_URL, SECONDARY_URL } from '../fakes/fake-ledger-client';

/** The local compose services; CI provides the same values. */
export const TEST_DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgresql://reconciler:reconciler_local_only@localhost:5432/reconciler';
export const TEST_REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';

/** Environment for a service that talks only to the FakeLedgerClient. */
export function testEnvironment(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    DATABASE_URL: TEST_DATABASE_URL,
    REDIS_URL: TEST_REDIS_URL,
    XRPL_NETWORK_ID: '1',
    XRPL_PRIMARY_URL: PRIMARY_URL,
    XRPL_SECONDARY_URL: SECONDARY_URL,
    LOG_LEVEL: 'error',
    ...overrides,
  };
}
