/**
 * MongoDB Queue Implementation
 *
 * - Persistent message storage
 * - Atomic idempotency via upsert
 * - Lock management with token verification
 * - Dual-mode watching (Change Streams + polling fallback)
 * - Graceful shutdown with in-flight tracking
 * - Exponential backoff with jitter
 * - Stuck message recovery
 */

import { JsonTransport } from '@vercel/queue';
import type {
  Queue,
  MessageId,
  ValidQueueName,
  QueuePrefix,
} from '@workflow/world';
import type { Collection, ChangeStream, MongoClient } from 'mongodb';
import { monotonicFactory } from 'ulid';
import { z } from 'zod';
import { debug } from './utils.js';

const generateUlid = monotonicFactory();

// =============================================================================
// Configuration
// =============================================================================

/**
 * Configuration for the queue.
 */
export interface QueueConfig {
  /**
   * Base URL for HTTP callbacks.
   * If not provided, uses WORKFLOW_SERVICE_URL environment variable.
   * Default: http://localhost:{PORT} (where PORT defaults to 3000)
   */
  baseUrl?: string;

  /**
   * Maximum concurrent message processing.
   * If not provided, uses WORKFLOW_CONCURRENCY environment variable.
   * Default: 20
   */
  concurrency?: number;

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

  /**
   * Optional MongoDB client instance.
   * If provided, mongoUrl will be ignored.
   */
  client?: MongoClient;

  /**
   * Polling interval in milliseconds.
   * Default: 100
   */
  pollIntervalMs?: number;

  /**
   * Lock duration in milliseconds.
   * Default: 300000 (5 minutes)
   */
  lockDurationMs?: number;

  /**
   * Maximum retries before marking as failed.
   * Default: 3
   */
  maxRetries?: number;

  /**
   * Shutdown timeout in milliseconds.
   * Default: 30000 (30 seconds)
   */
  shutdownTimeoutMs?: number;

  /**
   * Message retention in days (for completed/failed).
   * Default: 7
   */
  messageRetentionDays?: number;
}

// =============================================================================
// Constants & Defaults
// =============================================================================

const DEFAULT_POLL_INTERVAL_MS = 100;
const DEFAULT_LOCK_DURATION_MS = 300_000; // 5 minutes
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 30_000; // 30 seconds
const DEFAULT_MESSAGE_RETENTION_DAYS = 7;
const IDEMPOTENCY_TTL_MS = 60_000; // 1 minute for idempotency window
const STUCK_RECOVERY_INTERVAL_MS = 60_000; // Check for stuck messages every minute

const BACKOFF_CONFIG = {
  initialDelayMs: 1000,
  maxDelayMs: 60_000,
  multiplier: 2,
  jitter: 0.2,
};

// =============================================================================
// Types
// =============================================================================

/**
 * Message status
 */
type MessageStatus = 'pending' | 'processing' | 'completed' | 'failed';

/**
 * Persisted queue message
 */
interface QueuedMessage {
  messageId: MessageId;
  queueName: ValidQueueName;
  payload: Buffer;
  status: MessageStatus;
  attempt: number;
  maxRetries: number;
  createdAt: Date;
  updatedAt: Date;
  scheduledFor: Date;
  lockedUntil?: Date;
  lockToken?: string;
  idempotencyKey?: string;
  lastError?: {
    message: string;
    status?: number;
    timestamp: Date;
  };
}

/**
 * In-flight message tracking for graceful shutdown
 */
interface InflightContext {
  lockToken: string;
  abortController: AbortController;
}

/**
 * Watcher interface for dual-mode message watching
 */
