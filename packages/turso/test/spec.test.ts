/**
 * Test Suite for Turso World
 *
 * This file uses @workflow/world-testing to run the standard test suite
 * against the Turso world implementation.
 *
 * Uses a local file-based SQLite database for testing.
 */

import { unlinkSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestSuite } from '@workflow/world-testing';
import { afterAll, beforeAll } from 'vitest';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { createClient } from '@libsql/client';

// Get the absolute path to the built world module
const __dirname = dirname(fileURLToPath(import.meta.url));
const worldPath = join(__dirname, '..', 'dist', 'index.js');

// Test database file path
const testDbPath = join(__dirname, '..', 'test.db');
const migrationsPath = join(__dirname, '..', 'src', 'drizzle', 'migrations');

beforeAll(async () => {
  // Clean up any existing test database
  if (existsSync(testDbPath)) {
    unlinkSync(testDbPath);
  }

  // Set environment variables for the test
  process.env.WORKFLOW_TURSO_DATABASE_URL = `file:${testDbPath}`;

  // Run migrations to set up the database schema
  const client = createClient({ url: `file:${testDbPath}` });
  await client.execute('PRAGMA journal_mode = WAL');
  await client.execute('PRAGMA busy_timeout = 5000');

  const db = drizzle(client);
  await migrate(db, {
    migrationsFolder: migrationsPath,
    migrationsTable: 'workflow_migrations',
  });

  await client.close();
}, 30_000);

afterAll(async () => {
  // Clean up test database
  try {
    if (existsSync(testDbPath)) {
      unlinkSync(testDbPath);
    }
  } catch {
    // Ignore cleanup errors
  }
});

// Run the full test suite against the Turso world
createTestSuite(worldPath);
