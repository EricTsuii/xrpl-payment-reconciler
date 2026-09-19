import { Client, ConnectionError, RippledError } from 'xrpl';
import type { Request } from 'xrpl';
import {
  ACCOUNT_TX_LIMIT,
  XRPL_CONNECT_TIMEOUT_MS,
  XRPL_REQUEST_TIMEOUT_MS,
} from '../common/constants';
import { LedgerClient, LedgerServerError, LedgerTransportError } from './ledger-client.interface';
import {
  AccountInfoResult,
  AccountTransactionPage,
  AccountTransactionRequest,
  asRecord,
  LedgerClosedEvent,
  parseAccountInfo,
  parseAccountTransactionPage,
  parseServerInfo,
  parseValidatedLedgerIndex,
  ServerInfo,
  TransactionStreamMessage,
} from './types';

/**
 * The only place in the service that instantiates xrpl.Client. It reads the
 * ledger and manages subscriptions; it never signs or submits.
 */
export class XrplLedgerClient implements LedgerClient {
  private readonly client: Client;
  private ledgerListeners: ((event: LedgerClosedEvent) => void)[] = [];
  private transactionListeners: ((message: TransactionStreamMessage) => void)[] = [];
  private disconnectListeners: (() => void)[] = [];
  private closing = false;

  constructor(readonly url: string) {
    this.client = new Client(url, {
      connectionTimeout: XRPL_CONNECT_TIMEOUT_MS,
      timeout: XRPL_REQUEST_TIMEOUT_MS,
    });
    this.client.on('ledgerClosed', (ledger) => {
      const event: LedgerClosedEvent = {
        ledgerIndex: ledger.ledger_index,
        ledgerHash: ledger.ledger_hash,
        networkId: ledger.network_id,
      };
      for (const listener of this.ledgerListeners) {
        listener(event);
      }
    });
    this.client.on('transaction', (message) => {
      const raw = asRecord(message);
      if (raw === undefined) {
        return;
      }
      for (const listener of this.transactionListeners) {
        listener(raw);
      }
    });
    this.client.on('disconnected', () => {
      if (this.closing) {
        return;
      }
      for (const listener of this.disconnectListeners) {
        listener();
      }
    });
    // Connection-level errors surface through requests and 'disconnected'.
    this.client.on('error', () => undefined);
  }

  async connect(): Promise<void> {
    try {
      await this.client.connect();
    } catch (error) {
      throw new LedgerTransportError(`connect failed: ${describe(error)}`);
    }
  }

  async disconnect(): Promise<void> {
    this.closing = true;
    try {
      await this.client.disconnect();
    } catch {
      // Already closed.
    }
  }

  isConnected(): boolean {
    return this.client.isConnected();
  }

  async getServerInfo(): Promise<ServerInfo> {
    return parseServerInfo(await this.request({ command: 'server_info' }));
  }

  async getValidatedLedgerIndex(): Promise<number> {
    return parseValidatedLedgerIndex(
      await this.request({
        command: 'ledger',
        ledger_index: 'validated',
        transactions: false,
        expand: false,
      }),
    );
  }

  async subscribeLedger(): Promise<void> {
    await this.request({ command: 'subscribe', streams: ['ledger'] });
  }

  async subscribeAccounts(accounts: string[]): Promise<void> {
    if (accounts.length > 0) {
      await this.request({ command: 'subscribe', accounts });
    }
  }

  async unsubscribeAccounts(accounts: string[]): Promise<void> {
    if (accounts.length > 0) {
      await this.request({ command: 'unsubscribe', accounts });
    }
  }

  async getAccountInfo(address: string): Promise<AccountInfoResult> {
    try {
      return parseAccountInfo(
        await this.request({
          command: 'account_info',
          account: address,
          ledger_index: 'validated',
        }),
      );
    } catch (error) {
      if (error instanceof LedgerServerError && error.code === 'actNotFound') {
        return { found: false };
      }
      throw error;
    }
  }

  async getAccountTransactions(
    request: AccountTransactionRequest,
  ): Promise<AccountTransactionPage> {
    return parseAccountTransactionPage(
      await this.request({
        command: 'account_tx',
        account: request.account,
        ledger_index_min: request.ledgerIndexMin,
        ledger_index_max: request.ledgerIndexMax,
        binary: false,
        forward: true,
        limit: ACCOUNT_TX_LIMIT,
        ...(request.marker === undefined ? {} : { marker: request.marker }),
      }),
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

  private async request(fields: Record<string, unknown>): Promise<Record<string, unknown>> {
    const command = String(fields.command);
    try {
      // Every explicit request uses API v2. The command object is sent as-is;
      // typing it as the SDK's union of request shapes adds nothing here.
      const response = await this.client.request({
        api_version: 2,
        ...fields,
      } as unknown as Request);
      return asRecord(response.result) ?? {};
    } catch (error) {
      if (error instanceof ConnectionError) {
        throw new LedgerTransportError(`${command} failed: ${describe(error)}`);
      }
      if (error instanceof RippledError) {
        const data = asRecord(error.data) ?? {};
        const code = typeof data.error === 'string' ? data.error : 'unknownError';
        throw new LedgerServerError(code, `${command} returned ${code}`);
      }
      throw error;
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : 'unknown error';
}
