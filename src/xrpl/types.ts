// XRPL API v2 payloads. Everything from the network arrives as `unknown` and
// is narrowed field by field before the service relies on it.

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** A server response that does not have the documented shape. */
export class LedgerResponseFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LedgerResponseFormatError';
  }
}

function fail(message: string): never {
  throw new LedgerResponseFormatError(message);
}

function uint(value: unknown, what: string): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : fail(`${what} is not a non-negative integer`);
}

function optionalUint(value: unknown, what: string): number | undefined {
  return value === undefined ? undefined : uint(value, what);
}

// --- server_info ------------------------------------------------------------

export interface ServerInfo {
  networkId: number | undefined;
  serverState: string;
  buildVersion: string;
  validatedLedger: { index: number; ageSeconds: number } | undefined;
}

export function parseServerInfo(result: Record<string, unknown>): ServerInfo {
  const info = asRecord(result.info) ?? fail('server_info.info is not an object');
  const validated = asRecord(info.validated_ledger);
  const state = info.server_state;
  return {
    networkId: optionalUint(info.network_id, 'server_info.info.network_id'),
    serverState: typeof state === 'string' ? state : fail('server_state is not a string'),
    buildVersion: typeof info.build_version === 'string' ? info.build_version : 'unknown',
    validatedLedger:
      validated === undefined
        ? undefined
        : {
            index: uint(validated.seq, 'validated_ledger.seq'),
            ageSeconds: uint(validated.age, 'validated_ledger.age'),
          },
  };
}

// --- ledger -----------------------------------------------------------------

export function parseValidatedLedgerIndex(result: Record<string, unknown>): number {
  if (result.validated === false) {
    fail('ledger reported validated=false');
  }
  const ledger = asRecord(result.ledger);
  const raw = result.ledger_index ?? ledger?.ledger_index;
  const index = typeof raw === 'string' && /^[0-9]+$/.test(raw) ? Number(raw) : raw;
  return uint(index, 'ledger.ledger_index');
}

// --- account_info -------------------------------------------------------------

export type AccountInfoResult = { found: true; ledgerIndex: number | undefined } | { found: false };

export function parseAccountInfo(result: Record<string, unknown>): AccountInfoResult {
  if (result.validated !== true) {
    fail('account_info did not return validated data');
  }
  const accountData = asRecord(result.account_data) ?? fail('account_data is not an object');
  if (typeof accountData.Account !== 'string') {
    fail('account_data.Account is not a string');
  }
  return {
    found: true,
    ledgerIndex: optionalUint(result.ledger_index, 'account_info.ledger_index'),
  };
}

// --- account_tx ---------------------------------------------------------------

export interface AccountTransactionRequest {
  account: string;
  ledgerIndexMin: number;
  ledgerIndexMax: number;
  /** Opaque; passed back exactly as the server returned it. */
  marker?: unknown;
}

export interface AccountTransactionPage {
  ledgerIndexMin: number | undefined;
  ledgerIndexMax: number | undefined;
  /** Response-level flag. Absent is allowed; false is a failure. */
  validated: boolean | undefined;
  marker: unknown;
  transactions: unknown[];
}

export function parseAccountTransactionPage(
  result: Record<string, unknown>,
): AccountTransactionPage {
  if (!Array.isArray(result.transactions)) {
    fail('account_tx.transactions is not an array');
  }
  return {
    ledgerIndexMin: optionalUint(result.ledger_index_min, 'account_tx.ledger_index_min'),
    ledgerIndexMax: optionalUint(result.ledger_index_max, 'account_tx.ledger_index_max'),
    validated: typeof result.validated === 'boolean' ? result.validated : undefined,
    marker: result.marker,
    transactions: result.transactions as unknown[],
  };
}

// --- streams --------------------------------------------------------------------

export interface LedgerClosedEvent {
  ledgerIndex: number;
  ledgerHash: string;
  networkId: number | undefined;
}

/** A raw message from the `transactions`/`accounts` stream, not yet trusted. */
export type TransactionStreamMessage = Record<string, unknown>;
