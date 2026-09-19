import { sql } from 'drizzle-orm';
import { LedgerServerError } from '../../src/xrpl/ledger-client.interface';
import { FakeLedgerNetwork, transportFailure } from '../fakes/fake-ledger-client';
import { entry, MONITORED } from '../support/entries';
import { counts, startTestApp, type TestApp } from '../support/test-app';
import { waitFor } from '../support/wait';

let t: TestApp;

afterEach(async () => {
  await t.close();
});

async function activate(address = MONITORED): Promise<string> {
  const response = await t.http().post('/v1/accounts').send({ address }).expect(201);
  return response.body.data.id as string;
}

async function cursorOf(id: string): Promise<number> {
  const result = await t.database.db.execute<{ ledger: string }>(
    sql`SELECT last_reconciled_ledger::text AS ledger FROM account_cursors WHERE account_id = ${id}`,
  );
  return Number(result.rows[0]?.ledger);
}

async function paymentRows(): Promise<
  { hash: string; value: string | null; drops: string | null }[]
> {
  const result = await t.database.db.execute<{
    hash: string;
    value: string | null;
    drops: string | null;
  }>(
    sql`SELECT transaction_hash AS hash, value, drops::text AS drops FROM payments ORDER BY ledger_index, transaction_index`,
  );
  return result.rows;
}

describe('live path', () => {
  it('records a validated live payment without moving the cursor', async () => {
    t = await startTestApp();
    const id = await activate();
    const before = await cursorOf(id);

    const payment = entry('payment.xrp');
    t.network.closeLedger([payment]);
    await t.live.drain();

    expect(await counts(t.database)).toEqual({ payments: 1, outbox: 1 });
    expect(await cursorOf(id)).toBe(before);

    await t.reconciliation.runCycle();
    expect(await cursorOf(id)).toBe(t.network.ledger.validatedLedger);
  });

  it('ignores stream messages that are not validated', async () => {
    t = await startTestApp();
    await activate();
    const client = t.network.primary.live();
    const payment = entry('payment.xrp');
    client?.emitTransaction({ ...payment, validated: false });
    await t.live.drain();
    expect(await counts(t.database)).toEqual({ payments: 0, outbox: 0 });
  });
});

describe('live and backfill convergence', () => {
  it('stores a payment seen live and again through account_tx once', async () => {
    t = await startTestApp();
    await activate();
    t.network.closeLedger([entry('payment.xrp')]);
    await t.live.drain();
    await t.reconciliation.runCycle();
    await t.reconciliation.runCycle();

    expect(await counts(t.database)).toEqual({ payments: 1, outbox: 1 });
  });
});

describe('recovery', () => {
  it('recovers a payment missed during a disconnect through the secondary endpoint', async () => {
    t = await startTestApp();
    await activate();

    t.network.primary.failConnect = true;
    t.network.primary.live()?.dropConnection();
    const missed = entry('payment.xrp');
    t.network.closeLedger([missed], { live: false });

    await waitFor(() => t.network.secondary.live() !== undefined, 'secondary connection');
    await waitFor(async () => (await counts(t.database)).payments === 1, 'recovered payment');
    await t.settle();

    expect(await counts(t.database)).toEqual({ payments: 1, outbox: 1 });
    expect((await paymentRows())[0]?.hash).toBe(missed.hash);
    expect(t.network.maxConnectedAtOnce).toBe(1);
    expect(t.network.secondary.live()?.subscriptions()).toContain(MONITORED);
  });

  it('closes the registration race between H0 and H1', async () => {
    t = await startTestApp();
    const racing = entry('payment.xrp');
    // The payment validates after H0 is captured but before H1, while the
    // subscription is being made: the live event cannot be relied on.
    t.network.primary.override('subscribeAccounts', () => {
      t.network.closeLedger([racing], { live: false });
    });

    await activate();

    const rows = await paymentRows();
    expect(rows.map((row) => row.hash)).toEqual([racing.hash]);
    expect(await counts(t.database)).toEqual({ payments: 1, outbox: 1 });
  });

  it('replays a range safely after a crash before the cursor update', async () => {
    t = await startTestApp();
    const id = await activate();
    const start = await cursorOf(id);
    t.network.closeLedger([entry('payment.xrp'), entry('payment.issued')], { live: false });

    // The cursor update fails as if the process died right before it.
    await t.database.db.execute(
      sql.raw(
        `ALTER TABLE account_cursors ADD CONSTRAINT test_crash CHECK (last_reconciled_ledger <= ${start})`,
      ),
    );
    try {
      await t.reconciliation.runCycle();
      expect(await counts(t.database)).toEqual({ payments: 2, outbox: 2 });
      expect(await cursorOf(id)).toBe(start);
    } finally {
      await t.database.db.execute(
        sql.raw('ALTER TABLE account_cursors DROP CONSTRAINT test_crash'),
      );
    }

    await t.reconciliation.runCycle();
    expect(await counts(t.database)).toEqual({ payments: 2, outbox: 2 });
    expect(await cursorOf(id)).toBe(t.network.ledger.validatedLedger);
  });

  it('catches up after a restart without any API call', async () => {
    const network = new FakeLedgerNetwork();
    t = await startTestApp({ network });
    const id = await activate();
    await t.close();

    network.closeLedger([entry('payment.xrp')], { live: false });
    network.advance(3);
    t = await startTestApp({ network, keepData: true });

    expect(await counts(t.database)).toEqual({ payments: 1, outbox: 1 });
    expect(await cursorOf(id)).toBe(network.ledger.validatedLedger);
  });
});

