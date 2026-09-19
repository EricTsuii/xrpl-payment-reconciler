import { sql } from 'drizzle-orm';
import { AccountsRepository } from '../../src/accounts/accounts.repository';
import { OutboxRepository } from '../../src/outbox/outbox.repository';
import { PaymentsRepository } from '../../src/payments/payments.repository';
import { ReconciliationLockService } from '../../src/redis/reconciliation-lock.service';
import {
  envelopeFromAccountTx,
  NormalizedPayment,
  PaymentNormalizerService,
} from '../../src/xrpl/payment-normalizer.service';
import { stampEntry } from '../fakes/fake-ledger-client';
import { entry, MONITORED } from '../support/entries';
import { counts, startTestApp, type TestApp } from '../support/test-app';

let t: TestApp;
let accountId: string;

beforeAll(async () => {
  t = await startTestApp();
});

afterAll(async () => {
  await t.close();
});

beforeEach(async () => {
  await t.database.db.execute(
    sql`TRUNCATE outbox_events, payments, account_cursors, monitored_accounts CASCADE`,
  );
  await t.redis.client.flushDb();
  const account = await t.app.get(AccountsRepository).createDisabled(1, MONITORED, null, 1000);
  accountId = account.id;
});

function normalized(name = 'payment.xrp', ledgerIndex = 1001, position = 0): NormalizedPayment {
  const built = envelopeFromAccountTx(stampEntry(entry(name), ledgerIndex, position, 1), 1);
  if (!built.ok) {
    throw new Error(built.reason);
  }
  const result = t.app
    .get(PaymentNormalizerService)
    .normalize(built.envelope, { id: accountId, address: MONITORED });
  if (result.outcome !== 'ACCEPTED') {
    throw new Error(`fixture not accepted: ${result.outcome}`);
  }
  return result.payment;
}

describe('payment idempotency', () => {
  it('stores one payment and one outbox event for five deliveries of the same transaction', async () => {
    const payments = t.app.get(PaymentsRepository);
    const payment = normalized();
    const outcomes = [];
    for (let n = 0; n < 5; n += 1) {
      outcomes.push((await payments.persist(payment)).outcome);
    }
    expect(outcomes).toEqual(['ACCEPTED', 'DUPLICATE', 'DUPLICATE', 'DUPLICATE', 'DUPLICATE']);
    expect(await counts(t.database)).toEqual({ payments: 1, outbox: 1 });
  });

  it('stays at one row under concurrent deliveries', async () => {
    const payments = t.app.get(PaymentsRepository);
    const payment = normalized();
    const outcomes = await Promise.all(Array.from({ length: 8 }, () => payments.persist(payment)));
    expect(outcomes.filter((o) => o.outcome === 'ACCEPTED')).toHaveLength(1);
    expect(outcomes.filter((o) => o.outcome === 'DUPLICATE')).toHaveLength(7);
    expect(await counts(t.database)).toEqual({ payments: 1, outbox: 1 });
  });

  it('reports INTEGRITY_ERROR when a replayed hash carries different data', async () => {
    const payments = t.app.get(PaymentsRepository);
    const payment = normalized();
    await payments.persist(payment);

    for (const altered of [
      { ...payment, asset: { type: 'XRP' as const, drops: '1' } },
      { ...payment, ledgerHash: 'F'.repeat(64) },
      { ...payment, destinationTag: 999 },
    ]) {
      const result = await payments.persist(altered);
      expect(result.outcome).toBe('INTEGRITY_ERROR');
    }
    expect(await counts(t.database)).toEqual({ payments: 1, outbox: 1 });
  });

  it('rolls back and reports INTEGRITY_ERROR on a CTID collision', async () => {
    const payments = t.app.get(PaymentsRepository);
    const first = normalized('payment.xrp', 1001, 0);
    await payments.persist(first);
    const collision = { ...normalized('payment.issued', 1001, 0), ctid: first.ctid };
    expect(collision.hash).not.toBe(first.hash);

    const result = await payments.persist(collision);
    expect(result).toMatchObject({ outcome: 'INTEGRITY_ERROR' });
    expect(await counts(t.database)).toEqual({ payments: 1, outbox: 1 });
  });

  it('never commits a payment without its outbox event', async () => {
    const payments = t.app.get(PaymentsRepository);
    await t.database.db.execute(
      sql.raw(
        `ALTER TABLE outbox_events ADD CONSTRAINT test_outbox_failure CHECK (event_type = 'never')`,
      ),
    );
    try {
      await expect(payments.persist(normalized())).rejects.toThrow();
    } finally {
      await t.database.db.execute(
        sql.raw('ALTER TABLE outbox_events DROP CONSTRAINT test_outbox_failure'),
      );
    }
    expect(await counts(t.database)).toEqual({ payments: 0, outbox: 0 });
  });

  it('stores the webhook body once, with a stable event ID', async () => {
    const payments = t.app.get(PaymentsRepository);
    const stored = await payments.persist(normalized('payment.issued'));
    if (stored.outcome !== 'ACCEPTED') {
      throw new Error('not accepted');
    }
    const event = await t.app.get(OutboxRepository).findByAggregate(stored.payment.id);
    const body = JSON.parse(event?.body ?? '{}') as Record<string, unknown>;
    expect(body).toMatchObject({
      eventId: event?.id,
      type: 'payment.validated',
      payment: {
        id: stored.payment.id,
        ctid: stored.payment.ctid,
        asset: { type: 'ISSUED_CURRENCY', currency: 'USD', value: '12.345' },
        destinationTag: null,
      },
    });
  });
});

