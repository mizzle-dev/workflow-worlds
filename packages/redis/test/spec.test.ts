/**
 * Test Suite for Redis World
 *
 * This file uses @workflow/world-testing to run the standard test suite
 * against the Redis world implementation with a test container.
 *
 * To run tests:
 *   pnpm build
 *   pnpm test
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RedisContainer } from '@testcontainers/redis';
import { createTestSuite } from '@workflow/world-testing';
import { afterAll, beforeAll } from 'vitest';

// Get the absolute path to the built world module
const __dirname = dirname(fileURLToPath(import.meta.url));
const worldPath = join(__dirname, '..', 'dist', 'index.js');

let container: Awaited<ReturnType<RedisContainer['start']>>;

beforeAll(async () => {
  // Start Redis container
  container = await new RedisContainer('redis:7-alpine').start();

  // Set connection string for the world
  process.env.WORKFLOW_REDIS_URI = container.getConnectionUrl();

  console.log(`[test] Redis container started at ${process.env.WORKFLOW_REDIS_URI}`);
}, 120_000);

afterAll(async () => {
  if (container) {
    await container.stop();
    console.log('[test] Redis container stopped');
  }
});

// Run the full test suite against the Redis world
createTestSuite(worldPath);
