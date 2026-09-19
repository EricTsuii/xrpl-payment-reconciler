import {
  BeforeApplicationShutdown,
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { SHUTDOWN_DEADLINE_MS } from '../common/constants';
import { DatabaseService } from '../database/database.service';
import { OutboxWorker } from '../outbox/outbox.worker';
import { LiveIngestionService } from '../reconciliation/live-ingestion.service';
import { ReconciliationScheduler } from '../reconciliation/reconciliation.scheduler';
import { RedisService } from '../redis/redis.service';
import { ConnectionManagerService } from '../xrpl/connection-manager.service';
import { HealthService } from './health.service';

/**
 * Starts the outbox worker and runs the shutdown sequence in its exact
 * order, within a 10-second global deadline:
 * readiness false → stop reconciliation → stop outbox worker → wait for
 * active operations → disconnect XRPL → quit Redis → end PostgreSQL pool.
 * Nest closes the application afterwards.
 */
@Injectable()
export class LifecycleService implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger('Lifecycle');
  private shutdown: Promise<void> | undefined;

  constructor(
    private readonly health: HealthService,
    private readonly scheduler: ReconciliationScheduler,
    private readonly worker: OutboxWorker,
    private readonly live: LiveIngestionService,
    private readonly connection: ConnectionManagerService,
    private readonly redis: RedisService,
    private readonly database: DatabaseService,
  ) {}

  onApplicationBootstrap(): void {
    this.worker.start();
  }

  beforeApplicationShutdown(): Promise<void> {
    this.shutdown ??= this.runShutdown();
    return this.shutdown;
  }

  private async runShutdown(): Promise<void> {
    const started = Date.now();
    this.health.markShuttingDown();

    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<'deadline'>((resolve) => {
      timer = setTimeout(() => resolve('deadline'), SHUTDOWN_DEADLINE_MS);
      timer.unref();
    });
    const drained = (async () => {
      await this.scheduler.stop();
      await this.worker.stop();
      await this.live.stop();
      return 'drained' as const;
    })();

    if ((await Promise.race([drained, deadline])) === 'deadline') {
      this.logger.warn('shutdown deadline reached with operations still running');
    }
    clearTimeout(timer);

    // Resources close in order even after the deadline, each bounded.
    await bounded(this.connection.stop(), remaining(started));
    await bounded(this.redis.close(), remaining(started));
    await bounded(this.database.close(), remaining(started));
    this.logger.log(`shutdown completed in ${Date.now() - started} ms`);
  }
}

function remaining(started: number): number {
  return Math.max(250, SHUTDOWN_DEADLINE_MS - (Date.now() - started));
}

async function bounded(work: Promise<unknown>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    work.catch(() => undefined),
    new Promise((resolve) => {
      timer = setTimeout(resolve, ms);
      timer.unref();
    }),
  ]);
  clearTimeout(timer);
}
