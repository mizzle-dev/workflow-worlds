/**
 * Shared test setup for Redis World
 *
 * This file is loaded by vitest's setupFiles config.
 * It manages the Redis container lifecycle.
 *
 * If WORKFLOW_REDIS_URI is already set (e.g., by GitHub Actions services),
 * testcontainers will be skipped.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RedisContainer } from '@testcontainers/redis';
import { beforeAll, afterAll } from 'vitest';
import { Redis } from 'ioredis';

const __dirname = dirname(fileURLToPath(import.meta.url));

let container: Awaited<ReturnType<RedisContainer['start']>> | null = null;
let redisClient: Redis | undefined;

beforeAll(async () => {
  // Skip testcontainers if env var is already set (e.g., GitHub Actions services)
  if (process.env.WORKFLOW_REDIS_URI) {
    console.log('[test] Using existing Redis:', process.env.WORKFLOW_REDIS_URI);
    return;
  }

  container = await new RedisContainer('redis:7-alpine').start();
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

function getRedisClient(): Redis {
  if (!redisClient) {
    redisClient = new Redis(process.env.WORKFLOW_REDIS_URI!, {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    });
  }
  return redisClient;
}

export const worldPath = join(__dirname, '..', 'dist', 'index.js');

export async function createStorage() {
  const mod = await import(join(__dirname, '..', 'dist', 'storage.js'));
  const client = getRedisClient();

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
}

export async function createStreamer() {
  const mod = await import(join(__dirname, '..', 'dist', 'streamer.js'));
  const client = getRedisClient();

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
}
