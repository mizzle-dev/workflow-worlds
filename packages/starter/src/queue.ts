/**
 * In-Memory Queue Implementation
 *
 * This file implements the Queue interface using setTimeout for async processing.
 * Replace with your actual queue system (BullMQ, Agenda, SQS, etc.).
 *
 * TODO markers indicate where to swap in your real backend.
 */

import {
  WORKFLOW_FLOW_ROUTE,
  type MessageId,
  type Queue,
  type QueueOptions,
  type QueuePayload,
  type QueuePrefix,
  type ValidQueueName,
} from '@workflow/world';
import { monotonicFactory } from 'ulid';
import { z } from 'zod';
import { debug, parseQueueMessage, stringifyQueueMessage } from './utils.js';

const WORKFLOW_QUEUE_NAME = /^__(?:[a-z][a-z0-9]*_)?wkf_workflow_.+$/;

const generateUlid = monotonicFactory();

/**
 * Configuration for the queue.
 *
 * TODO: Add your queue-specific configuration options.
 */
export interface QueueConfig {
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
}

/**
 * Gets the base URL for HTTP callbacks.
 * Reads PORT from environment at call time to support dynamic port assignment.
 */
function getBaseUrl(configBaseUrl?: string): string {
  if (configBaseUrl) {
    return configBaseUrl;
  }
  const port = process.env.PORT ?? '3000';
  return `http://localhost:${port}`;
}

/**
 * Buffered message for processing after start() is called.
 */
interface BufferedMessage {
  queueName: ValidQueueName;
  serialized: string;
  messageId: MessageId;
  /** Earliest delivery time, for a message queued with `delaySeconds`. */
  notBefore: number;
}

/**
 * Creates the Queue implementation.
 *
 * Returns both the queue interface and a start function.
 * Messages are buffered until start() is called, then processed.
 *
 * TODO: Replace the in-memory queue with your queue system.
 */
