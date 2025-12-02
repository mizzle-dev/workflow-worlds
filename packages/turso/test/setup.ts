/**
 * Shared test setup for Turso World
 *
 * This file is loaded by vitest's setupFiles config.
 * It manages the test database lifecycle.
 */

import { unlinkSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient, type Client } from '@libsql/client';
import { beforeAll, afterAll } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Test database file paths
const testDbPath = join(__dirname, '..', 'test.db');
const extendedTestDbPath = join(__dirname, '..', 'test-extended.db');

let extendedClient: Client | undefined;

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
    // Initialize schema
    const schemaModule = await import(join(__dirname, '..', 'dist', 'schema.js'));
    await schemaModule.initializeSchema(extendedClient);
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
