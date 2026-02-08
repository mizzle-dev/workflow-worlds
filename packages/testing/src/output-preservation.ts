/**
 * Output Preservation Test Suite
 *
 * Tests that workflow outputs survive storage round-trips correctly.
 * This catches issues where outputs become empty objects {} or lose properties.
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import type { Storage } from '@workflow/world';
import {
  completeRun,
  completeStep,
  createRun,
  createStep,
  retryStep,
  startStep,
} from './storage-compat.js';

export interface OutputPreservationTestOptions {
  /**
   * Factory function to create a storage instance.
   */
  createStorage: () => Promise<{ storage: Storage; cleanup?: () => Promise<void> }>;
}

/**
 * Creates the output preservation test suite.
 * Tests that various output types survive storage correctly.
 */
export function outputPreservationTests(options: OutputPreservationTestOptions) {
  describe('output preservation', () => {
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

    describe('run outputs', () => {
      test('preserves number output (addTenWorkflow pattern)', async () => {
        const run = await createRun(storage, {
          deploymentId: 'test-deployment',
          workflowName: 'addTen',
          input: [123],
        });

        await completeRun(storage, run.runId, 133);

        const retrieved = await storage.runs.get(run.runId);

        expect(retrieved.output).toBe(133);
        expect(typeof retrieved.output).toBe('number');
      });

      test('preserves object output with properties (retryAttemptCounter pattern)', async () => {
        const run = await createRun(storage, {
          deploymentId: 'test-deployment',
          workflowName: 'retryAttemptCounter',
          input: [],
        });

        const expectedOutput = { finalAttempt: 3 };

        await completeRun(storage, run.runId, expectedOutput);

        const retrieved = await storage.runs.get(run.runId);

        expect(retrieved.output).toEqual(expectedOutput);
        expect((retrieved.output as { finalAttempt: number }).finalAttempt).toBe(3);
      });

      test('preserves complex object output (spawnWorkflow pattern)', async () => {
        const run = await createRun(storage, {
          deploymentId: 'test-deployment',
          workflowName: 'spawnWorkflowFromStep',
          input: [42],
        });

        const expectedOutput = {
          childRunId: 'wrun_01ABC123',
          childResult: 84,
          parentInput: 42,
          metadata: { spawned: true },
        };

        await completeRun(storage, run.runId, expectedOutput);

        const retrieved = await storage.runs.get(run.runId);

        expect(retrieved.output).toEqual(expectedOutput);
      });

      test('preserves string output', async () => {
        const run = await createRun(storage, {
          deploymentId: 'test-deployment',
          workflowName: 'stringOutput',
          input: [],
        });

        const expectedOutput = 'Wrapped: Result: 21';

        await completeRun(storage, run.runId, expectedOutput);

        const retrieved = await storage.runs.get(run.runId);

        expect(retrieved.output).toBe(expectedOutput);
        expect(typeof retrieved.output).toBe('string');
      });

      test('preserves array output', async () => {
        const run = await createRun(storage, {
          deploymentId: 'test-deployment',
          workflowName: 'arrayOutput',
          input: [],
        });

        const expectedOutput = [1, 2, 3, 'four', { five: 5 }];

        await completeRun(storage, run.runId, expectedOutput);

        const retrieved = await storage.runs.get(run.runId);

        expect(retrieved.output).toEqual(expectedOutput);
        expect(Array.isArray(retrieved.output)).toBe(true);
      });

      test('preserves boolean output', async () => {
        const runTrue = await createRun(storage, {
          deploymentId: 'test-deployment',
          workflowName: 'booleanOutputTrue',
          input: [],
        });

        await completeRun(storage, runTrue.runId, true);
        const retrievedTrue = await storage.runs.get(runTrue.runId);
        expect(retrievedTrue.output).toBe(true);

        const runFalse = await createRun(storage, {
          deploymentId: 'test-deployment',
          workflowName: 'booleanOutputFalse',
          input: [],
        });

        await completeRun(storage, runFalse.runId, false);
        const retrievedFalse = await storage.runs.get(runFalse.runId);
        expect(retrievedFalse.output).toBe(false);
      });

      test('preserves null output', async () => {
        const run = await createRun(storage, {
          deploymentId: 'test-deployment',
          workflowName: 'nullOutput',
          input: [],
        });

        await completeRun(storage, run.runId, null);

        const retrieved = await storage.runs.get(run.runId);
        expect(retrieved.output).toBeNull();
      });

      test('preserves zero output', async () => {
        const run = await createRun(storage, {
          deploymentId: 'test-deployment',
          workflowName: 'zeroOutput',
          input: [],
        });

        await completeRun(storage, run.runId, 0);

        const retrieved = await storage.runs.get(run.runId);
        expect(retrieved.output).toBe(0);
        expect(typeof retrieved.output).toBe('number');
      });

      test('preserves empty string output', async () => {
        const run = await createRun(storage, {
          deploymentId: 'test-deployment',
          workflowName: 'emptyStringOutput',
          input: [],
        });

        await completeRun(storage, run.runId, '');

        const retrieved = await storage.runs.get(run.runId);
        expect(retrieved.output).toBe('');
        expect(typeof retrieved.output).toBe('string');
      });
    });

    describe('step outputs', () => {
      test('preserves step output with attempt count', async () => {
        const run = await createRun(storage, {
          deploymentId: 'test-deployment',
          workflowName: 'retryTest',
          input: [],
        });

        await createStep(storage, run.runId, {
          stepId: 'wstep_retry-step',
          stepName: 'retryStep',
          input: [],
        });

        await startStep(storage, run.runId, 'wstep_retry-step');
        await retryStep(storage, run.runId, 'wstep_retry-step', {
          message: 'retry 1',
        });
        await startStep(storage, run.runId, 'wstep_retry-step');
        await retryStep(storage, run.runId, 'wstep_retry-step', {
          message: 'retry 2',
        });
        await startStep(storage, run.runId, 'wstep_retry-step');

        await completeStep(storage, run.runId, 'wstep_retry-step', [3]);

        const retrieved = await storage.steps.get(run.runId, 'wstep_retry-step');

        expect(retrieved.attempt).toBe(3);
        expect(retrieved.output).toEqual([3]);
      });

      test('preserves step output with function result', async () => {
        const run = await createRun(storage, {
          deploymentId: 'test-deployment',
          workflowName: 'functionTest',
          input: [],
        });

        await createStep(storage, run.runId, {
          stepId: 'wstep_function-step',
          stepName: 'functionStep',
          input: [10],
        });

        await completeStep(storage, run.runId, 'wstep_function-step', [20]);

        const retrieved = await storage.steps.get(run.runId, 'wstep_function-step');

        expect(retrieved.input).toEqual([10]);
        expect(retrieved.output).toEqual([20]);
      });

      test('preserves step output with complex object', async () => {
        const run = await createRun(storage, {
          deploymentId: 'test-deployment',
          workflowName: 'complexStepTest',
          input: [],
        });

        await createStep(storage, run.runId, {
          stepId: 'wstep_complex-step',
          stepName: 'complexStep',
          input: [],
        });

        const complexOutput = {
          result: 'success',
          data: { nested: { value: 42 } },
          items: [1, 2, 3],
        };

        await completeStep(storage, run.runId, 'wstep_complex-step', [complexOutput]);

        const retrieved = await storage.steps.get(run.runId, 'wstep_complex-step');

        expect(retrieved.output).toEqual([complexOutput]);
      });
    });

    describe('input preservation', () => {
      test('preserves run input array', async () => {
        const input = [123, 'test', { key: 'value' }, [1, 2, 3]];

        const run = await createRun(storage, {
          deploymentId: 'test-deployment',
          workflowName: 'inputTest',
          input,
        });

        const retrieved = await storage.runs.get(run.runId);

        expect(retrieved.input).toEqual(input);
      });

      test('preserves step input array', async () => {
        const run = await createRun(storage, {
          deploymentId: 'test-deployment',
          workflowName: 'stepInputTest',
          input: [],
        });

        const stepInput = [42, { config: { enabled: true } }];

        await createStep(storage, run.runId, {
          stepId: 'wstep_input-step',
          stepName: 'inputStep',
          input: stepInput,
        });

        const retrieved = await storage.steps.get(run.runId, 'wstep_input-step');

        expect(retrieved.input).toEqual(stepInput);
      });
    });
  });
}
