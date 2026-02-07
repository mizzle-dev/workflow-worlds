/**
 * Serialization Test Suite
 *
 * Tests that complex data types survive storage round-trips correctly.
 * This catches issues like Date objects being converted to strings,
 * undefined vs null handling, and nested data preservation.
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { SPEC_VERSION_CURRENT, type Event, type Storage } from '@workflow/world';
import {
  completeStep,
  createHook,
  createRun,
  createStep,
} from './storage-compat.js';

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

    afterAll(async () => {
      if (cleanup) {
        await cleanup();
      }
    });

    describe('runs', () => {
      test('preserves Date objects in input/output', async () => {
        const testDate = new Date('2024-06-15T10:30:00.000Z');
        const nestedDate = new Date('2024-01-01T00:00:00.000Z');

        const run = await createRun(storage, {
          deploymentId: 'test-deployment',
          workflowName: 'test-workflow',
          input: [testDate, { nested: nestedDate }],
        });

        const retrieved = await storage.runs.get(run.runId);
        const inputs = retrieved.input as unknown[];

        expect(inputs).toHaveLength(2);
        expect(inputs[0]).toBeInstanceOf(Date);
        expect((inputs[0] as Date).toISOString()).toBe(testDate.toISOString());

        const nestedObj = inputs[1] as { nested: Date };
        expect(nestedObj.nested).toBeInstanceOf(Date);
        expect(nestedObj.nested.toISOString()).toBe(nestedDate.toISOString());
      });

      test('handles undefined vs null correctly', async () => {
        const run = await createRun(storage, {
          deploymentId: 'test-deployment',
          workflowName: 'test-workflow',
          input: [{ explicit: null, missing: undefined }],
        });

        const retrieved = await storage.runs.get(run.runId);
        const inputs = retrieved.input as unknown[];
        const obj = inputs[0] as { explicit: null; missing?: undefined };

        expect(obj.explicit).toBeNull();
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

        const run = await createRun(storage, {
          deploymentId: 'test-deployment',
          workflowName: 'test-workflow',
          input: [complexData],
        });

        const retrieved = await storage.runs.get(run.runId);
        const inputs = retrieved.input as unknown[];
        const data = inputs[0] as typeof complexData;

        expect(data.string).toBe('test');
        expect(data.number).toBe(42);
        expect(data.float).toBeCloseTo(3.14159);
        expect(data.boolean).toBe(true);
        expect(data.null).toBeNull();
        expect(data.array[2]).toBeInstanceOf(Date);
        expect(data.nested.deep.deeper.value).toBe('found');
        expect(data.nested.deep.deeper.date).toBeInstanceOf(Date);
      });
    });

    describe('steps', () => {
      test('preserves Date objects in step input/output', async () => {
        const run = await createRun(storage, {
          deploymentId: 'test-deployment',
          workflowName: 'test-workflow',
          input: [],
        });

        const stepDate = new Date('2024-03-15T08:00:00.000Z');

        const step = await createStep(storage, run.runId, {
          stepId: 'step-date-test',
          stepName: 'dateTest',
          input: [stepDate, { timestamp: stepDate }],
        });

        const retrieved = await storage.steps.get(run.runId, step.stepId);
        const inputs = retrieved.input as unknown[];

        expect(inputs[0]).toBeInstanceOf(Date);
        expect((inputs[0] as Date).toISOString()).toBe(stepDate.toISOString());

        const obj = inputs[1] as { timestamp: Date };
        expect(obj.timestamp).toBeInstanceOf(Date);
      });

      test('preserves Date in step output after completion', async () => {
        const run = await createRun(storage, {
          deploymentId: 'test-deployment',
          workflowName: 'test-workflow',
          input: [],
        });

        await createStep(storage, run.runId, {
          stepId: 'step-output-date',
          stepName: 'outputDate',
          input: [],
        });

        const resultDate = new Date('2024-07-04T16:00:00.000Z');
        await completeStep(storage, run.runId, 'step-output-date', [{ result: resultDate }]);

        const retrieved = await storage.steps.get(run.runId, 'step-output-date');
        const output = retrieved.output as [{ result: Date }];

        expect(output[0].result).toBeInstanceOf(Date);
        expect(output[0].result.toISOString()).toBe(resultDate.toISOString());
      });
    });

    describe('events', () => {
      test('preserves Date objects in eventData', async () => {
        const run = await createRun(storage, {
          deploymentId: 'test-deployment',
          workflowName: 'test-workflow',
          input: [],
        });

        const eventDate = new Date('2024-08-20T14:30:00.000Z');

        await storage.events.create(run.runId, {
          eventType: 'wait_created',
          specVersion: SPEC_VERSION_CURRENT,
          correlationId: 'wait-date-123',
          eventData: {
            resumeAt: eventDate,
          },
        });

        const events = await storage.events.list({ runId: run.runId });
        const event = events.data.find((e) => e.correlationId === 'wait-date-123') as
          | (Event & { eventData: { resumeAt: Date } })
          | undefined;

        expect(event).toBeDefined();
        expect(event!.eventData.resumeAt).toBeInstanceOf(Date);
        expect(event!.eventData.resumeAt.toISOString()).toBe(eventDate.toISOString());
      });

      test('preserves event ordering and complex data', async () => {
        const run = await createRun(storage, {
          deploymentId: 'test-deployment',
          workflowName: 'test-workflow',
          input: [],
        });

        const dates = [
          new Date('2024-01-01T00:00:00.000Z'),
          new Date('2024-02-01T00:00:00.000Z'),
          new Date('2024-03-01T00:00:00.000Z'),
        ];

        for (let i = 0; i < dates.length; i++) {
          await storage.events.create(run.runId, {
            eventType: 'wait_created',
            specVersion: SPEC_VERSION_CURRENT,
            correlationId: `order-test-${i}`,
            eventData: { resumeAt: dates[i] },
          });
        }

        const events = await storage.events.list({ runId: run.runId });
        const orderEvents = events.data.filter((event) =>
          event.correlationId?.startsWith('order-test-')
        ) as Array<Event & { eventData: { resumeAt: Date } }>;

        expect(orderEvents.length).toBe(3);

        for (let i = 0; i < orderEvents.length; i++) {
          expect(orderEvents[i].correlationId).toBe(`order-test-${i}`);
          expect(orderEvents[i].eventData.resumeAt).toBeInstanceOf(Date);
          expect(orderEvents[i].eventData.resumeAt.toISOString()).toBe(dates[i].toISOString());
        }
      });
    });

    describe('hooks', () => {
      test('preserves metadata with Date objects', async () => {
        const run = await createRun(storage, {
          deploymentId: 'test-deployment',
          workflowName: 'test-workflow',
          input: [],
        });

        const metadataDate = new Date('2024-09-15T10:00:00.000Z');
        const token = `test-token-${Date.now()}`;

        const created = await createHook(storage, run.runId, {
          hookId: `whook_test-${Date.now()}`,
          token,
          metadata: {
            createdAt: metadataDate,
            config: { expiresAt: metadataDate },
          },
        });

        expect(created.hook?.token).toBe(token);

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
