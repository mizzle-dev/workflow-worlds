/**
 * Serialization Test Suite
 *
 * Tests that complex data types survive storage round-trips correctly.
 * This catches issues like Date objects being converted to strings,
 * undefined vs null handling, and nested data preservation.
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import type { Storage, Event } from '@workflow/world';

export interface SerializationTestOptions {
  /**
   * Factory function to create a storage instance.
   * Called before tests run.
   */
  createStorage: () => Promise<{ storage: Storage; cleanup?: () => Promise<void> }>;
}

/**
 * Creates the serialization test suite.
 * Tests Date preservation, complex nested data, and special values.
 */
export function serializationTests(options: SerializationTestOptions) {
  describe('serialization', () => {
    let storage: Storage;
    let cleanup: (() => Promise<void>) | undefined;

    beforeAll(async () => {
      const result = await options.createStorage();
      storage = result.storage;
      cleanup = result.cleanup;
    });

    // Clean up after all tests
    afterAll(async () => {
      if (cleanup) {
        await cleanup();
      }
    });

    describe('runs', () => {
      test('preserves Date objects in input/output', async () => {
        const testDate = new Date('2024-06-15T10:30:00.000Z');
        const nestedDate = new Date('2024-01-01T00:00:00.000Z');

        // Create a run with Date in input
        const run = await storage.runs.create({
          deploymentId: 'test-deployment',
          workflowName: 'test-workflow',
          input: [testDate, { nested: nestedDate }],
        });

        // Retrieve and verify dates are preserved
        const retrieved = await storage.runs.get(run.runId);

        expect(retrieved.input).toHaveLength(2);
        expect(retrieved.input[0]).toBeInstanceOf(Date);
        expect((retrieved.input[0] as Date).toISOString()).toBe(testDate.toISOString());

        // Check nested date
        const nestedObj = retrieved.input[1] as { nested: Date };
        expect(nestedObj.nested).toBeInstanceOf(Date);
        expect(nestedObj.nested.toISOString()).toBe(nestedDate.toISOString());
      });

      test('preserves Date objects in output after update', async () => {
        const run = await storage.runs.create({
          deploymentId: 'test-deployment',
          workflowName: 'test-workflow',
          input: [],
        });

        const outputDate = new Date('2024-12-25T12:00:00.000Z');
        await storage.runs.update(run.runId, {
          status: 'completed',
          output: { completedAt: outputDate, values: [outputDate, outputDate] },
        });

        const retrieved = await storage.runs.get(run.runId);
        const output = retrieved.output as { completedAt: Date; values: Date[] };

        expect(output.completedAt).toBeInstanceOf(Date);
        expect(output.completedAt.toISOString()).toBe(outputDate.toISOString());
        expect(output.values[0]).toBeInstanceOf(Date);
        expect(output.values[1]).toBeInstanceOf(Date);
      });

      test('handles undefined vs null correctly', async () => {
        const run = await storage.runs.create({
          deploymentId: 'test-deployment',
          workflowName: 'test-workflow',
          input: [{ explicit: null, missing: undefined }],
        });

        const retrieved = await storage.runs.get(run.runId);
        const obj = retrieved.input[0] as { explicit: null; missing?: undefined };

        // null should be preserved
        expect(obj.explicit).toBeNull();
        // undefined may or may not be preserved depending on implementation
        // but should not become null
        expect(obj.missing).not.toBe(null);
      });

      test('preserves complex nested structures', async () => {
        const complexData = {
          string: 'test',
          number: 42,
          float: 3.14159,
          boolean: true,
          null: null,
          array: [1, 'two', new Date('2024-01-01T00:00:00.000Z')],
          nested: {
            deep: {
              deeper: {
                value: 'found',
                date: new Date('2024-06-15T00:00:00.000Z'),
              },
            },
          },
        };

        const run = await storage.runs.create({
          deploymentId: 'test-deployment',
          workflowName: 'test-workflow',
          input: [complexData],
        });

        const retrieved = await storage.runs.get(run.runId);
        const data = retrieved.input[0] as typeof complexData;

        expect(data.string).toBe('test');
        expect(data.number).toBe(42);
        expect(data.float).toBeCloseTo(3.14159);
        expect(data.boolean).toBe(true);
        expect(data.null).toBeNull();
        expect(data.array[0]).toBe(1);
        expect(data.array[1]).toBe('two');
        expect(data.array[2]).toBeInstanceOf(Date);
        expect(data.nested.deep.deeper.value).toBe('found');
        expect(data.nested.deep.deeper.date).toBeInstanceOf(Date);
      });
    });

    describe('steps', () => {
      test('preserves Date objects in step input/output', async () => {
        const run = await storage.runs.create({
          deploymentId: 'test-deployment',
          workflowName: 'test-workflow',
          input: [],
        });

        const stepDate = new Date('2024-03-15T08:00:00.000Z');

        const step = await storage.steps.create(run.runId, {
          stepId: 'step-date-test',
          stepName: 'dateTest',
          input: [stepDate, { timestamp: stepDate }],
        });

        const retrieved = await storage.steps.get(run.runId, step.stepId);

        expect(retrieved.input[0]).toBeInstanceOf(Date);
        expect((retrieved.input[0] as Date).toISOString()).toBe(stepDate.toISOString());

        const obj = retrieved.input[1] as { timestamp: Date };
        expect(obj.timestamp).toBeInstanceOf(Date);
      });

      test('preserves Date in step output after completion', async () => {
        const run = await storage.runs.create({
          deploymentId: 'test-deployment',
          workflowName: 'test-workflow',
          input: [],
        });

        await storage.steps.create(run.runId, {
          stepId: 'step-output-date',
          stepName: 'outputDate',
          input: [],
        });

        const resultDate = new Date('2024-07-04T16:00:00.000Z');
        await storage.steps.update(run.runId, 'step-output-date', {
          status: 'completed',
          output: [{ result: resultDate }],
        });

        const retrieved = await storage.steps.get(run.runId, 'step-output-date');
        const output = retrieved.output as [{ result: Date }];

        expect(output[0].result).toBeInstanceOf(Date);
        expect(output[0].result.toISOString()).toBe(resultDate.toISOString());
      });
    });

    describe('events', () => {
      test('preserves Date objects in eventData', async () => {
        const run = await storage.runs.create({
          deploymentId: 'test-deployment',
          workflowName: 'test-workflow',
          input: [],
        });

        const eventDate = new Date('2024-08-20T14:30:00.000Z');

        // Use step_started which is a valid event type
        await storage.events.create(run.runId, {
          eventType: 'step_started',
          correlationId: 'corr-123',
          eventData: {
            startedAt: eventDate,
            metadata: {
              createdAt: eventDate,
            },
          },
        } as any); // Use 'as any' since eventData structure varies by type

        const events = await storage.events.list({ runId: run.runId });
        expect(events.data.length).toBeGreaterThan(0);

        const event = events.data[0] as Event & {
          eventData: { startedAt: Date; metadata: { createdAt: Date } };
        };

        // This is the critical test - eventData should preserve Dates
        expect(event.eventData.startedAt).toBeInstanceOf(Date);
        expect(event.eventData.startedAt.toISOString()).toBe(eventDate.toISOString());
        expect(event.eventData.metadata.createdAt).toBeInstanceOf(Date);
      });

      test('preserves event ordering and complex data', async () => {
        const run = await storage.runs.create({
          deploymentId: 'test-deployment',
          workflowName: 'test-workflow',
          input: [],
        });

        const dates = [
          new Date('2024-01-01T00:00:00.000Z'),
          new Date('2024-02-01T00:00:00.000Z'),
          new Date('2024-03-01T00:00:00.000Z'),
        ];

        // Create events in order using step_started which is a valid event type
        for (let i = 0; i < dates.length; i++) {
          await storage.events.create(run.runId, {
            eventType: 'step_started',
            correlationId: `order-test-${i}`,
            eventData: { index: i, timestamp: dates[i] },
          } as any); // Use 'as any' since we're adding custom fields for testing
        }

        const events = await storage.events.list({ runId: run.runId });

        // Events should be in ascending order (oldest first)
        expect(events.data.length).toBe(3);

        for (let i = 0; i < events.data.length; i++) {
          const event = events.data[i] as Event & {
            eventData: { index: number; timestamp: Date };
          };
          expect(event.eventData.index).toBe(i);
          expect(event.eventData.timestamp).toBeInstanceOf(Date);
          expect(event.eventData.timestamp.toISOString()).toBe(dates[i].toISOString());
        }
      });
    });

    describe('hooks', () => {
      test('preserves metadata with Date objects', async () => {
        const run = await storage.runs.create({
          deploymentId: 'test-deployment',
          workflowName: 'test-workflow',
          input: [],
        });

        const metadataDate = new Date('2024-09-15T10:00:00.000Z');
        const token = `test-token-${Date.now()}`;

        const hook = await storage.hooks.create(run.runId, {
          hookId: `whook_test-${Date.now()}`,
          token,
          metadata: {
            createdAt: metadataDate,
            config: { expiresAt: metadataDate },
          },
        });

        const retrieved = await storage.hooks.getByToken(token);

        const metadata = retrieved.metadata as {
          createdAt: Date;
          config: { expiresAt: Date };
        };

        expect(metadata.createdAt).toBeInstanceOf(Date);
        expect(metadata.createdAt.toISOString()).toBe(metadataDate.toISOString());
        expect(metadata.config.expiresAt).toBeInstanceOf(Date);
      });
    });
  });
}