interface Watcher {
  start(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * Queue state tracking
 */
interface QueueState {
  isRunning: boolean;
  isShuttingDown: boolean;
  inflightMessages: Map<string, InflightContext>;
  watcher: Watcher | null;
  recoveryInterval: ReturnType<typeof setInterval> | null;
}

// =============================================================================
// Utilities
// =============================================================================

/**
 * Gets the base URL for HTTP callbacks.
 */
function getBaseUrl(configBaseUrl?: string): string {
  if (configBaseUrl) {
    return configBaseUrl;
  }
  if (process.env.WORKFLOW_SERVICE_URL) {
    return process.env.WORKFLOW_SERVICE_URL;
  }
  const port = process.env.PORT ?? '3000';
  return `http://localhost:${port}`;
}

/**
 * Calculate exponential backoff delay with jitter.
 */
function calculateBackoffDelay(attempt: number): number {
  const delay = Math.min(
    BACKOFF_CONFIG.initialDelayMs * Math.pow(BACKOFF_CONFIG.multiplier, attempt - 1),
    BACKOFF_CONFIG.maxDelayMs
  );
  const jitter = delay * BACKOFF_CONFIG.jitter * (Math.random() * 2 - 1);
  return Math.round(delay + jitter);
}

/**
 * Sleep for a specified duration, respecting abort signal.
 */
async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Aborted'));
      return;
    }
    const timeout = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timeout);
      reject(new Error('Aborted'));
    });
  });
}

/**
 * Detect if Change Streams are supported (requires replica set).
 */
async function detectChangeStreamSupport(
  collection: Collection<QueuedMessage>
): Promise<boolean> {
  try {
    const stream = collection.watch([], { maxAwaitTimeMS: 1 });
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        stream.close();
        resolve();
      }, 100);
      stream.once('error', (err) => {
        clearTimeout(timeout);
        stream.close();
        reject(err);
      });
    });
    return true;
  } catch {
    return false;
  }
}

// =============================================================================
// Queue Implementation
// =============================================================================

/**
 * Creates the Queue implementation using MongoDB.
 */
