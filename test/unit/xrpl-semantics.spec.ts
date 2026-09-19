import { formatDropsToXrp, parseDeliveredAmount } from '../../src/xrpl/amount';
import { CTID_PATTERN, encodeCtid } from '../../src/xrpl/ctid';
import {
  envelopeFromAccountTx,
  envelopeFromStream,
  PaymentNormalizerService,
  ValidatedTransactionEnvelope,
} from '../../src/xrpl/payment-normalizer.service';
import { resolveCloseTime, rippleTimeToIso } from '../../src/xrpl/ripple-time';
import { fixture, FIXTURE_ACCOUNTS, streamMessage } from '../fakes/fake-ledger-client';

const normalizer = new PaymentNormalizerService();
const account = { id: '00000000-0000-4000-8000-000000000001', address: FIXTURE_ACCOUNTS.monitored };

function envelope(
  name: string,
  mutate?: (entry: Record<string, unknown>) => void,
): ValidatedTransactionEnvelope {
  const raw = fixture(name);
  mutate?.(raw);
  const built = envelopeFromAccountTx(raw, 1);
  if (!built.ok) {
    throw new Error(built.reason);
  }
  return built.envelope;
}

describe('CTID', () => {
  it('matches a vector observed on the XRPL Testnet', () => {
    // rippled 3.4.0 reported C13E41B3000A0001 for ledger 20857267, index 10.
    expect(encodeCtid(20857267, 10, 1)).toBe('C13E41B3000A0001');
    expect(encodeCtid(20857256, 4, 1)).toBe('C13E41A800040001');
  });

  it('handles the minimum and maximum values', () => {
    expect(encodeCtid(0, 0, 0)).toBe('C000000000000000');
    expect(encodeCtid(268_435_455, 65_535, 65_535)).toBe('CFFFFFFFFFFFFFFF');
    expect(encodeCtid(1, 65_535, 1)).toBe('C0000001FFFF0001');
  });

  it('is 16 uppercase hexadecimal characters starting with C', () => {
    for (const value of [encodeCtid(1005, 4, 1), encodeCtid(7, 0, 21_338)]) {
      expect(value).toHaveLength(16);
      expect(value).toMatch(CTID_PATTERN);
      expect(value).toBe(value.toUpperCase());
    }
  });

  it.each([
    ['ledger index', 268_435_456, 0, 1],
    ['negative ledger index', -1, 0, 1],
    ['transaction index', 1, 65_536, 1],
    ['network ID', 1, 0, 65_536],
    ['fractional ledger index', 1.5, 0, 1],
  ])('rejects an invalid %s', (_label, ledger, index, network) => {
    expect(() => encodeCtid(ledger, index, network)).toThrow(RangeError);
  });
});

describe('XRP amounts', () => {
  it.each([
    ['1', '0.000001'],
    ['1000000', '1'],
    ['25000000', '25'],
    ['25000001', '25.000001'],
    ['100000000000000000', '100000000000'],
    ['99999999999999999999999999', '99999999999999999999.999999'],
  ])('formats %s drops as %s XRP', (drops, xrp) => {
    expect(formatDropsToXrp(drops)).toBe(xrp);
  });

  it('never uses floating point', () => {
    // 0.1 + 0.2 style errors cannot appear: this is exact to the drop.
    expect(formatDropsToXrp('100000000000000001')).toBe('100000000000.000001');
  });

  it('reads delivered XRP exactly and canonically', () => {
    expect(parseDeliveredAmount('25000000')).toEqual({
      kind: 'ok',
      amount: { type: 'XRP', drops: '25000000' },
    });
    expect(parseDeliveredAmount('99999999999999999999')).toMatchObject({
      amount: { drops: '99999999999999999999' },
    });
    expect(parseDeliveredAmount('0')).toMatchObject({ kind: 'invalid' });
    expect(parseDeliveredAmount('1.5')).toMatchObject({ kind: 'invalid' });
    expect(parseDeliveredAmount(undefined)).toMatchObject({ kind: 'invalid' });
  });

  it('keeps issued-currency values as exact strings', () => {
    const value = {
      currency: 'USD',
      issuer: FIXTURE_ACCOUNTS.issuer,
      value: '1234567890123456e-10',
    };
    expect(parseDeliveredAmount(value)).toEqual({
      kind: 'ok',
      amount: { type: 'ISSUED_CURRENCY', ...value },
    });
    expect(parseDeliveredAmount({ ...value, value: '-1' })).toMatchObject({ kind: 'invalid' });
    expect(parseDeliveredAmount({ ...value, issuer: 'nope' })).toMatchObject({ kind: 'invalid' });
  });

  it('classifies unavailable and unknown shapes', () => {
    expect(parseDeliveredAmount('unavailable')).toEqual({ kind: 'unavailable' });
    expect(parseDeliveredAmount({ mpt_issuance_id: 'AB', value: '1' })).toMatchObject({
      kind: 'unsupported',
    });
    expect(parseDeliveredAmount(42)).toMatchObject({ kind: 'unsupported' });
  });
});

