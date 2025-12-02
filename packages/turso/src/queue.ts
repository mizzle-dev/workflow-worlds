/**
 * Turso Queue Implementation
 *
 * Implements the Queue interface using Turso/libSQL for message persistence
 * and polling-based message processing with TTL-based idempotency.
 *
 * Key behavior:
 * - queue() stores messages in the database
 * - start() begins polling and processing messages
 * - If start() is not called, messages are stored but not processed
 */

import type { Client, InValue } from '@libsql/client';
import { JsonTransport } from '@vercel/queue';
import type {
  Queue,
  MessageId,
  ValidQueueName,
  QueuePrefix,
} from '@workflow/world';
import { monotonicFactory } from 'ulid';
import { z } from 'zod';
import { debug } from './utils.js';

const generateUlid = monotonicFactory();

/**
 * Configuration for the queue.
 */
export interface QueueConfig {
  /**
   * Turso client instance.
   */
  client: Client;

  /**
   * Base URL for HTTP callbacks.
   * Default: http://localhost:3000
   */
  baseUrl?: string;

  /**
   * Maximum concurrent message processing.
   * Default: 20
   */
  concurrency?: number;

  /**
   * Idempotency TTL in milliseconds.
   * Default: 5000 (5 seconds)
   */
  idempotencyTtlMs?: number;

  /**
   * Maximum retry attempts.
   * Default: 3
   */
  maxRetries?: number;

  /**
   * Polling interval in milliseconds.
   * Default: 100
   */
  pollIntervalMs?: number;
}

/**
 * Gets the base URL for HTTP callbacks.
 */
function getBaseUrl(configBaseUrl?: string): string {
  if (configBaseUrl) {
    return configBaseUrl;
  }
  const serviceUrl = process.env.WORKFLOW_SERVICE_URL;
  if (serviceUrl) {
    return serviceUrl;
  }
  const port = process.env.PORT ?? '3000';
  return `http://localhost:${port}`;
}

/**
 * Calculate exponential backoff delay with jitter.
 */
function calculateBackoffDelay(attempt: number): number {
  const baseDelay = 1000;
  const maxDelay = 60000;
  const delay = Math.min(baseDelay * Math.pow(2, attempt - 1), maxDelay);
  const jitter = delay * 0.2 * (Math.random() * 2 - 1);
  return Math.round(delay + jitter);
}

/**
 * Creates the Queue implementation using Turso/libSQL.
 */
