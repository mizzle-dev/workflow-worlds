/**
 * BullMQ Queue Implementation
 *
 * This file implements the Queue interface using BullMQ for job processing.
 * BullMQ provides:
 * - Built-in deduplication with TTL
 * - Automatic retries with exponential backoff
 * - Concurrency control
 * - Graceful shutdown
 */

import { Queue, Worker, Job, type ConnectionOptions, type JobsOptions } from 'bullmq';
import type { ConnectionOptions as TlsConnectionOptions } from 'tls';
import type {
  Queue as WorkflowQueue,
  MessageId,
  ValidQueueName,
  QueuePrefix,
} from '@workflow/world';
import { monotonicFactory } from 'ulid';
import { debug } from './utils.js';

const generateUlid = monotonicFactory();

/**
 * Configuration for the queue.
 */
export interface QueueConfig {
  /**
   * Base URL for HTTP callbacks.
   * Default: http://localhost:${PORT}
   */
  baseUrl?: string;

  /**
   * TLS options for the Redis connection.
   */
  tls?: TlsConnectionOptions;

  /**
   * Maximum concurrent message processing.
   * Default: 20
   */
  concurrency?: number;

  /**
   * Maximum retry attempts for failed jobs.
   * Default: 3
   */
  maxRetries?: number;

  /**
   * TTL for idempotency deduplication in milliseconds.
   * Default: 60000 (1 minute)
   */
  idempotencyTtlMs?: number;

  /**
   * Timeout for HTTP calls to workflow endpoints in milliseconds.
   * Default: 300000 (5 minutes)
   */
  httpTimeoutMs?: number;
}

/**
 * Gets the base URL for HTTP callbacks.
 */
function getBaseUrl(configBaseUrl?: string): string {
  if (configBaseUrl) {
    return configBaseUrl;
  }
  const port = process.env.PORT ?? '3000';
  return `http://localhost:${port}`;
}

/**
 * Creates the Queue implementation using BullMQ.
 */
