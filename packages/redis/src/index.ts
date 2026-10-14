/**
 * Redis World Implementation
 *
 * A production-ready World implementation using Redis for storage,
 * BullMQ for queue processing, and Redis Streams for real-time output.
 */

import { globalSingleton } from '@workflow/utils';
import { mintedSpecVersion, type Storage, type World } from '@workflow/world';
import { Redis } from 'ioredis';
import type { Redis as RedisClient } from 'ioredis';
import { createQueue, type QueueConfig } from './queue.js';
import { createStorage, type RedisStorageConfig } from './storage.js';
import { createStreamer, type StreamerConfig } from './streamer.js';
import { debug } from './utils.js';

// Process-wide client cache, shared across createWorld() calls and across
// every copy of this module a bundler produces.
const { clients: clientCache } = globalSingleton('@workflow-worlds/redis//connections', 1, () => ({
  clients: new Map<string, RedisClient>(),
}));

function getOrCreateClient(redisUrl: string): RedisClient {
  const existing = clientCache.get(redisUrl);
  if (existing) {
    return existing;
  }
  const client = new Redis(redisUrl, {
    maxRetriesPerRequest: null, // Required for BullMQ
    enableReadyCheck: false, // Faster connection
  });
  clientCache.set(redisUrl, client);

  // Clean up cache on disconnect or error
  const cleanup = () => {
    if (clientCache.get(redisUrl) === client) {
      clientCache.delete(redisUrl);
    }
    client.removeListener('end', cleanup);
    client.removeListener('error', cleanup);
  };
  client.once('end', cleanup);
  client.once('error', cleanup);

  return client;
}

/**
 * Configuration for the Redis world.
 */
export interface RedisWorldConfig extends QueueConfig, StreamerConfig, RedisStorageConfig {
  /**
   * Redis connection string.
   * If not provided, uses WORKFLOW_REDIS_URI environment variable.
   * Default: 'redis://localhost:6379'
   */
  redisUrl?: string;

  /**
   * Pre-existing ioredis client to use.
   * If provided, redisUrl is ignored.
   */
  client?: Redis;
}

/**
 * Creates a Redis World instance.
 *
 * This implementation uses Redis for:
 * - Storage: Runs, steps, events, and hooks (using Hashes and Sorted Sets)
 * - Queue: BullMQ with native deduplication and retries
 * - Streaming: Redis Streams with Pub/Sub for real-time output
 */
