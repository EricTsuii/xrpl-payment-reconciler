import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { and, asc, count, eq, min, sql } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service';
import {
  accountCursors,
  monitoredAccounts,
  MonitoredAccountRow,
  payments,
} from '../database/schema';

const ERROR_MAX_LENGTH = 1000;
const UNIQUE_VIOLATION = '23505';
/** Serializes the enabled-account limit check across concurrent activations. */
const ENABLE_LOCK_KEY = 710_425_001;

export interface AccountWithCursor extends MonitoredAccountRow {
  lastReconciledLedger: number;
  lastReconciledAt: Date | null;
}

export class AccountExistsError extends Error {
  constructor() {
    super('account already registered');
    this.name = 'AccountExistsError';
  }
}

@Injectable()
export class AccountsRepository {
  constructor(private readonly database: DatabaseService) {}

  async findById(id: string): Promise<AccountWithCursor | undefined> {
    const [row] = await this.withCursor().where(eq(monitoredAccounts.id, id));
    return row;
  }

  async findByAddress(networkId: number, address: string): Promise<AccountWithCursor | undefined> {
    const [row] = await this.withCursor().where(
      and(eq(monitoredAccounts.networkId, networkId), eq(monitoredAccounts.address, address)),
    );
    return row;
  }

  listAll(networkId: number): Promise<AccountWithCursor[]> {
    return this.withCursor()
      .where(eq(monitoredAccounts.networkId, networkId))
      .orderBy(asc(monitoredAccounts.createdAt), asc(monitoredAccounts.id));
  }

  listEnabled(networkId: number): Promise<AccountWithCursor[]> {
    return this.withCursor()
      .where(and(eq(monitoredAccounts.networkId, networkId), eq(monitoredAccounts.enabled, true)))
      .orderBy(asc(monitoredAccounts.createdAt), asc(monitoredAccounts.id));
  }

  async findEnabledByAddress(
    networkId: number,
    address: string,
  ): Promise<MonitoredAccountRow | undefined> {
    const [row] = await this.database.db
      .select()
      .from(monitoredAccounts)
      .where(
        and(
          eq(monitoredAccounts.networkId, networkId),
          eq(monitoredAccounts.address, address),
          eq(monitoredAccounts.enabled, true),
        ),
      );
    return row;
  }

  async enabledSummary(
    networkId: number,
  ): Promise<{ enabled: number; minimumCursor: number | null }> {
    const [row] = await this.database.db
      .select({ enabled: count(), minimumCursor: min(accountCursors.lastReconciledLedger) })
      .from(monitoredAccounts)
      .innerJoin(accountCursors, eq(accountCursors.accountId, monitoredAccounts.id))
      .where(and(eq(monitoredAccounts.networkId, networkId), eq(monitoredAccounts.enabled, true)));
    return { enabled: row?.enabled ?? 0, minimumCursor: row?.minimumCursor ?? null };
  }

