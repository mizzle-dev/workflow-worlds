/**
 * Event Sourcing Contract Test Suite
 *
 * Tests Workflow 5 event-sourcing invariants:
 * - event creation contract and guard rails
 * - resolveData='none' projection behavior
 * - legacy/future spec-version compatibility behavior
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import {
  SPEC_VERSION_CURRENT,
  SPEC_VERSION_LEGACY,
  SPEC_VERSION_MAX_SUPPORTED,
  type CreateEventRequest,
  type RunCreatedEventRequest,
  type Storage,
} from '@workflow/world';
import {
  EntityConflictError,
  HookNotFoundError,
  RunExpiredError,
  RunNotSupportedError,
  TooEarlyError,
} from '@workflow/errors';
import {
  cancelRun,
  completeRun,
  completeStep,
  createHook,
  createRun,
  createStep,
  retryStep,
} from './storage-compat.js';

export interface EventSourcingTestOptions {
  /**
   * Factory function to create a storage instance.
   */
  createStorage: () => Promise<{ storage: Storage; cleanup?: () => Promise<void> }>;
}

async function expectErrorStatus(
  promise: Promise<unknown>,
  expectedStatus: number,
  messagePattern?: RegExp
): Promise<void> {
  try {
    await promise;
    throw new Error(`Expected failure with status ${expectedStatus}`);
  } catch (error) {
    const err = error as { status?: number; message?: string };
    expect(err.status).toBe(expectedStatus);
    if (messagePattern) {
      expect(err.message ?? String(error)).toMatch(messagePattern);
    }
  }
}

/**
 * Workflow 5 classifies World errors by type rather than by status code:
 * the runtime matches them with each class's `is()`.
 */