export function createWorld(config: RedisWorldConfig = {}): World {
  const redisUrl = config.redisUrl
    ?? process.env.WORKFLOW_REDIS_URI
    ?? 'redis://localhost:6379';

  // Use provided client or create/get cached one
  const client = config.client ?? getOrCreateClient(redisUrl);

  debug('Creating world with:', {
    redisUrl: redisUrl.replace(/\/\/[^:]*:[^@]*@/, '//***:***@'), // Hide credentials
    keyPrefix: config.keyPrefix ?? 'workflow',
  });

  // Track initialization
  let initPromise: Promise<{
    storage: Awaited<ReturnType<typeof createStorage>>['storage'];
    queue: Awaited<ReturnType<typeof createQueue>>['queue'];
    streamer: Awaited<ReturnType<typeof createStreamer>>['streamer'];
    startQueue: () => Promise<void>;
    closeQueue: () => Promise<void>;
    closeStreamer: () => Promise<void>;
  }> | null = null;

  // Lazy initialization
  function ensureInitialized() {
    if (!initPromise) {
      initPromise = (async () => {
        debug('Initializing components...');

        // Wait for Redis connection
        if (client.status !== 'ready') {
          await new Promise<void>((resolve, reject) => {
            client.once('ready', resolve);
            client.once('error', reject);
          });
        }

        const [storageResult, queueResult, streamerResult] = await Promise.all([
          createStorage({ redis: client, config }),
          createQueue({
            redisUrl,
            config,
          }),
          createStreamer({ redis: client, config }),
        ]);

        debug('Initialization complete');

        return {
          storage: storageResult.storage,
          queue: queueResult.queue,
          streamer: streamerResult.streamer,
          startQueue: queueResult.start,
          closeQueue: queueResult.close,
          closeStreamer: streamerResult.close,
        };
      })();
    }
    return initPromise;
  }

  const storage = async (): Promise<Storage> => (await ensureInitialized()).storage;
  const streams = async () => (await ensureInitialized()).streamer.streams;

  return {
    specVersion: mintedSpecVersion(),

    // =========================================================================
    // STORAGE
    // =========================================================================
    runs: {
      get: (async (id: string, params?: any) =>
        (await storage()).runs.get(id, params)) as Storage['runs']['get'],
      list: (async (params?: any) =>
        (await storage()).runs.list(params)) as Storage['runs']['list'],
    },

    steps: {
      get: (async (runId: string, stepId: string, params?: any) =>
        (await storage()).steps.get(runId, stepId, params)) as Storage['steps']['get'],
      list: (async (params: any) =>
        (await storage()).steps.list(params)) as Storage['steps']['list'],
    },

    events: {
      create: (async (runId: string | null, data: any, params?: any) =>
        (await storage()).events.create(runId as string, data, params)) as Storage['events']['create'],
      get: async (runId, eventId, params) =>
        (await storage()).events.get(runId, eventId, params),
      list: async (params) => (await storage()).events.list(params),
      listByCorrelationId: async (params) =>
        (await storage()).events.listByCorrelationId(params),
    },

    hooks: {
      get: async (hookId, params) => (await storage()).hooks.get(hookId, params),
      getByToken: async (token, params) =>
        (await storage()).hooks.getByToken(token, params),
      list: async (params) => (await storage()).hooks.list(params),
    },

    // =========================================================================
    // QUEUE
    // =========================================================================
    async getDeploymentId() {
      const { queue } = await ensureInitialized();
      return queue.getDeploymentId();
    },

    async queue(queueName, message, opts) {
      const { queue } = await ensureInitialized();
      return queue.queue(queueName, message, opts);
    },

    createQueueHandler(prefix, handler) {
      // This needs to return synchronously, so we create the handler immediately
      // but it will initialize Redis on first use
      let queueHandler: ((req: Request) => Promise<Response>) | null = null;
      return async (req: Request) => {
        if (!queueHandler) {
          const { queue } = await ensureInitialized();
          queueHandler = queue.createQueueHandler(prefix, handler);
        }
        return queueHandler(req);
      };
    },

    // =========================================================================
    // STREAMER
    // =========================================================================
    streams: {
      write: async (runId, name, chunk) => (await streams()).write(runId, name, chunk),
      writeMulti: async (runId, name, chunks) =>
        (await streams()).writeMulti!(runId, name, chunks),
      close: async (runId, name) => (await streams()).close(runId, name),
      get: async (runId, name, startIndex) => (await streams()).get(runId, name, startIndex),
      list: async (runId) => (await streams()).list(runId),
      getChunks: async (runId, name, options) =>
        (await streams()).getChunks(runId, name, options),
      getInfo: async (runId, name) => (await streams()).getInfo(runId, name),
    },

    /**
     * Start the World as a worker that processes queue messages.
     * Without calling start(), the World will only store data but not process anything.
     */
    async start(): Promise<void> {
      const { startQueue } = await ensureInitialized();
      await startQueue();
    },

    /**
     * Stops the queue workers and the stream subscriber. The Redis client is
     * shared process-wide and stays open for other World instances.
     */
    async close(): Promise<void> {
      if (!initPromise) return;
      const { closeQueue, closeStreamer } = await initPromise;
      await Promise.all([closeQueue(), closeStreamer()]);
    },
  };
}

// Default export for WORKFLOW_TARGET_WORLD environment variable
export default createWorld;

// Re-export types for convenience
export { type QueueConfig } from './queue.js';
export { type StreamerConfig } from './streamer.js';
export { type RedisStorageConfig } from './storage.js';
