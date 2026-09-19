import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { createClient, type RedisClientType } from 'redis';
import { STARTUP_CONNECT_TIMEOUT_MS } from '../common/constants';
import { AppConfigService } from '../config/config.service';

/**
 * The Redis connection. Redis holds nothing but per-account reconciliation
 * leases; losing it never loses business data.
 */
@Injectable()
export class RedisService implements OnModuleInit {
  private readonly logger = new Logger('RedisService');
  readonly client: RedisClientType;
  private closed = false;

  constructor(config: AppConfigService) {
    this.client = createClient({
      url: config.redisUrl,
      socket: { connectTimeout: STARTUP_CONNECT_TIMEOUT_MS },
    });
    // Reconnection is automatic; failures surface through commands.
    this.client.on('error', () => undefined);
  }

  /** Redis must be reachable at startup; otherwise the process exits. */
  async onModuleInit(): Promise<void> {
    if (this.client.isOpen) {
      return;
    }
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.client.connect(),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('connect timed out')),
            STARTUP_CONNECT_TIMEOUT_MS,
          );
        }),
      ]);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';
      this.logger.error(`Redis is not reachable at startup: ${message}`);
      this.client.destroy();
      throw new Error('Redis is not reachable at startup', { cause: error });
    } finally {
      clearTimeout(timer);
    }
  }

  async isReachable(): Promise<boolean> {
    if (this.closed || !this.client.isReady) {
      return false;
    }
    try {
      return (await this.client.ping()) === 'PONG';
    } catch {
      return false;
    }
  }

  /** Closes the connection. Called once by the shutdown sequence. */
  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    if (this.client.isOpen) {
      await this.client.close();
    }
  }
}
