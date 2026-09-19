import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig, ConfigLogLevel, WebhookConfig } from './config.validation';

export const APP_CONFIG_KEY = 'app';

/** Typed read-only access to the validated configuration. */
@Injectable()
export class AppConfigService {
  private readonly config: AppConfig;

  constructor(configService: ConfigService) {
    const config = configService.get<AppConfig>(APP_CONFIG_KEY);
    if (config === undefined) {
      throw new Error('configuration was not loaded');
    }
    this.config = config;
  }

  get databaseUrl(): string {
    return this.config.databaseUrl;
  }

  get redisUrl(): string {
    return this.config.redisUrl;
  }

  get networkId(): number {
    return this.config.xrplNetworkId;
  }

  get primaryUrl(): string {
    return this.config.xrplPrimaryUrl;
  }

  get secondaryUrl(): string {
    return this.config.xrplSecondaryUrl;
  }

  /** Undefined when webhook delivery is disabled. */
  get webhook(): WebhookConfig | undefined {
    return this.config.webhook;
  }

  get logLevel(): ConfigLogLevel {
    return this.config.logLevel;
  }

  get port(): number {
    return this.config.port;
  }
}
