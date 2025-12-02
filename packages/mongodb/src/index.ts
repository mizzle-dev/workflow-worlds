/**
 * MongoDB World Implementation
 *
 * This is a complete MongoDB-backed World implementation.
 */

import type { World } from '@workflow/world';
import { MongoClient } from 'mongodb';
import { createQueue, type QueueConfig } from './queue.js';
import { createStorage, type MongoStorageConfig } from './storage.js';
import { createStreamer, type StreamerConfig } from './streamer.js';
import { debug } from './utils.js';

// Module-level client cache to share connections across multiple createWorld() calls
const clientCache = new Map<string, MongoClient>();

function getOrCreateClient(mongoUri: string): MongoClient {
  let client = clientCache.get(mongoUri);
  if (!client) {
    client = new MongoClient(mongoUri);
    clientCache.set(mongoUri, client);
  }
  return client;
}

/**
 * Configuration for the MongoDB world.
 */
export interface MongoDBWorldConfig extends QueueConfig, StreamerConfig, MongoStorageConfig {
  /**
   * MongoDB connection string.
   * If not provided, uses WORKFLOW_MONGODB_URI environment variable.
   * Default: 'mongodb://localhost:27017'
   */
  mongoUrl?: string;

  /**
   * Database name to use.
   * If not provided, uses WORKFLOW_MONGODB_DATABASE_NAME environment variable.
   * Default: 'workflow'
   */
  databaseName?: string;
}

/**
 * Creates a MongoDB World instance.
 *
 * This implementation uses MongoDB for:
 * - Storage: Runs, steps, events, and hooks
 * - Queue: TTL-based idempotency tracking
 * - Streaming: Real-time output via change streams
 */
export function createWorld(config: MongoDBWorldConfig = {}): World {
  // Create a shared MongoDB client for all components
  const mongoUri = config.mongoUrl
    ?? process.env.WORKFLOW_MONGODB_URI
    ?? 'mongodb://localhost:27017';
  const databaseName = config.databaseName
    ?? process.env.WORKFLOW_MONGODB_DATABASE_NAME
    ?? 'workflow';

  // Determine useChangeStreams: config > env var > default (true)
  const useChangeStreams = config.useChangeStreams
    ?? (process.env.WORKFLOW_MONGODB_CHANGE_STREAMS !== undefined
      ? process.env.WORKFLOW_MONGODB_CHANGE_STREAMS === 'true'
      : true);

  const client = getOrCreateClient(mongoUri);

  debug('Creating world with:', {
    mongoUri: mongoUri.replace(/\/\/[^:]+:[^@]+@/, '//***:***@'), // Hide credentials
    databaseName,
    useChangeStreams,
  });

  // Override config with resolved values
  const resolvedConfig = { ...config, useChangeStreams };

  // Track initialization
  let initPromise: Promise<{
    storage: any;
    queue: any;
    streamer: any;
    startQueue: () => Promise<void>;
    closeQueue: () => Promise<void>;
  }> | null = null;

  // Lazy initialization
  function ensureInitialized() {
    if (!initPromise) {
      initPromise = (async () => {
        debug('Connecting to MongoDB...');
        await client.connect();
        debug('Connected. Initializing components...');

        const [storageResult, queueResult, streamerResult] = await Promise.all([
          createStorage({ ...resolvedConfig, client, databaseName }),
          createQueue({ ...resolvedConfig, client, databaseName }),
          createStreamer({ ...resolvedConfig, client, databaseName }),
        ]);

        debug('Initialization complete');

        return {
          storage: storageResult.storage,
          queue: queueResult.queue,
          streamer: streamerResult.streamer,
          startQueue: queueResult.start,
          closeQueue: queueResult.close,
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
      // but it will initialize MongoDB on first use
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
export { type MongoStorageConfig } from './storage.js';