describe('XRPL payment semantics', () => {
  it('stores delivered_amount for a partial payment, never DeliverMax', async () => {
    t = await startTestApp();
    await activate();
    t.network.closeLedger([entry('payment.partial')]);
    await t.settle();

    const rows = await paymentRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.value).toBe('0.5');
  });

  it('ignores a failed validated payment and still moves the cursor', async () => {
    t = await startTestApp();
    const id = await activate();
    t.network.closeLedger([entry('payment.failed')]);
    await t.settle();

    expect(await counts(t.database)).toEqual({ payments: 0, outbox: 0 });
    expect(await cursorOf(id)).toBe(t.network.ledger.validatedLedger);
  });

  it('records only incoming payments among mixed account activity', async () => {
    t = await startTestApp();
    const id = await activate();
    t.network.closeLedger([
      entry('payment.outgoing'),
      entry('payment.self'),
      entry('non-payment.trustset'),
      entry('payment.delivered-unavailable'),
      entry('payment.unsupported-amount'),
      entry('payment.xrp-no-tag'),
    ]);
    await t.settle();

    expect(await counts(t.database)).toEqual({ payments: 1, outbox: 1 });
    expect(await cursorOf(id)).toBe(t.network.ledger.validatedLedger);
  });
});

describe('account_tx correctness path', () => {
  it('consumes every marker page and moves the cursor only after the last one', async () => {
    t = await startTestApp();
    const id = await activate();
    const start = await cursorOf(id);
    t.network.ledger.pageSize = 2;
    const payments = [1, 2, 3, 4, 5].map((n) =>
      entry('payment.xrp', { drops: String(n * 1_000_000) }),
    );
    t.network.closeLedger(payments.slice(0, 3), { live: false });
    t.network.closeLedger(payments.slice(3), { live: false });

    // The third page fails once: nothing may move the cursor yet.
    let pages = 0;
    t.network.primary.pageMutator = (page) => {
      pages += 1;
      if (pages === 3) {
        throw new LedgerServerError('internal', 'account_tx returned internal');
      }
      return page;
    };
    await t.reconciliation.runCycle();
    expect(await cursorOf(id)).toBe(start);
    expect((await counts(t.database)).payments).toBe(4);

    t.network.primary.pageMutator = undefined;
    await t.reconciliation.runCycle();
    expect(await counts(t.database)).toEqual({ payments: 5, outbox: 5 });
    expect(await cursorOf(id)).toBe(t.network.ledger.validatedLedger);
    const markers = t.network.primary.calls
      .filter((call) => call.method === 'getAccountTransactions')
      .map((call) => (call.args[0] as { marker?: unknown }).marker !== undefined);
    expect(markers.filter(Boolean).length).toBeGreaterThanOrEqual(2);
  });

  it('accepts a response without the optional validated flag', async () => {
    t = await startTestApp();
    const id = await activate();
    t.network.primary.pageMutator = (page) => ({ ...page, validated: undefined });
    t.network.closeLedger([entry('payment.xrp')], { live: false });
    await t.reconciliation.runCycle();

    expect((await counts(t.database)).payments).toBe(1);
    expect(await cursorOf(id)).toBe(t.network.ledger.validatedLedger);
  });

  it('rejects a response that says validated=false', async () => {
    t = await startTestApp();
    const id = await activate();
    const start = await cursorOf(id);
    t.network.primary.pageMutator = (page) => ({ ...page, validated: false });
    t.network.closeLedger([entry('payment.xrp')], { live: false });
    await t.reconciliation.runCycle();

    expect(await counts(t.database)).toEqual({ payments: 0, outbox: 0 });
    expect(await cursorOf(id)).toBe(start);
    expect(t.reconciliation.status().status).toBe('DEGRADED');
  });

  it('switches to the secondary when the primary lacks the history', async () => {
    t = await startTestApp();
    const id = await activate();
    t.network.closeLedger([entry('payment.xrp')], { live: false });
    t.network.primary.earliestLedger = t.network.ledger.validatedLedger + 1_000;

    await t.reconciliation.runCycle();

    expect(t.network.secondary.live()).toBeDefined();
    expect(t.network.primary.live()).toBeUndefined();
    expect(await counts(t.database)).toEqual({ payments: 1, outbox: 1 });
    expect(await cursorOf(id)).toBe(t.network.ledger.validatedLedger);
    expect(t.network.maxConnectedAtOnce).toBe(1);
  });

  it('keeps the cursor and reports DEGRADED when no endpoint has the history', async () => {
    t = await startTestApp();
    const id = await activate();
    const start = await cursorOf(id);
    t.network.closeLedger([entry('payment.xrp')], { live: false });
    t.network.primary.earliestLedger = 1_000_000;
    t.network.secondary.earliestLedger = 1_000_000;

    await t.reconciliation.runCycle();

    expect(await cursorOf(id)).toBe(start);
    expect(t.reconciliation.status().status).toBe('DEGRADED');
    const ready = await t.http().get('/readyz').expect(503);
    expect(ready.body).toMatchObject({
      status: 'not_ready',
      checks: { reconciliation: 'degraded' },
    });
  });

  it('treats a transaction outside the requested range as an integrity error', async () => {
    t = await startTestApp();
    const id = await activate();
    const start = await cursorOf(id);
    t.network.closeLedger([entry('payment.xrp')], { live: false });
    t.network.primary.pageMutator = (page) => ({
      ...page,
      transactions: page.transactions.map((tx) => ({ ...(tx as object), ledger_index: 5 })),
    });
    await t.reconciliation.runCycle();

    expect(await counts(t.database)).toEqual({ payments: 0, outbox: 0 });
    expect(await cursorOf(id)).toBe(start);
    expect(t.reconciliation.status().status).toBe('DEGRADED');
  });

  it('never runs two XRPL clients when a transport failure interrupts reconciliation', async () => {
    t = await startTestApp();
    await activate();
    t.network.closeLedger([entry('payment.xrp')], { live: false });
    t.network.primary.override('getAccountTransactions', transportFailure);
    await t.reconciliation.runCycle();
    await t.reconciliation.runCycle();

    expect(await counts(t.database)).toEqual({ payments: 1, outbox: 1 });
    expect(t.network.maxConnectedAtOnce).toBe(1);
  });
});

