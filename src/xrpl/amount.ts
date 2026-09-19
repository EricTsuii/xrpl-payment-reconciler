import { isValidClassicAddress } from 'xrpl';

// Financial values stay strings end to end; arithmetic uses BigInt only.

const DROPS_PATTERN = /^[0-9]+$/;
const DECIMAL_PATTERN = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][-+]?[0-9]+)?$/;
const DROPS_PER_XRP = 1_000_000n;

export type DeliveredAmount =
  | { type: 'XRP'; drops: string }
  | { type: 'ISSUED_CURRENCY'; currency: string; issuer: string; value: string };

export type DeliveredAmountResult =
  | { kind: 'ok'; amount: DeliveredAmount }
  | { kind: 'unavailable' }
  | { kind: 'unsupported'; reason: string }
  | { kind: 'invalid'; reason: string };

/** Formats drops as XRP without floating point: "25000001" → "25.000001". */
export function formatDropsToXrp(drops: string): string {
  if (!DROPS_PATTERN.test(drops)) {
    throw new RangeError('drops must be a non-negative integer string');
  }
  const value = BigInt(drops);
  const whole = value / DROPS_PER_XRP;
  const fraction = (value % DROPS_PER_XRP).toString().padStart(6, '0').replace(/0+$/, '');
  return fraction === '' ? whole.toString() : `${whole.toString()}.${fraction}`;
}

/**
 * Reads meta.delivered_amount, the amount the destination actually received.
 * Amount and DeliverMax are never used: for a partial payment they state a
 * maximum, not what arrived.
 */
export function parseDeliveredAmount(value: unknown): DeliveredAmountResult {
  if (value === undefined) {
    return { kind: 'invalid', reason: 'meta.delivered_amount is missing' };
  }
  if (value === 'unavailable') {
    return { kind: 'unavailable' };
  }
  if (typeof value === 'string') {
    if (!DROPS_PATTERN.test(value) || BigInt(value) <= 0n) {
      return { kind: 'invalid', reason: 'delivered XRP amount is not a positive drops string' };
    }
    // Canonical form, so equality with the NUMERIC column is exact.
    return { kind: 'ok', amount: { type: 'XRP', drops: BigInt(value).toString() } };
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { kind: 'unsupported', reason: 'delivered amount has an unknown shape' };
  }

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort().join(',');
  if (keys !== 'currency,issuer,value') {
    // MPT amounts carry mpt_issuance_id; anything else is a future shape.
    return { kind: 'unsupported', reason: `delivered amount has fields ${keys}` };
  }
  const { currency, issuer, value: amount } = record;
  if (
    typeof currency !== 'string' ||
    currency === '' ||
    typeof issuer !== 'string' ||
    !isValidClassicAddress(issuer) ||
    typeof amount !== 'string' ||
    !DECIMAL_PATTERN.test(amount) ||
    amount.startsWith('-')
  ) {
    return { kind: 'invalid', reason: 'issued-currency delivered amount is malformed' };
  }
  return { kind: 'ok', amount: { type: 'ISSUED_CURRENCY', currency, issuer, value: amount } };
}
