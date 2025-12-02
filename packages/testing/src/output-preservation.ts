/**
 * Output Preservation Test Suite
 *
 * Tests that workflow outputs survive storage round-trips correctly.
 * This catches issues where outputs become empty objects {} or lose properties.
 *
 * These tests are designed to catch the exact failures seen in e2e tests:
 * - addTenWorkflow: output should be a number (133)
 * - retryAttemptCounterWorkflow: output should be { finalAttempt: 3 }
 * - stepFunctionPassingWorkflow: output should be a number (40)
 * - spawnWorkflowFromStepWorkflow: output should have childRunId and childResult
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import type { Storage } from '@workflow/world';

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
        // Simulates: workflow that returns input + 10
        const run = await storage.runs.create({
          deploymentId: 'test-deployment',
          workflowName: 'addTen',
          input: [123],
        });

        // Update with numeric output
        await storage.runs.update(run.runId, {
          status: 'completed',
          output: 133,
        });

        const retrieved = await storage.runs.get(run.runId);

        // This MUST be exactly 133, not {} or undefined
        expect(retrieved.output).toBe(133);
        expect(typeof retrieved.output).toBe('number');
      });

      test('preserves object output with properties (retryAttemptCounter pattern)', async () => {
        // Simulates: workflow that returns { finalAttempt: 3 }
        const run = await storage.runs.create({
          deploymentId: 'test-deployment',
          workflowName: 'retryAttemptCounter',
          input: [],
        });

        const expectedOutput = { finalAttempt: 3 };

        await storage.runs.update(run.runId, {
          status: 'completed',
          output: expectedOutput,
        });

        const retrieved = await storage.runs.get(run.runId);

        // This MUST match the exact object, not {}
        expect(retrieved.output).toEqual(expectedOutput);
        expect(retrieved.output).toMatchObject({ finalAttempt: 3 });
        expect((retrieved.output as { finalAttempt: number }).finalAttempt).toBe(3);
      });

      test('preserves complex object output (spawnWorkflow pattern)', async () => {
        // Simulates: workflow that spawns child and returns results
        const run = await storage.runs.create({
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

        await storage.runs.update(run.runId, {
          status: 'completed',
          output: expectedOutput,
        });

        const retrieved = await storage.runs.get(run.runId);

        // All properties must be preserved
        expect(retrieved.output).toEqual(expectedOutput);
        expect((retrieved.output as typeof expectedOutput).childRunId).toBe('wrun_01ABC123');
        expect((retrieved.output as typeof expectedOutput).childResult).toBe(84);
        expect((retrieved.output as typeof expectedOutput).parentInput).toBe(42);
        expect((retrieved.output as typeof expectedOutput).metadata.spawned).toBe(true);
      });

      test('preserves string output', async () => {
        const run = await storage.runs.create({
          deploymentId: 'test-deployment',
          workflowName: 'stringOutput',
          input: [],
        });

        const expectedOutput = 'Wrapped: Result: 21';

        await storage.runs.update(run.runId, {
          status: 'completed',
          output: expectedOutput,
        });

        const retrieved = await storage.runs.get(run.runId);

        expect(retrieved.output).toBe(expectedOutput);
        expect(typeof retrieved.output).toBe('string');
      });

      test('preserves array output', async () => {
        const run = await storage.runs.create({
          deploymentId: 'test-deployment',
          workflowName: 'arrayOutput',
          input: [],
        });

        const expectedOutput = [1, 2, 3, 'four', { five: 5 }];

        await storage.runs.update(run.runId, {
          status: 'completed',
          output: expectedOutput,
        });

        const retrieved = await storage.runs.get(run.runId);

        expect(retrieved.output).toEqual(expectedOutput);
        expect(Array.isArray(retrieved.output)).toBe(true);
        expect((retrieved.output as unknown[])[3]).toBe('four');
        expect((retrieved.output as unknown[])[4]).toEqual({ five: 5 });
      });

      test('preserves boolean output', async () => {
        const run = await storage.runs.create({
          deploymentId: 'test-deployment',
          workflowName: 'booleanOutput',
          input: [],
        });

        // Test true
        await storage.runs.update(run.runId, {
          status: 'completed',
          output: true,
        });

        let retrieved = await storage.runs.get(run.runId);
        expect(retrieved.output).toBe(true);
        expect(typeof retrieved.output).toBe('boolean');

        // Test false (important edge case)
        await storage.runs.update(run.runId, {
          output: false,
        });

        retrieved = await storage.runs.get(run.runId);
        expect(retrieved.output).toBe(false);
        expect(typeof retrieved.output).toBe('boolean');
      });

      test('preserves null output', async () => {
        const run = await storage.runs.create({
          deploymentId: 'test-deployment',
          workflowName: 'nullOutput',
          input: [],
        });

        await storage.runs.update(run.runId, {
          status: 'completed',
          output: null,
        });

        const retrieved = await storage.runs.get(run.runId);
        expect(retrieved.output).toBeNull();
      });

      test('preserves zero output', async () => {
        const run = await storage.runs.create({
          deploymentId: 'test-deployment',
          workflowName: 'zeroOutput',
          input: [],
        });

        await storage.runs.update(run.runId, {
          status: 'completed',
          output: 0,
        });

        const retrieved = await storage.runs.get(run.runId);
        expect(retrieved.output).toBe(0);
        expect(typeof retrieved.output).toBe('number');
      });

      test('preserves empty string output', async () => {
        const run = await storage.runs.create({
          deploymentId: 'test-deployment',
          workflowName: 'emptyStringOutput',
          input: [],
        });

        await storage.runs.update(run.runId, {
          status: 'completed',
          output: '',
        });

        const retrieved = await storage.runs.get(run.runId);
        expect(retrieved.output).toBe('');
        expect(typeof retrieved.output).toBe('string');
      });
    });

    describe('step outputs', () => {
      test('preserves step output with attempt count', async () => {
        // Simulates retry step that succeeds on attempt 3
        const run = await storage.runs.create({
          deploymentId: 'test-deployment',
          workflowName: 'retryTest',
          input: [],
        });

        await storage.steps.create(run.runId, {
          stepId: 'wstep_retry-step',
          stepName: 'retryStep',
          input: [],
        });

        // Update with attempt count and output
        await storage.steps.update(run.runId, 'wstep_retry-step', {
          status: 'completed',
          attempt: 3,
          output: [3], // Step output is always an array
        });

        const retrieved = await storage.steps.get(run.runId, 'wstep_retry-step');

        expect(retrieved.attempt).toBe(3);
        expect(retrieved.output).toEqual([3]);
        expect((retrieved.output as number[])[0]).toBe(3);
      });

      test('preserves step output with function result', async () => {
        // Simulates step that calls a function and returns result
        const run = await storage.runs.create({
          deploymentId: 'test-deployment',
          workflowName: 'functionTest',
          input: [],
        });

        await storage.steps.create(run.runId, {
          stepId: 'wstep_function-step',
          stepName: 'functionStep',
          input: [10],
        });

        // Step returns [20] (doubleNumber(10) = 20)
        await storage.steps.update(run.runId, 'wstep_function-step', {
          status: 'completed',
          output: [20],
        });

        const retrieved = await storage.steps.get(run.runId, 'wstep_function-step');

        expect(retrieved.input).toEqual([10]);
        expect(retrieved.output).toEqual([20]);
      });

      test('preserves step output with complex object', async () => {
        const run = await storage.runs.create({
          deploymentId: 'test-deployment',
          workflowName: 'complexStepTest',
          input: [],
        });

        await storage.steps.create(run.runId, {
          stepId: 'wstep_complex-step',
          stepName: 'complexStep',
          input: [],
        });

        const complexOutput = {
          result: 'success',
          data: { nested: { value: 42 } },
          items: [1, 2, 3],
        };

        await storage.steps.update(run.runId, 'wstep_complex-step', {
          status: 'completed',
          output: [complexOutput],
        });

        const retrieved = await storage.steps.get(run.runId, 'wstep_complex-step');

        expect(retrieved.output).toEqual([complexOutput]);
        const output = (retrieved.output as [typeof complexOutput])[0];
        expect(output.result).toBe('success');
        expect(output.data.nested.value).toBe(42);
        expect(output.items).toEqual([1, 2, 3]);
      });
    });

    describe('input preservation', () => {
      test('preserves run input array', async () => {
        const input = [123, 'test', { key: 'value' }, [1, 2, 3]];

        const run = await storage.runs.create({
          deploymentId: 'test-deployment',
          workflowName: 'inputTest',
          input,
        });

        const retrieved = await storage.runs.get(run.runId);

        expect(retrieved.input).toEqual(input);
        expect(retrieved.input[0]).toBe(123);
        expect(retrieved.input[1]).toBe('test');
        expect(retrieved.input[2]).toEqual({ key: 'value' });
        expect(retrieved.input[3]).toEqual([1, 2, 3]);
      });

      test('preserves step input array', async () => {
        const run = await storage.runs.create({
          deploymentId: 'test-deployment',
          workflowName: 'stepInputTest',
          input: [],
        });

        const stepInput = [42, { config: { enabled: true } }];

        await storage.steps.create(run.runId, {
          stepId: 'wstep_input-step',
          stepName: 'inputStep',
          input: stepInput,
        });

        const retrieved = await storage.steps.get(run.runId, 'wstep_input-step');

        expect(retrieved.input).toEqual(stepInput);
        expect(retrieved.input[0]).toBe(42);
        expect((retrieved.input[1] as { config: { enabled: boolean } }).config.enabled).toBe(true);
      });
    });
  });
}
