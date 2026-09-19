import { createHmac } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { ERROR_CODES, ERROR_HTTP_STATUS } from '../../src/common/errors/api-error';
import type { AppConfigService } from '../../src/config/config.service';
import { enabledLogLevels, validateConfig } from '../../src/config/config.validation';
import { decodePaymentCursor, encodePaymentCursor } from '../../src/payments/payments.service';
import { Lease, ReconciliationLockService } from '../../src/redis/reconciliation-lock.service';
import { signatureHeader, signWebhookBody } from '../../src/webhooks/webhook-signature';
import {
  ConnectionManagerService,
  endpointProblem,
  reconnectDelayMs,
} from '../../src/xrpl/connection-manager.service';
import {
  FakeLedgerNetwork,
  PRIMARY_URL,
  SECONDARY_URL,
  transportFailure,
} from '../fakes/fake-ledger-client';

const env = {
  DATABASE_URL: 'postgresql://user:db-password@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
  XRPL_PRIMARY_URL: 'wss://one.example/',
  XRPL_SECONDARY_URL: 'wss://two.example/',
};
const SECRET = 'a-webhook-secret-that-is-32-bytes!';

describe('configuration', () => {
  it('applies defaults and leaves delivery disabled without a webhook', () => {
    expect(validateConfig(env)).toMatchObject({
      xrplNetworkId: 1,
      logLevel: 'log',
      port: 3000,
      webhook: undefined,
    });
  });

  it('requires the webhook URL and secret together', () => {
    expect(() => validateConfig({ ...env, WEBHOOK_URL: 'http://localhost:9/hook' })).toThrow(
      /WEBHOOK_SECRET is missing/,
    );
    expect(() => validateConfig({ ...env, WEBHOOK_SECRET: SECRET })).toThrow(
      /WEBHOOK_URL is missing/,
    );
    expect(
      validateConfig({ ...env, WEBHOOK_URL: 'http://localhost:9/hook', WEBHOOK_SECRET: SECRET })
        .webhook,
    ).toEqual({
      url: 'http://localhost:9/hook',
      secret: SECRET,
    });
  });

  it('rejects short secrets, credentials in the URL and other schemes, without echoing secrets', () => {
    const cases = [
      { WEBHOOK_URL: 'http://localhost/hook', WEBHOOK_SECRET: 'short' },
      { WEBHOOK_URL: 'https://user:pass@example.com/hook', WEBHOOK_SECRET: SECRET },
      { WEBHOOK_URL: 'ftp://example.com/hook', WEBHOOK_SECRET: SECRET },
    ];
    for (const extra of cases) {
      try {
        validateConfig({ ...env, ...extra });
        throw new Error('expected rejection');
      } catch (error) {
        const message = (error as Error).message;
        expect(message).toMatch(/WEBHOOK/);
        expect(message).not.toContain('pass@');
        expect(message).not.toContain(SECRET);
        expect(message).not.toContain('db-password');
      }
    }
  });

  it('measures the secret in UTF-8 bytes', () => {
    // 11 characters of 3 bytes each: 33 bytes.
    expect(
      validateConfig({ ...env, WEBHOOK_URL: 'http://localhost/h', WEBHOOK_SECRET: '€'.repeat(11) })
        .webhook,
    ).toBeDefined();
  });

  it('bounds the network ID to 0..65535 and requires every endpoint', () => {
    expect(() => validateConfig({ ...env, XRPL_NETWORK_ID: '65536' })).toThrow(/XRPL_NETWORK_ID/);
    expect(() => validateConfig({})).toThrow(/REDIS_URL is required/);
    expect(() => validateConfig({ ...env, XRPL_SECONDARY_URL: env.XRPL_PRIMARY_URL })).toThrow(
      /different/,
    );
  });

  it('supports the four log levels', () => {
    expect(enabledLogLevels('error')).toEqual(['fatal', 'error']);
    expect(enabledLogLevels('debug')).toEqual(['fatal', 'error', 'warn', 'log', 'debug']);
    expect(() => validateConfig({ ...env, LOG_LEVEL: 'verbose' })).toThrow(/LOG_LEVEL/);
  });
});

describe('error contract', () => {
  it('has exactly the specified codes', () => {
    expect([...ERROR_CODES].sort()).toEqual(
      [
        'VALIDATION_ERROR',
        'SERVICE_NOT_READY',
        'ACCOUNT_NOT_FOUND',
        'ACCOUNT_ALREADY_MONITORED',
        'ACCOUNT_LIMIT_REACHED',
        'ACCOUNT_ACTIVATION_FAILED',
        'ACCOUNT_NOT_MONITORED',
        'ACCOUNT_DISABLE_FAILED',
        'PAYMENT_NOT_FOUND',
        'INVALID_CURSOR',
        'INTERNAL_ERROR',
      ].sort(),
    );
    expect(ERROR_HTTP_STATUS).toMatchObject({
      ACCOUNT_NOT_FOUND: 422,
      ACCOUNT_DISABLE_FAILED: 503,
      INVALID_CURSOR: 400,
    });
  });
});

describe('webhook signature', () => {
  it('is HMAC-SHA256 of the exact body, lowercase hex', () => {
    const body = '{"eventId":"e","type":"payment.validated"}';
    const expected = createHmac('sha256', SECRET).update(body, 'utf8').digest('hex');
    expect(signWebhookBody(body, SECRET)).toBe(expected);
    expect(signatureHeader(body, SECRET)).toBe(`sha256=${expected}`);
    expect(expected).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is stable for the same body and changes with any byte', () => {
    const body = '{"a":1}';
    expect(signWebhookBody(body, SECRET)).toBe(signWebhookBody(body, SECRET));
    expect(signWebhookBody('{"a":2}', SECRET)).not.toBe(signWebhookBody(body, SECRET));
    expect(signWebhookBody('{"a": 1}', SECRET)).not.toBe(signWebhookBody(body, SECRET));
  });
});

