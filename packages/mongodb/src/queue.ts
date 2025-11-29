/**
 * MongoDB Queue Implementation
 *
 * This file implements the Queue interface using MongoDB for message storage
 * with TTL-based idempotency.
 */

import { JsonTransport } from '@vercel/queue';
import type {
  Queue,
  MessageId,
  ValidQueueName,
  QueuePrefix,
} from '@workflow/world';
import { MongoClient } from 'mongodb';
import { monotonicFactory } from 'ulid';
import { z } from 'zod';

const generateUlid = monotonicFactory();

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
}

/**
 * Gets the base URL for HTTP callbacks.
 * Priority: config > WORKFLOW_SERVICE_URL > http://localhost:{PORT}
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
 * Interface for idempotency key tracking
 */
interface IdempotencyRecord {
  key: string;
  messageId: MessageId;
  createdAt: Date;
}

/**
 * Creates the Queue implementation using MongoDB for TTL-based idempotency.
 */
export async function createQueue(config: QueueConfig = {}): Promise<{
  queue: Queue;
  client: MongoClient;
  close: () => Promise<void>;
}> {
  const transport = new JsonTransport();

  // Get or create MongoDB client
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
  const idempotencyCollection = db.collection<IdempotencyRecord>('idempotency_keys');

  // Create TTL index for automatic cleanup (expire after 1 minute)
  await idempotencyCollection.createIndex(
    { createdAt: 1 },
    { expireAfterSeconds: 60 }
  );
  await idempotencyCollection.createIndex(
    { key: 1 },
    { unique: true, sparse: true }
  );

  // TTL window for idempotency checking (5 seconds)
  const IDEMPOTENCY_TTL_MS = 5000;

  // Simple concurrency limiter
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
    // Wait for a slot to open
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

  const queue: Queue = {
    /**
     * Returns a unique identifier for this deployment.
     */
    async getDeploymentId(): Promise<string> {
      return process.env.DEPLOYMENT_ID ?? 'dpl_mongodb';
    },

    /**
     * Enqueues a message for processing with TTL-based idempotency.
     */
    async queue(
      queueName: ValidQueueName,
      message: unknown,
      opts?: { deploymentId?: string; idempotencyKey?: string }
    ): Promise<{ messageId: MessageId }> {
      // Check idempotency with TTL using MongoDB
      if (opts?.idempotencyKey) {
        const cutoff = new Date(Date.now() - IDEMPOTENCY_TTL_MS);

        // Try to find existing record within TTL window
        const existing = await idempotencyCollection.findOne({
          key: opts.idempotencyKey,
          createdAt: { $gte: cutoff },
        });

        if (existing) {
          return { messageId: existing.messageId };
        }
      }

      const messageId = `msg_${generateUlid()}` as MessageId;

      // Track for short-term deduplication
      if (opts?.idempotencyKey) {
        try {
          await idempotencyCollection.insertOne({
            key: opts.idempotencyKey,
            messageId,
            createdAt: new Date(),
          });
        } catch (error: any) {
          // If duplicate key error, another concurrent request won
          if (error.code === 11000) {
            // Fetch the winning message ID
            const winner = await idempotencyCollection.findOne({
              key: opts.idempotencyKey,
            });
            if (winner) {
              return { messageId: winner.messageId };
            }
          }
          // Other errors, continue with processing
        }
      }

      // Serialize the message
      const serialized = transport.serialize(message);

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
          let retriesLeft = 3;

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

              console.error('[mongodb-world] Message processing failed:', {
                queueName,
                status: response.status,
                text,
              });
            } catch (err) {
              // Network error, retry
              console.error('[mongodb-world] Network error:', err);
            }
          }

          console.error('[mongodb-world] Max retries reached for:', queueName);
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
        meta: { attempt: number; queueName: ValidQueueName; messageId: MessageId }
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
          console.error('[mongodb-world] Handler error:', error);
          return Response.json(String(error), { status: 500 });
        }
      };
    },
  };

  return {
    queue,
    client,
    close: async () => {
      if (!config.client) {
        await client.close();
      }
    },
  };
}
