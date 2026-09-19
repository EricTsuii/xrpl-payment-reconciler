import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  char,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

export const paymentAssetType = pgEnum('payment_asset_type', ['XRP', 'ISSUED_CURRENCY']);
export const outboxStatus = pgEnum('outbox_status', ['PENDING', 'DELIVERED', 'DEAD']);

const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const monitoredAccounts = pgTable(
  'monitored_accounts',
  {
    id: uuid('id').primaryKey(),
    networkId: integer('network_id').notNull(),
    address: text('address').notNull(),
    label: varchar('label', { length: 120 }),
    enabled: boolean('enabled').notNull().default(false),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    unique('monitored_accounts_network_id_address_key').on(table.networkId, table.address),
    check('monitored_accounts_network_id_check', sql`${table.networkId} BETWEEN 0 AND 65535`),
  ],
);

export const accountCursors = pgTable(
  'account_cursors',
  {
    accountId: uuid('account_id')
      .primaryKey()
      .references(() => monitoredAccounts.id, { onDelete: 'cascade' }),
    lastReconciledLedger: bigint('last_reconciled_ledger', { mode: 'number' }).notNull(),
    lastReconciledAt: timestamptz('last_reconciled_at'),
    lastError: varchar('last_error', { length: 1000 }),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    check('account_cursors_last_reconciled_ledger_check', sql`${table.lastReconciledLedger} >= 0`),
  ],
);

export const payments = pgTable(
  'payments',
  {
    id: uuid('id').primaryKey(),
    monitoredAccountId: uuid('monitored_account_id')
      .notNull()
      .references(() => monitoredAccounts.id),

    networkId: integer('network_id').notNull(),
    transactionHash: char('transaction_hash', { length: 64 }).notNull(),
    // "ctid" is a reserved system column name in PostgreSQL; the API and the
    // webhook still call this field "ctid".
    ctid: char('xrpl_ctid', { length: 16 }).notNull(),

    ledgerIndex: bigint('ledger_index', { mode: 'number' }).notNull(),
    transactionIndex: integer('transaction_index').notNull(),
    ledgerHash: char('ledger_hash', { length: 64 }).notNull(),
    closeTime: timestamptz('close_time').notNull(),

    sourceAccount: text('source_account').notNull(),
    destinationAccount: text('destination_account').notNull(),
    destinationTag: bigint('destination_tag', { mode: 'number' }),

    assetType: paymentAssetType('asset_type').notNull(),

    currency: text('currency'),
    issuer: text('issuer'),
    drops: numeric('drops', { precision: 30, scale: 0 }),
    value: text('value'),

    transactionResult: text('transaction_result').notNull(),

    rawTransaction: jsonb('raw_transaction').notNull(),
    rawMetadata: jsonb('raw_metadata').notNull(),

    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (table) => [
    unique('payments_network_id_transaction_hash_key').on(table.networkId, table.transactionHash),
    unique('payments_network_id_xrpl_ctid_key').on(table.networkId, table.ctid),

    index('payments_account_order_idx').on(
      table.monitoredAccountId,
      table.ledgerIndex.desc(),
      table.transactionIndex.desc(),
      table.id.desc(),
    ),
    index('payments_destination_tag_idx')
      .on(table.destinationTag)
      .where(sql`${table.destinationTag} IS NOT NULL`),

    check('payments_network_id_check', sql`${table.networkId} BETWEEN 0 AND 65535`),
    check('payments_ledger_index_check', sql`${table.ledgerIndex} BETWEEN 0 AND 268435455`),
    check('payments_transaction_index_check', sql`${table.transactionIndex} BETWEEN 0 AND 65535`),
    check(
      'payments_destination_tag_check',
      sql`${table.destinationTag} IS NULL OR ${table.destinationTag} BETWEEN 0 AND 4294967295`,
    ),
    check('payments_transaction_hash_check', sql`${table.transactionHash} ~ '^[A-F0-9]{64}$'`),
    check('payments_ledger_hash_check', sql`${table.ledgerHash} ~ '^[A-F0-9]{64}$'`),
    check('payments_xrpl_ctid_check', sql`${table.ctid} ~ '^C[A-F0-9]{15}$'`),
    check(
      'payments_xrp_amount_check',
      sql`${table.assetType} <> 'XRP' OR (${table.drops} IS NOT NULL AND ${table.currency} IS NULL AND ${table.issuer} IS NULL AND ${table.value} IS NULL)`,
    ),
    check(
      'payments_issued_amount_check',
      sql`${table.assetType} <> 'ISSUED_CURRENCY' OR (${table.drops} IS NULL AND ${table.currency} IS NOT NULL AND ${table.issuer} IS NOT NULL AND ${table.value} IS NOT NULL)`,
    ),
  ],
);

export const outboxEvents = pgTable(
  'outbox_events',
  {
    id: uuid('id').primaryKey(),
    eventType: text('event_type').notNull(),
    aggregateId: uuid('aggregate_id')
      .notNull()
      .references(() => payments.id),

    body: text('body').notNull(),

    status: outboxStatus('status').notNull().default('PENDING'),
    attemptCount: integer('attempt_count').notNull().default(0),

    availableAt: timestamptz('available_at').notNull().defaultNow(),

    lockedBy: text('locked_by'),
    lockedUntil: timestamptz('locked_until'),

    deliveredAt: timestamptz('delivered_at'),
    lastError: varchar('last_error', { length: 1000 }),

    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (table) => [
    unique('outbox_events_event_type_aggregate_id_key').on(table.eventType, table.aggregateId),
    index('outbox_events_pending_idx')
      .on(table.availableAt, table.lockedUntil)
      .where(sql`${table.status} = 'PENDING'`),
    check('outbox_events_event_type_check', sql`${table.eventType} = 'payment.validated'`),
    check('outbox_events_attempt_count_check', sql`${table.attemptCount} BETWEEN 0 AND 5`),
  ],
);

export type MonitoredAccountRow = typeof monitoredAccounts.$inferSelect;
export type AccountCursorRow = typeof accountCursors.$inferSelect;
export type PaymentRow = typeof payments.$inferSelect;
export type NewPaymentRow = typeof payments.$inferInsert;
export type OutboxEventRow = typeof outboxEvents.$inferSelect;