export async function createQueue(config: QueueConfig = {}): Promise<{
  queue: Queue;
  client: MongoClient;
  start: () => Promise<void>;
  close: () => Promise<void>;
}> {
  const transport = new JsonTransport();

  // Resolve configuration
  const pollIntervalMs = config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const lockDurationMs = config.lockDurationMs ?? DEFAULT_LOCK_DURATION_MS;
  const maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES;
  const shutdownTimeoutMs = config.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
  const messageRetentionDays = config.messageRetentionDays ?? DEFAULT_MESSAGE_RETENTION_DAYS;

  // Get or create MongoDB client
  const { MongoClient } = await import('mongodb');
  const client = config.client ?? new MongoClient(
    config.mongoUrl ?? process.env.WORKFLOW_MONGODB_URI ?? 'mongodb://localhost:27017'
  );

  // Connect if we created the client
  if (!config.client) {
    await client.connect();
  }

  const db = client.db(
    config.databaseName ?? process.env.WORKFLOW_MONGODB_DATABASE_NAME ?? 'workflow'
  );
  const messagesCollection = db.collection<QueuedMessage>('queue_messages');

  // Create indexes
  await Promise.all([
    // Unique message ID
    messagesCollection.createIndex({ messageId: 1 }, { unique: true }),

    // Polling: find pending messages scheduled for now or earlier
    messagesCollection.createIndex(
      { status: 1, scheduledFor: 1, createdAt: 1 }
    ),

    // Idempotency: unique within TTL window (partial on non-null idempotencyKey)
    messagesCollection.createIndex(
      { idempotencyKey: 1 },
      {
        unique: true,
        partialFilterExpression: { idempotencyKey: { $type: 'string' } },
      }
    ),

    // Recovery: find stuck processing messages with expired locks
    messagesCollection.createIndex(
      { status: 1, lockedUntil: 1 },
      { partialFilterExpression: { status: 'processing' } }
    ),

    // TTL: auto-delete completed/failed messages after retention period
    messagesCollection.createIndex(
      { updatedAt: 1 },
      {
        expireAfterSeconds: messageRetentionDays * 24 * 60 * 60,
        partialFilterExpression: { status: { $in: ['completed', 'failed'] } },
      }
    ),
  ]);

  // Concurrency control
  const maxConcurrency = config.concurrency
    ?? (process.env.WORKFLOW_CONCURRENCY
      ? parseInt(process.env.WORKFLOW_CONCURRENCY, 10)
      : 20);
  let currentConcurrency = 0;
  const waitQueue: Array<() => void> = [];

  async function acquireConcurrency(): Promise<void> {
    if (currentConcurrency < maxConcurrency) {
      currentConcurrency++;
      return;
    }
    return new Promise((resolve) => {
      waitQueue.push(resolve);
    });
  }

  function releaseConcurrency(): void {
    const next = waitQueue.shift();
    if (next) {
      next();
    } else {
      currentConcurrency--;
    }
  }

  // Queue state
  const state: QueueState = {
    isRunning: false,
    isShuttingDown: false,
    inflightMessages: new Map(),
    watcher: null,
    recoveryInterval: null,
  };

  // =========================================================================
  // Lock Management
  // =========================================================================

  /**
   * Acquire lock on a message for processing.
   */
  async function acquireLock(messageId: MessageId): Promise<{ lockToken: string } | null> {
    const now = new Date();
    const lockToken = generateUlid();
    const lockedUntil = new Date(now.getTime() + lockDurationMs);

    const result = await messagesCollection.findOneAndUpdate(
      {
        messageId,
        status: 'pending',
        scheduledFor: { $lte: now },
      },
      {
        $set: {
          status: 'processing',
          lockToken,
          lockedUntil,
          updatedAt: now,
        },
      },
      { returnDocument: 'after' }
    );

    return result ? { lockToken } : null;
  }

  /**
   * Release lock on a message (for graceful shutdown).
   */
  async function releaseLock(messageId: MessageId, lockToken: string): Promise<void> {
    await messagesCollection.updateOne(
      { messageId, lockToken, status: 'processing' },
      {
        $set: {
          status: 'pending',
          updatedAt: new Date(),
        },
        $unset: { lockToken: '', lockedUntil: '' },
      }
    );
  }

  /**
   * Mark message as completed (verifying lock ownership).
   */
  async function completeMessage(messageId: MessageId, lockToken: string): Promise<boolean> {
    const now = new Date();
    const result = await messagesCollection.updateOne(
      {
        messageId,
        lockToken,
        status: 'processing',
        lockedUntil: { $gt: now },
      },
      {
        $set: { status: 'completed', updatedAt: now },
        $unset: { lockToken: '', lockedUntil: '' },
      }
    );
    return result.modifiedCount > 0;
  }

  /**
   * Mark message for retry with backoff or as failed.
   */
  async function failMessage(
    messageId: MessageId,
    lockToken: string,
    error: { message: string; status?: number },
    currentAttempt: number,
    msgMaxRetries: number
  ): Promise<void> {
    const now = new Date();

    if (currentAttempt >= msgMaxRetries) {
      // Max retries reached - mark as failed
      await messagesCollection.updateOne(
        { messageId, lockToken, status: 'processing' },
        {
          $set: {
            status: 'failed',
            lastError: { ...error, timestamp: now },
            updatedAt: now,
          },
          $unset: { lockToken: '', lockedUntil: '' },
        }
      );
    } else {
      // Schedule retry with backoff
      const delay = calculateBackoffDelay(currentAttempt);
      const scheduledFor = new Date(now.getTime() + delay);

      await messagesCollection.updateOne(
        { messageId, lockToken, status: 'processing' },
        {
          $set: {
            status: 'pending',
            scheduledFor,
            lastError: { ...error, timestamp: now },
            updatedAt: now,
          },
          $inc: { attempt: 1 },
          $unset: { lockToken: '', lockedUntil: '' },
        }
      );
    }
  }

  /**
   * Reschedule message after 503 (not counted as failure).
   */
  async function rescheduleMessage(
    messageId: MessageId,
    lockToken: string,
    delaySeconds: number
  ): Promise<void> {
    const now = new Date();
    const scheduledFor = new Date(now.getTime() + delaySeconds * 1000);

    await messagesCollection.updateOne(
      { messageId, lockToken, status: 'processing' },
      {
        $set: {
          status: 'pending',
          scheduledFor,
          updatedAt: now,
        },
        $unset: { lockToken: '', lockedUntil: '' },
      }
    );
  }

  // =========================================================================
  // Message Processing
  // =========================================================================

  /**
   * Process a single message.
   */
  async function processMessage(msg: QueuedMessage, lockToken: string): Promise<void> {
    const abortController = new AbortController();

    // Track in-flight
    state.inflightMessages.set(msg.messageId, { lockToken, abortController });

    try {
      const pathname = msg.queueName.startsWith('__wkf_step_') ? 'step' : 'flow';

      try {
        const response = await fetch(
          `${getBaseUrl(config.baseUrl)}/.well-known/workflow/v1/${pathname}`,
          {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-vqs-queue-name': msg.queueName,
              'x-vqs-message-id': msg.messageId,
              'x-vqs-message-attempt': String(msg.attempt),
            },
            body: msg.payload,
            signal: abortController.signal,
          }
        );

        if (response.ok) {
          const success = await completeMessage(msg.messageId, lockToken);
          if (!success) {
            debug('Lock lost during completion:', msg.messageId);
          }
          return;
        }

        const text = await response.text();

        // Handle 503 with timeoutSeconds (not a failure)
        if (response.status === 503) {
          try {
            const { timeoutSeconds } = JSON.parse(text);
            if (typeof timeoutSeconds === 'number') {
              await rescheduleMessage(msg.messageId, lockToken, timeoutSeconds);
              return;
            }
          } catch {
            // Not a valid retry response
          }
        }

        // Other error - schedule retry or fail
        await failMessage(
          msg.messageId,
          lockToken,
          { message: text, status: response.status },
          msg.attempt,
          msg.maxRetries
        );

        console.error('[mongodb-world] Message processing failed:', {
          messageId: msg.messageId,
          queueName: msg.queueName,
          status: response.status,
          attempt: msg.attempt,
        });
      } catch (err: any) {
        if (err.name === 'AbortError' || state.isShuttingDown) {
          // Aborted during shutdown - release lock
          await releaseLock(msg.messageId, lockToken);
          return;
        }

        // Network error - schedule retry
        await failMessage(
          msg.messageId,
          lockToken,
          { message: err.message || 'Network error' },
          msg.attempt,
          msg.maxRetries
        );

        console.error('[mongodb-world] Network error:', err);
      }
    } finally {
      state.inflightMessages.delete(msg.messageId);
      releaseConcurrency();
    }
  }

  // =========================================================================
  // Stuck Message Recovery
  // =========================================================================

  /**
   * Recover messages with expired locks.
   */
  async function recoverStuckMessages(): Promise<void> {
    const now = new Date();
    const result = await messagesCollection.updateMany(
      {
        status: 'processing',
        lockedUntil: { $lt: now },
      },
      {
        $set: {
          status: 'pending',
          updatedAt: now,
        },
        $unset: { lockToken: '', lockedUntil: '' },
      }
    );

    if (result.modifiedCount > 0) {
      debug(`Recovered ${result.modifiedCount} stuck messages`);
    }
  }

  // =========================================================================
  // Watchers
  // =========================================================================

  /**
   * Create polling-based watcher.
   */
  function createPollingWatcher(): Watcher {
    let running = false;

    return {
      async start() {
        running = true;
        debug('Starting polling watcher');

        while (running && !state.isShuttingDown) {
          try {
            const now = new Date();

            // Find next pending message
            const msg = await messagesCollection.findOne(
              {
                status: 'pending',
                scheduledFor: { $lte: now },
              },
              { sort: { scheduledFor: 1, createdAt: 1 } }
            );

            if (msg) {
              // Try to acquire lock
              const lock = await acquireLock(msg.messageId);
              if (lock) {
                await acquireConcurrency();
                // Process in background
                processMessage(msg, lock.lockToken).catch((err) => {
                  console.error('[mongodb-world] Error processing message:', err);
                });
              }
            }
          } catch (err) {
            console.error('[mongodb-world] Poll error:', err);
          }

          // Wait before next poll
          try {
            await sleep(pollIntervalMs);
          } catch {
            // Interrupted - check loop condition
          }
        }
      },

      async stop() {
        running = false;
      },
    };
  }

  /**
   * Create Change Stream-based watcher with polling fallback for scheduled messages.
   */
  function createChangeStreamWatcher(): Watcher {
    let stream: ChangeStream | null = null;
    let pollingForScheduled = false;

    return {
      async start() {
        debug('Starting Change Stream watcher');

        // Watch for new pending messages or status changes to pending
        stream = messagesCollection.watch(
          [
            {
              $match: {
                $or: [
                  { operationType: 'insert', 'fullDocument.status': 'pending' },
                  {
                    operationType: 'update',
                    'updateDescription.updatedFields.status': 'pending',
                  },
                ],
              },
            },
          ],
          { fullDocument: 'updateLookup' }
        );

        // Start polling for scheduled messages (handles scheduledFor time passing)
        pollingForScheduled = true;
        (async () => {
          while (pollingForScheduled && !state.isShuttingDown) {
            try {
              const now = new Date();
              const msg = await messagesCollection.findOne(
                {
                  status: 'pending',
                  scheduledFor: { $lte: now },
                },
                { sort: { scheduledFor: 1, createdAt: 1 } }
              );

              if (msg) {
                const lock = await acquireLock(msg.messageId);
                if (lock) {
                  await acquireConcurrency();
                  processMessage(msg, lock.lockToken).catch((err) => {
                    console.error('[mongodb-world] Error processing message:', err);
                  });
                }
              }
            } catch (err) {
              console.error('[mongodb-world] Scheduled poll error:', err);
            }

            await sleep(pollIntervalMs).catch(() => {});
          }
        })();

        // Process change stream events
        for await (const change of stream) {
          if (state.isShuttingDown) break;

          const doc = (change as any).fullDocument as QueuedMessage | undefined;
          if (!doc || doc.status !== 'pending') continue;

          // Check if scheduled for now
          const now = new Date();
          if (doc.scheduledFor <= now) {
            const lock = await acquireLock(doc.messageId);
            if (lock) {
              await acquireConcurrency();
              processMessage(doc, lock.lockToken).catch((err) => {
                console.error('[mongodb-world] Error processing message:', err);
              });
            }
          }
        }
      },

      async stop() {
        pollingForScheduled = false;
        await stream?.close();
        stream = null;
      },
    };
  }

  /**
   * Create the appropriate watcher based on MongoDB capabilities.
   */
  async function createWatcher(): Promise<Watcher> {
    const supportsChangeStreams = await detectChangeStreamSupport(messagesCollection);

    if (supportsChangeStreams) {
      debug('Change Streams supported - using hybrid mode');
      return createChangeStreamWatcher();
    }

    debug('Change Streams not supported - using polling mode');
    return createPollingWatcher();
  }

  // =========================================================================
  // Queue Interface
  // =========================================================================

  const queue: Queue = {
    async getDeploymentId(): Promise<string> {
      return process.env.DEPLOYMENT_ID ?? 'dpl_mongodb';
    },

    async queue(
      queueName: ValidQueueName,
      message: unknown,
      opts?: { deploymentId?: string; idempotencyKey?: string }
    ): Promise<{ messageId: MessageId }> {
      // Validate queue type
      if (!queueName.startsWith('__wkf_step_') && !queueName.startsWith('__wkf_workflow_')) {
        throw new Error(`Unknown queue prefix in: ${queueName}`);
      }

      const now = new Date();
      const messageId = `msg_${generateUlid()}` as MessageId;
      const serialized = transport.serialize(message);

      // Atomic upsert for idempotency
      if (opts?.idempotencyKey) {
        const idempotencyCutoff = new Date(now.getTime() - IDEMPOTENCY_TTL_MS);

        try {
          const result = await messagesCollection.findOneAndUpdate(
            {
              idempotencyKey: opts.idempotencyKey,
              createdAt: { $gt: idempotencyCutoff },
            },
            {
              $setOnInsert: {
                messageId,
                queueName,
                payload: serialized,
                status: 'pending' as MessageStatus,
                attempt: 1,
                maxRetries,
                createdAt: now,
                scheduledFor: now,
                idempotencyKey: opts.idempotencyKey,
              },
              $set: { updatedAt: now },
            },
            { upsert: true, returnDocument: 'after' }
          );

          if (result) {
            return { messageId: result.messageId };
          }
        } catch (error: any) {
          // Duplicate key on idempotencyKey - find existing
          if (error.code === 11000) {
            const existing = await messagesCollection.findOne({
              idempotencyKey: opts.idempotencyKey,
            });
            if (existing) {
              return { messageId: existing.messageId };
            }
          }
          throw error;
        }
      }

      // No idempotency key - simple insert
      await messagesCollection.insertOne({
        messageId,
        queueName,
        payload: serialized,
        status: 'pending',
        attempt: 1,
        maxRetries,
        createdAt: now,
        updatedAt: now,
        scheduledFor: now,
      });

      return { messageId };
    },

    createQueueHandler(
      prefix: QueuePrefix,
      handler: (
        message: unknown,
        meta: { attempt: number; queueName: ValidQueueName; messageId: MessageId }
      ) => Promise<void | { timeoutSeconds: number }>
    ): (req: Request) => Promise<Response> {
      const HeaderParser = z.object({
        'x-vqs-queue-name': z.string(),
        'x-vqs-message-id': z.string(),
        'x-vqs-message-attempt': z.coerce.number(),
      });

      return async (req: Request): Promise<Response> => {
        const headers = HeaderParser.safeParse(Object.fromEntries(req.headers));

        if (!headers.success || !req.body) {
          return Response.json(
            {
              error: !req.body ? 'Missing request body' : 'Missing required headers',
            },
            { status: 400 }
          );
        }

        const queueName = headers.data['x-vqs-queue-name'] as ValidQueueName;
        const messageId = headers.data['x-vqs-message-id'] as MessageId;
        const attempt = headers.data['x-vqs-message-attempt'];

        if (!queueName.startsWith(prefix)) {
          return Response.json({ error: 'Unhandled queue' }, { status: 400 });
        }

        const body = await new JsonTransport().deserialize(req.body);

        try {
          const result = await handler(body, { attempt, queueName, messageId });

          if (result?.timeoutSeconds) {
            return Response.json(
              { timeoutSeconds: result.timeoutSeconds },
              { status: 503 }
            );
          }

          return Response.json({ ok: true });
        } catch (error) {
          console.error('[mongodb-world] Handler error:', error);
          return Response.json(String(error), { status: 500 });
        }
      };
    },
  };

  // =========================================================================
  // Lifecycle
  // =========================================================================

  return {
    queue,
    client,

    async start(): Promise<void> {
      if (state.isRunning) {
        debug('Queue already running');
        return;
      }

      debug('Starting queue processing...');
      state.isRunning = true;
      state.isShuttingDown = false;

      // Recover any stuck messages first
      await recoverStuckMessages();

      // Start periodic recovery
      state.recoveryInterval = setInterval(() => {
        recoverStuckMessages().catch((err) => {
          console.error('[mongodb-world] Recovery error:', err);
        });
      }, STUCK_RECOVERY_INTERVAL_MS);

      // Create and start watcher
      state.watcher = await createWatcher();
      state.watcher.start().catch((err) => {
        if (!state.isShuttingDown) {
          console.error('[mongodb-world] Watcher error:', err);
        }
      });

      debug('Queue processing started');
    },

    async close(): Promise<void> {
      if (!state.isRunning) {
        return;
      }

      debug('Shutting down queue...');
      state.isShuttingDown = true;

      // Stop recovery interval
      if (state.recoveryInterval) {
        clearInterval(state.recoveryInterval);
        state.recoveryInterval = null;
      }

      // Stop watcher
      await state.watcher?.stop();
      state.watcher = null;

      // Wait for in-flight messages with timeout
      const deadline = Date.now() + shutdownTimeoutMs;
      while (state.inflightMessages.size > 0 && Date.now() < deadline) {
        debug(`Waiting for ${state.inflightMessages.size} in-flight messages...`);
        await sleep(100).catch(() => {});
      }

      // Abort and release locks for remaining messages
      for (const [messageId, ctx] of state.inflightMessages) {
        debug(`Force-releasing lock for: ${messageId}`);
        ctx.abortController.abort();
        await releaseLock(messageId as MessageId, ctx.lockToken).catch(() => {});
      }
      state.inflightMessages.clear();

      state.isRunning = false;

      // Close client if we created it
      if (!config.client) {
        await client.close();
      }

      debug('Queue shutdown complete');
    },
  };
}