describe('Redis lease', () => {
  it('does not move the cursor after losing the lease', async () => {
    t = await startTestApp();
    const id = await activate();
    const start = await cursorOf(id);
    const key = `xrpl-reconciler:reconcile:1:${id}`;
    t.network.closeLedger([entry('payment.xrp')], { live: false });
    t.network.primary.pageMutator = (page) => {
      void t.redis.client.set(key, 'another-owner');
      return page;
    };

    await t.reconciliation.runCycle();

    expect(await cursorOf(id)).toBe(start);
    // Our release must not delete the other owner's lease.
    expect(await t.redis.client.get(key)).toBe('another-owner');
  });

  it('skips an account whose lease another owner holds', async () => {
    t = await startTestApp();
    const id = await activate();
    const start = await cursorOf(id);
    await t.redis.client.set(`xrpl-reconciler:reconcile:1:${id}`, 'another-owner', { PX: 60_000 });
    t.network.advance(2);

    await t.reconciliation.runCycle();

    expect(await cursorOf(id)).toBe(start);
    expect(t.reconciliation.status().status).toBe('HEALTHY');
  });
});

describe('account lifecycle', () => {
  it('disables safely: unsubscribe, then Hstop, then a final reconciliation', async () => {
    t = await startTestApp();
    const id = await activate();
    const tail = entry('payment.xrp');
    t.network.closeLedger([tail], { live: false });

    await t.http().delete(`/v1/accounts/${id}`).expect(204);

    expect((await paymentRows()).map((row) => row.hash)).toEqual([tail.hash]);
    expect(await cursorOf(id)).toBe(t.network.ledger.validatedLedger);
    const methods = t.network.primary.calls.map((call) => call.method);
    const unsubscribeAt = methods.lastIndexOf('unsubscribeAccounts');
    expect(unsubscribeAt).toBeGreaterThan(-1);
    expect(methods.indexOf('getValidatedLedgerIndex', unsubscribeAt)).toBeGreaterThan(
      unsubscribeAt,
    );
    expect(t.network.primary.live()?.subscriptions()).not.toContain(MONITORED);

    const list = await t.http().get('/v1/accounts').expect(200);
    expect(list.body.data.items[0]).toMatchObject({ id, enabled: false });
  });

  it('keeps monitoring when the final reconciliation fails', async () => {
    t = await startTestApp();
    const id = await activate();
    t.network.primary.override('getAccountTransactions', () => {
      throw new LedgerServerError('internal', 'account_tx returned internal');
    });
    t.network.advance(1);

    const response = await t.http().delete(`/v1/accounts/${id}`).expect(503);
    expect(response.body.error.code).toBe('ACCOUNT_DISABLE_FAILED');
    expect(t.network.primary.live()?.subscriptions()).toContain(MONITORED);
    const list = await t.http().get('/v1/accounts').expect(200);
    expect(list.body.data.items[0]).toMatchObject({ id, enabled: true });
  });

  it('rolls an activation back when the subscription fails', async () => {
    t = await startTestApp();
    t.network.primary.override('subscribeAccounts', () => {
      throw new LedgerServerError('internal', 'subscribe returned internal');
    });

    const response = await t.http().post('/v1/accounts').send({ address: MONITORED }).expect(503);
    expect(response.body.error.code).toBe('ACCOUNT_ACTIVATION_FAILED');
    const list = await t.http().get('/v1/accounts').expect(200);
    expect(list.body.data.items).toEqual([]);
  });

  it('reactivates from a new H0 without backfilling the disabled period', async () => {
    t = await startTestApp();
    const id = await activate();
    await t.http().delete(`/v1/accounts/${id}`).expect(204);
    t.network.closeLedger([entry('payment.xrp')], { live: false });

    const again = await t.http().post('/v1/accounts').send({ address: MONITORED }).expect(200);
    expect(again.body.data).toMatchObject({
      id,
      enabled: true,
      lastReconciledLedger: t.network.ledger.validatedLedger,
    });
    expect(await counts(t.database)).toEqual({ payments: 0, outbox: 0 });
  });
});