async function expectErrorType(
  promise: Promise<unknown>,
  isType: (value: unknown) => boolean,
  messagePattern?: RegExp
): Promise<void> {
  let thrown: unknown;
  try {
    await promise;
  } catch (error) {
    thrown = error;
  }
  expect(thrown, 'expected the call to fail').toBeDefined();
  expect(isType(thrown), `unexpected error: ${String(thrown)}`).toBe(true);
  if (messagePattern) {
    expect((thrown as { message?: string }).message ?? String(thrown)).toMatch(messagePattern);
  }
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** A ULID for the current instant, which is what the runtime mints for run IDs. */
function ulidNow(): string {
  let time = Date.now();
  let timePart = '';
  for (let i = 0; i < 10; i++) {
    timePart = CROCKFORD[time % 32] + timePart;
    time = Math.floor(time / 32);
  }
  let randomPart = '';
  for (let i = 0; i < 16; i++) {
    randomPart += CROCKFORD[Math.floor(Math.random() * 32)];
  }
  return timePart + randomPart;
}

async function createRunWithSpecVersion(
  storage: Storage,
  specVersion: number
) {
  const result = await storage.events.create(
    null,
    {
      eventType: 'run_created',
      specVersion,
      eventData: {
        deploymentId: 'test-deployment',
        workflowName: 'event-sourcing-spec-run',
        input: [],
      },
    } satisfies RunCreatedEventRequest
  );

  if (!result.run) {
    throw new Error('run_created did not return a run entity');
  }

  return result.run;
}

/**
 * Creates the event sourcing contract test suite.
 */
export function eventSourcingTests(options: EventSourcingTestOptions) {
  describe('event sourcing contract', () => {
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

    describe('create contract guards', () => {
      test('accepts client-provided runId for run_created', async () => {
        const clientRunId = `wrun_${ulidNow()}`;
        const result = await storage.events.create(
          clientRunId as unknown as null,
          {
            eventType: 'run_created',
            specVersion: SPEC_VERSION_CURRENT,
            eventData: {
              deploymentId: 'test-deployment',
              workflowName: 'client-runid-test',
              input: [],
            },
          } satisfies RunCreatedEventRequest
        );
        expect(result.run).toBeDefined();
        expect(result.run!.runId).toBe(clientRunId);
      });

      test('requires runId for non run_created events', async () => {
        await expectErrorStatus(
          storage.events.create(
            null as unknown as string,
            {
              eventType: 'run_started',
              specVersion: SPEC_VERSION_CURRENT,
            } as unknown as CreateEventRequest
          ),
          400,
          /runId is required/i
        );
      });

      test('requires correlationId for step lifecycle events', async () => {
        const run = await createRun(storage, {
          deploymentId: 'test-deployment',
          workflowName: 'missing-correlation-id',
          input: [],
        });

        await expectErrorStatus(
          storage.events.create(
            run.runId,
            {
              eventType: 'step_started',
              specVersion: SPEC_VERSION_CURRENT,
            } as unknown as CreateEventRequest
          ),
          400,
          /correlationId/i
        );
      });
    });

    describe('terminal state guards', () => {
      test('supports idempotent run_cancelled on cancelled runs', async () => {
        const run = await createRun(storage, {
          deploymentId: 'test-deployment',
          workflowName: 'idempotent-cancel',
          input: [],
        });

        await cancelRun(storage, run.runId);
        const secondCancel = await storage.events.create(run.runId, {
          eventType: 'run_cancelled',
          specVersion: SPEC_VERSION_CURRENT,
        });

        expect(secondCancel.run?.status).toBe('cancelled');
        expect(secondCancel.event?.eventType).toBe('run_cancelled');
      });

      test('rejects run transitions after terminal completion', async () => {
        const run = await createRun(storage, {
          deploymentId: 'test-deployment',
          workflowName: 'terminal-run-transition',
          input: [],
        });

        await completeRun(storage, run.runId, { ok: true });

        await expectErrorType(
          storage.events.create(run.runId, {
            eventType: 'run_started',
            specVersion: SPEC_VERSION_CURRENT,
          }),
          RunExpiredError.is,
          /terminal state/i
        );

        await expectErrorType(
          storage.events.create(run.runId, {
            eventType: 'run_completed',
            specVersion: SPEC_VERSION_CURRENT,
            eventData: { output: { again: true } },
          }),
          EntityConflictError.is,
          /terminal state/i
        );
      });

      test('rejects step/hook creation on terminal runs', async () => {
        const run = await createRun(storage, {
          deploymentId: 'test-deployment',
          workflowName: 'terminal-entity-creation',
          input: [],
        });

        await completeRun(storage, run.runId, { done: true });

        await expectErrorType(
          storage.events.create(run.runId, {
            eventType: 'step_created',
            specVersion: SPEC_VERSION_CURRENT,
            correlationId: `wstep_terminal-${Date.now()}`,
            eventData: { stepName: 'step', input: [] },
          }),
          EntityConflictError.is,
          /terminal run/i
        );

        await expectErrorType(
          storage.events.create(run.runId, {
            eventType: 'hook_created',
            specVersion: SPEC_VERSION_CURRENT,
            correlationId: `whook_terminal-${Date.now()}`,
            eventData: { token: `terminal-hook-${Date.now()}`, metadata: {} },
          }),
          EntityConflictError.is,
          /terminal run/i
        );
      });

      test('rejects mutating terminal steps', async () => {
        const run = await createRun(storage, {
          deploymentId: 'test-deployment',
          workflowName: 'terminal-step-mutation',
          input: [],
        });
        const stepId = `wstep_terminal-mutation-${Date.now()}`;

        await createStep(storage, run.runId, {
          stepId,
          stepName: 'terminalStep',
          input: [],
        });
        await completeStep(storage, run.runId, stepId, { done: true });

        await expectErrorType(
          storage.events.create(run.runId, {
            eventType: 'step_started',
            specVersion: SPEC_VERSION_CURRENT,
            correlationId: stepId,
            eventData: {},
          }),
          EntityConflictError.is,
          /terminal state/i
        );
      });

      test('refuses step_started on a terminal run even when the step is running', async () => {
        const run = await createRun(storage, {
          deploymentId: 'test-deployment',
          workflowName: 'terminal-run-step-start',
          input: [],
        });
        const stepId = `wstep_terminal-run-start-${Date.now()}`;

        await createStep(storage, run.runId, {
          stepId,
          stepName: 'inFlightStep',
          input: [],
        });
        await storage.events.create(run.runId, {
          eventType: 'step_started',
          specVersion: SPEC_VERSION_CURRENT,
          correlationId: stepId,
        });
        await cancelRun(storage, run.runId);

        // A redelivered start of a step that is still `running`.
        await expectErrorType(
          storage.events.create(run.runId, {
            eventType: 'step_started',
            specVersion: SPEC_VERSION_CURRENT,
            correlationId: stepId,
          }),
          RunExpiredError.is
        );

        // The step already in flight may still record its outcome.
        const completed = await completeStep(storage, run.runId, stepId, { late: true });
        expect(completed?.status).toBe('completed');
      });

      test('enforces retryAfter gate with TooEarlyError', async () => {
        const run = await createRun(storage, {
          deploymentId: 'test-deployment',
          workflowName: 'retry-after-gate',
          input: [],
        });
        const stepId = `wstep_retry-after-${Date.now()}`;

        await createStep(storage, run.runId, {
          stepId,
          stepName: 'retryStep',
          input: [],
        });

        const retryAfter = new Date(Date.now() + 60_000);
        await retryStep(
          storage,
          run.runId,
          stepId,
          { message: 'retry later' },
          retryAfter
        );

        await expectErrorType(
          storage.events.create(run.runId, {
            eventType: 'step_started',
            specVersion: SPEC_VERSION_CURRENT,
            correlationId: stepId,
            eventData: {},
          }),
          TooEarlyError.is,
          /retryAfter/i
        );
      });

      test('requires existing hook for hook_disposed', async () => {
        const run = await createRun(storage, {
          deploymentId: 'test-deployment',
          workflowName: 'missing-hook-dispose',
          input: [],
        });

        await expectErrorType(
          storage.events.create(run.runId, {
            eventType: 'hook_disposed',
            specVersion: SPEC_VERSION_CURRENT,
            correlationId: `whook_missing-${Date.now()}`,
          }),
          HookNotFoundError.is,
          /hook/i
        );
      });
    });

    describe('resolveData=none', () => {
      test('redacts run input/output/error', async () => {
        const run = await createRun(storage, {
          deploymentId: 'test-deployment',
          workflowName: 'resolve-data-run',
          input: [{ important: 'secret' }],
        });
        await completeRun(storage, run.runId, { result: 123 });

        const redacted = await storage.runs.get(run.runId, { resolveData: 'none' });
        expect((redacted as { input?: unknown }).input).toBeUndefined();
        expect((redacted as { output?: unknown }).output).toBeUndefined();
        expect((redacted as { error?: unknown }).error).toBeUndefined();
      });

      test('redacts step input/output/error', async () => {
        const run = await createRun(storage, {
          deploymentId: 'test-deployment',
          workflowName: 'resolve-data-step',
          input: [],
        });
        const stepId = `wstep_resolve-${Date.now()}`;

        await createStep(storage, run.runId, {
          stepId,
          stepName: 'resolveStep',
          input: [{ input: 'secret' }],
        });
        await completeStep(storage, run.runId, stepId, [{ output: 'secret' }]);

        const redacted = await storage.steps.get(run.runId, stepId, { resolveData: 'none' });
        expect((redacted as { input?: unknown }).input).toBeUndefined();
        expect((redacted as { output?: unknown }).output).toBeUndefined();
        expect((redacted as { error?: unknown }).error).toBeUndefined();
      });

      test('redacts hook metadata and eventData', async () => {
        const run = await createRun(storage, {
          deploymentId: 'test-deployment',
          workflowName: 'resolve-data-hook-event',
          input: [],
        });
        const token = `resolve-token-${Date.now()}`;
        const waitCorrelationId = `wait-${Date.now()}`;

        await createHook(storage, run.runId, {
          hookId: `whook_resolve-${Date.now()}`,
          token,
          metadata: { apiKey: 'secret' },
        });

        await storage.events.create(run.runId, {
          eventType: 'wait_created',
          specVersion: SPEC_VERSION_CURRENT,
          correlationId: waitCorrelationId,
          eventData: {
            resumeAt: new Date(Date.now() + 1_000),
          },
        });

        const redactedHook = await storage.hooks.getByToken(token, { resolveData: 'none' });
        expect((redactedHook as { metadata?: unknown }).metadata).toBeUndefined();

        const redactedEvents = await storage.events.list({
          runId: run.runId,
          resolveData: 'none',
        });
        const waitEvent = redactedEvents.data.find(
          (event) => event.correlationId === waitCorrelationId
        ) as { eventData?: unknown } | undefined;

        expect(waitEvent).toBeDefined();
        expect(waitEvent?.eventData).toBeUndefined();
      });
    });

    describe('legacy/future spec behavior', () => {
      test('supports only legacy-allowed events', async () => {
        const run = await createRunWithSpecVersion(storage, SPEC_VERSION_LEGACY);

        const waitCompleted = await storage.events.create(run.runId, {
          eventType: 'wait_completed',
          specVersion: SPEC_VERSION_CURRENT,
          correlationId: `legacy-wait-${Date.now()}`,
        });
        expect(waitCompleted.event?.eventType).toBe('wait_completed');

        const hookReceived = await storage.events.create(run.runId, {
          eventType: 'hook_received',
          specVersion: SPEC_VERSION_CURRENT,
          correlationId: `legacy-hook-${Date.now()}`,
          eventData: { payload: { ok: true } },
        });
        expect(hookReceived.event?.eventType).toBe('hook_received');

        await expectErrorType(
          storage.events.create(run.runId, {
            eventType: 'run_completed',
            specVersion: SPEC_VERSION_CURRENT,
            eventData: { output: { done: true } },
          }),
          EntityConflictError.is,
          /not supported for legacy runs/i
        );

        const cancelled = await storage.events.create(run.runId, {
          eventType: 'run_cancelled',
          specVersion: SPEC_VERSION_CURRENT,
        });
        expect(cancelled.run?.status).toBe('cancelled');
      });

      test('rejects events for future spec runs with RunNotSupportedError', async () => {
        const run = await createRunWithSpecVersion(storage, SPEC_VERSION_MAX_SUPPORTED + 1);

        try {
          await storage.events.create(run.runId, {
            eventType: 'run_started',
            specVersion: SPEC_VERSION_CURRENT,
          });
          throw new Error('Expected RunNotSupportedError');
        } catch (error) {
          expect(RunNotSupportedError.is(error)).toBe(true);
        }
      });
    });
  });
}
