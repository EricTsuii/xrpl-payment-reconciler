import { createHmac } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { OutboxRepository } from '../../src/outbox/outbox.repository';
import { entry, MONITORED } from '../support/entries';
import { startTestApp, type TestApp } from '../support/test-app';
import { waitFor } from '../support/wait';
import { WebhookSink } from '../helpers/webhook-sink';

const SECRET = 'test-webhook-secret-with-at-least-32-bytes';

let t: TestApp;
let sink: WebhookSink;

beforeEach(async () => {
  sink = await new WebhookSink().listen();
  t = await startTestApp({ webhook: { url: sink.url, secret: SECRET } });
  // Deliveries are driven one at a time by the tests.
  await t.worker.stop();
  await t.http().post('/v1/accounts').send({ address: MONITORED }).expect(201);
  t.network.closeLedger([entry('payment.xrp')]);
  await t.settle();
});

afterEach(async () => {
  await t.close();
  await sink.close();
});

type OutboxState = {
  status: string;
  attempt_count: number;
  delay_ms: number;
  last_error: string | null;
};

async function outboxState(): Promise<OutboxState> {
  const result = await t.database.db.execute<OutboxState>(sql`
    SELECT status::text AS status, attempt_count,
           (EXTRACT(EPOCH FROM (available_at - now())) * 1000)::int AS delay_ms, last_error
    FROM outbox_events`);
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error('no outbox event');
  }
  return row;
}

/** Makes the pending retry due now instead of waiting for it. */
async function makeDue(): Promise<void> {
  await t.database.db.execute(sql`UPDATE outbox_events SET available_at = now()`);
}

describe('webhook delivery', () => {
  it('retries 500, 500 and delivers on 204 with a stable event, body and signature', async () => {
    sink.respondWith(500, 500, 204);

    expect(await t.worker.runOnce()).toBe(true);
    let state = await outboxState();
    expect(state).toMatchObject({ status: 'PENDING', attempt_count: 1, last_error: 'HTTP 500' });
    expect(state.delay_ms).toBeGreaterThan(0);
    expect(state.delay_ms).toBeLessThanOrEqual(1_000);
    expect(await t.worker.runOnce()).toBe(false);

    await makeDue();
    await t.worker.runOnce();
    state = await outboxState();
    expect(state).toMatchObject({ status: 'PENDING', attempt_count: 2 });
    expect(state.delay_ms).toBeGreaterThan(4_000);
    expect(state.delay_ms).toBeLessThanOrEqual(5_000);

    await makeDue();
    await t.worker.runOnce();
    expect(await outboxState()).toMatchObject({
      status: 'DELIVERED',
      attempt_count: 3,
      last_error: null,
    });

    expect(sink.requests).toHaveLength(3);
    const [first, ...others] = sink.requests;
    for (const request of others) {
      expect(request.body).toBe(first?.body);
      expect(request.headers['x-reconciler-event-id']).toBe(
        first?.headers['x-reconciler-event-id'],
      );
      expect(request.headers['x-reconciler-signature']).toBe(
        first?.headers['x-reconciler-signature'],
      );
    }

    const body = first?.body ?? '';
    expect(first?.headers).toMatchObject({
      'content-type': 'application/json',
      'user-agent': 'xrpl-payment-reconciler/0.1.0',
      'x-reconciler-signature': `sha256=${createHmac('sha256', SECRET).update(body, 'utf8').digest('hex')}`,
    });
    const event = JSON.parse(body) as Record<string, unknown>;
    expect(event).toMatchObject({
      eventId: first?.headers['x-reconciler-event-id'],
      type: 'payment.validated',
      payment: {
        networkId: 1,
        destination: MONITORED,
        destinationTag: 123,
        asset: { type: 'XRP', drops: '25000000', xrp: '25' },
      },
    });
  });

  it('marks an event DEAD after five failures and stays ready', async () => {
    sink.respondWith(500, 502, 503, 504, 500);
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await makeDue();
      expect(await t.worker.runOnce()).toBe(true);
    }

    expect(await outboxState()).toMatchObject({
      status: 'DEAD',
      attempt_count: 5,
      last_error: 'HTTP 500',
    });
    await makeDue();
    expect(await t.worker.runOnce()).toBe(false);
    expect(sink.requests).toHaveLength(5);

    const payments = await t.http().get('/v1/payments').expect(200);
    expect(payments.body.data.items).toHaveLength(1);
    await t.http().get('/readyz').expect(200);
    const status = await t.http().get('/v1/status').expect(200);
    expect(status.body.data.outbox).toEqual({ deliveryEnabled: true, pending: 0, dead: 1 });
  });

  it('reclaims an event after a crashed worker lock expires', async () => {
    const outbox = t.app.get(OutboxRepository);
    const claimed = await outbox.claim('crashed-instance');
    expect(claimed?.attemptCount).toBe(1);

    // Locked: nobody else may take it yet.
    expect(await t.worker.runOnce()).toBe(false);

    await waitFor(
      async () => {
        const result = await t.database.db.execute<{ expired: boolean }>(
          sql`SELECT locked_until < now() AS expired FROM outbox_events`,
        );
        return result.rows[0]?.expired === true;
      },
      'outbox lock expiry',
      20_000,
      250,
    );

    expect(await t.worker.runOnce()).toBe(true);
    expect(await outboxState()).toMatchObject({ status: 'DELIVERED', attempt_count: 2 });
    expect(sink.requests).toHaveLength(1);
  }, 30_000);

  it('does not follow redirects with a signed body', async () => {
    sink.respondWith(302);
    await t.worker.runOnce();
    expect(await outboxState()).toMatchObject({ status: 'PENDING', last_error: 'HTTP 302' });
  });
});
