import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { OUTBOX_POLL_MS, WEBHOOK_MAX_ATTEMPTS, WEBHOOK_RETRY_DELAYS_MS } from '../common/constants';
import { WebhookDeliveryService } from '../webhooks/webhook-delivery.service';
import { ClaimedEvent, OutboxRepository } from './outbox.repository';

/** Identifies this process in outbox locks. */
export const INSTANCE_ID = randomUUID();

/**
 * Delivers outbox events one at a time, at least once. A claimed event is
 * locked for 15 seconds; if this process dies the lock expires and any
 * worker may deliver it again, which the stable event ID makes safe for the
 * receiver.
 */
@Injectable()
export class OutboxWorker {
  private readonly logger = new Logger('OutboxWorker');
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;
  private started = false;
  private stopped = false;

  constructor(
    private readonly outbox: OutboxRepository,
    private readonly delivery: WebhookDeliveryService,
  ) {}

  get deliveryEnabled(): boolean {
    return this.delivery.enabled;
  }

  /** Starts polling. Without webhook configuration events stay PENDING. */
  start(): void {
    if (this.started || this.stopped) {
      return;
    }
    this.started = true;
    if (!this.delivery.enabled) {
      this.logger.log('webhook delivery disabled: outbox events stay PENDING');
      return;
    }
    this.schedule(0);
  }

  /** Stops polling and waits for the delivery in flight. */
  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    await this.running;
  }

  /** One poll: claim at most one event and attempt it. Returns whether one was found. */
  async runOnce(): Promise<boolean> {
    await this.outbox.retireExhausted();
    const event = await this.outbox.claim(INSTANCE_ID);
    if (event === undefined) {
      return false;
    }
    await this.attempt(event);
    return true;
  }

  private schedule(delayMs: number): void {
    if (this.stopped) {
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.running = this.tick().finally(() => {
        this.running = undefined;
      });
    }, delayMs);
    this.timer.unref();
  }

  private async tick(): Promise<void> {
    let found = false;
    try {
      found = await this.runOnce();
    } catch (error) {
      this.logger.warn(`outbox poll failed: ${error instanceof Error ? error.message : 'unknown'}`);
    }
    // Keep draining while there is work; otherwise wait one poll interval.
    this.schedule(found ? 0 : OUTBOX_POLL_MS);
  }

  private async attempt(event: ClaimedEvent): Promise<void> {
    const result = await this.delivery.deliver(event.id, event.body);
    if (result.ok) {
      if (!(await this.outbox.markDelivered(event.id, INSTANCE_ID))) {
        this.logger.warn(`event ${event.id} delivered, but its lock had passed to another worker`);
      }
      return;
    }

    if (event.attemptCount >= WEBHOOK_MAX_ATTEMPTS) {
      await this.outbox.markDead(event.id, INSTANCE_ID, result.error);
      this.logger.warn(
        `event ${event.id} is DEAD after ${event.attemptCount} attempts: ${result.error}`,
      );
      return;
    }
    const delay = WEBHOOK_RETRY_DELAYS_MS[event.attemptCount - 1] ?? 30_000;
    await this.outbox.markRetry(event.id, INSTANCE_ID, delay, result.error);
    this.logger.log(
      `event ${event.id} attempt ${event.attemptCount} failed (${result.error}); retry in ${delay} ms`,
    );
  }
}
