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

import { createRequire } from 'node:module';
import { createClient, type Client } from '@libsql/client';
import type { World } from '@workflow/world';
import { createQueue } from './queue.js';
import { createStorage } from './storage.js';
import { createStreamer } from './streamer.js';

const require = createRequire(import.meta.url);
const { version } = require('../package.json') as { version: string };

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

// Module-level client cache to reuse connections
const clientCache = new Map<string, Client>();

/**
 * Gets or creates a Turso client for the given URL.
 */
function getOrCreateClient(url: string, authToken?: string): Client {
  const cacheKey = `${url}:${authToken ?? ''}`;
  if (!clientCache.has(cacheKey)) {
    const client = createClient({
      url,
      authToken,
    });
    clientCache.set(cacheKey, client);
  }
  return clientCache.get(cacheKey)!;
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

  // Return a World with lazy initialization
  return {
    // World spec version for server routing
    specVersion: version,

    // =========================================================================
    // RUNS
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
    },

    // =========================================================================
    // STEPS
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
    // EVENTS
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
    // HOOKS
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
      // but it will initialize on first use
      let queueHandler: ReturnType<
        ReturnType<typeof createQueue>['queue']['createQueueHandler']
      > | null = null;

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
  };
}

// Default export for WORKFLOW_TARGET_WORLD environment variable
export default createWorld;
