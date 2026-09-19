import { Inject, Injectable, Logger } from '@nestjs/common';
import { RECONNECT_BACKOFF_MS, VALIDATED_LEDGER_MAX_AGE_SECONDS } from '../common/constants';
import { AppConfigService } from '../config/config.service';
import {
  LEDGER_CLIENT_FACTORY,
  LedgerClient,
  LedgerClientFactory,
  LedgerTransportError,
} from './ledger-client.interface';
import {
  AccountInfoResult,
  AccountTransactionPage,
  AccountTransactionRequest,
  LedgerResponseFormatError,
  ServerInfo,
  TransactionStreamMessage,
} from './types';

export type EndpointName = 'primary' | 'secondary';

export interface ConnectionStatus {
  connected: boolean;
  endpoint: EndpointName | null;
  networkId: number | null;
  validatedLedger: number | null;
  lastLedgerSeenAt: string | null;
}

/** No XRPL endpoint could serve the request. */
export class XrplUnavailableError extends Error {
  constructor(message = 'no usable XRPL endpoint is available') {
    super(message);
    this.name = 'XrplUnavailableError';
  }
}

class EndpointUnusableError extends Error {
  constructor(endpoint: EndpointName, reason: string) {
    super(`${endpoint} endpoint unusable: ${reason}`);
    this.name = 'EndpointUnusableError';
  }
}

const USABLE_SERVER_STATES: ReadonlySet<string> = new Set([
  'tracking',
  'full',
  'validating',
  'proposing',
]);

interface ActiveEndpoint {
  name: EndpointName;
  client: LedgerClient;
}

/** Reconnect delay for the n-th consecutive failed round (0-based). */
export function reconnectDelayMs(attempt: number): number {
  return (
    RECONNECT_BACKOFF_MS[attempt] ?? RECONNECT_BACKOFF_MS[RECONNECT_BACKOFF_MS.length - 1] ?? 30_000
  );
}

/** Why an endpoint may not be used, or undefined when it is usable. */
export function endpointProblem(info: ServerInfo, networkId: number): string | undefined {
  if (info.networkId !== networkId) {
    return `network_id ${String(info.networkId)} does not match configured ${networkId}`;
  }
  if (!USABLE_SERVER_STATES.has(info.serverState)) {
    return `server_state ${info.serverState} is not usable`;
  }
  if (info.validatedLedger === undefined) {
    return 'server has no validated ledger';
  }
  if (info.validatedLedger.ageSeconds >= VALIDATED_LEDGER_MAX_AGE_SECONDS) {
    return `validated ledger is ${info.validatedLedger.ageSeconds}s old`;
  }
  return undefined;
}

function otherEndpoint(name: EndpointName): EndpointName {
  return name === 'primary' ? 'secondary' : 'primary';
}

/**
 * Owns the single XRPL connection and its subscriptions. At most one
 * LedgerClient is connected at any time: the old one is always disconnected
 * before another endpoint is tried, and history recovery never opens a
 * parallel client. After a failover the service stays on the alternate
 * endpoint; there is no automatic failback.
 */
@Injectable()
export class ConnectionManagerService {
  private readonly logger = new Logger('ConnectionManager');
  private active: ActiveEndpoint | undefined;
  private preferred: EndpointName = 'primary';
  private switching: Promise<ActiveEndpoint> | undefined;
  private latestValidatedLedger: number | undefined;
  private lastLedgerSeenAt: Date | undefined;
  private reconnectAttempt = 0;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private stopped = false;

  /** Accounts that must be subscribed on whichever endpoint is active. */
  private readonly accounts = new Set<string>();
  private readonly transactionListeners: ((message: TransactionStreamMessage) => void)[] = [];
  private readonly connectedListeners: ((endpoint: EndpointName) => void)[] = [];

  constructor(
    private readonly config: AppConfigService,
    @Inject(LEDGER_CLIENT_FACTORY) private readonly createClient: LedgerClientFactory,
  ) {}

