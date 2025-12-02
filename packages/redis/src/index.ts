/**
 * Redis World Implementation
 *
 * A production-ready World implementation using Redis for storage,
 * BullMQ for queue processing, and Redis Streams for real-time output.
 */

import type { World } from '@workflow/world';
import { Redis } from 'ioredis';
import type { Redis as RedisClient } from 'ioredis';
import { createQueue, type QueueConfig } from './queue.js';
import { createStorage, type RedisStorageConfig } from './storage.js';
import { createStreamer, type StreamerConfig } from './streamer.js';
import { debug } from './utils.js';

// Module-level client cache to share connections across multiple createWorld() calls
const clientCache = new Map<string, RedisClient>();

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

  return {
    // =========================================================================
    // RUNS STORAGE
    // =========================================================================
    runs: {
      async create(data) {
        const { storage } = await ensureInitialized();
        return storage.runs.create(data);
      },
      async get(id, params) {
        const { storage } = await ensureInitialized();
        return storage.runs.get(id, params);
      },
      async update(id, data) {
        const { storage } = await ensureInitialized();
        return storage.runs.update(id, data);
      },
      async list(params) {
        const { storage } = await ensureInitialized();
        return storage.runs.list(params);
      },
      async cancel(id, params) {
        const { storage } = await ensureInitialized();
        return storage.runs.cancel(id, params);
      },
      async pause(id, params) {
        const { storage } = await ensureInitialized();
        return storage.runs.pause(id, params);
      },
      async resume(id, params) {
        const { storage } = await ensureInitialized();
        return storage.runs.resume(id, params);
      },
    },

    // =========================================================================
    // STEPS STORAGE
    // =========================================================================
    steps: {
      async create(runId, data) {
        const { storage } = await ensureInitialized();
        return storage.steps.create(runId, data);
      },
      async get(runId, stepId, params) {
        const { storage } = await ensureInitialized();
        return storage.steps.get(runId, stepId, params);
      },
      async update(runId, stepId, data) {
        const { storage } = await ensureInitialized();
        return storage.steps.update(runId, stepId, data);
      },
      async list(params) {
        const { storage } = await ensureInitialized();
        return storage.steps.list(params);
      },
    },

    // =========================================================================
    // EVENTS STORAGE
    // =========================================================================
    events: {
      async create(runId, data, params) {
        const { storage } = await ensureInitialized();
        return storage.events.create(runId, data, params);
      },
      async list(params) {
        const { storage } = await ensureInitialized();
        return storage.events.list(params);
      },
      async listByCorrelationId(params) {
        const { storage } = await ensureInitialized();
        return storage.events.listByCorrelationId(params);
      },
    },

    // =========================================================================
    // HOOKS STORAGE
    // =========================================================================
    hooks: {
      async create(runId, data, params) {
        const { storage } = await ensureInitialized();
        return storage.hooks.create(runId, data, params);
      },
      async get(hookId, params) {
        const { storage } = await ensureInitialized();
        return storage.hooks.get(hookId, params);
      },
      async getByToken(token, params) {
        const { storage } = await ensureInitialized();
        return storage.hooks.getByToken(token, params);
      },
      async list(params) {
        const { storage } = await ensureInitialized();
        return storage.hooks.list(params);
      },
      async dispose(hookId, params) {
        const { storage } = await ensureInitialized();
        return storage.hooks.dispose(hookId, params);
      },
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
      return async (req: Request) => {
        const { queue } = await ensureInitialized();
        const queueHandler = queue.createQueueHandler(prefix, handler);
        return queueHandler(req);
      };
    },

    // =========================================================================
    // STREAMER
    // =========================================================================
    async writeToStream(name, runId, chunk) {
      const { streamer } = await ensureInitialized();
      return streamer.writeToStream(name, runId, chunk);
    },

    async closeStream(name, runId) {
      const { streamer } = await ensureInitialized();
      return streamer.closeStream(name, runId);
    },

    async readFromStream(name, startIndex) {
      const { streamer } = await ensureInitialized();
      return streamer.readFromStream(name, startIndex);
    },

    /**
     * Start the World as a worker that processes queue messages.
     * Without calling start(), the World will only store data but not process anything.
     */
    async start(): Promise<void> {
      const { startQueue } = await ensureInitialized();
      await startQueue();
    },
  };
}

// Default export for WORKFLOW_TARGET_WORLD environment variable
export default createWorld;

// Re-export types for convenience
export { type QueueConfig } from './queue.js';
export { type StreamerConfig } from './streamer.js';
export { type RedisStorageConfig } from './storage.js';