export async function createQueue(options: {
  redisUrl: string;
  config?: QueueConfig;
}): Promise<{
  queue: WorkflowQueue;
  start: () => Promise<void>;
  close: () => Promise<void>;
}> {
  const { redisUrl, config = {} } = options;
  const concurrency = config.concurrency ?? 20;
  const maxRetries = config.maxRetries ?? 3;
  const idempotencyTtlMs = config.idempotencyTtlMs ?? 60000;
  const httpTimeoutMs = config.httpTimeoutMs ?? 300000; // 5 minutes default

  // BullMQ connection - requires maxRetriesPerRequest: null
  const connection: ConnectionOptions = {
    url: redisUrl,
    maxRetriesPerRequest: null,
    tls: config.tls ? {
      key: config.tls.key,
      cert: config.tls.cert,
      ca: config.tls.ca,
    } : undefined,
  };

  // Create BullMQ queues for workflow and step execution
  const workflowQueue = new Queue('__wkf_workflow', {
    connection,
    defaultJobOptions: {
      attempts: maxRetries,
      backoff: { type: 'exponential', delay: 1000 },
      removeOnComplete: true,
      removeOnFail: 1000, // Keep last 1000 failed jobs for debugging
    },
  });

  const stepQueue = new Queue('__wkf_step', {
    connection,
    defaultJobOptions: {
      attempts: maxRetries,
      backoff: { type: 'exponential', delay: 1000 },
      removeOnComplete: true,
      removeOnFail: 1000,
    },
  });

  // Track workers for shutdown
  let workflowWorker: Worker | null = null;
  let stepWorker: Worker | null = null;
  let isStarted = false;

  /**
   * Creates a worker processor function for a given queue type.
   */
  function createProcessor(pathname: 'flow' | 'step') {
    return async (job: Job) => {
      const baseUrl = getBaseUrl(config.baseUrl);
      const url = `${baseUrl}/.well-known/workflow/v1/${pathname}`;

      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-vqs-queue-name': job.name,
            'x-vqs-message-id': job.id ?? generateUlid(),
            'x-vqs-message-attempt': String(job.attemptsMade + 1),
          },
          body: JSON.stringify(job.data),
          signal: AbortSignal.timeout(httpTimeoutMs),
        });

        if (response.ok) {
          return; // Success
        }

        const text = await response.text();

        // Check for retry request (503 with timeoutSeconds)
        if (response.status === 503) {
          try {
            const parsed = JSON.parse(text);
            if (typeof parsed.timeoutSeconds === 'number') {
              // Move job to delayed state without counting as failed attempt
              const delayMs = parsed.timeoutSeconds * 1000;
              await job.moveToDelayed(Date.now() + delayMs, job.token);
              return;
            }
          } catch {
            // Not a valid retry response, fall through to error
          }
        }

        // Non-retriable error
        throw new Error(`HTTP ${response.status}: ${text}`);
      } catch (err) {
        debug(`Job ${job.id} failed:`, err);
        throw err;
      }
    };
  }

  const queue: WorkflowQueue = {
    /**
     * Returns a unique identifier for this deployment.
     */
    async getDeploymentId(): Promise<string> {
      return process.env.WORKFLOW_DEPLOYMENT_ID ?? process.env.DEPLOYMENT_ID ?? 'dpl_redis';
    },

    /**
     * Enqueues a message for processing using BullMQ.
     */
    async queue(
      queueName: ValidQueueName,
      message: unknown,
      opts?: { deploymentId?: string; idempotencyKey?: string }
    ): Promise<{ messageId: MessageId }> {
      const messageId = `msg_${generateUlid()}` as MessageId;

      // Determine which queue to use based on queue name
      const targetQueue = queueName.startsWith('__wkf_step_')
        ? stepQueue
        : workflowQueue;

      const jobOptions: JobsOptions = {};

      // Use BullMQ's native deduplication with TTL (Throttle mode)
      if (opts?.idempotencyKey) {
        jobOptions.deduplication = {
          id: opts.idempotencyKey,
          ttl: idempotencyTtlMs,
        };
      }

      try {
        const job = await targetQueue.add(queueName, message, {
          ...jobOptions,
          jobId: messageId,
        });

        return { messageId: (job?.id ?? messageId) as MessageId };
      } catch (err) {
        // BullMQ may throw if job is deduplicated - still return the messageId
        debug('Queue add error:', err);
        return { messageId };
      }
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
      return async (req: Request): Promise<Response> => {
        // Parse headers
        const queueName = req.headers.get('x-vqs-queue-name') as ValidQueueName;
        const messageId = req.headers.get('x-vqs-message-id') as MessageId;
        const attemptStr = req.headers.get('x-vqs-message-attempt');

        if (!queueName || !messageId || !attemptStr || !req.body) {
          return Response.json(
            { error: 'Missing required headers or body' },
            { status: 400 }
          );
        }

        const attempt = parseInt(attemptStr, 10);

        // Verify this handler handles this queue type
        if (!queueName.startsWith(prefix)) {
          return Response.json({ error: 'Unhandled queue' }, { status: 400 });
        }

        try {
          // Parse the message body
          const body = await req.json();

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
          debug('Handler error:', error);
          return Response.json({ error: String(error) }, { status: 500 });
        }
      };
    },
  };

  /**
   * Starts the queue workers.
   */
  async function start(): Promise<void> {
    if (isStarted) {
      return;
    }

    debug('Starting queue workers...');

    // Create workers for both queue types
    workflowWorker = new Worker('__wkf_workflow', createProcessor('flow'), {
      connection,
      concurrency,
    });

    stepWorker = new Worker('__wkf_step', createProcessor('step'), {
      connection,
      concurrency,
    });

    // Set up error handlers
    workflowWorker.on('error', (err) => {
      debug('Workflow worker error:', err);
    });

    stepWorker.on('error', (err) => {
      debug('Step worker error:', err);
    });

    // Wait for workers to be ready
    await Promise.all([
      workflowWorker.waitUntilReady(),
      stepWorker.waitUntilReady(),
    ]);

    isStarted = true;
    debug('Queue workers started');
  }

  /**
   * Gracefully closes the queue workers and connections.
   */
  async function close(): Promise<void> {
    debug('Closing queue workers...');

    // Close workers first (gracefully waits for in-progress jobs)
    await Promise.all([
      workflowWorker?.close(),
      stepWorker?.close(),
    ]);

    // Then close queues
    await Promise.all([
      workflowQueue.close(),
      stepQueue.close(),
    ]);

    isStarted = false;
    debug('Queue workers closed');
  }

  return { queue, start, close };
}
