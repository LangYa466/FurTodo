// Gives the worker tests a migrated PostgreSQL database: TEST_DATABASE_URL if
// set (it must be disposable), otherwise a throwaway container started with
// Docker or Podman.

import {execFile} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {promisify} from 'node:util';
import {drizzle} from 'drizzle-orm/node-postgres';
import {migrate} from 'drizzle-orm/node-postgres/migrator';
import {Client} from 'pg';
import type {TestProject} from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string;
  }
}

const run = promisify(execFile);
const IMAGE = 'docker.io/library/postgres:19-alpine';
const PASSWORD = 'furtodo-test';
const READY_TIMEOUT_MS = 60_000;
const READY_POLL_MS = 250;

interface TestDatabase {
  url: string;
  stop: () => Promise<void>;
}

async function containerCli(): Promise<string> {
  for (const cli of ['docker', 'podman']) {
    try {
      await run(cli, ['--version']);
      return cli;
    } catch {
      // Not installed; try the next one.
    }
  }
  throw new Error(
    'Worker tests need Docker or Podman, or TEST_DATABASE_URL pointing at a disposable PostgreSQL database',
  );
}

async function waitUntilReady(url: string): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  for (;;) {
    const client = new Client({connectionString: url});
    try {
      await client.connect();
      return;
    } catch (error: unknown) {
      if (Date.now() > deadline) throw error;
      await delay(READY_POLL_MS);
    } finally {
      await client.end().catch(() => undefined);
    }
  }
}

async function startContainer(): Promise<TestDatabase> {
  const cli = await containerCli();
  const {stdout} = await run(cli, [
    'run',
    '--detach',
    '--rm',
    '--env',
    `POSTGRES_PASSWORD=${PASSWORD}`,
    '--publish',
    '127.0.0.1::5432',
    IMAGE,
  ]);
  const id = stdout.trim();
  const stop = async () => {
    await run(cli, ['rm', '--force', id]).catch(() => undefined);
  };
  try {
    const mapping = (await run(cli, ['port', id, '5432/tcp'])).stdout;
    const port = mapping.trim().split('\n')[0]?.split(':').at(-1);
    const url = `postgres://postgres:${PASSWORD}@127.0.0.1:${port}/postgres`;
    await waitUntilReady(url);
    return {url, stop};
  } catch (error: unknown) {
    await stop();
    throw error;
  }
}

async function migrateDatabase(url: string): Promise<void> {
  const client = new Client({connectionString: url});
  await client.connect();
  try {
    await migrate(drizzle({client}), {migrationsFolder: 'drizzle'});
  } finally {
    await client.end();
  }
}

/** Starts or adopts a test database, migrates it, and returns its teardown. */
export default async function setup(
  project: TestProject,
): Promise<() => Promise<void>> {
  const external = process.env.TEST_DATABASE_URL;
  const database: TestDatabase = external
    ? {url: external, stop: async () => undefined}
    : await startContainer();
  try {
    await migrateDatabase(database.url);
  } catch (error: unknown) {
    await database.stop();
    throw error;
  }
  project.provide('databaseUrl', database.url);
  return database.stop;
}
