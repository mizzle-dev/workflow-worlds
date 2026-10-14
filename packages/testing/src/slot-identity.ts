/**
 * Slot Identity Test Suite
 *
 * Tests the Workflow 5 storage contract that the type signatures do not show:
 * - event IDs are dense, 1-based positions in their run's log
 * - concurrent appends to one run never share or skip a position
 * - a write with a stale `eventCount` is bumped, and reports what it skipped
 * - a lazy `step_started` creates its step exactly once
 * - lookups are scoped to a run
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import {
  FIRST_EVENT_SLOT,
  SPEC_VERSION_CURRENT,
  eventIdToSlot,
  slotToEventId,
  type Event,
  type Storage,
} from '@workflow/world';
import { EntityConflictError, HookNotFoundError } from '@workflow/errors';
import { createHook, createRun, createStep } from './storage-compat.js';

export interface SlotIdentityTestOptions {
  /**
   * Factory function to create a storage instance.
   */
  createStorage: () => Promise<{ storage: Storage; cleanup?: () => Promise<void> }>;
}

async function listAllEvents(storage: Storage, runId: string): Promise<Event[]> {
  const events: Event[] = [];
  let cursor: string | undefined;
  do {
    const page = await storage.events.list({
      runId,
      pagination: { sortOrder: 'asc', cursor, limit: 10 },
    });
    events.push(...page.data);
    cursor = page.hasMore ? (page.cursor ?? undefined) : undefined;
  } while (cursor);
  return events;
}

function expectDense(events: Event[]): void {
  expect(events.map((event) => event.eventId)).toEqual(
    events.map((_, index) => slotToEventId(FIRST_EVENT_SLOT + index))
  );
}

async function newRun(storage: Storage, workflowName: string) {
  return createRun(storage, {
    deploymentId: 'test-deployment',
    workflowName,
    input: [],
  });
}

