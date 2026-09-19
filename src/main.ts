import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module';
import { configureApp, createAdapter } from './app.setup';
import { AppConfigService } from './config/config.service';

async function bootstrap(): Promise<void> {
  // PostgreSQL or Redis unreachable at startup makes create() reject and the
  // process exit non-zero. An XRPL outage does not: the service stays up,
  // not ready, and keeps reconnecting.
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, createAdapter(), {
    bufferLogs: true,
  });
  configureApp(app);
  app.enableShutdownHooks(['SIGTERM', 'SIGINT']);
  await app.listen(app.get(AppConfigService).port, '0.0.0.0');
}

bootstrap().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`startup failed: ${message}\n`);
  process.exit(1);
});
