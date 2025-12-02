/**
 * Test Suite for Turso World
 *
 * This file runs both:
 * 1. The standard @workflow/world-testing suite (integration tests)
 * 2. Extended @workflow-worlds/testing suite (serialization, hooks, etc.)
 *
 * Uses a local file-based SQLite database for testing.
 */

import { unlinkSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient, type Client } from '@libsql/client';
import { createTestSuite } from '@workflow/world-testing';
import {
  serializationTests,
  hookCleanupTests,
  streamerTests,
  outputPreservationTests,
} from '@workflow-worlds/testing';
import { afterAll, beforeAll } from 'vitest';

// Get the absolute path to the built world module
const __dirname = dirname(fileURLToPath(import.meta.url));
const worldPath = join(__dirname, '..', 'dist', 'index.js');

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
  // Clean up test databases
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

// Helper to get or create extended test client
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

// =============================================================================
// Standard Test Suite
// =============================================================================
createTestSuite(worldPath);

// =============================================================================
// Extended Test Suite
// =============================================================================
// These tests verify data serialization, hook cleanup, and other edge cases.

// Create storage factory for extended tests
const createStorage = async () => {
  const mod = await import(join(__dirname, '..', 'dist', 'storage.js'));
  const client = await getExtendedClient();
  const storage = mod.createStorage({ client });
  return { storage };
};

// Create streamer factory for extended tests
const createStreamer = async () => {
  const mod = await import(join(__dirname, '..', 'dist', 'streamer.js'));
  const client = await getExtendedClient();
  const streamer = mod.createStreamer({ client });
  return { streamer };
};

// Run extended tests
serializationTests({ createStorage });
hookCleanupTests({ createStorage });
streamerTests({ createStreamer });
outputPreservationTests({ createStorage });
