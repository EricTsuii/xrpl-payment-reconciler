import { LEDGER_INDEX_MAX, NETWORK_ID_MAX, TRANSACTION_INDEX_MAX } from '../common/constants';

export const CTID_PATTERN = /^C[A-F0-9]{15}$/;

/**
 * Concise Transaction Identifier: 0xC in the top nibble, then the 28-bit
 * ledger index, the 16-bit transaction index and the 16-bit network ID.
 * Throws RangeError when an input is out of bounds.
 */
export function encodeCtid(
  ledgerIndex: number,
  transactionIndex: number,
  networkId: number,
): string {
  assertRange('ledgerIndex', ledgerIndex, LEDGER_INDEX_MAX);
  assertRange('transactionIndex', transactionIndex, TRANSACTION_INDEX_MAX);
  assertRange('networkId', networkId, NETWORK_ID_MAX);
  return (
    ((0xc0000000n + BigInt(ledgerIndex)) << 32n) +
    (BigInt(transactionIndex) << 16n) +
    BigInt(networkId)
  )
    .toString(16)
    .toUpperCase();
}

function assertRange(name: string, value: number, max: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > max) {
    throw new RangeError(`${name} ${String(value)} is outside 0..${max}`);
  }
}
