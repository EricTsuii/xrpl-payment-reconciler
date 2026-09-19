// Fixed policy constants. These are deliberately not configurable in v0.1.0.

export const XRPL_CONNECT_TIMEOUT_MS = 10_000;
export const XRPL_REQUEST_TIMEOUT_MS = 10_000;
export const VALIDATED_LEDGER_MAX_AGE_SECONDS = 20;

export const RECONCILE_INTERVAL_MS = 30_000;
export const ACCOUNT_TX_LIMIT = 200;
export const MAX_MONITORED_ACCOUNTS = 25;

export const REDIS_LOCK_TTL_MS = 60_000;
export const REDIS_LOCK_REFRESH_MS = 20_000;

export const OUTBOX_POLL_MS = 500;
export const OUTBOX_LOCK_MS = 15_000;
export const OUTBOX_CLAIM_BATCH = 1;

export const WEBHOOK_TIMEOUT_MS = 5_000;
export const WEBHOOK_MAX_ATTEMPTS = 5;

export const RIPPLE_EPOCH_OFFSET_SECONDS = 946_684_800;

/** Delay after the n-th failed webhook attempt (1-based); the 5th is final. */
export const WEBHOOK_RETRY_DELAYS_MS: readonly number[] = [1_000, 5_000, 15_000, 30_000];

/** XRPL reconnect delays after every endpoint failed: 1s, 2s, 5s, 10s, then 30s. */
export const RECONNECT_BACKOFF_MS: readonly number[] = [1_000, 2_000, 5_000, 10_000, 30_000];

/** Initial PostgreSQL and Redis connection timeout; startup fails after it. */
export const STARTUP_CONNECT_TIMEOUT_MS = 10_000;

/** Global deadline for graceful shutdown. */
export const SHUTDOWN_DEADLINE_MS = 10_000;

export const PAYMENT_LIST_DEFAULT_LIMIT = 25;
export const PAYMENT_LIST_MAX_LIMIT = 100;

export const NETWORK_ID_MAX = 65_535;
export const LEDGER_INDEX_MAX = 268_435_455;
export const TRANSACTION_INDEX_MAX = 65_535;
export const UINT32_MAX = 4_294_967_295;

export const USER_AGENT = 'xrpl-payment-reconciler/0.1.0';
