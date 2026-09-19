import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { sql } from 'drizzle-orm';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { configureApp, createAdapter } from '../../src/app.setup';
import { AppConfigService, APP_CONFIG_KEY } from '../../src/config/config.service';
import { validateConfig } from '../../src/config/config.validation';
import { DatabaseService } from '../../src/database/database.service';
import { HealthService } from '../../src/health/health.service';
import { OutboxWorker } from '../../src/outbox/outbox.worker';
import { LiveIngestionService } from '../../src/reconciliation/live-ingestion.service';
import { ReconciliationService } from '../../src/reconciliation/reconciliation.service';
import { RedisService } from '../../src/redis/redis.service';
import { LEDGER_CLIENT_FACTORY } from '../../src/xrpl/ledger-client.interface';
import { FakeLedgerNetwork } from '../fakes/fake-ledger-client';
import { testEnvironment } from './environment';
import { waitFor } from './wait';

export interface TestApp {
  app: NestFastifyApplication;
  network: FakeLedgerNetwork;
  http: () => ReturnType<typeof request>;
  database: DatabaseService;
  redis: RedisService;
  reconciliation: ReconciliationService;
  live: LiveIngestionService;
  worker: OutboxWorker;
  health: HealthService;
  /** Waits for live processing and one full reconciliation cycle. */
  settle: () => Promise<void>;
  close: () => Promise<void>;
}

export interface TestAppOptions {
  network?: FakeLedgerNetwork;
  /** Keep the data of a previous run (restart scenarios). */
  keepData?: boolean;
  webhook?: { url: string; secret: string };
  /** Wait until /readyz would answer 200 (default true). */
  waitReady?: boolean;
}

/**
 * Boots the real application, configured exactly as main.ts does, with the
 * FakeLedgerClient in place of xrpl.Client. PostgreSQL and Redis are real.
 */
export async function startTestApp(options: TestAppOptions = {}): Promise<TestApp> {
  const network = options.network ?? new FakeLedgerNetwork();
  const env = testEnvironment(
    options.webhook === undefined
      ? {}
      : { WEBHOOK_URL: options.webhook.url, WEBHOOK_SECRET: options.webhook.secret },
  );
  const config = new AppConfigService({
    get: (key: string) => (key === APP_CONFIG_KEY ? validateConfig(env) : undefined),
  } as unknown as ConfigService);

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(LEDGER_CLIENT_FACTORY)
    .useValue(network.factory)
    .overrideProvider(AppConfigService)
    .useValue(config)
    .compile();

  const app = moduleRef.createNestApplication<NestFastifyApplication>(createAdapter(), {
    logger: false,
  });
  configureApp(app);

  const database = app.get(DatabaseService);
  const redis = app.get(RedisService);
  await database.onModuleInit();
  await redis.onModuleInit();
  if (!(options.keepData ?? false)) {
    await resetState(database, redis);
  }

  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  const reconciliation = app.get(ReconciliationService);
  const live = app.get(LiveIngestionService);
  const health = app.get(HealthService);
  if (options.waitReady ?? true) {
    await waitFor(async () => (await health.readiness()).ready, 'readiness');
  }

  return {
    app,
    network,
    database,
    redis,
    reconciliation,
    live,
    health,
    worker: app.get(OutboxWorker),
    http: () => request(app.getHttpServer()),
    settle: async () => {
      await live.drain();
      await reconciliation.runCycle();
    },
    close: () => app.close(),
  };
}

export async function resetState(database: DatabaseService, redis: RedisService): Promise<void> {
  await database.db.execute(
    sql`TRUNCATE outbox_events, payments, account_cursors, monitored_accounts RESTART IDENTITY CASCADE`,
  );
  await redis.client.flushDb();
}

/** Row counts of the business tables. */
export async function counts(
  database: DatabaseService,
): Promise<{ payments: number; outbox: number }> {
  const result = await database.db.execute<{ payments: string; outbox: string }>(
    sql`SELECT (SELECT count(*) FROM payments)::text AS payments, (SELECT count(*) FROM outbox_events)::text AS outbox`,
  );
  const row = result.rows[0];
  return { payments: Number(row?.payments ?? 0), outbox: Number(row?.outbox ?? 0) };
}
