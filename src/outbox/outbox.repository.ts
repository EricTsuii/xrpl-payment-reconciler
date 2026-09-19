import { Injectable } from '@nestjs/common';
import { and, count, eq, sql } from 'drizzle-orm';
import { OUTBOX_LOCK_MS, WEBHOOK_MAX_ATTEMPTS } from '../common/constants';
import { DatabaseService, DbExecutor } from '../database/database.service';
import { OutboxEventRow, outboxEvents } from '../database/schema';

export const PAYMENT_VALIDATED = 'payment.validated';

const ERROR_MAX_LENGTH = 1000;

export interface ClaimedEvent {
  id: string;
  body: string;
  attemptCount: number;
}

@Injectable()
export class OutboxRepository {
  constructor(private readonly database: DatabaseService) {}

  /** Always called inside the transaction that inserts the payment. */
  async insert(
    executor: DbExecutor,
    event: { id: string; aggregateId: string; body: string },
  ): Promise<void> {
    await executor.insert(outboxEvents).values({
      id: event.id,
      eventType: PAYMENT_VALIDATED,
      aggregateId: event.aggregateId,
      body: event.body,
    });
  }

  /**
   * Claims the oldest deliverable event for this instance: locked for 15
   * seconds and its attempt counted, committed before any HTTP request.
   */
  claim(instanceId: string): Promise<ClaimedEvent | undefined> {
    return this.database.transaction(async (tx) => {
      const selected = await tx.execute<{ id: string }>(sql`
        SELECT id
        FROM outbox_events
        WHERE status = 'PENDING'
          AND available_at <= now()
          AND (locked_until IS NULL OR locked_until < now())
          AND attempt_count < ${WEBHOOK_MAX_ATTEMPTS}
        ORDER BY created_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1`);
      const id = selected.rows[0]?.id;
      if (id === undefined) {
        return undefined;
      }
      const [claimed] = await tx
        .update(outboxEvents)
        .set({
          lockedBy: instanceId,
          lockedUntil: sql`now() + make_interval(secs => ${OUTBOX_LOCK_MS / 1000})`,
          attemptCount: sql`${outboxEvents.attemptCount} + 1`,
        })
        .where(eq(outboxEvents.id, id))
        .returning({
          id: outboxEvents.id,
          body: outboxEvents.body,
          attemptCount: outboxEvents.attemptCount,
        });
      return claimed;
    });
  }

  /**
   * A worker that died during its fifth attempt leaves a PENDING event with
   * no attempts left. Once its lock expires it becomes DEAD.
   */
  async retireExhausted(): Promise<number> {
    const rows = await this.database.db
      .update(outboxEvents)
      .set({
        status: 'DEAD',
        lockedBy: null,
        lockedUntil: null,
        lastError: 'attempts exhausted after an interrupted delivery',
      })
      .where(
        sql`${outboxEvents.status} = 'PENDING'
          AND ${outboxEvents.attemptCount} >= ${WEBHOOK_MAX_ATTEMPTS}
          AND (${outboxEvents.lockedUntil} IS NULL OR ${outboxEvents.lockedUntil} < now())`,
      )
      .returning({ id: outboxEvents.id });
    return rows.length;
  }

  async markDelivered(id: string, instanceId: string): Promise<boolean> {
    const rows = await this.database.db
      .update(outboxEvents)
      .set({
        status: 'DELIVERED',
        deliveredAt: sql`now()`,
        lockedBy: null,
        lockedUntil: null,
        lastError: null,
      })
      .where(and(eq(outboxEvents.id, id), eq(outboxEvents.lockedBy, instanceId)))
      .returning({ id: outboxEvents.id });
    return rows.length === 1;
  }

  async markRetry(
    id: string,
    instanceId: string,
    delayMs: number,
    error: string,
  ): Promise<boolean> {
    const rows = await this.database.db
      .update(outboxEvents)
      .set({
        status: 'PENDING',
        availableAt: sql`now() + make_interval(secs => ${delayMs / 1000})`,
        lockedBy: null,
        lockedUntil: null,
        lastError: truncate(error),
      })
      .where(and(eq(outboxEvents.id, id), eq(outboxEvents.lockedBy, instanceId)))
      .returning({ id: outboxEvents.id });
    return rows.length === 1;
  }

  async markDead(id: string, instanceId: string, error: string): Promise<boolean> {
    const rows = await this.database.db
      .update(outboxEvents)
      .set({ status: 'DEAD', lockedBy: null, lockedUntil: null, lastError: truncate(error) })
      .where(and(eq(outboxEvents.id, id), eq(outboxEvents.lockedBy, instanceId)))
      .returning({ id: outboxEvents.id });
    return rows.length === 1;
  }

  async counts(): Promise<{ pending: number; dead: number }> {
    const rows = await this.database.db
      .select({ status: outboxEvents.status, total: count() })
      .from(outboxEvents)
      .groupBy(outboxEvents.status);
    const byStatus = new Map(rows.map((row) => [row.status, row.total]));
    return { pending: byStatus.get('PENDING') ?? 0, dead: byStatus.get('DEAD') ?? 0 };
  }

  async findByAggregate(aggregateId: string): Promise<OutboxEventRow | undefined> {
    const [row] = await this.database.db
      .select()
      .from(outboxEvents)
      .where(eq(outboxEvents.aggregateId, aggregateId));
    return row;
  }
}

function truncate(error: string): string {
  return error.length > ERROR_MAX_LENGTH ? error.slice(0, ERROR_MAX_LENGTH) : error;
}
