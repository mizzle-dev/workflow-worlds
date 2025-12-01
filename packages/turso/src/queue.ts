/**
 * Turso Queue Implementation
 *
 * Implements the Queue interface using Turso/libSQL for message persistence
 * and polling-based message processing with TTL-based idempotency.
 */

import type { Client } from '@libsql/client';
import { JsonTransport } from '@vercel/queue';
import type {
  Queue,
  MessageId,
  ValidQueueName,
  QueuePrefix,
} from '@workflow/world';
import { monotonicFactory } from 'ulid';
import { z } from 'zod';

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
 * Creates the Queue implementation using Turso/libSQL.
 */
export function createQueue(config: QueueConfig): Queue {
  const { client } = config;
  const transport = new JsonTransport();

  // Track recently queued idempotency keys with their results (in-memory for speed).
  // Uses a short TTL to deduplicate concurrent duplicate messages.
  const recentlyQueuedKeys = new Map<
    string,
    { messageId: MessageId; timestamp: number }
  >();
  const IDEMPOTENCY_TTL_MS = config.idempotencyTtlMs ?? 5000;
  const MAX_RETRIES = config.maxRetries ?? 3;

  // Simple concurrency limiter
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

  return {
    /**
     * Returns a unique identifier for this deployment.
     */
    async getDeploymentId(): Promise<string> {
      return process.env.DEPLOYMENT_ID ?? 'dpl_turso';
    },

    /**
     * Enqueues a message for processing.
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

      // Insert into database - use INSERT OR IGNORE to handle duplicate idempotency keys
      // The unique index on idempotency_key ensures no duplicates
      try {
        await client.execute({
          sql: `INSERT INTO queue_messages
                (message_id, queue_name, payload, idempotency_key, status, attempt, max_attempts, not_before, created_at)
                VALUES (?, ?, ?, ?, 'pending', 0, ?, ?, ?)`,
          args: [
            messageId,
            queueName,
            serialized,
            opts?.idempotencyKey ?? null,
            MAX_RETRIES,
            nowStr,
            nowStr,
          ],
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
        // Clean up old entries periodically to prevent memory leaks
        if (recentlyQueuedKeys.size > 1000) {
          const cutoff = now - IDEMPOTENCY_TTL_MS;
          for (const [key, value] of recentlyQueuedKeys) {
            if (value.timestamp < cutoff) {
              recentlyQueuedKeys.delete(key);
            }
          }
        }
      }

      // Determine endpoint based on queue type
      let pathname: string;
      if (queueName.startsWith('__wkf_step_')) {
        pathname = 'step';
      } else if (queueName.startsWith('__wkf_workflow_')) {
        pathname = 'flow';
      } else {
        throw new Error(`Unknown queue prefix in: ${queueName}`);
      }

      // Process asynchronously
      (async () => {
        await acquireConcurrency();

        try {
          let retriesLeft = MAX_RETRIES;

          for (let attempt = 1; retriesLeft > 0; attempt++) {
            retriesLeft--;

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
                  body: serialized,
                }
              );

              if (response.ok) {
                // Mark message as completed
                await client.execute({
                  sql: `UPDATE queue_messages SET status = 'completed', processed_at = ? WHERE message_id = ?`,
                  args: [new Date().toISOString(), messageId],
                });
                return; // Success
              }

              const text = await response.text();

              // Check for retry request (503 with timeoutSeconds)
              if (response.status === 503) {
                try {
                  const { timeoutSeconds } = JSON.parse(text);
                  if (typeof timeoutSeconds === 'number') {
                    // Wait and retry
                    await new Promise((r) =>
                      setTimeout(r, timeoutSeconds * 1000)
                    );
                    retriesLeft++; // Don't count this as a failed retry
                    continue;
                  }
                } catch {
                  // Not a valid retry response
                }
              }

              console.error('[turso-world] Message processing failed:', {
                queueName,
                status: response.status,
                text,
              });
            } catch (err) {
              // Network error, retry
              console.error('[turso-world] Network error:', err);
            }
          }

          // Mark as failed after all retries exhausted
          await client.execute({
            sql: `UPDATE queue_messages SET status = 'failed', processed_at = ?, attempt = ? WHERE message_id = ?`,
            args: [new Date().toISOString(), MAX_RETRIES, messageId],
          });

          console.error('[turso-world] Max retries reached for:', queueName);
        } finally {
          releaseConcurrency();
        }
      })();

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
      // Schema for validating required headers
      const HeaderParser = z.object({
        'x-vqs-queue-name': z.string(),
        'x-vqs-message-id': z.string(),
        'x-vqs-message-attempt': z.coerce.number(),
      });

      return async (req: Request): Promise<Response> => {
        // Validate headers
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

        // Verify this handler handles this queue type
        if (!queueName.startsWith(prefix)) {
          return Response.json({ error: 'Unhandled queue' }, { status: 400 });
        }

        // Deserialize the message
        const body = await new JsonTransport().deserialize(req.body);

        try {
          // Call the actual handler
          const result = await handler(body, { attempt, queueName, messageId });

          // Check if handler requests a retry
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
}
