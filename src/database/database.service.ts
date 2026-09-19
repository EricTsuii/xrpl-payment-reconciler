import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { drizzle, NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { STARTUP_CONNECT_TIMEOUT_MS } from '../common/constants';
import { AppConfigService } from '../config/config.service';
import * as schema from './schema';

export type Database = NodePgDatabase<typeof schema>;

/** A Drizzle handle that is either the pool or an open transaction. */
export type DbExecutor = Pick<Database, 'select' | 'insert' | 'update' | 'delete' | 'execute'>;

@Injectable()
export class DatabaseService implements OnModuleInit {
  private readonly logger = new Logger('DatabaseService');
  readonly pool: Pool;
  readonly db: Database;
  private closed = false;

  constructor(config: AppConfigService) {
    this.pool = new Pool({
      connectionString: config.databaseUrl,
      max: 10,
      connectionTimeoutMillis: STARTUP_CONNECT_TIMEOUT_MS,
    });
    // A broken idle connection must not crash the process; the next query
    // reports the failure through the normal path.
    this.pool.on('error', () => undefined);
    this.db = drizzle(this.pool, { schema });
  }

  /** PostgreSQL must be reachable at startup; otherwise the process exits. */
  async onModuleInit(): Promise<void> {
    try {
      await this.db.execute(sql`SELECT 1`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';
      this.logger.error(`PostgreSQL is not reachable at startup: ${message}`);
      throw new Error('PostgreSQL is not reachable at startup', { cause: error });
    }
  }

  /** Runs `work` in one PostgreSQL transaction: all of it commits or none of it does. */
  transaction<T>(work: (tx: DbExecutor) => Promise<T>): Promise<T> {
    return this.db.transaction((tx) => work(tx));
  }

  async isReachable(): Promise<boolean> {
    if (this.closed) {
      return false;
    }
    try {
      await this.db.execute(sql`SELECT 1`);
      return true;
    } catch {
      return false;
    }
  }

  /** Ends the pool. Called once, last, by the shutdown sequence. */
  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    await this.pool.end();
  }
}
