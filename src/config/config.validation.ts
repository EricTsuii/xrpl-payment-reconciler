import type { LogLevel } from '@nestjs/common';
import { NETWORK_ID_MAX } from '../common/constants';

export const CONFIG_LOG_LEVELS = ['error', 'warn', 'log', 'debug'] as const;
export type ConfigLogLevel = (typeof CONFIG_LOG_LEVELS)[number];

export interface WebhookConfig {
  url: string;
  secret: string;
}

export interface AppConfig {
  databaseUrl: string;
  redisUrl: string;
  xrplNetworkId: number;
  xrplPrimaryUrl: string;
  xrplSecondaryUrl: string;
  /** Undefined when delivery is disabled. */
  webhook: WebhookConfig | undefined;
  logLevel: ConfigLogLevel;
  port: number;
}

const WEBHOOK_SECRET_MIN_BYTES = 32;

/**
 * Validates the nine supported environment variables. Values are never echoed
 * in error messages: URLs may carry passwords and the webhook secret is secret.
 */
export function validateConfig(env: Record<string, unknown>): AppConfig {
  const problems: string[] = [];

  const databaseUrl = required(env, 'DATABASE_URL', problems);
  if (databaseUrl !== undefined && !hasProtocol(databaseUrl, ['postgres:', 'postgresql:'])) {
    problems.push('DATABASE_URL must be a postgres:// or postgresql:// URL');
  }

  const redisUrl = required(env, 'REDIS_URL', problems);
  if (redisUrl !== undefined && !hasProtocol(redisUrl, ['redis:', 'rediss:'])) {
    problems.push('REDIS_URL must be a redis:// or rediss:// URL');
  }

  const xrplPrimaryUrl = required(env, 'XRPL_PRIMARY_URL', problems);
  const xrplSecondaryUrl = required(env, 'XRPL_SECONDARY_URL', problems);
  for (const [name, value] of [
    ['XRPL_PRIMARY_URL', xrplPrimaryUrl],
    ['XRPL_SECONDARY_URL', xrplSecondaryUrl],
  ] as const) {
    if (value !== undefined && !hasProtocol(value, ['ws:', 'wss:'])) {
      problems.push(`${name} must be a ws:// or wss:// URL`);
    }
  }
  if (xrplPrimaryUrl !== undefined && xrplPrimaryUrl === xrplSecondaryUrl) {
    problems.push('XRPL_PRIMARY_URL and XRPL_SECONDARY_URL must be different endpoints');
  }

  const xrplNetworkId = integer(env, 'XRPL_NETWORK_ID', 1, 0, NETWORK_ID_MAX);
  if (xrplNetworkId === undefined) {
    problems.push(`XRPL_NETWORK_ID must be an integer between 0 and ${NETWORK_ID_MAX}`);
  }

  const port = integer(env, 'PORT', 3000, 1, 65_535);
  if (port === undefined) {
    problems.push('PORT must be an integer between 1 and 65535');
  }

  const rawLogLevel = optional(env, 'LOG_LEVEL') ?? 'log';
  const logLevel = CONFIG_LOG_LEVELS.find((level) => level === rawLogLevel);
  if (logLevel === undefined) {
    problems.push(`LOG_LEVEL must be one of: ${CONFIG_LOG_LEVELS.join(', ')}`);
  }

  const webhook = webhookConfig(env, problems);

  if (
    problems.length > 0 ||
    databaseUrl === undefined ||
    redisUrl === undefined ||
    xrplPrimaryUrl === undefined ||
    xrplSecondaryUrl === undefined ||
    xrplNetworkId === undefined ||
    port === undefined ||
    logLevel === undefined
  ) {
    throw new Error(`Invalid configuration:\n- ${problems.join('\n- ')}`);
  }

  return {
    databaseUrl,
    redisUrl,
    xrplNetworkId,
    xrplPrimaryUrl,
    xrplSecondaryUrl,
    webhook,
    logLevel,
    port,
  };
}

/** Nest log levels enabled for a configured minimum level. */
export function enabledLogLevels(level: ConfigLogLevel): LogLevel[] {
  const order: LogLevel[] = ['fatal', 'error', 'warn', 'log', 'debug'];
  return order.slice(0, order.indexOf(level) + 1);
}

function webhookConfig(
  env: Record<string, unknown>,
  problems: string[],
): WebhookConfig | undefined {
  const url = optional(env, 'WEBHOOK_URL');
  const secret = optional(env, 'WEBHOOK_SECRET');
  if (url === undefined && secret === undefined) {
    return undefined;
  }
  if (url === undefined) {
    problems.push('WEBHOOK_SECRET is set but WEBHOOK_URL is missing');
    return undefined;
  }
  if (secret === undefined) {
    problems.push('WEBHOOK_URL is set but WEBHOOK_SECRET is missing');
    return undefined;
  }

  let parsed: URL | undefined;
  try {
    parsed = new URL(url);
  } catch {
    problems.push('WEBHOOK_URL is not a valid URL');
  }
  if (parsed !== undefined) {
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      problems.push('WEBHOOK_URL must be an http:// or https:// URL');
    }
    if (parsed.username !== '' || parsed.password !== '') {
      problems.push('WEBHOOK_URL must not contain a username or password');
    }
  }
  if (Buffer.byteLength(secret, 'utf8') < WEBHOOK_SECRET_MIN_BYTES) {
    problems.push(`WEBHOOK_SECRET must be at least ${WEBHOOK_SECRET_MIN_BYTES} UTF-8 bytes`);
  }
  return { url, secret };
}

function optional(env: Record<string, unknown>, name: string): string | undefined {
  const value = env[name];
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function required(
  env: Record<string, unknown>,
  name: string,
  problems: string[],
): string | undefined {
  const value = optional(env, name);
  if (value === undefined) {
    problems.push(`${name} is required`);
  }
  return value;
}

function integer(
  env: Record<string, unknown>,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number | undefined {
  const raw = optional(env, name);
  if (raw === undefined) {
    return fallback;
  }
  if (!/^(0|[1-9][0-9]*)$/.test(raw)) {
    return undefined;
  }
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= min && value <= max ? value : undefined;
}

function hasProtocol(value: string, protocols: string[]): boolean {
  try {
    return protocols.includes(new URL(value).protocol);
  } catch {
    return false;
  }
}
