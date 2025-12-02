/**
 * Hook Cleanup Test Suite
 *
 * Tests that hooks are properly cleaned up when workflows reach terminal status,
 * allowing token reuse for subsequent workflows.
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import type { Storage } from '@workflow/world';
import { WorkflowAPIError } from '@workflow/errors';

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

      // Create a workflow run
      const run = await storage.runs.create({
        deploymentId: 'test-deployment',
        workflowName: 'test-workflow',
        input: [],
      });

      // Create a hook for this run
      await storage.hooks.create(run.runId, {
        hookId: `whook_cleanup-${Date.now()}`,
        token,
        metadata: { test: 'data' },
      });

      // Verify hook exists
      const hook = await storage.hooks.getByToken(token);
      expect(hook.token).toBe(token);

      // Complete the workflow (this should clean up hooks)
      await storage.runs.update(run.runId, {
        status: 'completed',
        output: { result: 'done' },
      });

      // Hook should no longer exist
      await expect(storage.hooks.getByToken(token)).rejects.toThrow();
    });

    test('cleans up hooks when workflow fails', async () => {
      const token = `fail-cleanup-${Date.now()}`;

      const run = await storage.runs.create({
        deploymentId: 'test-deployment',
        workflowName: 'test-workflow',
        input: [],
      });

      await storage.hooks.create(run.runId, {
        hookId: `whook_fail-${Date.now()}`,
        token,
        metadata: {},
      });

      // Fail the workflow
      await storage.runs.update(run.runId, {
        status: 'failed',
        error: { message: 'Test error' },
      });

      // Hook should be cleaned up
      await expect(storage.hooks.getByToken(token)).rejects.toThrow();
    });

    test('cleans up hooks when workflow is cancelled', async () => {
      const token = `cancel-cleanup-${Date.now()}`;

      const run = await storage.runs.create({
        deploymentId: 'test-deployment',
        workflowName: 'test-workflow',
        input: [],
      });

      await storage.hooks.create(run.runId, {
        hookId: `whook_cancel-${Date.now()}`,
        token,
        metadata: {},
      });

      // Cancel the workflow
      await storage.runs.cancel(run.runId);

      // Hook should be cleaned up
      await expect(storage.hooks.getByToken(token)).rejects.toThrow();
    });

    test('allows token reuse after workflow completes', async () => {
      const token = `reuse-test-${Date.now()}`;

      // First workflow
      const run1 = await storage.runs.create({
        deploymentId: 'test-deployment',
        workflowName: 'test-workflow',
        input: [],
      });

      await storage.hooks.create(run1.runId, {
        hookId: `whook_reuse1-${Date.now()}`,
        token,
        metadata: { workflow: 1 },
      });

      // Complete first workflow
      await storage.runs.update(run1.runId, {
        status: 'completed',
        output: {},
      });

      // Second workflow should be able to use the same token
      const run2 = await storage.runs.create({
        deploymentId: 'test-deployment',
        workflowName: 'test-workflow',
        input: [],
      });

      // This should NOT throw - token should be available after cleanup
      const hook2 = await storage.hooks.create(run2.runId, {
        hookId: `whook_reuse2-${Date.now()}`,
        token,
        metadata: { workflow: 2 },
      });

      expect(hook2.token).toBe(token);
      expect(hook2.runId).toBe(run2.runId);

      // Verify the hook is for the second run
      const retrieved = await storage.hooks.getByToken(token);
      expect(retrieved.runId).toBe(run2.runId);

      // Clean up
      await storage.runs.update(run2.runId, { status: 'completed', output: {} });
    });

    test('token conflict throws 409 for active workflow', async () => {
      const token = `conflict-test-${Date.now()}`;

      // Create first workflow and hook
      const run1 = await storage.runs.create({
        deploymentId: 'test-deployment',
        workflowName: 'test-workflow',
        input: [],
      });

      await storage.hooks.create(run1.runId, {
        hookId: `whook_conflict1-${Date.now()}`,
        token,
        metadata: {},
      });

      // Try to create another hook with same token (workflow still active)
      const run2 = await storage.runs.create({
        deploymentId: 'test-deployment',
        workflowName: 'test-workflow',
        input: [],
      });

      await expect(
        storage.hooks.create(run2.runId, {
          hookId: `whook_conflict2-${Date.now()}`,
          token,
          metadata: {},
        })
      ).rejects.toThrow(/409|already exists/i);

      // Clean up
      await storage.runs.update(run1.runId, { status: 'completed', output: {} });
      await storage.runs.update(run2.runId, { status: 'completed', output: {} });
    });

    test('cleans up multiple hooks for same workflow', async () => {
      const tokens = [
        `multi-1-${Date.now()}`,
        `multi-2-${Date.now()}`,
        `multi-3-${Date.now()}`,
      ];

      const run = await storage.runs.create({
        deploymentId: 'test-deployment',
        workflowName: 'test-workflow',
        input: [],
      });

      // Create multiple hooks
      for (let i = 0; i < tokens.length; i++) {
        await storage.hooks.create(run.runId, {
          hookId: `whook_multi-${i}-${Date.now()}`,
          token: tokens[i],
          metadata: { index: i },
        });
      }

      // Verify all hooks exist
      for (const token of tokens) {
        const hook = await storage.hooks.getByToken(token);
        expect(hook.runId).toBe(run.runId);
      }

      // Complete workflow
      await storage.runs.update(run.runId, {
        status: 'completed',
        output: {},
      });

      // All hooks should be cleaned up
      for (const token of tokens) {
        await expect(storage.hooks.getByToken(token)).rejects.toThrow();
      }
    });
  });
}