describe('Ripple time', () => {
  it('converts from the Ripple epoch', () => {
    expect(rippleTimeToIso(0)).toBe('2000-01-01T00:00:00.000Z');
    expect(rippleTimeToIso(843053160)).toBe('2026-09-18T13:26:00.000Z');
  });

  it('prefers close_time_iso and falls back to tx_json.date', () => {
    expect(resolveCloseTime('2026-09-18T13:26:00Z', 1)).toBe('2026-09-18T13:26:00.000Z');
    expect(resolveCloseTime(undefined, 843053160)).toBe('2026-09-18T13:26:00.000Z');
    expect(resolveCloseTime(undefined, undefined)).toBeUndefined();
  });
});

describe('PaymentNormalizer', () => {
  it('accepts an incoming XRP payment with its DestinationTag', () => {
    const result = normalizer.normalize(envelope('payment.xrp'), account);
    expect(result).toMatchObject({
      outcome: 'ACCEPTED',
      payment: {
        monitoredAccountId: account.id,
        ctid: 'C00003ED00040001',
        ledgerIndex: 1005,
        transactionIndex: 4,
        destinationTag: 123,
        asset: { type: 'XRP', drops: '25000000' },
        transactionResult: 'tesSUCCESS',
      },
    });
  });

  it('accepts a payment without DestinationTag', () => {
    expect(normalizer.normalize(envelope('payment.xrp-no-tag'), account)).toMatchObject({
      outcome: 'ACCEPTED',
      payment: { destinationTag: null, asset: { drops: '1' } },
    });
  });

  it('accepts an issued-currency payment', () => {
    expect(normalizer.normalize(envelope('payment.issued'), account)).toMatchObject({
      outcome: 'ACCEPTED',
      payment: { asset: { type: 'ISSUED_CURRENCY', currency: 'USD', value: '12.345' } },
    });
  });

  it('uses delivered_amount for a partial payment, not DeliverMax', () => {
    const result = normalizer.normalize(envelope('payment.partial'), account);
    expect(result).toMatchObject({ outcome: 'ACCEPTED', payment: { asset: { value: '0.5' } } });
  });

  it.each([
    ['non-payment.trustset', 'IGNORED_NON_PAYMENT'],
    ['payment.outgoing', 'IGNORED_OUTGOING_PAYMENT'],
    ['payment.self', 'IGNORED_SELF_PAYMENT'],
    ['payment.failed', 'IGNORED_FAILED_TRANSACTION'],
    ['payment.delivered-unavailable', 'UNSUPPORTED_DELIVERED_AMOUNT'],
    ['payment.unsupported-amount', 'UNSUPPORTED_ASSET_TYPE'],
  ])('classifies %s as %s', (name, outcome) => {
    expect(normalizer.normalize(envelope(name), account).outcome).toBe(outcome);
  });

  it('reports INTEGRITY_ERROR for a CTID the server contradicts', () => {
    const result = normalizer.normalize(
      envelope('payment.xrp', (raw) => {
        (raw.tx_json as Record<string, unknown>).ctid = 'C00003ED00050001';
      }),
      account,
    );
    expect(result).toMatchObject({ outcome: 'INTEGRITY_ERROR' });
  });

  it('reports INTEGRITY_ERROR for malformed validated data', () => {
    const cases: ((raw: Record<string, unknown>) => void)[] = [
      (raw) => delete (raw.meta as Record<string, unknown>).delivered_amount,
      (raw) => delete (raw.meta as Record<string, unknown>).TransactionIndex,
      (raw) => {
        (raw.meta as Record<string, unknown>).delivered_amount = '0';
      },
      (raw) => {
        (raw.tx_json as Record<string, unknown>).DestinationTag = 4294967296;
      },
    ];
    for (const mutate of cases) {
      expect(normalizer.normalize(envelope('payment.xrp', mutate), account).outcome).toBe(
        'INTEGRITY_ERROR',
      );
    }
  });

  it('treats the live and backfill shapes of one transaction identically', () => {
    const raw = fixture('payment.xrp');
    const live = envelopeFromStream(streamMessage(raw), 1);
    const backfill = envelopeFromAccountTx(raw, 1);
    if (!live.ok || !backfill.ok) {
      throw new Error('envelope failed');
    }
    const a = normalizer.normalize(live.envelope, account);
    const b = normalizer.normalize(backfill.envelope, account);
    if (a.outcome !== 'ACCEPTED' || b.outcome !== 'ACCEPTED') {
      throw new Error('both paths must accept the payment');
    }
    // Raw payloads are stored as received (the stream puts ctid at the top
    // level, account_tx inside tx_json); every normalized field is identical.
    const { rawTransaction: _liveRaw, ...liveFields } = a.payment;
    const { rawTransaction: _backfillRaw, ...backfillFields } = b.payment;
    expect(liveFields).toEqual(backfillFields);
  });
});

