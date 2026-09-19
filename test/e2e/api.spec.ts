import { randomUUID } from 'node:crypto';
import { classicAddressToXAddress, Wallet } from 'xrpl';
import { entry, ISSUER, MONITORED } from '../support/entries';
import { counts, startTestApp, type TestApp } from '../support/test-app';

let t: TestApp;

beforeEach(async () => {
  t = await startTestApp();
});

afterEach(async () => {
  await t.close();
});

async function activate(address = MONITORED, label?: string): Promise<string> {
  const response = await t
    .http()
    .post('/v1/accounts')
    .send(label === undefined ? { address } : { address, label })
    .expect(201);
  return response.body.data.id as string;
}

describe('accounts API', () => {
  it('creates, lists and rejects duplicates', async () => {
    const created = await t
      .http()
      .post('/v1/accounts')
      .send({ address: MONITORED, label: 'Treasury' })
      .expect(201);
    expect(created.body.data).toStrictEqual({
      id: expect.any(String) as string,
      networkId: 1,
      address: MONITORED,
      label: 'Treasury',
      enabled: true,
      lastReconciledLedger: 1000,
      createdAt: expect.any(String) as string,
    });

    const list = await t.http().get('/v1/accounts').expect(200);
    expect(list.body.data.items).toHaveLength(1);
    expect(list.body.data.items[0]).toHaveProperty('lastReconciledAt');

    const duplicate = await t.http().post('/v1/accounts').send({ address: MONITORED }).expect(409);
    expect(duplicate.body.error.code).toBe('ACCOUNT_ALREADY_MONITORED');
  });

  it('validates the request', async () => {
    const xAddress = classicAddressToXAddress(MONITORED, false, false);
    for (const body of [
      { address: xAddress },
      { address: 'rNotAnAddress' },
      { address: MONITORED, label: 'x'.repeat(121) },
      { address: MONITORED, seed: 'sEd...' },
      {},
    ]) {
      const response = await t.http().post('/v1/accounts').send(body).expect(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    }
  });

  it('refuses an account that does not exist on the ledger', async () => {
    const response = await t
      .http()
      .post('/v1/accounts')
      .send({ address: Wallet.generate().classicAddress })
      .expect(422);
    expect(response.body.error.code).toBe('ACCOUNT_NOT_FOUND');
  });

  it('enforces the 25 enabled accounts limit', async () => {
    for (let n = 0; n < 25; n += 1) {
      const address = Wallet.generate().classicAddress;
      t.network.ledger.accounts.add(address);
      await activate(address);
    }
    const extra = Wallet.generate().classicAddress;
    t.network.ledger.accounts.add(extra);
    const response = await t.http().post('/v1/accounts').send({ address: extra }).expect(409);
    expect(response.body.error.code).toBe('ACCOUNT_LIMIT_REACHED');
  });

  it('answers 404 for an account that is not monitored', async () => {
    const missing = await t.http().delete(`/v1/accounts/${randomUUID()}`).expect(404);
    expect(missing.body.error.code).toBe('ACCOUNT_NOT_MONITORED');
    const id = await activate();
    await t.http().delete(`/v1/accounts/${id}`).expect(204);
    const again = await t.http().delete(`/v1/accounts/${id}`).expect(404);
    expect(again.body.error.code).toBe('ACCOUNT_NOT_MONITORED');
  });
});

describe('payments API', () => {
  beforeEach(async () => {
    await activate();
    t.network.closeLedger([
      entry('payment.xrp', { destinationTag: 7 }),
      entry('payment.xrp-no-tag'),
      entry('payment.issued'),
    ]);
    t.network.closeLedger([entry('payment.xrp', { destinationTag: 7, drops: '25000001' })]);
    await t.settle();
    expect(await counts(t.database)).toEqual({ payments: 4, outbox: 4 });
  });

  it('lists newest first with a keyset cursor', async () => {
    const seen: { ledgerIndex: number; transactionIndex: number }[] = [];
    let cursor: string | null = null;
    do {
      const query: string = cursor === null ? '?limit=1' : `?limit=1&cursor=${cursor}`;
      const page = await t.http().get(`/v1/payments${query}`).expect(200);
      seen.push(...(page.body.data.items as { ledgerIndex: number; transactionIndex: number }[]));
      cursor = page.body.data.nextCursor as string | null;
    } while (cursor !== null);

    expect(seen).toHaveLength(4);
    const order = seen.map((p) => [p.ledgerIndex, p.transactionIndex]);
    expect(order).toEqual(
      [...order].sort((a, b) => (b[0] ?? 0) - (a[0] ?? 0) || (b[1] ?? 0) - (a[1] ?? 0)),
    );
  });

  it('represents XRP and issued amounts exactly, without raw data in lists', async () => {
    const list = await t.http().get('/v1/payments').expect(200);
    const items = list.body.data.items as Record<string, unknown>[];
    expect(items[0]).toMatchObject({
      asset: { type: 'XRP', drops: '25000001', xrp: '25.000001' },
      destinationTag: 7,
    });
    expect(
      items.find((p) => (p.asset as { type: string }).type === 'ISSUED_CURRENCY'),
    ).toMatchObject({
      asset: { type: 'ISSUED_CURRENCY', currency: 'USD', issuer: ISSUER, value: '12.345' },
      destinationTag: null,
    });
    for (const item of items) {
      expect(item).not.toHaveProperty('rawTransaction');
      expect(item.ctid).toMatch(/^C[A-F0-9]{15}$/);
      expect(item.hash).toMatch(/^[A-F0-9]{64}$/);
    }
  });

  it('filters by account, destination tag and asset type', async () => {
    const accounts = await t.http().get('/v1/accounts').expect(200);
    const accountId = accounts.body.data.items[0].id as string;
    expect(
      (await t.http().get(`/v1/payments?accountId=${accountId}`).expect(200)).body.data.items,
    ).toHaveLength(4);
    expect(
      (await t.http().get('/v1/payments?destinationTag=7').expect(200)).body.data.items,
    ).toHaveLength(2);
    expect(
      (await t.http().get('/v1/payments?assetType=ISSUED_CURRENCY').expect(200)).body.data.items,
    ).toHaveLength(1);
  });

  it('returns details by id and by hash, with raw ledger data', async () => {
    const list = await t.http().get('/v1/payments?limit=1').expect(200);
    const { id, hash } = list.body.data.items[0] as { id: string; hash: string };

    const byId = await t.http().get(`/v1/payments/${id}`).expect(200);
    expect(byId.body.data).toMatchObject({ id, hash });
    expect(byId.body.data.rawTransaction).toMatchObject({ TransactionType: 'Payment' });
    expect(byId.body.data.rawMetadata).toHaveProperty('delivered_amount');

    const byHash = await t.http().get(`/v1/payments/by-hash/${hash.toLowerCase()}`).expect(200);
    expect(byHash.body.data.id).toBe(id);
  });

  it('answers errors from the fixed contract', async () => {
    const cases: [string, number, string][] = [
      [`/v1/payments/${randomUUID()}`, 404, 'PAYMENT_NOT_FOUND'],
      [`/v1/payments/by-hash/${'A'.repeat(64)}`, 404, 'PAYMENT_NOT_FOUND'],
      ['/v1/payments/by-hash/xyz', 400, 'VALIDATION_ERROR'],
      ['/v1/payments/not-a-uuid', 400, 'VALIDATION_ERROR'],
      ['/v1/payments?unknown=1', 400, 'VALIDATION_ERROR'],
      ['/v1/payments?limit=101', 400, 'VALIDATION_ERROR'],
      ['/v1/payments?limit=0', 400, 'VALIDATION_ERROR'],
      ['/v1/payments?cursor=not-a-cursor', 400, 'INVALID_CURSOR'],
      ['/v1/nope', 400, 'VALIDATION_ERROR'],
    ];
    for (const [path, status, code] of cases) {
      const response = await t.http().get(path).expect(status);
      expect(response.body.error).toMatchObject({
        code,
        requestId: response.headers['x-request-id'],
      });
      expect(JSON.stringify(response.body)).not.toMatch(/stack|node_modules/);
    }
  });
});

describe('health and status', () => {
  it('reports liveness, readiness and status without secrets', async () => {
    expect((await t.http().get('/healthz').expect(200)).body).toEqual({ status: 'ok' });
    expect((await t.http().get('/readyz').expect(200)).body).toEqual({ status: 'ready' });

    const response = await t.http().get('/v1/status').set('X-Request-Id', 'forged').expect(200);
    expect(response.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(response.body.data).toMatchObject({
      database: 'up',
      redis: 'up',
      xrpl: { connected: true, endpoint: 'primary', networkId: 1, validatedLedger: 1000 },
      reconciliation: { status: 'HEALTHY', enabledAccounts: 0, minimumCursor: null },
      outbox: { deliveryEnabled: false, pending: 0, dead: 0 },
    });
    const text = JSON.stringify(response.body);
    for (const secret of ['postgresql://', 'redis://', 'reconciler_local_only', 'wss://']) {
      expect(text).not.toContain(secret);
    }
  });
});