  /** Live transaction messages from the active endpoint only. */
  onTransaction(listener: (message: TransactionStreamMessage) => void): void {
    this.transactionListeners.push(listener);
  }

  /** Called after every successful bootstrap: startup, reconnect, failover. */
  onConnected(listener: (endpoint: EndpointName) => void): void {
    this.connectedListeners.push(listener);
  }

  /** The accounts to subscribe on the first connection. */
  setAccounts(addresses: Iterable<string>): void {
    this.accounts.clear();
    for (const address of addresses) {
      this.accounts.add(address);
    }
  }

  /** First connection attempt; on failure the backoff loop keeps trying. */
  async start(): Promise<void> {
    try {
      await this.connection();
    } catch {
      // Scheduled reconnect already running; readiness reports the outage.
    }
  }

  isReady(): boolean {
    return this.active !== undefined;
  }

  status(): ConnectionStatus {
    const active = this.active;
    return {
      connected: active !== undefined,
      endpoint: active?.name ?? null,
      networkId: active === undefined ? null : this.config.networkId,
      validatedLedger: active === undefined ? null : (this.latestValidatedLedger ?? null),
      lastLedgerSeenAt: this.lastLedgerSeenAt?.toISOString() ?? null,
    };
  }

  getValidatedLedgerIndex(): Promise<number> {
    return this.call((client) => client.getValidatedLedgerIndex());
  }

  getAccountInfo(address: string): Promise<AccountInfoResult> {
    return this.call((client) => client.getAccountInfo(address));
  }

  getAccountTransactions(request: AccountTransactionRequest): Promise<AccountTransactionPage> {
    return this.call((client) => client.getAccountTransactions(request));
  }

  /** Subscribes an account now and on every future endpoint. */
  async subscribeAccount(address: string): Promise<void> {
    this.accounts.add(address);
    try {
      await this.call((client) => client.subscribeAccounts([address]));
    } catch (error) {
      this.accounts.delete(address);
      throw error;
    }
  }

  /** Unsubscribes an account and waits for the server to confirm. */
  async unsubscribeAccount(address: string): Promise<void> {
    await this.call((client) => client.unsubscribeAccounts([address]));
    this.accounts.delete(address);
  }

  /**
   * Abandons the active endpoint and switches to the alternate one: used when
   * the active endpoint lacks the account history a reconciliation needs.
   */
  async switchEndpoint(reason: string): Promise<void> {
    const current = this.active;
    if (current === undefined) {
      await this.connection();
      return;
    }
    await this.failover(current.client, reason);
  }

