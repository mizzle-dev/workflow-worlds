/**
 * Queue Test Suite
 *
 * Tests queue functionality including:
 * - Deployment ID
 * - Message queueing with idempotency
 *
 * Note: Full queue tests (resumeAt, message processing) require the
 * full runtime environment. These tests focus on what can be tested directly.
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import type { Queue } from '@workflow/world';

export interface QueueTestOptions {
  /**
   * Factory function to create a queue instance.
   */
  createQueue: () => Promise<{ queue: Queue; cleanup?: () => Promise<void> }>;
}

/**
 * Creates the queue test suite.
 * Tests basic queue functionality.
 */
export function queueTests(options: QueueTestOptions) {
  describe('queue', () => {
    let queue: Queue;
    let cleanup: (() => Promise<void>) | undefined;

    beforeAll(async () => {
      const result = await options.createQueue();
      queue = result.queue;
      cleanup = result.cleanup;
    });

    afterAll(async () => {
      if (cleanup) {
        await cleanup();
      }
    });

    describe('deployment ID', () => {
      test('returns a valid deployment ID', async () => {
        const deploymentId = await queue.getDeploymentId();
        expect(deploymentId).toBeDefined();
        expect(typeof deploymentId).toBe('string');
        expect(deploymentId.length).toBeGreaterThan(0);
      });
    });

    describe('queue operations', () => {
      test('queues a message and returns messageId', async () => {
        // Use workflow queue prefix for simpler message format
        const queueName = '__wkf_workflow_test' as any;
        const message = { runId: `wrun_test-${Date.now()}` };

        const result = await queue.queue(queueName, message, {
          idempotencyKey: `test-${Date.now()}-${Math.random()}`,
        });

        expect(result).toBeDefined();
        expect(result.messageId).toBeDefined();
        expect(typeof result.messageId).toBe('string');
        expect(result.messageId.startsWith('msg_')).toBe(true);
      });

      test('deduplicates messages with same idempotency key', async () => {
        const queueName = '__wkf_workflow_dedup' as any;
        const idempotencyKey = `dedup-test-${Date.now()}-${Math.random()}`;

        // Queue first message
        const result1 = await queue.queue(
          queueName,
          { runId: `wrun_test-1-${Date.now()}` },
          { idempotencyKey }
        );

        // Queue second message with same key
        const result2 = await queue.queue(
          queueName,
          { runId: `wrun_test-2-${Date.now()}` },
          { idempotencyKey }
        );

        // Should return the same messageId (deduplicated)
        expect(result1.messageId).toBe(result2.messageId);
      });

      test('allows different idempotency keys', async () => {
        const queueName = '__wkf_workflow_unique' as any;

        const result1 = await queue.queue(
          queueName,
          { runId: `wrun_test-1-${Date.now()}` },
          { idempotencyKey: `unique-1-${Date.now()}-${Math.random()}` }
        );

        const result2 = await queue.queue(
          queueName,
          { runId: `wrun_test-2-${Date.now()}` },
          { idempotencyKey: `unique-2-${Date.now()}-${Math.random()}` }
        );

        // Different keys should produce different messageIds
        expect(result1.messageId).not.toBe(result2.messageId);
      });
    });
  });
}