  /** Inserts a disabled account and its cursor at `cursor`, in one transaction. */
  async createDisabled(
    networkId: number,
    address: string,
    label: string | null,
    cursor: number,
  ): Promise<AccountWithCursor> {
    try {
      return await this.database.transaction(async (tx) => {
        const now = new Date();
        const [account] = await tx
          .insert(monitoredAccounts)
          .values({
            id: randomUUID(),
            networkId,
            address,
            label,
            enabled: false,
            createdAt: now,
            updatedAt: now,
          })
          .returning();
        if (account === undefined) {
          throw new Error('account insert returned nothing');
        }
        await tx
          .insert(accountCursors)
          .values({ accountId: account.id, lastReconciledLedger: cursor });
        return { ...account, lastReconciledLedger: cursor, lastReconciledAt: null };
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new AccountExistsError();
      }
      throw error;
    }
  }

  /** Reactivation starts from `cursor`: the disabled period is not backfilled. */
  async resetCursor(id: string, cursor: number, label: string | null | undefined): Promise<void> {
    await this.database.transaction(async (tx) => {
      await tx
        .update(accountCursors)
        .set({
          lastReconciledLedger: cursor,
          lastReconciledAt: null,
          lastError: null,
          updatedAt: new Date(),
        })
        .where(eq(accountCursors.accountId, id));
      if (label !== undefined) {
        await tx
          .update(monitoredAccounts)
          .set({ label, updatedAt: new Date() })
          .where(eq(monitoredAccounts.id, id));
      }
    });
  }

  async getCursor(id: string): Promise<number | undefined> {
    const [row] = await this.database.db
      .select({ ledger: accountCursors.lastReconciledLedger })
      .from(accountCursors)
      .where(eq(accountCursors.accountId, id));
    return row?.ledger;
  }

  /**
   * Moves the cursor from `expected` to `next`. Fails (returns false) when
   * the cursor is no longer `expected`: someone else moved it.
   */
  async advanceCursor(id: string, expected: number, next: number): Promise<boolean> {
    const result = await this.database.db.execute(sql`
      UPDATE account_cursors
      SET last_reconciled_ledger = ${next},
          last_reconciled_at = now(),
          last_error = NULL,
          updated_at = now()
      WHERE account_id = ${id}
        AND last_reconciled_ledger = ${expected}`);
    return result.rowCount === 1;
  }

  async recordError(id: string, error: string): Promise<void> {
    await this.database.db
      .update(accountCursors)
      .set({ lastError: error.slice(0, ERROR_MAX_LENGTH), updatedAt: new Date() })
      .where(eq(accountCursors.accountId, id));
  }

  /** Enables the account unless the enabled limit is reached, atomically. */
  enableWithinLimit(id: string, networkId: number, limit: number): Promise<boolean> {
    return this.database.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${ENABLE_LOCK_KEY})`);
      const [row] = await tx
        .select({ enabled: count() })
        .from(monitoredAccounts)
        .where(
          and(eq(monitoredAccounts.networkId, networkId), eq(monitoredAccounts.enabled, true)),
        );
      if ((row?.enabled ?? 0) >= limit) {
        return false;
      }
      await tx
        .update(monitoredAccounts)
        .set({ enabled: true, updatedAt: new Date() })
        .where(eq(monitoredAccounts.id, id));
      return true;
    });
  }

  async disable(id: string): Promise<void> {
    await this.database.db
      .update(monitoredAccounts)
      .set({ enabled: false, updatedAt: new Date() })
      .where(eq(monitoredAccounts.id, id));
  }

  /**
   * Removes an account whose activation failed. Returns false, leaving it
   * disabled, when payments already reference it.
   */
  async deleteIfUnused(id: string): Promise<boolean> {
    return this.database.transaction(async (tx) => {
      const [row] = await tx
        .select({ total: count() })
        .from(payments)
        .where(eq(payments.monitoredAccountId, id));
      if ((row?.total ?? 0) > 0) {
        return false;
      }
      await tx.delete(monitoredAccounts).where(eq(monitoredAccounts.id, id));
      return true;
    });
  }

  private withCursor() {
    return this.database.db
      .select({
        id: monitoredAccounts.id,
        networkId: monitoredAccounts.networkId,
        address: monitoredAccounts.address,
        label: monitoredAccounts.label,
        enabled: monitoredAccounts.enabled,
        createdAt: monitoredAccounts.createdAt,
        updatedAt: monitoredAccounts.updatedAt,
        lastReconciledLedger: accountCursors.lastReconciledLedger,
        lastReconciledAt: accountCursors.lastReconciledAt,
      })
      .from(monitoredAccounts)
      .innerJoin(accountCursors, eq(accountCursors.accountId, monitoredAccounts.id))
      .$dynamic();
  }
}

function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && typeof current === 'object' && current !== null; depth += 1) {
    if ((current as { code?: unknown }).code === UNIQUE_VIOLATION) {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}
