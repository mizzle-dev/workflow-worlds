/**
 * Test Suite for Redis World
 *
 * This file runs both:
 * 1. The standard @workflow/world-testing suite (integration tests)
 * 2. Extended @workflow-worlds/testing suite (serialization, hooks, etc.)
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RedisContainer } from '@testcontainers/redis';
import { createTestSuite } from '@workflow/world-testing';
import {
  serializationTests,
  hookCleanupTests,
  streamerTests,
  outputPreservationTests,
} from '@workflow-worlds/testing';
import { afterAll, beforeAll } from 'vitest';
import { Redis } from 'ioredis';

// Get the absolute path to the built world module
const __dirname = dirname(fileURLToPath(import.meta.url));
const worldPath = join(__dirname, '..', 'dist', 'index.js');

let container: Awaited<ReturnType<RedisContainer['start']>>;
let redisClient: Redis | undefined;

beforeAll(async () => {
  // Start Redis container
  container = await new RedisContainer('redis:7-alpine').start();

  // Set connection string for the world
  process.env.WORKFLOW_REDIS_URI = container.getConnectionUrl();

  console.log(`[test] Redis container started at ${process.env.WORKFLOW_REDIS_URI}`);
}, 120_000);

afterAll(async () => {
  if (redisClient) {
    await redisClient.quit();
    redisClient = undefined;
  }
  if (container) {
    await container.stop();
    console.log('[test] Redis container stopped');
  }
});

// Helper to get or create Redis client
function getRedisClient(): Redis {
  if (!redisClient) {
    redisClient = new Redis(process.env.WORKFLOW_REDIS_URI!, {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    });
  }
  return redisClient;
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
  const client = getRedisClient();

  // Wait for client to be ready
  if (client.status !== 'ready') {
    await new Promise<void>((resolve, reject) => {
      client.once('ready', resolve);
      client.once('error', reject);
    });
  }

  const { storage } = await mod.createStorage({
    redis: client,
    config: { keyPrefix: 'test-extended' },
  });
  return { storage };
};

// Create streamer factory for extended tests
const createStreamer = async () => {
  const mod = await import(join(__dirname, '..', 'dist', 'streamer.js'));
  const client = getRedisClient();

  // Wait for client to be ready
  if (client.status !== 'ready') {
    await new Promise<void>((resolve, reject) => {
      client.once('ready', resolve);
      client.once('error', reject);
    });
  }

  const { streamer } = await mod.createStreamer({
    redis: client,
    config: { keyPrefix: 'test-extended' },
  });
  return { streamer };
};

// Run extended tests
serializationTests({ createStorage });
hookCleanupTests({ createStorage });
streamerTests({ createStreamer });
outputPreservationTests({ createStorage });
