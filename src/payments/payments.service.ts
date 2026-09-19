import { Injectable } from '@nestjs/common';
import { PAYMENT_LIST_DEFAULT_LIMIT } from '../common/constants';
import { ApiError } from '../common/errors/api-error';
import { AppConfigService } from '../config/config.service';
import type { PaymentRow } from '../database/schema';
import type { ListPaymentsDto } from './dto/list-payments.dto';
import { PaymentsRepository } from './payments.repository';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface PaymentCursor {
  ledgerIndex: number;
  transactionIndex: number;
  id: string;
}

/** base64url of {"l": "<ledger index>", "t": <transaction index>, "i": "<uuid>"}. */
export function encodePaymentCursor(cursor: PaymentCursor): string {
  const json = JSON.stringify({
    l: String(cursor.ledgerIndex),
    t: cursor.transactionIndex,
    i: cursor.id,
  });
  return Buffer.from(json, 'utf8').toString('base64url');
}

export function decodePaymentCursor(value: string): PaymentCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    throw invalidCursor();
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw invalidCursor();
  }
  const { l, t, i } = parsed as { l?: unknown; t?: unknown; i?: unknown };
  if (
    typeof l !== 'string' ||
    !/^(0|[1-9][0-9]{0,8})$/.test(l) ||
    typeof t !== 'number' ||
    !Number.isInteger(t) ||
    t < 0 ||
    t > 65_535 ||
    typeof i !== 'string' ||
    !UUID_PATTERN.test(i)
  ) {
    throw invalidCursor();
  }
  return { ledgerIndex: Number(l), transactionIndex: t, id: i };
}

function invalidCursor(): ApiError {
  return new ApiError('INVALID_CURSOR', 'cursor is not valid');
}

@Injectable()
export class PaymentsService {
  constructor(
    private readonly payments: PaymentsRepository,
    private readonly config: AppConfigService,
  ) {}

  async list(query: ListPaymentsDto): Promise<{ items: PaymentRow[]; nextCursor: string | null }> {
    const limit = query.limit ?? PAYMENT_LIST_DEFAULT_LIMIT;
    const before = query.cursor === undefined ? undefined : decodePaymentCursor(query.cursor);
    const rows = await this.payments.list({
      accountId: query.accountId,
      destinationTag: query.destinationTag,
      assetType: query.assetType,
      before,
      limit: limit + 1,
    });
    const items = rows.slice(0, limit);
    const last = items[items.length - 1];
    const nextCursor =
      rows.length > limit && last !== undefined
        ? encodePaymentCursor({
            ledgerIndex: last.ledgerIndex,
            transactionIndex: last.transactionIndex,
            id: last.id,
          })
        : null;
    return { items, nextCursor };
  }

  async get(id: string): Promise<PaymentRow> {
    const row = await this.payments.findById(id);
    if (row === undefined) {
      throw new ApiError('PAYMENT_NOT_FOUND', 'Payment not found.');
    }
    return row;
  }

  async getByHash(hash: string): Promise<PaymentRow> {
    const row = await this.payments.findByHash(this.config.networkId, hash.toUpperCase());
    if (row === undefined) {
      throw new ApiError('PAYMENT_NOT_FOUND', 'Payment not found.');
    }
    return row;
  }
}
