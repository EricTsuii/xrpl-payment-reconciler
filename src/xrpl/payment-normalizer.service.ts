import { Injectable } from '@nestjs/common';
import { isValidClassicAddress } from 'xrpl';
import { LEDGER_INDEX_MAX, TRANSACTION_INDEX_MAX, UINT32_MAX } from '../common/constants';
import { DeliveredAmount, parseDeliveredAmount } from './amount';
import { encodeCtid } from './ctid';
import { resolveCloseTime } from './ripple-time';
import { asRecord } from './types';

const HASH_PATTERN = /^[A-Fa-f0-9]{64}$/;

/** Where live and reconciliation paths meet: one shape, one normalizer. */
export interface ValidatedTransactionEnvelope {
  source: 'live' | 'backfill';
  networkId: number;
  ledgerIndex: number;
  ledgerHash: string;
  closeTime: string;
  hash: string;
  /** CTID reported by the server, when it sends one. */
  upstreamCtid: string | undefined;
  tx: unknown;
  meta: unknown;
}

export interface MonitoredAccountRef {
  id: string;
  address: string;
}

export interface NormalizedPayment {
  monitoredAccountId: string;
  networkId: number;
  hash: string;
  ctid: string;
  ledgerIndex: number;
  transactionIndex: number;
  ledgerHash: string;
  closeTime: string;
  source: string;
  destination: string;
  destinationTag: number | null;
  asset: DeliveredAmount;
  transactionResult: string;
  rawTransaction: Record<string, unknown>;
  rawMetadata: Record<string, unknown>;
}

export type IgnoredOutcome =
  | 'IGNORED_NON_PAYMENT'
  | 'IGNORED_OUTGOING_PAYMENT'
  | 'IGNORED_SELF_PAYMENT'
  | 'IGNORED_FAILED_TRANSACTION'
  | 'UNSUPPORTED_DELIVERED_AMOUNT'
  | 'UNSUPPORTED_ASSET_TYPE';

export type NormalizationResult =
  | { outcome: 'ACCEPTED'; payment: NormalizedPayment }
  | { outcome: IgnoredOutcome; reason?: string }
  | { outcome: 'INTEGRITY_ERROR'; reason: string };

export type EnvelopeResult =
  { ok: true; envelope: ValidatedTransactionEnvelope } | { ok: false; reason: string };

/**
 * Builds an envelope from a live stream message. The stream must say
 * `validated: true`; anything else is an integrity error.
 */
export function envelopeFromStream(message: unknown, networkId: number): EnvelopeResult {
  const raw = asRecord(message);
  if (raw === undefined) {
    return { ok: false, reason: 'stream message is not an object' };
  }
  if (raw.validated !== true) {
    return { ok: false, reason: 'stream transaction is not validated' };
  }
  return buildEnvelope(raw, 'live', networkId);
}

/**
 * Builds an envelope from one account_tx entry. Transaction-level
 * `validated` may be absent (the method returns validated history) but must
 * not be false.
 */
export function envelopeFromAccountTx(entry: unknown, networkId: number): EnvelopeResult {
  const raw = asRecord(entry);
  if (raw === undefined) {
    return { ok: false, reason: 'account_tx entry is not an object' };
  }
  if (raw.validated === false) {
    return { ok: false, reason: 'account_tx entry reports validated=false' };
  }
  return buildEnvelope(raw, 'backfill', networkId);
}

function buildEnvelope(
  raw: Record<string, unknown>,
  source: 'live' | 'backfill',
  networkId: number,
): EnvelopeResult {
  const tx = asRecord(raw.tx_json);
  const meta = asRecord(raw.meta);
  if (tx === undefined || meta === undefined) {
    return { ok: false, reason: 'tx_json or meta is missing' };
  }
  const { hash, ledger_hash: ledgerHash, ledger_index: ledgerIndex } = raw;
  if (typeof hash !== 'string' || !HASH_PATTERN.test(hash)) {
    return { ok: false, reason: 'transaction hash is missing or malformed' };
  }
  if (typeof ledgerHash !== 'string' || !HASH_PATTERN.test(ledgerHash)) {
    return { ok: false, reason: 'ledger hash is missing or malformed' };
  }
  if (
    typeof ledgerIndex !== 'number' ||
    !Number.isSafeInteger(ledgerIndex) ||
    ledgerIndex < 0 ||
    ledgerIndex > LEDGER_INDEX_MAX
  ) {
    return { ok: false, reason: 'ledger index is missing or out of range' };
  }
  const closeTime = resolveCloseTime(raw.close_time_iso, tx.date);
  if (closeTime === undefined) {
    return { ok: false, reason: 'close_time_iso and tx_json.date are both missing' };
  }
  if (tx.NetworkID !== undefined && tx.NetworkID !== networkId) {
    return {
      ok: false,
      reason: `transaction NetworkID ${JSON.stringify(tx.NetworkID)} is not ${networkId}`,
    };
  }
  return {
    ok: true,
    envelope: {
      source,
      networkId,
      ledgerIndex,
      ledgerHash: ledgerHash.toUpperCase(),
      closeTime,
      hash: hash.toUpperCase(),
      // Stream messages carry ctid at the top level; account_tx (API v2) inside tx_json.
      upstreamCtid: upstreamCtid(raw.ctid ?? tx.ctid),
      tx,
      meta,
    },
  };
}

