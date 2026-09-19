import type {
  AccountInfoResult,
  AccountTransactionPage,
  AccountTransactionRequest,
  LedgerClosedEvent,
  ServerInfo,
  TransactionStreamMessage,
} from './types';

/**
 * One connection to one XRPL endpoint. The ConnectionManager owns at most one
 * live LedgerClient at a time; tests replace it with FakeLedgerClient.
 *
 * Request methods reject with LedgerTransportError when no server response
 * arrived, and with LedgerServerError when the server answered with an error.
 */
export interface LedgerClient {
  readonly url: string;

  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;

  getServerInfo(): Promise<ServerInfo>;
  getValidatedLedgerIndex(): Promise<number>;

  subscribeLedger(): Promise<void>;
  subscribeAccounts(accounts: string[]): Promise<void>;
  unsubscribeAccounts(accounts: string[]): Promise<void>;

  getAccountInfo(address: string): Promise<AccountInfoResult>;
  getAccountTransactions(request: AccountTransactionRequest): Promise<AccountTransactionPage>;

  onLedgerClosed(listener: (event: LedgerClosedEvent) => void): void;
  onTransaction(listener: (message: TransactionStreamMessage) => void): void;
  /** The connection was lost unexpectedly. */
  onDisconnected(listener: () => void): void;
  removeAllListeners(): void;
}

export type LedgerClientFactory = (url: string) => LedgerClient;

export const LEDGER_CLIENT_FACTORY = Symbol('LEDGER_CLIENT_FACTORY');

/** A request that produced no server response. Safe to retry elsewhere. */
export class LedgerTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LedgerTransportError';
  }
}

/** The server answered with an error status, such as lgrIdxMalformed. */
export class LedgerServerError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'LedgerServerError';
  }
}

/**
 * account_tx errors that mean the endpoint cannot serve the requested range.
 * rippled 3.x with API v2 answers lgrIdxMalformed when ledger_index_min lies
 * below its available history (verified against the public Testnet); the
 * service never asks beyond the validated ledger, so the error is unambiguous.
 */
export const HISTORY_UNAVAILABLE_ERRORS: ReadonlySet<string> = new Set([
  'lgrIdxMalformed',
  'lgrIdxsInvalid',
  'lgrNotFound',
]);
