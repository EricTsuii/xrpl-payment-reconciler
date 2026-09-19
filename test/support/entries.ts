import { createHash } from 'node:crypto';
import { FIXTURE_ACCOUNTS, fixture } from '../fakes/fake-ledger-client';

let counter = 0;

function hex64(seed: string): string {
  return createHash('sha256').update(seed).digest('hex').toUpperCase();
}

export interface EntryOptions {
  destination?: string;
  source?: string;
  drops?: string;
  destinationTag?: number | null;
  /** Keep this transaction index when the entry is stamped into a ledger. */
  transactionIndex?: number;
}

/**
 * A fresh account_tx entry from a fixture, with a unique hash so several
 * copies can live in one test. Ledger index and CTID are stamped when the
 * fake ledger closes the ledger that contains it.
 */
export function entry(name: string, options: EntryOptions = {}): Record<string, unknown> {
  counter += 1;
  const copy = fixture(name);
  const tx = copy.tx_json as Record<string, unknown>;
  const meta = copy.meta as Record<string, unknown>;
  copy.hash = hex64(`${name}:${counter}:${process.pid}:${Date.now()}`);
  copy.ledger_hash = hex64(`ledger:${counter}`);
  if (options.destination !== undefined) {
    const monitored = FIXTURE_ACCOUNTS.monitored;
    if (tx.Destination === monitored) {
      tx.Destination = options.destination;
    }
    if (tx.Account === monitored) {
      tx.Account = options.destination;
    }
  }
  if (options.source !== undefined) {
    tx.Account = options.source;
  }
  if (options.drops !== undefined) {
    tx.DeliverMax = options.drops;
    meta.delivered_amount = options.drops;
  }
  if (options.destinationTag === null) {
    delete tx.DestinationTag;
  } else if (options.destinationTag !== undefined) {
    tx.DestinationTag = options.destinationTag;
  }
  if (options.transactionIndex !== undefined) {
    copy.__keepIndex = options.transactionIndex;
  }
  return copy;
}

export const MONITORED = FIXTURE_ACCOUNTS.monitored;
export const SENDER = FIXTURE_ACCOUNTS.sender;
export const ISSUER = FIXTURE_ACCOUNTS.issuer;
export const OTHER = FIXTURE_ACCOUNTS.other;
