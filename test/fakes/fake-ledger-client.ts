import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  type LedgerClient,
  type LedgerClientFactory,
  LedgerServerError,
  LedgerTransportError,
} from '../../src/xrpl/ledger-client.interface';
import type {
  AccountInfoResult,
  AccountTransactionPage,
  AccountTransactionRequest,
  LedgerClosedEvent,
  ServerInfo,
  TransactionStreamMessage,
} from '../../src/xrpl/types';

// A deterministic stand-in for the XRP Ledger. No test reaches a public
// network: account_tx entries and stream messages are built from the
// API v2 fixtures in test/fixtures/xrpl and a small ledger model.

const FIXTURES = path.join(__dirname, '..', 'fixtures', 'xrpl');

export function fixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(FIXTURES, `${name}.json`), 'utf8')) as Record<
    string,
    unknown
  >;
}

export const FIXTURE_ACCOUNTS = fixture('accounts') as {
  monitored: string;
  sender: string;
  issuer: string;
  other: string;
};

export const PRIMARY_URL = 'wss://primary.xrpl.test/';
export const SECONDARY_URL = 'wss://secondary.xrpl.test/';

export type Method = keyof Omit<
  LedgerClient,
  | 'url'
  | 'connect'
  | 'disconnect'
  | 'isConnected'
  | 'onLedgerClosed'
  | 'onTransaction'
  | 'onDisconnected'
  | 'removeAllListeners'
>;

/** Replaces one method on one endpoint; may throw to simulate a failure. */
export type Override = (...args: never[]) => unknown;

export const transportFailure = (): never => {
  throw new LedgerTransportError('simulated transport failure');
};

/** Rewrites an account_tx page before it is returned, e.g. to drop `validated`. */
export type PageMutator = (
  page: AccountTransactionPage,
  request: AccountTransactionRequest,
) => AccountTransactionPage;

/** Ledger state that both endpoints report on. */
export class FakeLedger {
  networkId = 1;
  validatedLedger = 1000;
  ledgerAge = 2;
  serverState = 'full';
  pageSize = 200;
  readonly accounts = new Set<string>(Object.values(FIXTURE_ACCOUNTS));
  readonly transactions: Record<string, unknown>[] = [];
}

export class FakeEndpoint {
  readonly calls: { method: string; args: unknown[] }[] = [];
  readonly clients: FakeLedgerClient[] = [];
  failConnect = false;
  /** First ledger this endpoint holds history for. */
  earliestLedger = 1;
  pageMutator: PageMutator | undefined;
  private readonly overrides = new Map<string, Override>();

  constructor(
    readonly name: 'primary' | 'secondary',
    readonly url: string,
  ) {}

  override(method: Method, behaviour: Override): void {
    this.overrides.set(method, behaviour);
  }

  clearOverride(method: Method): void {
    this.overrides.delete(method);
  }

  overrideFor(method: string): Override | undefined {
    return this.overrides.get(method);
  }

  count(method: Method): number {
    return this.calls.filter((call) => call.method === method).length;
  }

  /** The currently connected client of this endpoint, if any. */
  live(): FakeLedgerClient | undefined {
    return this.clients.find((client) => client.isConnected());
  }
}

export interface IncludeOptions {
  /** Deliver stream messages to subscribed clients (default true). */
  live?: boolean;
}

/** Two endpoints over one ledger, plus the invariants the tests assert. */
export class FakeLedgerNetwork {
  readonly ledger = new FakeLedger();
  readonly primary = new FakeEndpoint('primary', PRIMARY_URL);
  readonly secondary = new FakeEndpoint('secondary', SECONDARY_URL);
  connectedNow = 0;
  maxConnectedAtOnce = 0;

  readonly factory: LedgerClientFactory = (url) => {
    const endpoint =
      url === PRIMARY_URL ? this.primary : url === SECONDARY_URL ? this.secondary : undefined;
    if (endpoint === undefined) {
      throw new Error(`unexpected XRPL url ${url}`);
    }
    const client = new FakeLedgerClient(endpoint, this);
    endpoint.clients.push(client);
    return client;
  };