export function slotIdentityTests(options: SlotIdentityTestOptions) {
  describe('slot identity', () => {
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

    test('numbers a run’s events densely from the first slot', async () => {
      const run = await newRun(storage, 'slot-dense');
      const stepId = `wstep_dense-${Date.now()}`;
      await createStep(storage, run.runId, { stepId, stepName: 'dense', input: [] });
      await storage.events.create(run.runId, {
        eventType: 'step_started',
        specVersion: SPEC_VERSION_CURRENT,
        correlationId: stepId,
      });
      await storage.events.create(run.runId, {
        eventType: 'step_completed',
        specVersion: SPEC_VERSION_CURRENT,
        correlationId: stepId,
        eventData: { result: 1 },
      });

      const events = await listAllEvents(storage, run.runId);
      expect(events.map((event) => event.eventType)).toEqual([
        'run_created',
        'step_created',
        'step_started',
        'step_completed',
      ]);
      expectDense(events);

      const fetched = await storage.events.get(run.runId, events[2].eventId);
      expect(fetched.eventType).toBe('step_started');
      expect(fetched.correlationId).toBe(stepId);
    });

    test('concurrent appends to one run take distinct, dense slots', async () => {
      const run = await newRun(storage, 'slot-concurrent');
      const width = 25;
      const stepIds = Array.from({ length: width }, (_, i) => `wstep_fanout-${i}-${Date.now()}`);

      const results = await Promise.all(
        stepIds.map((stepId) =>
          storage.events.create(run.runId, {
            eventType: 'step_created',
            specVersion: SPEC_VERSION_CURRENT,
            correlationId: stepId,
            eventData: { stepName: 'fanout', input: [] },
          })
        )
      );

      const committed = results.map((result) => result.event!.eventId);
      expect(new Set(committed).size).toBe(width);

      const events = await listAllEvents(storage, run.runId);
      expect(events).toHaveLength(width + 1);
      expectDense(events);
      expect(new Set(events.slice(1).map((event) => event.correlationId))).toEqual(
        new Set(stepIds)
      );
    });

    test('bumps a write with a stale eventCount and reports the skipped events', async () => {
      const run = await newRun(storage, 'slot-bump');
      const a = await createStep(storage, run.runId, {
        stepId: `wstep_bump-a-${Date.now()}`,
        stepName: 'a',
        input: [],
      });
      const b = await createStep(storage, run.runId, {
        stepId: `wstep_bump-b-${Date.now()}`,
        stepName: 'b',
        input: [],
      });

      // The writer replayed a log holding only run_created.
      const result = await storage.events.create(
        run.runId,
        {
          eventType: 'step_created',
          specVersion: SPEC_VERSION_CURRENT,
          correlationId: `wstep_bump-c-${Date.now()}`,
          eventData: { stepName: 'c', input: [] },
        },
        { eventCount: 1 }
      );

      expect(eventIdToSlot(result.event!.eventId)).toBe(FIRST_EVENT_SLOT + 3);
      expect(result.events?.map((event) => event.correlationId)).toEqual([a.stepId, b.stepId]);
      expect(result.events?.map((event) => event.eventId)).toEqual([
        slotToEventId(FIRST_EVENT_SLOT + 1),
        slotToEventId(FIRST_EVENT_SLOT + 2),
      ]);

      // A current count reports nothing.
      const current = await storage.events.create(
        run.runId,
        {
          eventType: 'step_created',
          specVersion: SPEC_VERSION_CURRENT,
          correlationId: `wstep_bump-d-${Date.now()}`,
          eventData: { stepName: 'd', input: [] },
        },
        { eventCount: 4 }
      );
      expect(eventIdToSlot(current.event!.eventId)).toBe(FIRST_EVENT_SLOT + 4);
      expect(current.events).toBeUndefined();
    });

    test('a lazy step_started creates its step and a step_created event', async () => {
      const run = await newRun(storage, 'slot-lazy');
      const stepId = `wstep_lazy-${Date.now()}`;

      const result = await storage.events.create(run.runId, {
        eventType: 'step_started',
        specVersion: SPEC_VERSION_CURRENT,
        correlationId: stepId,
        eventData: { stepName: 'lazy', input: ['lazy-input'] },
      });

      expect(result.stepCreated).toBe(true);
      expect(result.step?.status).toBe('running');
      expect(result.step?.attempt).toBe(1);
      expect(result.step?.input).toEqual(['lazy-input']);

      const events = await listAllEvents(storage, run.runId);
      expect(events.map((event) => event.eventType)).toEqual([
        'run_created',
        'step_created',
        'step_started',
      ]);
      expectDense(events);
      const started = events[2] as Event & { eventData?: Record<string, unknown> };
      expect(started.eventData?.input).toBeUndefined();

      await expect(
        storage.events.create(run.runId, {
          eventType: 'step_started',
          specVersion: SPEC_VERSION_CURRENT,
          correlationId: stepId,
          eventData: { stepName: 'lazy', input: ['lazy-input'] },
        })
      ).rejects.toSatisfy(EntityConflictError.is);
    });

    test('concurrent lazy starts let exactly one caller own the step', async () => {
      const run = await newRun(storage, 'slot-lazy-race');
      const stepId = `wstep_lazy-race-${Date.now()}`;

      const settled = await Promise.allSettled(
        Array.from({ length: 6 }, () =>
          storage.events.create(run.runId, {
            eventType: 'step_started',
            specVersion: SPEC_VERSION_CURRENT,
            correlationId: stepId,
            eventData: { stepName: 'race', input: [] },
          })
        )
      );

      const owners = settled.filter(
        (outcome) => outcome.status === 'fulfilled' && outcome.value.stepCreated === true
      );
      expect(owners).toHaveLength(1);
      for (const outcome of settled) {
        if (outcome.status === 'rejected') {
          expect(EntityConflictError.is(outcome.reason)).toBe(true);
        }
      }

      const events = await listAllEvents(storage, run.runId);
      expect(events.map((event) => event.eventType)).toEqual([
        'run_created',
        'step_created',
        'step_started',
      ]);
      expectDense(events);
    });

    test('listByCorrelationId is scoped to one run', async () => {
      const runA = await newRun(storage, 'slot-correlation-a');
      const runB = await newRun(storage, 'slot-correlation-b');
      const shared = `wstep_shared-${Date.now()}`;
      await createStep(storage, runA.runId, { stepId: shared, stepName: 's', input: [] });
      await createStep(storage, runB.runId, { stepId: shared, stepName: 's', input: [] });

      const page = await storage.events.listByCorrelationId({
        runId: runA.runId,
        correlationId: shared,
      });
      expect(page.data).toHaveLength(1);
      expect(page.data[0].runId).toBe(runA.runId);

      const step = await storage.steps.get(runB.runId, shared);
      expect(step.runId).toBe(runB.runId);
    });

    test('runs.list accepts an array of statuses', async () => {
      const name = `slot-status-list-${Date.now()}`;
      const pending = await newRun(storage, name);
      const cancelled = await newRun(storage, name);
      await storage.events.create(cancelled.runId, {
        eventType: 'run_cancelled',
        specVersion: SPEC_VERSION_CURRENT,
      });

      const both = await storage.runs.list({
        workflowName: name,
        status: ['pending', 'cancelled'],
      });
      expect(new Set(both.data.map((run) => run.runId))).toEqual(
        new Set([pending.runId, cancelled.runId])
      );

      const onlyCancelled = await storage.runs.list({ workflowName: name, status: ['cancelled'] });
      expect(onlyCancelled.data.map((run) => run.runId)).toEqual([cancelled.runId]);

      const none = await storage.runs.list({ workflowName: name, status: [] });
      expect(none.data).toEqual([]);
    });

    test('a wait completes exactly once', async () => {
      const run = await newRun(storage, 'slot-wait');
      const waitId = `wait-${Date.now()}`;
      const created = await storage.events.create(run.runId, {
        eventType: 'wait_created',
        specVersion: SPEC_VERSION_CURRENT,
        correlationId: waitId,
        eventData: { resumeAt: new Date(Date.now() + 1_000) },
      });
      expect(created.wait?.status).toBe('waiting');

      const outcomes = await Promise.allSettled(
        Array.from({ length: 4 }, () =>
          storage.events.create(run.runId, {
            eventType: 'wait_completed',
            specVersion: SPEC_VERSION_CURRENT,
            correlationId: waitId,
          })
        )
      );
      expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
      for (const outcome of outcomes) {
        if (outcome.status === 'rejected') {
          expect(EntityConflictError.is(outcome.reason)).toBe(true);
        }
      }
      expectDense(await listAllEvents(storage, run.runId));
    });

    test('refuses a hook delivery after the hook is disposed', async () => {
      const run = await newRun(storage, 'slot-hook-dispose');
      const hookId = `whook_dispose-${Date.now()}`;
      await createHook(storage, run.runId, { hookId, token: `dispose-${Date.now()}` });

      const received = await storage.events.create(run.runId, {
        eventType: 'hook_received',
        specVersion: SPEC_VERSION_CURRENT,
        correlationId: hookId,
        eventData: { payload: { n: 1 } },
      });
      expect(received.event?.eventType).toBe('hook_received');

      await storage.events.create(run.runId, {
        eventType: 'hook_disposed',
        specVersion: SPEC_VERSION_CURRENT,
        correlationId: hookId,
      });

      await expect(
        storage.events.create(run.runId, {
          eventType: 'hook_received',
          specVersion: SPEC_VERSION_CURRENT,
          correlationId: hookId,
          eventData: { payload: { n: 2 } },
        })
      ).rejects.toSatisfy(HookNotFoundError.is);
    });
  });
}
