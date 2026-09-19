import { Injectable } from '@nestjs/common';
import { USER_AGENT, WEBHOOK_TIMEOUT_MS } from '../common/constants';
import { AppConfigService } from '../config/config.service';
import { signatureHeader } from './webhook-signature';

export type DeliveryResult = { ok: true } | { ok: false; error: string };

/**
 * One HTTP attempt for one outbox event. The response body is never read or
 * stored; redirects count as failures so a signed body only goes where it was
 * configured to go.
 */
@Injectable()
export class WebhookDeliveryService {
  constructor(private readonly config: AppConfigService) {}

  get enabled(): boolean {
    return this.config.webhook !== undefined;
  }

  async deliver(eventId: string, body: string): Promise<DeliveryResult> {
    const webhook = this.config.webhook;
    if (webhook === undefined) {
      return { ok: false, error: 'webhook delivery is disabled' };
    }
    try {
      const response = await fetch(webhook.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': USER_AGENT,
          'X-Reconciler-Event-Id': eventId,
          'X-Reconciler-Signature': signatureHeader(body, webhook.secret),
        },
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
      });
      await response.body?.cancel();
      if (response.status >= 200 && response.status <= 299) {
        return { ok: true };
      }
      return { ok: false, error: `HTTP ${response.status}` };
    } catch (error) {
      if (error instanceof Error && error.name === 'TimeoutError') {
        return { ok: false, error: `timed out after ${WEBHOOK_TIMEOUT_MS} ms` };
      }
      const cause = error instanceof Error && error.cause instanceof Error ? error.cause : error;
      return {
        ok: false,
        error: `network error: ${cause instanceof Error ? cause.message : 'unknown'}`,
      };
    }
  }
}