function upstreamCtid(value: unknown): string | undefined {
  return typeof value === 'string' ? value.toUpperCase() : undefined;
}

/**
 * The only business normalization of XRPL transactions. Live events and
 * account_tx history both go through `normalize`, so they cannot disagree.
 */
@Injectable()
export class PaymentNormalizerService {
  normalize(
    envelope: ValidatedTransactionEnvelope,
    account: MonitoredAccountRef,
  ): NormalizationResult {
    const tx = asRecord(envelope.tx);
    const meta = asRecord(envelope.meta);
    if (tx === undefined || meta === undefined) {
      return integrity('tx_json or meta is not an object');
    }
    if (tx.TransactionType !== 'Payment') {
      return { outcome: 'IGNORED_NON_PAYMENT' };
    }

    const { Account: source, Destination: destination } = tx;
    if (
      typeof source !== 'string' ||
      !isValidClassicAddress(source) ||
      typeof destination !== 'string' ||
      !isValidClassicAddress(destination)
    ) {
      return integrity('Payment Account or Destination is not a classic address');
    }
    if (source === destination) {
      return { outcome: 'IGNORED_SELF_PAYMENT' };
    }
    if (destination !== account.address) {
      // Sent by the monitored account, or passing through it: not incoming.
      return { outcome: 'IGNORED_OUTGOING_PAYMENT' };
    }

    const transactionResult = meta.TransactionResult;
    if (typeof transactionResult !== 'string') {
      return integrity('meta.TransactionResult is missing');
    }
    if (transactionResult !== 'tesSUCCESS') {
      return { outcome: 'IGNORED_FAILED_TRANSACTION', reason: transactionResult };
    }

    const transactionIndex = meta.TransactionIndex;
    if (
      typeof transactionIndex !== 'number' ||
      !Number.isSafeInteger(transactionIndex) ||
      transactionIndex < 0 ||
      transactionIndex > TRANSACTION_INDEX_MAX
    ) {
      return integrity('meta.TransactionIndex is missing or out of range');
    }

    const delivered = parseDeliveredAmount(meta.delivered_amount);
    switch (delivered.kind) {
      case 'unavailable':
        return { outcome: 'UNSUPPORTED_DELIVERED_AMOUNT' };
      case 'unsupported':
        return { outcome: 'UNSUPPORTED_ASSET_TYPE', reason: delivered.reason };
      case 'invalid':
        return integrity(delivered.reason);
      case 'ok':
        break;
    }

    const destinationTag = tx.DestinationTag;
    if (
      destinationTag !== undefined &&
      (typeof destinationTag !== 'number' ||
        !Number.isSafeInteger(destinationTag) ||
        destinationTag < 0 ||
        destinationTag > UINT32_MAX)
    ) {
      return integrity('DestinationTag is out of range');
    }

    let ctid: string;
    try {
      ctid = encodeCtid(envelope.ledgerIndex, transactionIndex, envelope.networkId);
    } catch (error) {
      return integrity(error instanceof Error ? error.message : 'CTID out of range');
    }
    if (envelope.upstreamCtid !== undefined && envelope.upstreamCtid !== ctid) {
      return integrity(`upstream CTID ${envelope.upstreamCtid} does not match computed ${ctid}`);
    }

    return {
      outcome: 'ACCEPTED',
      payment: {
        monitoredAccountId: account.id,
        networkId: envelope.networkId,
        hash: envelope.hash,
        ctid,
        ledgerIndex: envelope.ledgerIndex,
        transactionIndex,
        ledgerHash: envelope.ledgerHash,
        closeTime: envelope.closeTime,
        source,
        destination,
        destinationTag: destinationTag ?? null,
        asset: delivered.amount,
        transactionResult,
        rawTransaction: tx,
        rawMetadata: meta,
      },
    };
  }
}

function integrity(reason: string): NormalizationResult {
  return { outcome: 'INTEGRITY_ERROR', reason };
}
