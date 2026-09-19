import type { PaymentRow } from '../database/schema';
import { formatDropsToXrp } from '../xrpl/amount';

export type ApiAsset =
  | { type: 'XRP'; drops: string; xrp: string }
  | { type: 'ISSUED_CURRENCY'; currency: string; issuer: string; value: string };

export function presentAsset(row: PaymentRow): ApiAsset {
  if (row.assetType === 'XRP') {
    const drops = row.drops ?? '0';
    return { type: 'XRP', drops, xrp: formatDropsToXrp(drops) };
  }
  return {
    type: 'ISSUED_CURRENCY',
    currency: row.currency ?? '',
    issuer: row.issuer ?? '',
    value: row.value ?? '',
  };
}

/** List and detail representation; raw ledger data only in the detail. */
export function presentPayment(row: PaymentRow, withRaw = false) {
  return {
    id: row.id,
    networkId: row.networkId,
    hash: row.transactionHash,
    ctid: row.ctid,
    ledgerIndex: row.ledgerIndex,
    transactionIndex: row.transactionIndex,
    ledgerHash: row.ledgerHash,
    validatedAt: row.closeTime.toISOString(),
    source: row.sourceAccount,
    destination: row.destinationAccount,
    destinationTag: row.destinationTag,
    asset: presentAsset(row),
    ...(withRaw ? { rawTransaction: row.rawTransaction, rawMetadata: row.rawMetadata } : {}),
  };
}

/** The webhook body, serialized once when the outbox event is created. */
export function paymentValidatedBody(eventId: string, row: PaymentRow): string {
  return JSON.stringify({
    eventId,
    type: 'payment.validated',
    payment: {
      id: row.id,
      networkId: row.networkId,
      hash: row.transactionHash,
      ctid: row.ctid,
      ledgerIndex: row.ledgerIndex,
      transactionIndex: row.transactionIndex,
      source: row.sourceAccount,
      destination: row.destinationAccount,
      destinationTag: row.destinationTag,
      asset: presentAsset(row),
      validatedAt: row.closeTime.toISOString(),
    },
  });
}