describe('readiness', () => {
  it('stays alive without XRPL and becomes ready once an endpoint returns', async () => {
    const network = new FakeLedgerNetwork();
    network.primary.failConnect = true;
    network.secondary.failConnect = true;
    t = await startTestApp({ network, waitReady: false });

    await t.http().get('/healthz').expect(200);
    const down = await t.http().get('/readyz').expect(503);
    expect(down.body.checks).toMatchObject({ database: 'up', redis: 'up', xrpl: 'down' });

    network.primary.failConnect = false;
    await waitFor(
      async () => (await t.health.readiness()).ready,
      'readiness after reconnect',
      15_000,
    );
    await t.http().get('/readyz').expect(200);
  });

  it('refuses to activate an account while not ready', async () => {
    const network = new FakeLedgerNetwork();
    network.primary.failConnect = true;
    network.secondary.failConnect = true;
    t = await startTestApp({ network, waitReady: false });
    const response = await t.http().post('/v1/accounts').send({ address: MONITORED }).expect(503);
    expect(response.body.error.code).toBe('SERVICE_NOT_READY');
  });

  it('fails over when the ledger stream reports another network', async () => {
    t = await startTestApp();
    t.network.primary
      .live()
      ?.emitLedgerClosed({ ledgerIndex: 1001, ledgerHash: 'B'.repeat(64), networkId: 0 });
    await waitFor(() => t.network.secondary.live() !== undefined, 'failover to secondary');
    expect(t.network.primary.live()).toBeUndefined();
  });
});
