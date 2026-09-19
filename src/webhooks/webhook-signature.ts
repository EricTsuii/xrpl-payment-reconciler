import { createHmac } from 'node:crypto';

/**
 * HMAC-SHA256 of the exact stored body, lowercase hex. The same event always
 * produces the same signature because the body is never re-serialized.
 */
export function signWebhookBody(body: string, secret: string): string {
  return createHmac('sha256', secret).update(body, 'utf8').digest('hex');
}

export function signatureHeader(body: string, secret: string): string {
  return `sha256=${signWebhookBody(body, secret)}`;
}
