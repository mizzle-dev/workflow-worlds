/**
 * Turso World Implementation
 *
 * A complete World implementation using Turso/libSQL for storage,
 * queue, and streaming. Supports both embedded (local file) and
 * remote Turso databases.
 *
 * Setup:
 * Before using this World, run the database setup command:
 *   pnpm exec workflow-turso-setup
 *
 * Key behavior:
 * - queue() stores messages in the database
 * - start() begins processing messages
 * - If start() is not called, messages are stored but not processed
 *
 * Environment variables:
 * - WORKFLOW_TURSO_DATABASE_URL: Database URL (libsql://... or file:...)
 * - WORKFLOW_TURSO_AUTH_TOKEN: Auth token for remote Turso databases
 * - WORKFLOW_SERVICE_URL: Base URL for queue callbacks
 * - WORKFLOW_CONCURRENCY: Queue concurrency (default: 20)
 * - PORT: HTTP server port (fallback for service URL)
 */

import { createClient, type Client } from '@libsql/client';
import { globalSingleton } from '@workflow/utils';
import { mintedSpecVersion, type Storage, type World } from '@workflow/world';
import { createQueue } from './queue.js';
import { createStorage } from './storage.js';
import { createStreamer } from './streamer.js';

/**
 * Configuration for the Turso World.
 */
export interface TursoWorldConfig {
  /**
   * Database URL (libsql://... for remote, file:... for local).
   * Falls back to WORKFLOW_TURSO_DATABASE_URL or file:workflow.db
   */
  databaseUrl?: string;

  /**
   * Auth token for remote Turso databases.
   * Falls back to WORKFLOW_TURSO_AUTH_TOKEN
   */
  authToken?: string;

  /**
   * Base URL for HTTP callbacks.
   * Falls back to WORKFLOW_SERVICE_URL or http://localhost:{PORT}
   */
  baseUrl?: string;

  /**
   * Maximum concurrent message processing.
   * Falls back to WORKFLOW_CONCURRENCY or 20
   */
  concurrency?: number;

  /**
   * Idempotency TTL in milliseconds.
   * Default: 5000 (5 seconds)
   */
  idempotencyTtlMs?: number;

  /**
   * Maximum retry attempts for queue messages.
   * Default: 3
   */
  maxRetries?: number;

  /**
   * Polling interval in milliseconds.
   * Default: 100
   */
  pollIntervalMs?: number;
}

// Process-wide client cache, so every copy of this module a bundler produces
// shares one connection per database.
const connections = globalSingleton('@workflow-worlds/turso//connections', 1, () => ({
  clients: new Map<string, Client>(),
  pragmaInit: new Map<string, Promise<void>>(),
}));

/**
 * Gets or creates a Turso client for the given URL.
 */
function getOrCreateClient(url: string, authToken?: string): Client {
  const cacheKey = `${url}:${authToken ?? ''}`;
  let client = connections.clients.get(cacheKey);
  if (!client) {
    client = createClient({
      url,
      authToken,
    });
    connections.clients.set(cacheKey, client);
  }
  return client;
}

/**
 * Configure SQLite pragmas for local file databases.
 * busy_timeout is per-connection, so this must run for runtime clients too.
 */
async function configureLocalSqlitePragmas(
  cacheKey: string,
  client: Client,
  databaseUrl: string
): Promise<void> {
  if (!databaseUrl.startsWith('file:')) {
    return;
  }

  const existing = connections.pragmaInit.get(cacheKey);
  if (existing) {
    await existing;
    return;
  }

  const init = (async () => {
    await client.execute('PRAGMA journal_mode = WAL');
    await client.execute('PRAGMA busy_timeout = 5000');
  })();

  connections.pragmaInit.set(cacheKey, init);
  await init;
}

