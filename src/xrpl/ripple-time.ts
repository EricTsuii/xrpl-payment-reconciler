import { RIPPLE_EPOCH_OFFSET_SECONDS } from '../common/constants';

/** Converts XRPL "seconds since 2000-01-01T00:00:00Z" to an ISO timestamp. */
export function rippleTimeToIso(rippleSeconds: number): string {
  return new Date((rippleSeconds + RIPPLE_EPOCH_OFFSET_SECONDS) * 1000).toISOString();
}

/** Close time from close_time_iso, falling back to tx_json.date; undefined if neither. */
export function resolveCloseTime(closeTimeIso: unknown, txDate: unknown): string | undefined {
  if (typeof closeTimeIso === 'string') {
    const parsed = new Date(closeTimeIso);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString();
    }
  }
  if (typeof txDate === 'number' && Number.isSafeInteger(txDate) && txDate >= 0) {
    return rippleTimeToIso(txDate);
  }
  return undefined;
}