  /**
   * Closes the next validated ledger containing `entries` (account_tx-shaped
   * fixtures, re-stamped to this ledger), emits ledgerClosed and, unless
   * `live` is false, stream messages to clients subscribed to the accounts.
   */
  closeLedger(entries: Record<string, unknown>[] = [], options: IncludeOptions = {}): number {
    this.ledger.validatedLedger += 1;
    const ledgerIndex = this.ledger.validatedLedger;
    const stamped = entries.map((entry, position) =>
      stampEntry(entry, ledgerIndex, position, this.ledger.networkId),
    );
    this.ledger.transactions.push(...stamped);

    for (const client of [...this.primary.clients, ...this.secondary.clients]) {
      client.emitLedgerClosed({
        ledgerIndex,
        ledgerHash: 'B'.repeat(64),
        networkId: this.ledger.networkId,
      });
      if (options.live ?? true) {
        for (const entry of stamped) {
          client.emitTransaction(streamMessage(entry));
        }
      }
    }
    return ledgerIndex;
  }

  /** Closes `count` empty ledgers. */
  advance(count: number): void {
    for (let step = 0; step < count; step += 1) {
      this.closeLedger();
    }
  }

  connected(): void {
    this.connectedNow += 1;
    this.maxConnectedAtOnce = Math.max(this.maxConnectedAtOnce, this.connectedNow);
  }

  disconnected(): void {
    this.connectedNow -= 1;
  }

  accountTransactions(
    endpoint: FakeEndpoint,
    request: AccountTransactionRequest,
  ): AccountTransactionPage {
    if (
      request.ledgerIndexMax > this.ledger.validatedLedger ||
      request.ledgerIndexMin < endpoint.earliestLedger
    ) {
      // rippled 3.x API v2 answers this for a range outside its history.
      throw new LedgerServerError('lgrIdxMalformed', 'account_tx returned lgrIdxMalformed');
    }
    const matching = this.ledger.transactions
      .filter((entry) => {
        const tx = entry.tx_json as Record<string, unknown>;
        const index = entry.ledger_index as number;
        return (
          (tx.Account === request.account || tx.Destination === request.account) &&
          index >= request.ledgerIndexMin &&
          index <= request.ledgerIndexMax
        );
      })
      .sort(
        (a, b) =>
          (a.ledger_index as number) - (b.ledger_index as number) ||
          (a.meta as { TransactionIndex: number }).TransactionIndex -
            (b.meta as { TransactionIndex: number }).TransactionIndex,
      );
    const offset =
      typeof request.marker === 'object' && request.marker !== null
        ? (request.marker as { seq: number }).seq
        : 0;
    const slice = matching.slice(offset, offset + this.ledger.pageSize);
    const next = offset + slice.length;
    let page: AccountTransactionPage = {
      ledgerIndexMin: request.ledgerIndexMin,
      ledgerIndexMax: request.ledgerIndexMax,
      validated: true,
      marker: next < matching.length ? { ledger: request.ledgerIndexMin, seq: next } : undefined,
      transactions: slice.map((entry) => structuredClone(entry)),
    };
    if (endpoint.pageMutator !== undefined) {
      page = endpoint.pageMutator(page, request);
    }
    return page;
  }
}

export class FakeLedgerClient implements LedgerClient {
  private connectedState = false;
  private readonly subscribed = new Set<string>();
  private ledgerSubscribed = false;
  private ledgerListeners: ((event: LedgerClosedEvent) => void)[] = [];
  private transactionListeners: ((message: TransactionStreamMessage) => void)[] = [];
  private disconnectListeners: (() => void)[] = [];

  constructor(
    private readonly endpoint: FakeEndpoint,
    private readonly network: FakeLedgerNetwork,
  ) {}

  get url(): string {
    return this.endpoint.url;
  }

  connect(): Promise<void> {
    if (this.endpoint.failConnect) {
      return Promise.reject(
        new LedgerTransportError(`connect failed: ${this.endpoint.name} is down`),
      );
    }
    this.connectedState = true;
    this.network.connected();
    return Promise.resolve();
  }

  disconnect(): Promise<void> {
    if (this.connectedState) {
      this.connectedState = false;
      this.network.disconnected();
    }
    return Promise.resolve();
  }

  isConnected(): boolean {
    return this.connectedState;
  }

  subscriptions(): string[] {
    return [...this.subscribed];
  }

  getServerInfo(): Promise<ServerInfo> {
    return this.run('getServerInfo', [], () => ({
      networkId: this.network.ledger.networkId,
      serverState: this.network.ledger.serverState,
      buildVersion: '3.4.0',
      validatedLedger: {
        index: this.network.ledger.validatedLedger,
        ageSeconds: this.network.ledger.ledgerAge,
      },
    }));
  }

  getValidatedLedgerIndex(): Promise<number> {
    return this.run('getValidatedLedgerIndex', [], () => this.network.ledger.validatedLedger);
  }

  subscribeLedger(): Promise<void> {
    return this.run('subscribeLedger', [], () => {
      this.ledgerSubscribed = true;
    });
  }