export function createQueue(config: QueueConfig = {}): {
  queue: Queue;
  start: () => Promise<void>;
} {
  debug('Creating queue with config:', {
    baseUrl: config.baseUrl ?? 'default',
    concurrency: config.concurrency ?? 20,
  });

  // Track recently queued idempotency keys with their results.
  // Uses a short TTL to deduplicate concurrent duplicate messages
  // while allowing legitimate continuation messages that come later.
  // TODO: For distributed systems, use database-level idempotency
  const recentlyQueuedKeys = new Map<
    string,
    { messageId: MessageId; timestamp: number }
  >();
  // Tunable: Must be long enough to catch network retries (typically sub-second)
  // but short enough to not interfere with rapid step completions.
  // 5 seconds is a reasonable default. Each step gets a unique idempotency key,
  // so workflow duration (hours, days) has no effect on this value.
  const IDEMPOTENCY_TTL_MS = 5000;

  // Simple concurrency limiter
  // NOTE: Default matches world-local for consistency.
  // TODO: Replace with your queue's concurrency control
  const maxConcurrency = config.concurrency ?? 20;
  let currentConcurrency = 0;
  const waitQueue: Array<() => void> = [];

  // Buffer for messages queued before start() is called
  const messageBuffer: BufferedMessage[] = [];
  let isStarted = false;

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

  /**
   * Processes a single message by making an HTTP request to the workflow server.
   */
  async function processMessage(msg: BufferedMessage): Promise<void> {
    const wait = msg.notBefore - Date.now();
    if (wait > 0) {
      await new Promise((r) => setTimeout(r, wait));
    }
    await acquireConcurrency();

    try {
      let retriesLeft = 3;

      for (let attempt = 1; retriesLeft > 0; attempt++) {
        retriesLeft--;

        try {
          const response = await fetch(
            `${getBaseUrl(config.baseUrl)}${WORKFLOW_FLOW_ROUTE}`,
            {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                'x-vqs-queue-name': msg.queueName,
                'x-vqs-message-id': msg.messageId,
                'x-vqs-message-attempt': String(attempt),
              },
              body: msg.serialized,
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
              if (typeof timeoutSeconds === 'number' && timeoutSeconds >= 0) {
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

          debug('Message processing failed:', {
            queueName: msg.queueName,
            status: response.status,
            text,
          });
        } catch (err) {
          // Network error, retry
          debug('Network error:', err);
        }
      }

      debug('Max retries reached for:', msg.queueName);
    } finally {
      releaseConcurrency();
    }
  }

  const queue: Queue = {
    /**
     * Returns a unique identifier for this deployment.
     *
     * TODO: Return your actual deployment ID (from env var, platform, etc.)
     */
    async getDeploymentId(): Promise<string> {
      // TODO: Replace with your deployment identification
      return process.env.DEPLOYMENT_ID ?? 'dpl_starter';
    },

    /**
     * Enqueues a message for processing.
     *
     * If start() has not been called, messages are buffered.
     * Once start() is called, buffered messages are processed and
     * future messages are processed immediately.
     *
     * TODO: Replace with your queue system:
     * - BullMQ: queue.add(name, data)
     * - Agenda: agenda.now(name, data)
     * - SQS: sqs.sendMessage(params)
     */
    async queue(
      queueName: ValidQueueName,
      message: QueuePayload,
      opts?: QueueOptions
    ): Promise<{ messageId: MessageId }> {
      // Check idempotency with TTL - only dedupe truly concurrent messages.
      // This allows workflow continuations (which reuse idempotency keys)
      // while preventing duplicate invocations within the TTL window.
      if (opts?.idempotencyKey) {
        const existing = recentlyQueuedKeys.get(opts.idempotencyKey);
        const now = Date.now();
        if (existing && now - existing.timestamp < IDEMPOTENCY_TTL_MS) {
          return { messageId: existing.messageId };
        }
      }

      const messageId = `msg_${generateUlid()}` as MessageId;

      // Track for short-term deduplication
      if (opts?.idempotencyKey) {
        recentlyQueuedKeys.set(opts.idempotencyKey, {
          messageId,
          timestamp: Date.now(),
        });
        // Clean up old entries periodically to prevent memory leaks
        if (recentlyQueuedKeys.size > 1000) {
          const cutoff = Date.now() - IDEMPOTENCY_TTL_MS;
          for (const [key, value] of recentlyQueuedKeys) {
            if (value.timestamp < cutoff) {
              recentlyQueuedKeys.delete(key);
            }
          }
        }
      }

      // Workflow runs and queued steps are both delivered to the flow route.
      if (!WORKFLOW_QUEUE_NAME.test(queueName)) {
        throw new Error(`Unknown queue prefix in: ${queueName}`);
      }

      const bufferedMsg: BufferedMessage = {
        queueName,
        serialized: stringifyQueueMessage(message),
        messageId,
        // A wait continuation is an ordinary message delivered after a delay.
        notBefore: Date.now() + (opts?.delaySeconds ?? 0) * 1000,
      };

      if (isStarted) {
        // Process immediately (async, don't await)
        processMessage(bufferedMsg);
      } else {
        // Buffer until start() is called
        messageBuffer.push(bufferedMsg);
      }

      return { messageId };
    },

    /**
     * Creates an HTTP request handler for processing queued messages.
     *
     * This handler is called by your HTTP server when receiving queue messages.
     */
    createQueueHandler(
      prefix: QueuePrefix,
      handler: (
        message: unknown,
        meta: { attempt: number; queueName: ValidQueueName; messageId: MessageId }
      ) => Promise<unknown>
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
        const body = parseQueueMessage(await req.text());

        try {
          // Call the actual handler
          const result = (await handler(body, { attempt, queueName, messageId })) as
            | { timeoutSeconds?: unknown }
            | undefined;

          // Check if handler requests a retry
          // The handler asks for a redelivery after a delay (0 is "now").
          if (typeof result?.timeoutSeconds === 'number' && result.timeoutSeconds >= 0) {
            return Response.json(
              { timeoutSeconds: result.timeoutSeconds },
              { status: 503 }
            );
          }

          return Response.json({ ok: true });
        } catch (error) {
          debug('Handler error:', error);
          return Response.json(String(error), { status: 500 });
        }
      };
    },
  };

  /**
   * Starts the queue processor.
   * Processes any buffered messages and allows future messages to process immediately.
   */
  async function start(): Promise<void> {
    if (isStarted) {
      return; // Already started
    }

    debug('Starting queue processor, processing', messageBuffer.length, 'buffered messages');
    isStarted = true;

    // Process all buffered messages (async, don't block)
    for (const msg of messageBuffer) {
      processMessage(msg);
    }
    // Clear the buffer
    messageBuffer.length = 0;
  }

  return { queue, start };
}