describe('cursor monotonicity', () => {
  it('moves the cursor only from the expected value', async () => {
    const accounts = t.app.get(AccountsRepository);
    expect(await accounts.advanceCursor(accountId, 1000, 1010)).toBe(true);
    expect(await accounts.advanceCursor(accountId, 1000, 1020)).toBe(false);
    expect(await accounts.getCursor(accountId)).toBe(1010);
  });

  it('lets exactly one of two concurrent updates from the same value win', async () => {
    const accounts = t.app.get(AccountsRepository);
    const results = await Promise.all([
      accounts.advanceCursor(accountId, 1000, 1005),
      accounts.advanceCursor(accountId, 1000, 1007),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('refuses a negative cursor in the database', async () => {
    await expect(
      t.database.db.execute(
        sql`UPDATE account_cursors SET last_reconciled_ledger = -1 WHERE account_id = ${accountId}`,
      ),
    ).rejects.toThrow();
  });
});

describe('Redis lease ownership', () => {
  it('lets only one owner hold the lease', async () => {
    const locks = t.app.get(ReconciliationLockService);
    const first = await locks.acquire(accountId);
    const second = await locks.acquire(accountId);
    expect(first).toBeDefined();
    expect(second).toBeUndefined();
    await first?.release();
    const third = await locks.acquire(accountId);
    expect(third).toBeDefined();
    await third?.release();
  });

  it('refreshes and releases only for the owner token', async () => {
    const locks = t.app.get(ReconciliationLockService);
    const lease = await locks.acquire(accountId);
    if (lease === undefined) {
      throw new Error('no lease');
    }
    expect(await locks.refresh(lease.key, 'someone-else')).toBe(false);
    expect(await locks.release(lease.key, 'someone-else')).toBe(false);
    expect(await t.redis.client.get(lease.key)).toBe(lease.token);

    await t.redis.client.pExpire(lease.key, 1_000);
    expect(await lease.refresh()).toBe(true);
    expect(await t.redis.client.pTTL(lease.key)).toBeGreaterThan(50_000);

    await lease.release();
    expect(await t.redis.client.get(lease.key)).toBeNull();
  });

  it('detects a lost lease and never deletes the new owner', async () => {
    const locks = t.app.get(ReconciliationLockService);
    const lease = await locks.acquire(accountId);
    if (lease === undefined) {
      throw new Error('no lease');
    }
    await t.redis.client.set(lease.key, 'new-owner');
    await expect(lease.assertOwned()).rejects.toThrow('lease lost');
    expect(lease.isLost).toBe(true);
    await lease.release();
    expect(await t.redis.client.get(lease.key)).toBe('new-owner');
  });

  it('uses the documented key format', () => {
    expect(t.app.get(ReconciliationLockService).key(accountId)).toBe(
      `xrpl-reconciler:reconcile:1:${accountId}`,
    );
  });
});

describe('outbox claims', () => {
  it('gives two concurrent workers different events', async () => {
    const payments = t.app.get(PaymentsRepository);
    await payments.persist(normalized('payment.xrp', 1001, 0));
    await payments.persist(normalized('payment.issued', 1001, 1));
    const outbox = t.app.get(OutboxRepository);

    const [a, b] = await Promise.all([outbox.claim('worker-a'), outbox.claim('worker-b')]);
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(a?.id).not.toBe(b?.id);
    expect(await outbox.claim('worker-c')).toBeUndefined();
  });

  it('updates an event only for the worker that holds its lock', async () => {
    const payments = t.app.get(PaymentsRepository);
    await payments.persist(normalized());
    const outbox = t.app.get(OutboxRepository);
    const claimed = await outbox.claim('worker-a');
    if (claimed === undefined) {
      throw new Error('nothing claimed');
    }
    expect(await outbox.markDelivered(claimed.id, 'worker-b')).toBe(false);
    expect(await outbox.markRetry(claimed.id, 'worker-b', 1_000, 'x')).toBe(false);
    expect(await outbox.markDelivered(claimed.id, 'worker-a')).toBe(true);
  });

  it('retires an event whose fifth attempt was interrupted', async () => {
    const payments = t.app.get(PaymentsRepository);
    await payments.persist(normalized());
    await t.database.db.execute(
      sql`UPDATE outbox_events SET attempt_count = 5, locked_by = 'dead-worker', locked_until = now() - interval '1 second'`,
    );
    const outbox = t.app.get(OutboxRepository);
    expect(await outbox.claim('worker-a')).toBeUndefined();
    expect(await outbox.retireExhausted()).toBe(1);
    expect(await outbox.counts()).toEqual({ pending: 0, dead: 1 });
  });
});
