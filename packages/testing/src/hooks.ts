/**
 * Hook Cleanup Test Suite
 *
 * Tests that hooks are properly cleaned up when workflows reach terminal status,
 * allowing token reuse for subsequent workflows.
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import type { Storage } from '@workflow/world';
import {
  cancelRun,
  completeRun,
  createHook,
  createRun,
  failRun,
} from './storage-compat.js';

export interface HookTestOptions {
  /**
   * Factory function to create a storage instance.
   */
  createStorage: () => Promise<{ storage: Storage; cleanup?: () => Promise<void> }>;
}

/**
 * Creates the hook cleanup test suite.
 * Tests token reuse after workflow completion.
 */
export function hookCleanupTests(options: HookTestOptions) {
  describe('hook cleanup', () => {
    let storage: Storage;
    let cleanup: (() => Promise<void>) | undefined;

    beforeAll(async () => {
      const result = await options.createStorage();
      storage = result.storage;
      cleanup = result.cleanup;
    });

    afterAll(async () => {
      if (cleanup) {
        await cleanup();
      }
    });

    test('cleans up hooks when workflow completes', async () => {
      const token = `cleanup-test-${Date.now()}`;

      const run = await createRun(storage, {
        deploymentId: 'test-deployment',
        workflowName: 'test-workflow',
        input: [],
      });

      const created = await createHook(storage, run.runId, {
        hookId: `whook_cleanup-${Date.now()}`,
        token,
        metadata: { test: 'data' },
      });

      expect(created.hook?.token).toBe(token);

      const hook = await storage.hooks.getByToken(token);
      expect(hook.token).toBe(token);

      await completeRun(storage, run.runId, { result: 'done' });

      await expect(storage.hooks.getByToken(token)).rejects.toThrow();
    });

    test('cleans up hooks when workflow fails', async () => {
      const token = `fail-cleanup-${Date.now()}`;

      const run = await createRun(storage, {
        deploymentId: 'test-deployment',
        workflowName: 'test-workflow',
        input: [],
      });

      await createHook(storage, run.runId, {
        hookId: `whook_fail-${Date.now()}`,
        token,
        metadata: {},
      });

      await failRun(storage, run.runId, { message: 'Test error' });

      await expect(storage.hooks.getByToken(token)).rejects.toThrow();
    });

    test('cleans up hooks when workflow is cancelled', async () => {
      const token = `cancel-cleanup-${Date.now()}`;

      const run = await createRun(storage, {
        deploymentId: 'test-deployment',
        workflowName: 'test-workflow',
        input: [],
      });

      await createHook(storage, run.runId, {
        hookId: `whook_cancel-${Date.now()}`,
        token,
        metadata: {},
      });

      await cancelRun(storage, run.runId);

      await expect(storage.hooks.getByToken(token)).rejects.toThrow();
    });

    test('allows token reuse after workflow completes', async () => {
      const token = `reuse-test-${Date.now()}`;

      const run1 = await createRun(storage, {
        deploymentId: 'test-deployment',
        workflowName: 'test-workflow',
        input: [],
      });

      await createHook(storage, run1.runId, {
        hookId: `whook_reuse1-${Date.now()}`,
        token,
        metadata: { workflow: 1 },
      });

      await completeRun(storage, run1.runId, {});

      const run2 = await createRun(storage, {
        deploymentId: 'test-deployment',
        workflowName: 'test-workflow',
        input: [],
      });

      const hook2 = await createHook(storage, run2.runId, {
        hookId: `whook_reuse2-${Date.now()}`,
        token,
        metadata: { workflow: 2 },
      });

      expect(hook2.hook?.token).toBe(token);
      expect(hook2.hook?.runId).toBe(run2.runId);

      const retrieved = await storage.hooks.getByToken(token);
      expect(retrieved.runId).toBe(run2.runId);

      await completeRun(storage, run2.runId, {});
    });

    test('token conflict returns conflict behavior for active workflow', async () => {
      const token = `conflict-test-${Date.now()}`;

      const run1 = await createRun(storage, {
        deploymentId: 'test-deployment',
        workflowName: 'test-workflow',
        input: [],
      });

      await createHook(storage, run1.runId, {
        hookId: `whook_conflict1-${Date.now()}`,
        token,
        metadata: {},
      });

      const run2 = await createRun(storage, {
        deploymentId: 'test-deployment',
        workflowName: 'test-workflow',
        input: [],
      });

      let sawConflict = false;
      try {
        const result = await createHook(storage, run2.runId, {
          hookId: `whook_conflict2-${Date.now()}`,
          token,
          metadata: {},
        });
        sawConflict = result.event?.eventType === 'hook_conflict';
      } catch (err) {
        sawConflict = true;
        expect(String(err)).toMatch(/409|already exists|conflict/i);
      }

      expect(sawConflict).toBe(true);

      await completeRun(storage, run1.runId, {});
      await completeRun(storage, run2.runId, {});
    });

    test('cleans up multiple hooks for same workflow', async () => {
      const tokens = [
        `multi-1-${Date.now()}`,
        `multi-2-${Date.now()}`,
        `multi-3-${Date.now()}`,
      ];

      const run = await createRun(storage, {
        deploymentId: 'test-deployment',
        workflowName: 'test-workflow',
        input: [],
      });

      for (let i = 0; i < tokens.length; i++) {
        await createHook(storage, run.runId, {
          hookId: `whook_multi-${i}-${Date.now()}`,
          token: tokens[i],
          metadata: { index: i },
        });
      }

      for (const token of tokens) {
        const hook = await storage.hooks.getByToken(token);
        expect(hook.runId).toBe(run.runId);
      }

      await completeRun(storage, run.runId, {});

      for (const token of tokens) {
        await expect(storage.hooks.getByToken(token)).rejects.toThrow();
      }
    });
  });
}