describe('payment cursor', () => {
  it('round-trips the documented payload', () => {
    const cursor = {
      ledgerIndex: 123456,
      transactionIndex: 4,
      id: '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b',
    };
    const encoded = encodePaymentCursor(cursor);
    expect(JSON.parse(Buffer.from(encoded, 'base64url').toString())).toEqual({
      l: '123456',
      t: 4,
      i: cursor.id,
    });
    expect(decodePaymentCursor(encoded)).toEqual(cursor);
  });

  it.each(['', 'x', Buffer.from('{"l":1,"t":4,"i":"x"}').toString('base64url')])(
    'rejects %p',
    (value) => {
      expect(() => decodePaymentCursor(value)).toThrow('cursor is not valid');
    },
  );
});

describe('lease', () => {
  function lease(refreshes: boolean[]): Lease {
    const locks = { refresh: jest.fn(() => Promise.resolve(refreshes.shift() ?? false)) };
    return new Lease('key', 'token', locks as unknown as ReconciliationLockService);
  }

  it('stays owned while refreshes succeed', async () => {
    const held = lease([true, true]);
    await held.assertOwned();
    expect(held.isLost).toBe(false);
  });

  it('is lost for good after one failed refresh', async () => {
    const held = lease([false, true]);
    await expect(held.assertOwned()).rejects.toThrow('lease lost');
    expect(await held.refresh()).toBe(false);
    expect(held.isLost).toBe(true);
  });
});

describe('connection manager', () => {
  const config = {
    networkId: 1,
    primaryUrl: PRIMARY_URL,
    secondaryUrl: SECONDARY_URL,
  } as unknown as AppConfigService;
  const info = (overrides = {}) => ({
    networkId: 1,
    serverState: 'full',
    buildVersion: '3.4.0',
    validatedLedger: { index: 10, ageSeconds: 2 },
    ...overrides,
  });

  it('accepts only a fresh, synced endpoint on the configured network', () => {
    expect(endpointProblem(info(), 1)).toBeUndefined();
    for (const state of ['tracking', 'validating', 'proposing']) {
      expect(endpointProblem(info({ serverState: state }), 1)).toBeUndefined();
    }
    expect(endpointProblem(info({ networkId: 0 }), 1)).toMatch(/network_id/);
    for (const state of ['disconnected', 'connected', 'syncing']) {
      expect(endpointProblem(info({ serverState: state }), 1)).toMatch(/server_state/);
    }
    expect(endpointProblem(info({ validatedLedger: undefined }), 1)).toMatch(/no validated ledger/);
    expect(endpointProblem(info({ validatedLedger: { index: 1, ageSeconds: 20 } }), 1)).toMatch(
      /old/,
    );
  });

  it('backs off 1s, 2s, 5s, 10s, then 30s', () => {
    expect([0, 1, 2, 3, 4, 9].map(reconnectDelayMs)).toEqual([
      1000, 2000, 5000, 10000, 30000, 30000,
    ]);
  });

  it('subscribes the ledger stream and accounts in order, on one client at a time', async () => {
    const network = new FakeLedgerNetwork();
    const manager = new ConnectionManagerService(config, network.factory);
    manager.setAccounts(['rAccountOne', 'rAccountTwo']);
    await manager.start();

    expect(network.primary.calls.map((call) => call.method)).toEqual([
      'getServerInfo',
      'subscribeLedger',
      'subscribeAccounts',
    ]);
    expect(network.primary.live()?.subscriptions()).toEqual(['rAccountOne', 'rAccountTwo']);

    network.primary.override('getValidatedLedgerIndex', transportFailure);
    expect(await manager.getValidatedLedgerIndex()).toBe(1000);
    expect(manager.status().endpoint).toBe('secondary');
    expect(network.secondary.live()?.subscriptions()).toEqual(['rAccountOne', 'rAccountTwo']);
    expect(network.maxConnectedAtOnce).toBe(1);

    // No automatic failback once the primary recovers.
    network.primary.clearOverride('getValidatedLedgerIndex');
    await manager.getValidatedLedgerIndex();
    expect(manager.status().endpoint).toBe('secondary');
    await manager.stop();
  });

  it('refuses an endpoint on another network and keeps the process alive', async () => {
    const network = new FakeLedgerNetwork();
    network.ledger.networkId = 0;
    const manager = new ConnectionManagerService(config, network.factory);
    await manager.start();
    expect(manager.isReady()).toBe(false);
    expect(network.connectedNow).toBe(0);
    await manager.stop();
  });
});

describe('security boundary', () => {
  const root = path.join(__dirname, '..', '..', 'src');
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const full = path.join(dir, name);
      return statSync(full).isDirectory() ? files(full) : full.endsWith('.ts') ? [full] : [];
    });

  it('has no wallet, seed, signing or submission code in src/', () => {
    const forbidden =
      /\bWallet\b|fromSeed|fundWallet|walletFromSecretNumbers|\bsubmitAndWait\b|command:\s*'submit'|\.sign\(|\bmnemonic\b|privateKey|secretNumbers/;
    const offenders = files(root).filter((file) => forbidden.test(readFileSync(file, 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('creates xrpl.Client only inside src/xrpl', () => {
    const offenders = files(root).filter(
      (file) =>
        /new Client\(/.test(readFileSync(file, 'utf8')) &&
        !file.includes(`${path.sep}xrpl${path.sep}`),
    );
    expect(offenders).toEqual([]);
  });
});