export function createQueue(config: QueueConfig): {
  queue: Queue;
  start: () => Promise<void>;
  close: () => Promise<void>;
} {
  const { client } = config;
  const transport = new JsonTransport();

  // Track recently queued idempotency keys with their results (in-memory for speed).
  const recentlyQueuedKeys = new Map<
    string,
    { messageId: MessageId; timestamp: number }
  >();
  const IDEMPOTENCY_TTL_MS = config.idempotencyTtlMs ?? 5000;
  const MAX_RETRIES = config.maxRetries ?? 3;
  const POLL_INTERVAL_MS = config.pollIntervalMs ?? 100;

  // Concurrency control
  const maxConcurrency = config.concurrency ?? 20;
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

  // Worker state
  let isRunning = false;
  let isShuttingDown = false;
  let pollTimeout: ReturnType<typeof setTimeout> | null = null;

  /**
   * Process a single message.
   */
  async function processMessage(
    messageId: MessageId,
    queueName: ValidQueueName,
    payload: string,
    attempt: number
  ): Promise<void> {
    const pathname = queueName.startsWith('__wkf_step_') ? 'step' : 'flow';

    try {
      const response = await fetch(
        `${getBaseUrl(config.baseUrl)}/.well-known/workflow/v1/${pathname}`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-vqs-queue-name': queueName,
            'x-vqs-message-id': messageId,
            'x-vqs-message-attempt': String(attempt),
          },
          body: payload,
        }
      );

      if (response.ok) {
        // Mark message as completed
        await client.execute({
          sql: `UPDATE queue_messages SET status = 'completed', processed_at = ? WHERE message_id = ?`,
          args: [new Date().toISOString(), messageId],
        });
        return;
      }

      const text = await response.text();

      // Check for retry request (503 with timeoutSeconds)
      if (response.status === 503) {
        try {
          const { timeoutSeconds } = JSON.parse(text);
          if (typeof timeoutSeconds === 'number') {
            // Reschedule without counting as failure
            const notBefore = new Date(Date.now() + timeoutSeconds * 1000).toISOString();
            await client.execute({
              sql: `UPDATE queue_messages SET status = 'pending', not_before = ? WHERE message_id = ?`,
              args: [notBefore, messageId],
            });
            return;
          }
        } catch {
          // Not a valid retry response
        }
      }

      // Failed - schedule retry or mark as failed
      if (attempt >= MAX_RETRIES) {
        await client.execute({
          sql: `UPDATE queue_messages SET status = 'failed', processed_at = ?, attempt = ? WHERE message_id = ?`,
          args: [new Date().toISOString(), attempt, messageId],
        });
      } else {
        const delay = calculateBackoffDelay(attempt);
        const notBefore = new Date(Date.now() + delay).toISOString();
        await client.execute({
          sql: `UPDATE queue_messages SET status = 'pending', not_before = ?, attempt = ? WHERE message_id = ?`,
          args: [notBefore, attempt + 1, messageId],
        });
      }

      console.error('[turso-world] Message processing failed:', {
        messageId,
        queueName,
        status: response.status,
        attempt,
      });
    } catch (err) {
      // Network error - schedule retry
      console.error('[turso-world] Network error:', err);

      if (attempt >= MAX_RETRIES) {
        await client.execute({
          sql: `UPDATE queue_messages SET status = 'failed', processed_at = ?, attempt = ? WHERE message_id = ?`,
          args: [new Date().toISOString(), attempt, messageId],
        });
      } else {
        const delay = calculateBackoffDelay(attempt);
        const notBefore = new Date(Date.now() + delay).toISOString();
        await client.execute({
          sql: `UPDATE queue_messages SET status = 'pending', not_before = ?, attempt = ? WHERE message_id = ?`,
          args: [notBefore, attempt + 1, messageId],
        });
      }
    }
  }

  /**
   * Poll for and process pending messages.
   * Uses a write transaction to atomically claim messages and prevent race conditions.
   */
  async function pollAndProcess(): Promise<void> {
    if (!isRunning || isShuttingDown) {
      return;
    }

    try {
      const now = new Date().toISOString();

      // Use a write transaction to atomically select and claim a message
      // This prevents race conditions where multiple pollers claim the same message
      const tx = await client.transaction('write');
      let messageId: MessageId | null = null;
      let queueName: ValidQueueName | null = null;
      let payload: string | null = null;
      let attempt = 1;

      try {
        // Find a pending message that's ready to process
        const result = await tx.execute({
          sql: `SELECT message_id, queue_name, payload, attempt
                FROM queue_messages
                WHERE status = 'pending' AND (not_before IS NULL OR not_before <= ?)
                ORDER BY created_at ASC
                LIMIT 1`,
          args: [now],
        });

        if (result.rows.length > 0) {
          const row = result.rows[0];
          messageId = row.message_id as MessageId;
          queueName = row.queue_name as ValidQueueName;
          payload = row.payload as string;
          attempt = (row.attempt as number) || 1;

          // Mark as processing within the same transaction
          await tx.execute({
            sql: `UPDATE queue_messages SET status = 'processing' WHERE message_id = ?`,
            args: [messageId],
          });
        }

        await tx.commit();
      } catch (err) {
        await tx.rollback();
        throw err;
      }

      // Process outside the transaction to avoid holding the lock
      if (messageId && queueName && payload) {
        await acquireConcurrency();
        processMessage(messageId, queueName, payload, attempt)
          .catch((err) => {
            console.error('[turso-world] Error processing message:', err);
          })
          .finally(() => {
            releaseConcurrency();
          });
      }
    } catch (err) {
      console.error('[turso-world] Poll error:', err);
    }

    // Schedule next poll
    if (isRunning && !isShuttingDown) {
      pollTimeout = setTimeout(pollAndProcess, POLL_INTERVAL_MS);
    }
  }

  const queue: Queue = {
    /**
     * Returns a unique identifier for this deployment.
     */
    async getDeploymentId(): Promise<string> {
      return process.env.DEPLOYMENT_ID ?? 'dpl_turso';
    },

    /**
     * Enqueues a message for processing.
     * Messages are stored in the database and will be processed when start() is called.
     */
    async queue(
      queueName: ValidQueueName,
      message: unknown,
      opts?: { deploymentId?: string; idempotencyKey?: string }
    ): Promise<{ messageId: MessageId }> {
      const now = Date.now();

      // Check idempotency with TTL - only dedupe truly concurrent messages.
      if (opts?.idempotencyKey) {
        const existing = recentlyQueuedKeys.get(opts.idempotencyKey);
        if (existing && now - existing.timestamp < IDEMPOTENCY_TTL_MS) {
          return { messageId: existing.messageId };
        }
      }

      const messageId = `msg_${generateUlid()}` as MessageId;
      const serialized = transport.serialize(message);
      const nowStr = new Date().toISOString();

      // Validate queue type
      if (!queueName.startsWith('__wkf_step_') && !queueName.startsWith('__wkf_workflow_')) {
        throw new Error(`Unknown queue prefix in: ${queueName}`);
      }

      // Insert into database
      try {
        await client.execute({
          sql: `INSERT INTO queue_messages
                (message_id, queue_name, payload, idempotency_key, status, attempt, max_attempts, not_before, created_at)
                VALUES (?, ?, ?, ?, 'pending', 1, ?, ?, ?)`,
          args: [
            messageId,
            queueName,
            serialized,
            opts?.idempotencyKey ?? null,
            MAX_RETRIES,
            nowStr,
            nowStr,
          ] as InValue[],
        });
      } catch (error) {
        // If duplicate idempotency key, find the existing message
        if (opts?.idempotencyKey) {
          const existing = await client.execute({
            sql: `SELECT message_id FROM queue_messages WHERE idempotency_key = ? AND status = 'pending'`,
            args: [opts.idempotencyKey],
          });
          if (existing.rows.length > 0) {
            const existingId = existing.rows[0].message_id as MessageId;
            return { messageId: existingId };
          }
        }
        throw error;
      }

      // Track for short-term deduplication
      if (opts?.idempotencyKey) {
        recentlyQueuedKeys.set(opts.idempotencyKey, {
          messageId,
          timestamp: now,
        });
        // Clean up old entries periodically
        if (recentlyQueuedKeys.size > 1000) {
          const cutoff = now - IDEMPOTENCY_TTL_MS;
          for (const [key, value] of recentlyQueuedKeys) {
            if (value.timestamp < cutoff) {
              recentlyQueuedKeys.delete(key);
            }
          }
        }
      }

      return { messageId };
    },

    /**
     * Creates an HTTP request handler for processing queued messages.
     */
    createQueueHandler(
      prefix: QueuePrefix,
      handler: (
        message: unknown,
        meta: {
          attempt: number;
          queueName: ValidQueueName;
          messageId: MessageId;
        }
      ) => Promise<void | { timeoutSeconds: number }>
    ): (req: Request) => Promise<Response> {
      const HeaderParser = z.object({
        'x-vqs-queue-name': z.string(),
        'x-vqs-message-id': z.string(),
        'x-vqs-message-attempt': z.coerce.number(),
      });

      return async (req: Request): Promise<Response> => {
        const headers = HeaderParser.safeParse(
          Object.fromEntries(req.headers)
        );

        if (!headers.success || !req.body) {
          return Response.json(
            {
              error: !req.body
                ? 'Missing request body'
                : 'Missing required headers',
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
          console.error('[turso-world] Handler error:', error);
          return Response.json(String(error), { status: 500 });
        }
      };
    },
  };

  return {
    queue,

    /**
     * Starts the queue worker that processes pending messages.
     * Without calling start(), messages are stored but not processed.
     */
    async start(): Promise<void> {
      if (isRunning) {
        debug('Queue already running');
        return;
      }

      debug('Starting queue worker...');
      isRunning = true;
      isShuttingDown = false;

      // Start polling
      pollAndProcess();
      debug('Queue worker started');
    },

    /**
     * Gracefully stops the queue worker.
     */
    async close(): Promise<void> {
      if (!isRunning) {
        return;
      }

      debug('Stopping queue worker...');
      isShuttingDown = true;

      // Clear poll timeout
      if (pollTimeout) {
        clearTimeout(pollTimeout);
        pollTimeout = null;
      }

      // Wait for in-flight messages to complete (with timeout)
      const deadline = Date.now() + 30000;
      while (currentConcurrency > 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
      }

      isRunning = false;
      debug('Queue worker stopped');
    },
  };
}