  subscribeAccounts(accounts: string[]): Promise<void> {
    return this.run('subscribeAccounts', [accounts], () => {
      for (const account of accounts) {
        this.subscribed.add(account);
      }
    });
  }

  unsubscribeAccounts(accounts: string[]): Promise<void> {
    return this.run('unsubscribeAccounts', [accounts], () => {
      for (const account of accounts) {
        this.subscribed.delete(account);
      }
    });
  }

  getAccountInfo(address: string): Promise<AccountInfoResult> {
    return this.run('getAccountInfo', [address], () =>
      this.network.ledger.accounts.has(address)
        ? { found: true as const, ledgerIndex: this.network.ledger.validatedLedger }
        : { found: false as const },
    );
  }

  getAccountTransactions(request: AccountTransactionRequest): Promise<AccountTransactionPage> {
    return this.run('getAccountTransactions', [request], () =>
      this.network.accountTransactions(this.endpoint, request),
    );
  }

  onLedgerClosed(listener: (event: LedgerClosedEvent) => void): void {
    this.ledgerListeners.push(listener);
  }

  onTransaction(listener: (message: TransactionStreamMessage) => void): void {
    this.transactionListeners.push(listener);
  }

  onDisconnected(listener: () => void): void {
    this.disconnectListeners.push(listener);
  }

  removeAllListeners(): void {
    this.ledgerListeners = [];
    this.transactionListeners = [];
    this.disconnectListeners = [];
  }

  emitLedgerClosed(event: LedgerClosedEvent): void {
    if (this.connectedState && this.ledgerSubscribed) {
      for (const listener of this.ledgerListeners) {
        listener(event);
      }
    }
  }

  emitTransaction(message: TransactionStreamMessage): void {
    if (!this.connectedState) {
      return;
    }
    const tx = message.tx_json as Record<string, unknown>;
    if (!this.subscribed.has(String(tx.Destination)) && !this.subscribed.has(String(tx.Account))) {
      return;
    }
    for (const listener of this.transactionListeners) {
      listener(structuredClone(message));
    }
  }

  /** The server dropped the connection. */
  dropConnection(): void {
    if (!this.connectedState) {
      return;
    }
    this.connectedState = false;
    this.network.disconnected();
    for (const listener of this.disconnectListeners) {
      listener();
    }
  }

  private async run<T>(method: Method, args: unknown[], standard: () => T): Promise<T> {
    if (!this.connectedState) {
      throw new LedgerTransportError(`${method} failed: not connected`);
    }
    this.endpoint.calls.push({ method, args });
    const override = this.endpoint.overrideFor(method);
    // Let pending work interleave as it would over a real socket.
    await Promise.resolve();
    if (override !== undefined) {
      return (override as (...values: unknown[]) => T)(...args);
    }
    return standard();
  }
}

/** Re-stamps a fixture entry into `ledgerIndex` at `position`, keeping it self-consistent. */
export function stampEntry(
  entry: Record<string, unknown>,
  ledgerIndex: number,
  position: number,
  networkId: number,
): Record<string, unknown> {
  const copy = structuredClone(entry);
  const tx = copy.tx_json as Record<string, unknown>;
  const meta = copy.meta as Record<string, unknown>;
  const transactionIndex = typeof copy.__keepIndex === 'number' ? copy.__keepIndex : position;
  delete copy.__keepIndex;
  meta.TransactionIndex = transactionIndex;
  copy.ledger_index = ledgerIndex;
  tx.ledger_index = ledgerIndex;
  tx.ctid = ctid(ledgerIndex, transactionIndex, networkId);
  return copy;
}

export function ctid(ledgerIndex: number, transactionIndex: number, networkId: number): string {
  return (
    ((0xc0000000n + BigInt(ledgerIndex)) << 32n) +
    (BigInt(transactionIndex) << 16n) +
    BigInt(networkId)
  )
    .toString(16)
    .toUpperCase();
}

/** The live stream shape of an account_tx entry (API v2: ctid at top level). */
export function streamMessage(entry: Record<string, unknown>): TransactionStreamMessage {
  const tx = structuredClone(entry.tx_json) as Record<string, unknown>;
  const topCtid = tx.ctid;
  delete tx.ctid;
  return {
    type: 'transaction',
    status: 'closed',
    validated: true,
    engine_result: (entry.meta as Record<string, unknown>).TransactionResult,
    hash: entry.hash,
    ledger_hash: entry.ledger_hash,
    ledger_index: entry.ledger_index,
    close_time_iso: entry.close_time_iso,
    ctid: topCtid,
    tx_json: tx,
    meta: structuredClone(entry.meta),
  };
}
