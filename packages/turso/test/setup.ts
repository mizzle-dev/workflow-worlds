/**
 * Shared test setup for Turso World
 *
 * This file is loaded by vitest's setupFiles config.
 * It manages the test database lifecycle and runs migrations.
 */

import { unlinkSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient, type Client } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { beforeAll, afterAll } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Test database file paths
const testDbPath = join(__dirname, '..', 'test.db');
const extendedTestDbPath = join(__dirname, '..', 'test-extended.db');
const migrationsPath = join(__dirname, '..', 'src', 'drizzle', 'migrations');

let extendedClient: Client | undefined;

/**
 * Runs Drizzle migrations on a database client.
 */
async function runMigrations(client: Client): Promise<void> {
  await client.execute('PRAGMA journal_mode = WAL');
  await client.execute('PRAGMA busy_timeout = 5000');
  const db = drizzle(client);
  await migrate(db, {
    migrationsFolder: migrationsPath,
    migrationsTable: 'workflow_migrations',
  });
}

beforeAll(async () => {
  // Clean up any existing test databases
  if (existsSync(testDbPath)) {
    unlinkSync(testDbPath);
  }
  if (existsSync(extendedTestDbPath)) {
    unlinkSync(extendedTestDbPath);
  }

  // Set environment variables for the standard test
  process.env.WORKFLOW_TURSO_DATABASE_URL = `file:${testDbPath}`;

  // Run migrations on the main test database
  const client = createClient({ url: `file:${testDbPath}` });
  await runMigrations(client);
  await client.close();
}, 30_000);

afterAll(async () => {
  try {
    if (extendedClient) {
      extendedClient.close();
      extendedClient = undefined;
    }
    if (existsSync(testDbPath)) {
      unlinkSync(testDbPath);
    }
    if (existsSync(extendedTestDbPath)) {
      unlinkSync(extendedTestDbPath);
    }
  } catch {
    // Ignore cleanup errors
  }
});

async function getExtendedClient(): Promise<Client> {
  if (!extendedClient) {
    extendedClient = createClient({
      url: `file:${extendedTestDbPath}`,
    });
    // Run migrations
    await runMigrations(extendedClient);
  }
  return extendedClient;
}

export const worldPath = join(__dirname, '..', 'dist', 'index.js');

export async function createStorage() {
  const mod = await import(join(__dirname, '..', 'dist', 'storage.js'));
  const client = await getExtendedClient();
  const storage = mod.createStorage({ client });
  return { storage };
}

export async function createStreamer() {
  const mod = await import(join(__dirname, '..', 'dist', 'streamer.js'));
  const client = await getExtendedClient();
  const streamer = mod.createStreamer({ client });
  return { streamer };
}
