/**
 * MongoDB World Implementation
 *
 * This is a complete MongoDB-backed World implementation.
 */

import { globalSingleton } from '@workflow/utils';
import { mintedSpecVersion, type Storage, type Streamer, type World } from '@workflow/world';
import { MongoClient } from 'mongodb';
import { createQueue, type QueueConfig } from './queue.js';
import { createStorage, type MongoStorageConfig } from './storage.js';
import { createStreamer, type StreamerConfig } from './streamer.js';
import { debug } from './utils.js';

// Process-wide client cache, shared across createWorld() calls and across
// every copy of this module a bundler produces.
const { clients: clientCache } = globalSingleton('@workflow-worlds/mongodb//connections', 1, () => ({
  clients: new Map<string, MongoClient>(),
}));

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
    storage: Storage;
    queue: any;
    streamer: Streamer;
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
      // but it will initialize MongoDB on first use
      let queueHandler: ((req: Request) => Promise<Response>) | null = null;
      return async (req: Request) => {
        if (!queueHandler) {
          const { queue } = await ensureInitialized();
          queueHandler = queue.createQueueHandler(prefix, handler);
        }
        return queueHandler!(req);
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
     * Stops the queue worker. The MongoDB client is shared process-wide and
     * stays open for other World instances.
     */
    async close(): Promise<void> {
      if (!initPromise) return;
      const { closeQueue } = await initPromise;
      await closeQueue();
    },
  };
}

// Default export for WORKFLOW_TARGET_WORLD environment variable
export default createWorld;

// Re-export types for convenience
export { type QueueConfig } from './queue.js';
export { type StreamerConfig } from './streamer.js';
export { type MongoStorageConfig } from './storage.js';
