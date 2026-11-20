import {
  drizzle,
  type NodePgDatabase,
  type NodePgQueryResultHKT,
} from 'drizzle-orm/node-postgres';
import type {PgAsyncDatabase} from 'drizzle-orm/pg-core';
import {Client} from 'pg';
import {AppError} from '../lib/errors';
import {
  entities,
  pushSubscriptions,
  reminders,
  sessions,
  usageDays,
  users,
} from './schema';

export type Database = NodePgDatabase;
/** The database or an open transaction on it. */
export type Executor = PgAsyncDatabase<NodePgQueryResultHKT>;

const CONNECT_TIMEOUT_MS = 5000;
const QUERY_TIMEOUT_MS = 15_000;
const TRANSACTION_ATTEMPTS = 3;
/** Deadlock and serialization failure: a retry may succeed. */
const RETRYABLE_SQL_STATES = new Set(['40P01', '40001']);
/** Undefined table or column: the migrations are behind the code. */
const SCHEMA_SQL_STATES = new Set(['42P01', '42703']);

/** Set once this isolate has seen every table and column the code uses. */
let schemaVerified = false;

/** Returns the SQLSTATE of a pg error, looking through Drizzle's wrapper. */
export function sqlState(error: unknown): string | undefined {
  let current: unknown = error;
  while (current instanceof Error) {
    if ('code' in current && typeof current.code === 'string') {
      return current.code;
    }
    current = current.cause;
  }
  return undefined;
}

/**
 * Selects every column of every table, once per isolate, so code deployed
 * ahead of its migrations fails clearly instead of at random queries.
 */
async function verifySchema(db: Database): Promise<void> {
  if (schemaVerified) return;
  try {
    await db
      .select()
      .from(users)
      .crossJoin(sessions)
      .crossJoin(usageDays)
      .crossJoin(entities)
      .crossJoin(reminders)
      .crossJoin(pushSubscriptions)
      .limit(0);
  } catch (error: unknown) {
    const state = sqlState(error);
    if (state && SCHEMA_SQL_STATES.has(state)) {
      console.error(
        JSON.stringify({
          msg: 'database schema is behind the code; run npm run db:migrate',
          error: String(error),
        }),
      );
      throw new AppError(
        503,
        'storage_unavailable',
        '数据库结构尚未更新，请稍后再试',
      );
    }
    throw error;
  }
  schemaVerified = true;
}

/**
 * The connection of one request or cron run. Hyperdrive pools connections,
 * so each request opens its own client and closes it at the end; a client is
 * never shared across requests.
 */
export class DatabaseConnection {
  private opening: Promise<Database> | null = null;
  private client: Client | null = null;
  private readonly deferred: Array<(db: Database) => Promise<unknown>> = [];

  constructor(private readonly connectionString: string) {}

  /** Connects on first use; later calls share the connection. */
  get(): Promise<Database> {
    this.opening ??= this.open();
    return this.opening;
  }

  /** Queues `work` to run on this connection once the response is sent. */
  defer(work: (db: Database) => Promise<unknown>): void {
    this.deferred.push(work);
  }

  /** Runs the deferred work, then closes the connection. */
  async close(): Promise<void> {
    if (!this.opening && this.deferred.length === 0) return;
    try {
      const db = await this.get();
      for (const work of this.deferred) {
        await work(db).catch((error: unknown) => {
          console.error(
            JSON.stringify({
              msg: 'deferred database work failed',
              error: String(error),
            }),
          );
        });
      }
    } catch {
      // The connection never opened, and the request already reported it.
    } finally {
      await this.client?.end().catch(() => undefined);
    }
  }

  private async open(): Promise<Database> {
    const client = new Client({
      connectionString: this.connectionString,
      connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
      query_timeout: QUERY_TIMEOUT_MS,
    });
    // pg reports socket failures as events, which throw when unhandled.
    client.on('error', (error: Error) => {
      console.error(
        JSON.stringify({msg: 'database client error', error: String(error)}),
      );
    });
    this.client = client;
    try {
      await client.connect();
    } catch (error: unknown) {
      console.error(
        JSON.stringify({
          msg: 'database connection failed',
          error: String(error),
        }),
      );
      throw new AppError(
        503,
        'storage_unavailable',
        '数据库暂时无法连接，请稍后再试',
      );
    }
    const db = drizzle({client});
    await verifySchema(db);
    return db;
  }
}

/** Runs `work` in a transaction, retrying deadlocks and serialization failures. */
export async function inTransaction<T>(
  db: Database,
  work: (tx: Executor) => Promise<T>,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await db.transaction(work);
    } catch (error: unknown) {
      const state = sqlState(error);
      if (!state || !RETRYABLE_SQL_STATES.has(state)) throw error;
      if (attempt >= TRANSACTION_ATTEMPTS) {
        throw new AppError(503, 'storage_busy', '数据库繁忙，请稍后重试');
      }
    }
  }
}