describe('envelopes', () => {
  it('requires validated=true on the live path', () => {
    const message = streamMessage(fixture('payment.xrp'));
    expect(envelopeFromStream({ ...message, validated: false }, 1)).toMatchObject({ ok: false });
    expect(envelopeFromStream({ ...message, validated: undefined }, 1)).toMatchObject({
      ok: false,
    });
  });

  it('allows an absent validated flag in account_tx but not false', () => {
    const raw = fixture('payment.xrp');
    expect(envelopeFromAccountTx({ ...raw, validated: undefined }, 1)).toMatchObject({ ok: true });
    expect(envelopeFromAccountTx({ ...raw, validated: false }, 1)).toMatchObject({ ok: false });
  });

  it.each(['hash', 'ledger_hash', 'ledger_index', 'tx_json', 'meta'])('requires %s', (field) => {
    const raw = fixture('payment.xrp');
    delete raw[field];
    expect(envelopeFromAccountTx(raw, 1)).toMatchObject({ ok: false });
  });

  it('requires a close time from close_time_iso or tx_json.date', () => {
    const raw = fixture('payment.xrp');
    delete raw.close_time_iso;
    expect(envelopeFromAccountTx(raw, 1)).toMatchObject({ ok: true });
    delete (raw.tx_json as Record<string, unknown>).date;
    expect(envelopeFromAccountTx(raw, 1)).toMatchObject({ ok: false });
  });

  it('normalizes hashes to uppercase', () => {
    const raw = fixture('payment.xrp');
    raw.hash = String(raw.hash).toLowerCase();
    const built = envelopeFromAccountTx(raw, 1);
    expect(built.ok && built.envelope.hash).toBe(String(fixture('payment.xrp').hash));
  });
});
