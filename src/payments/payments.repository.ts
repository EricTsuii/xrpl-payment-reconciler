import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { and, desc, eq, lt, or, SQL } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service';
import { NewPaymentRow, PaymentRow, payments } from '../database/schema';
import { OutboxRepository } from '../outbox/outbox.repository';
import type { NormalizedPayment } from '../xrpl/payment-normalizer.service';
import { paymentValidatedBody } from './payment.presenter';

const CTID_UNIQUE = 'payments_network_id_xrpl_ctid_key';
const UNIQUE_VIOLATION = '23505';

export type PersistResult =
  | { outcome: 'ACCEPTED'; payment: PaymentRow }
  | { outcome: 'DUPLICATE'; payment: PaymentRow }
  | { outcome: 'INTEGRITY_ERROR'; reason: string };

export interface PaymentListFilter {
  accountId?: string;
  destinationTag?: number;
  assetType?: 'XRP' | 'ISSUED_CURRENCY';
  before?: { ledgerIndex: number; transactionIndex: number; id: string };
  limit: number;
}

@Injectable()
export class PaymentsRepository {
  constructor(
    private readonly database: DatabaseService,
    private readonly outbox: OutboxRepository,
  ) {}

  /**
   * Stores a normalized payment and its outbox event in one transaction.
   * A repeated hash with identical data is a DUPLICATE; with different data,
   * or a CTID already used by another hash, it is an INTEGRITY_ERROR and
   * nothing is written.
   */
  async persist(payment: NormalizedPayment): Promise<PersistResult> {
    try {
      return await this.database.transaction(async (tx) => {
        const [inserted] = await tx
          .insert(payments)
          .values(toRow(payment))
          .onConflictDoNothing({ target: [payments.networkId, payments.transactionHash] })
          .returning();

        if (inserted === undefined) {
          const [existing] = await tx
            .select()
            .from(payments)
            .where(
              and(
                eq(payments.networkId, payment.networkId),
                eq(payments.transactionHash, payment.hash),
              ),
            );
          if (existing === undefined) {
            throw new Error('payment conflict without an existing row');
          }
          const difference = differingField(existing, payment);
          return difference === undefined
            ? { outcome: 'DUPLICATE', payment: existing }
            : {
                outcome: 'INTEGRITY_ERROR',
                reason: `hash ${payment.hash} was stored with a different ${difference}`,
              };
        }

        const eventId = randomUUID();
        await this.outbox.insert(tx, {
          id: eventId,
          aggregateId: inserted.id,
          body: paymentValidatedBody(eventId, inserted),
        });
        return { outcome: 'ACCEPTED', payment: inserted };
      });
    } catch (error) {
      if (isUniqueViolation(error, CTID_UNIQUE)) {
        return {
          outcome: 'INTEGRITY_ERROR',
          reason: `CTID ${payment.ctid} already belongs to another transaction`,
        };
      }
      throw error;
    }
  }

  async findById(id: string): Promise<PaymentRow | undefined> {
    const [row] = await this.database.db.select().from(payments).where(eq(payments.id, id));
    return row;
  }

  async findByHash(networkId: number, hash: string): Promise<PaymentRow | undefined> {
    const [row] = await this.database.db
      .select()
      .from(payments)
      .where(and(eq(payments.networkId, networkId), eq(payments.transactionHash, hash)));
    return row;
  }

  /** Newest first, keyset-paginated on (ledger_index, transaction_index, id). */
  list(filter: PaymentListFilter): Promise<PaymentRow[]> {
    const conditions: SQL[] = [];
    if (filter.accountId !== undefined) {
      conditions.push(eq(payments.monitoredAccountId, filter.accountId));
    }
    if (filter.destinationTag !== undefined) {
      conditions.push(eq(payments.destinationTag, filter.destinationTag));
    }
    if (filter.assetType !== undefined) {
      conditions.push(eq(payments.assetType, filter.assetType));
    }
    if (filter.before !== undefined) {
      const { ledgerIndex, transactionIndex, id } = filter.before;
      const older = or(
        lt(payments.ledgerIndex, ledgerIndex),
        and(eq(payments.ledgerIndex, ledgerIndex), lt(payments.transactionIndex, transactionIndex)),
        and(
          eq(payments.ledgerIndex, ledgerIndex),
          eq(payments.transactionIndex, transactionIndex),
          lt(payments.id, id),
        ),
      );
      if (older !== undefined) {
        conditions.push(older);
      }
    }
    return this.database.db
      .select()
      .from(payments)
      .where(and(...conditions))
      .orderBy(desc(payments.ledgerIndex), desc(payments.transactionIndex), desc(payments.id))
      .limit(filter.limit);
  }
}

function toRow(payment: NormalizedPayment): NewPaymentRow {
  const asset = payment.asset;
  return {
    id: randomUUID(),
    monitoredAccountId: payment.monitoredAccountId,
    networkId: payment.networkId,
    transactionHash: payment.hash,
    ctid: payment.ctid,
    ledgerIndex: payment.ledgerIndex,
    transactionIndex: payment.transactionIndex,
    ledgerHash: payment.ledgerHash,
    closeTime: new Date(payment.closeTime),
    sourceAccount: payment.source,
    destinationAccount: payment.destination,
    destinationTag: payment.destinationTag,
    assetType: asset.type,
    drops: asset.type === 'XRP' ? asset.drops : null,
    currency: asset.type === 'ISSUED_CURRENCY' ? asset.currency : null,
    issuer: asset.type === 'ISSUED_CURRENCY' ? asset.issuer : null,
    value: asset.type === 'ISSUED_CURRENCY' ? asset.value : null,
    transactionResult: payment.transactionResult,
    rawTransaction: payment.rawTransaction,
    rawMetadata: payment.rawMetadata,
  };
}

/** The first critical field on which a stored payment and a replay disagree. */
function differingField(existing: PaymentRow, payment: NormalizedPayment): string | undefined {
  const replay = toRow(payment);
  const checks: [string, unknown, unknown][] = [
    ['ctid', existing.ctid, replay.ctid],
    ['ledger_index', existing.ledgerIndex, replay.ledgerIndex],
    ['transaction_index', existing.transactionIndex, replay.transactionIndex],
    ['ledger_hash', existing.ledgerHash, replay.ledgerHash],
    ['source_account', existing.sourceAccount, replay.sourceAccount],
    ['destination_account', existing.destinationAccount, replay.destinationAccount],
    ['destination_tag', existing.destinationTag, replay.destinationTag],
    ['asset_type', existing.assetType, replay.assetType],
    ['drops', existing.drops, replay.drops],
    ['value', existing.value, replay.value],
    ['currency', existing.currency, replay.currency],
    ['issuer', existing.issuer, replay.issuer],
    ['transaction_result', existing.transactionResult, replay.transactionResult],
  ];
  return checks.find(([, stored, replayed]) => stored !== replayed)?.[0];
}

function isUniqueViolation(error: unknown, constraint: string): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && typeof current === 'object' && current !== null; depth += 1) {
    const candidate = current as { code?: unknown; constraint?: unknown; cause?: unknown };
    if (candidate.code === UNIQUE_VIOLATION && candidate.constraint === constraint) {
      return true;
    }
    current = candidate.cause;
  }
  return false;
}