/**
 * Creates a Turso World instance.
 *
 * This implementation uses Turso/libSQL for:
 * - Storage: SQL tables for runs, steps, events, hooks
 * - Queue: Polling-based queue with TTL idempotency
 * - Streamer: Table-based chunks with EventEmitter notifications
 *
 * Key behavior:
 * - queue() stores messages in the database
 * - start() begins processing messages
 * - If start() is not called, messages are stored but not processed
 */
export function createWorld(config: TursoWorldConfig = {}): World {
  // Resolve configuration with environment variable fallbacks
  const databaseUrl =
    config.databaseUrl ??
    process.env.WORKFLOW_TURSO_DATABASE_URL ??
    'file:workflow.db';

  const authToken =
    config.authToken ?? process.env.WORKFLOW_TURSO_AUTH_TOKEN ?? undefined;

  const concurrency =
    config.concurrency ??
    (process.env.WORKFLOW_CONCURRENCY
      ? parseInt(process.env.WORKFLOW_CONCURRENCY, 10)
      : 20);

  const clientCacheKey = `${databaseUrl}:${authToken ?? ''}`;

  // Get or create client
  const client = getOrCreateClient(databaseUrl, authToken);

  // Lazy initialization promise
  let initPromise: Promise<{
    storage: ReturnType<typeof createStorage>;
    queue: ReturnType<typeof createQueue>['queue'];
    streamer: ReturnType<typeof createStreamer>;
    startQueue: () => Promise<void>;
    closeQueue: () => Promise<void>;
  }> | null = null;

  // Ensure initialized before any operation
  function ensureInitialized() {
    if (!initPromise) {
      initPromise = (async () => {
        await configureLocalSqlitePragmas(clientCacheKey, client, databaseUrl);

        // Note: Schema must be created by running: pnpm exec workflow-turso-setup
        // Create components
        const storage = createStorage({ client });
        const queueResult = createQueue({
          client,
          baseUrl: config.baseUrl,
          concurrency,
          idempotencyTtlMs: config.idempotencyTtlMs,
          maxRetries: config.maxRetries,
          pollIntervalMs: config.pollIntervalMs,
        });
        const streamer = createStreamer({ client });

        return {
          storage,
          queue: queueResult.queue,
          streamer,
          startQueue: queueResult.start,
          closeQueue: queueResult.close,
        };
      })();
    }
    return initPromise;
  }

  const storage = async (): Promise<Storage> => (await ensureInitialized()).storage;

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
      // but it will initialize on first use
      let queueHandler: ((req: Request) => Promise<Response>) | null = null;

      return async (req: Request): Promise<Response> => {
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
      async write(runId, name, chunk) {
        const { streamer } = await ensureInitialized();
        return streamer.streams.write(runId, name, chunk);
      },
      async writeMulti(runId, name, chunks) {
        const { streamer } = await ensureInitialized();
        return streamer.streams.writeMulti!(runId, name, chunks);
      },
      async close(runId, name) {
        const { streamer } = await ensureInitialized();
        return streamer.streams.close(runId, name);
      },
      async get(runId, name, startIndex) {
        const { streamer } = await ensureInitialized();
        return streamer.streams.get(runId, name, startIndex);
      },
      async list(runId) {
        const { streamer } = await ensureInitialized();
        return streamer.streams.list(runId);
      },
      async getChunks(runId, name, options) {
        const { streamer } = await ensureInitialized();
        return streamer.streams.getChunks(runId, name, options);
      },
      async getInfo(runId, name) {
        const { streamer } = await ensureInitialized();
        return streamer.streams.getInfo(runId, name);
      },
    },

    // =========================================================================
    // LIFECYCLE
    // =========================================================================

    /**
     * Start the World as a worker that processes queue messages.
     * Without calling start(), the World will only store data but not process queue messages.
     */
    async start(): Promise<void> {
      const { startQueue } = await ensureInitialized();
      await startQueue();
    },

    /**
     * Stops the queue worker. The database client is shared process-wide
     * and stays open for other World instances.
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