  /** Disconnects and stops reconnecting. Part of the shutdown sequence. */
  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    await this.switching?.catch(() => undefined);
    await this.release();
  }

  /**
   * Runs one request on the active endpoint. A transport failure or an
   * unreadable response causes one sequential failover and one retry.
   */
  private async call<T>(work: (client: LedgerClient) => Promise<T>): Promise<T> {
    const first = await this.connection();
    try {
      return await work(first.client);
    } catch (error) {
      if (!isEndpointFailure(error)) {
        throw error;
      }
      this.logger.warn(`request failed on ${first.name}: ${describe(error)}`);
    }

    const second = await this.failover(first.client, 'request failure');
    try {
      return await work(second.client);
    } catch (error) {
      if (!isEndpointFailure(error)) {
        throw error;
      }
      this.logger.warn(`request failed on ${second.name}: ${describe(error)}`);
      if (this.active?.client === second.client && this.switching === undefined) {
        await this.release();
        this.scheduleReconnect();
      }
      throw new XrplUnavailableError();
    }
  }

  private connection(): Promise<ActiveEndpoint> {
    if (this.stopped) {
      return Promise.reject(new XrplUnavailableError('connection manager stopped'));
    }
    if (this.active !== undefined) {
      return Promise.resolve(this.active);
    }
    if (this.switching !== undefined) {
      return this.switching;
    }
    return this.track(this.connectInOrder([this.preferred, otherEndpoint(this.preferred)]));
  }

  private failover(failed: LedgerClient, reason: string): Promise<ActiveEndpoint> {
    if (this.switching !== undefined) {
      return this.switching;
    }
    if (this.active === undefined || this.active.client !== failed) {
      return this.connection();
    }
    const alternate = otherEndpoint(this.active.name);
    this.logger.warn(`failing over from ${this.active.name} to ${alternate}: ${reason}`);
    return this.track(
      (async () => {
        await this.release();
        this.preferred = alternate;
        return this.connectInOrder([alternate]);
      })(),
    );
  }

  private track(work: Promise<ActiveEndpoint>): Promise<ActiveEndpoint> {
    const tracked = work.finally(() => {
      if (this.switching === tracked) {
        this.switching = undefined;
      }
    });
    this.switching = tracked;
    return tracked;
  }

  private async connectInOrder(order: EndpointName[]): Promise<ActiveEndpoint> {
    for (const name of order) {
      if (this.stopped) {
        break;
      }
      try {
        const endpoint = await this.bootstrap(name);
        this.active = endpoint;
        this.preferred = name;
        this.reconnectAttempt = 0;
        this.logger.log(`XRPL ${name} endpoint active with ${this.accounts.size} account(s)`);
        for (const listener of this.connectedListeners) {
          listener(name);
        }
        return endpoint;
      } catch (error) {
        this.logger.warn(`XRPL ${name} endpoint bootstrap failed: ${describe(error)}`);
      }
    }
    this.scheduleReconnect();
    throw new XrplUnavailableError();
  }

  /** connect → server_info checks → subscribe ledger → subscribe accounts. */
  private async bootstrap(name: EndpointName): Promise<ActiveEndpoint> {
    const url = name === 'primary' ? this.config.primaryUrl : this.config.secondaryUrl;
    const client = this.createClient(url);
    try {
      await client.connect();
      const info = await client.getServerInfo();
      const problem = endpointProblem(info, this.config.networkId);
      if (problem !== undefined) {
        throw new EndpointUnusableError(name, problem);
      }

      client.onLedgerClosed((event) => {
        if (this.active?.client !== client) {
          return;
        }
        if (event.networkId !== undefined && event.networkId !== this.config.networkId) {
          void this.failover(client, `ledger stream network_id ${event.networkId}`).catch(
            () => undefined,
          );
          return;
        }
        if (
          this.latestValidatedLedger === undefined ||
          event.ledgerIndex > this.latestValidatedLedger
        ) {
          this.latestValidatedLedger = event.ledgerIndex;
        }
        this.lastLedgerSeenAt = new Date();
      });
      client.onTransaction((message) => {
        if (this.active?.client !== client) {
          return;
        }
        for (const listener of this.transactionListeners) {
          listener(message);
        }
      });
      client.onDisconnected(() => {
        if (this.active?.client === client) {
          void this.failover(client, 'connection lost').catch(() => undefined);
        }
      });

      await client.subscribeLedger();
      await client.subscribeAccounts([...this.accounts]);

      this.latestValidatedLedger = info.validatedLedger?.index;
      this.lastLedgerSeenAt = new Date();
      return { name, client };
    } catch (error) {
      client.removeAllListeners();
      await client.disconnect();
      throw error;
    }
  }

  private async release(): Promise<void> {
    const current = this.active;
    this.active = undefined;
    if (current !== undefined) {
      current.client.removeAllListeners();
      await current.client.disconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer !== undefined) {
      return;
    }
    const delay = reconnectDelayMs(this.reconnectAttempt);
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connection().catch(() => undefined);
    }, delay);
    this.reconnectTimer.unref();
  }
}

function isEndpointFailure(error: unknown): boolean {
  return error instanceof LedgerTransportError || error instanceof LedgerResponseFormatError;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error';
}
