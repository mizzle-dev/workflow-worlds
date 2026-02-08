/**
 * In-Memory Storage Implementation (Event-Sourced)
 *
 * This implementation follows the Workflow 4.1 storage contract where
 * state mutations happen through events.create().
 */

import {
  RunNotSupportedError,
  WorkflowAPIError,
  WorkflowRunNotFoundError,
} from '@workflow/errors';
import {
  type AnyEventRequest,
  isLegacySpecVersion,
  requiresNewerWorld,
  SPEC_VERSION_CURRENT,
  type CreateEventParams,
  type GetHookParams,
  type GetStepParams,
  type GetWorkflowRunParams,
  type ListEventsByCorrelationIdParams,
  type ListEventsParams,
  type ListHooksParams,
  type ListWorkflowRunStepsParams,
  type ListWorkflowRunsParams,
  type Event,
  type EventResult,
  type Hook,
  type RunCreatedEventRequest,
  type Step,
  type Storage,
  type WorkflowRun,
} from '@workflow/world';
import { monotonicFactory } from 'ulid';

// Monotonic ULID factory ensures IDs are always increasing
const generateUlid = monotonicFactory();

/**
 * Deep clone an object to prevent accidental mutation of stored data.
 */
function deepClone<T>(obj: T): T {
  return structuredClone(obj);
}

/**
 * In-memory stores.
 */
interface Store {
  runs: Map<string, WorkflowRun>;
  steps: Map<string, Step>;
  events: Map<string, Event>;
  hooks: Map<string, Hook>;
  hookIdsByToken: Map<string, string>;
}

function stepKey(runId: string, stepId: string): string {
  return `${runId}:${stepId}`;
}

function isTerminalRunStatus(status: WorkflowRun['status']): boolean {
  return (
    status === 'completed' || status === 'failed' || status === 'cancelled'
  );
}

function isTerminalStepStatus(status: Step['status']): boolean {
  return status === 'completed' || status === 'failed';
}

/**
 * Filter helpers for resolveData option.
 */
function filterRunData(
  run: WorkflowRun,
  resolveData: 'none' | 'all' = 'all'
): WorkflowRun {
  const cloned = deepClone(run);
  if (resolveData === 'none') {
    return {
      ...cloned,
      input: undefined,
      output: undefined,
    } as WorkflowRun;
  }
  return cloned;
}

function filterStepData(step: Step, resolveData: 'none' | 'all' = 'all'): Step {
  const cloned = deepClone(step);
  if (resolveData === 'none') {
    return {
      ...cloned,
      input: undefined,
      output: undefined,
    } as Step;
  }
  return cloned;
}

function filterEventData(
  event: Event,
  resolveData: 'none' | 'all' = 'all'
): Event {
  const cloned = deepClone(event);
  if (resolveData === 'none' && 'eventData' in cloned) {
    delete (cloned as Record<string, unknown>).eventData;
  }
  return cloned;
}

function filterHookData(hook: Hook, resolveData: 'none' | 'all' = 'all'): Hook {
  const cloned = deepClone(hook);
  if (resolveData === 'none') {
    delete (cloned as Record<string, unknown>).metadata;
  }
  return cloned;
}

function paginate<T>(
  items: T[],
  getId: (item: T) => string,
  opts: {
    sortOrder?: 'asc' | 'desc';
    limit?: number;
    cursor?: string;
  },
  defaultSortOrder: 'asc' | 'desc',
  defaultLimit: number
): { data: T[]; cursor: string | null; hasMore: boolean } {
  const sortOrder = opts.sortOrder ?? defaultSortOrder;
  const limit = opts.limit ?? defaultLimit;
  const cursor = opts.cursor;

  const sorted = [...items].sort((a, b) => {
    const cmp = getId(a).localeCompare(getId(b));
    return sortOrder === 'asc' ? cmp : -cmp;
  });

  let windowed = sorted;
  if (cursor) {
    const idx = sorted.findIndex((item) => getId(item) === cursor);
    if (idx !== -1) {
      windowed = sorted.slice(idx + 1);
    }
  }

  const hasMore = windowed.length > limit;
  const data = windowed.slice(0, limit);
  const nextCursor = hasMore && data.length > 0 ? getId(data[data.length - 1]) : null;

  return {
    data,
    cursor: nextCursor,
    hasMore,
  };
}

function cleanupHooksForRun(store: Store, runId: string): void {
  for (const [hookId, hook] of store.hooks.entries()) {
    if (hook.runId === runId) {
      store.hooks.delete(hookId);
      store.hookIdsByToken.delete(hook.token);
    }
  }
}

function readStep(store: Store, runId: string, stepId: string): Step | undefined {
  return store.steps.get(stepKey(runId, stepId));
}

function writeStep(store: Store, step: Step): void {
  store.steps.set(stepKey(step.runId, step.stepId), step);
}

function resolveDataOption(params?: CreateEventParams): 'none' | 'all' {
  return params?.resolveData ?? 'all';
}

async function handleLegacyEvent(
  store: Store,
  runId: string,
  data: AnyEventRequest,
  currentRun: WorkflowRun,
  params?: CreateEventParams
): Promise<EventResult> {
  const resolveData = resolveDataOption(params);

  if (data.eventType === 'run_cancelled') {
    const now = new Date();
    const run: WorkflowRun = {
      ...currentRun,
      status: 'cancelled',
      output: undefined,
      error: undefined,
      completedAt: now,
      updatedAt: now,
    };
    store.runs.set(runId, run);
    cleanupHooksForRun(store, runId);
    return {
      event: undefined,
      run: filterRunData(run, resolveData),
    };
  }

  if (data.eventType === 'wait_completed' || data.eventType === 'hook_received') {
    const now = new Date();
    const event: Event = {
      ...data,
      runId,
      eventId: `evnt_${generateUlid()}`,
      createdAt: now,
      specVersion: SPEC_VERSION_CURRENT,
    } as Event;
    store.events.set(event.eventId, event);
    return {
      event: filterEventData(event, resolveData),
    };
  }

  throw new WorkflowAPIError(
    `Event '${data.eventType}' is not supported for legacy runs`,
    { status: 409 }
  );
}

/**
 * Creates the Storage implementation.
 */
export function createStorage(): Storage {
  const store: Store = {
    runs: new Map(),
    steps: new Map(),
    events: new Map(),
    hooks: new Map(),
    hookIdsByToken: new Map(),
  };

  const storage = {
    runs: {
      async get(id: string, params?: GetWorkflowRunParams) {
        const run = store.runs.get(id);
        if (!run) {
          throw new WorkflowRunNotFoundError(id);
        }
        return filterRunData(run, params?.resolveData);
      },

      async list(params?: ListWorkflowRunsParams) {
        const allRuns = Array.from(store.runs.values());

        const filtered = allRuns.filter((run) => {
          if (params?.workflowName && run.workflowName !== params.workflowName) {
            return false;
          }
          if (params?.status && run.status !== params.status) {
            return false;
          }
          return true;
        });

        const page = paginate(
          filtered,
          (run) => run.runId,
          {
            sortOrder: params?.pagination?.sortOrder,
            limit: params?.pagination?.limit,
            cursor: params?.pagination?.cursor,
          },
          'desc',
          100
        );

        return {
          data: page.data.map((run) => filterRunData(run, params?.resolveData)),
          cursor: page.cursor,
          hasMore: page.hasMore,
        };
      },
    },

    steps: {
      async get(runId: string | undefined, stepId: string, params?: GetStepParams) {
        let found: Step | undefined;

        if (runId) {
          found = readStep(store, runId, stepId);
        } else {
          for (const step of store.steps.values()) {
            if (step.stepId === stepId) {
              found = step;
              break;
            }
          }
        }

        if (!found) {
          throw new WorkflowAPIError(`Step not found: ${stepId}`, { status: 404 });
        }

        return filterStepData(found, params?.resolveData);
      },

      async list(params: ListWorkflowRunStepsParams) {
        const stepsForRun = Array.from(store.steps.values()).filter(
          (step) => step.runId === params.runId
        );

        const page = paginate(
          stepsForRun,
          (step) => step.stepId,
          {
            sortOrder: params.pagination?.sortOrder,
            limit: params.pagination?.limit,
            cursor: params.pagination?.cursor,
          },
          'desc',
          100
        );

        return {
          data: page.data.map((step) => filterStepData(step, params.resolveData)),
          cursor: page.cursor,
          hasMore: page.hasMore,
        };
      },
    },

    events: {
      async create(
        runId: string | null,
        data: AnyEventRequest,
        params?: CreateEventParams
      ) {
        const resolveData = resolveDataOption(params);
        const now = new Date();
        const eventId = `evnt_${generateUlid()}`;
        const effectiveSpecVersion = data.specVersion ?? SPEC_VERSION_CURRENT;

        let effectiveRunId: string;
        if (data.eventType === 'run_created') {
          effectiveRunId = runId ?? `wrun_${generateUlid()}`;
        } else {
          if (!runId) {
            throw new WorkflowAPIError('runId is required for non run_created events', {
              status: 400,
            });
          }
          effectiveRunId = runId;
        }

        const currentRun = store.runs.get(effectiveRunId);

        if (currentRun) {
          if (requiresNewerWorld(currentRun.specVersion)) {
            throw new RunNotSupportedError(
              currentRun.specVersion as number,
              SPEC_VERSION_CURRENT
            );
          }

          if (isLegacySpecVersion(currentRun.specVersion)) {
            return handleLegacyEvent(store, effectiveRunId, data, currentRun, params);
          }

          if (isTerminalRunStatus(currentRun.status)) {
            const runTerminalEvents = new Set([
              'run_started',
              'run_completed',
              'run_failed',
              'run_cancelled',
            ]);

            if (
              data.eventType === 'run_cancelled' &&
              currentRun.status === 'cancelled'
            ) {
              const event: Event = {
                ...data,
                runId: effectiveRunId,
                eventId,
                createdAt: now,
                specVersion: effectiveSpecVersion,
              } as Event;
              store.events.set(eventId, event);
              return {
                event: filterEventData(event, resolveData),
                run: deepClone(currentRun),
              };
            }

            if (runTerminalEvents.has(data.eventType)) {
              throw new WorkflowAPIError(
                `Cannot transition run from terminal state '${currentRun.status}'`,
                { status: 409 }
              );
            }

            if (data.eventType === 'step_created' || data.eventType === 'hook_created') {
              throw new WorkflowAPIError(
                `Cannot create entities on terminal run '${currentRun.status}'`,
                { status: 409 }
              );
            }
          }
        }

        if (!currentRun && data.eventType !== 'run_created') {
          throw new WorkflowAPIError(`Run not found: ${effectiveRunId}`, {
            status: 404,
          });
        }

        let validatedStep: Step | undefined;
        const stepLifecycleEvents = new Set([
          'step_started',
          'step_completed',
          'step_failed',
          'step_retrying',
        ]);

        if (stepLifecycleEvents.has(data.eventType)) {
          if (!data.correlationId) {
            throw new WorkflowAPIError('Step events require correlationId', {
              status: 400,
            });
          }

          validatedStep = readStep(store, effectiveRunId, data.correlationId);
          if (!validatedStep) {
            throw new WorkflowAPIError(`Step '${data.correlationId}' not found`, {
              status: 404,
            });
          }

          if (isTerminalStepStatus(validatedStep.status)) {
            throw new WorkflowAPIError(
              `Cannot modify step in terminal state '${validatedStep.status}'`,
              { status: 409 }
            );
          }

          if (currentRun && isTerminalRunStatus(currentRun.status) && validatedStep.status !== 'running') {
            throw new WorkflowAPIError(
              `Cannot modify non-running step on terminal run '${currentRun.status}'`,
              { status: 410 }
            );
          }
        }

        if ((data.eventType === 'hook_received' || data.eventType === 'hook_disposed') && data.correlationId) {
          const existingHook = store.hooks.get(data.correlationId);
          if (!existingHook) {
            throw new WorkflowAPIError(`Hook '${data.correlationId}' not found`, {
              status: 404,
            });
          }
        }

        const baseEvent: Event = {
          ...data,
          runId: effectiveRunId,
          eventId,
          createdAt: now,
          specVersion: effectiveSpecVersion,
        } as Event;

        let run: WorkflowRun | undefined;
        let step: Step | undefined;
        let hook: Hook | undefined;

        if (data.eventType === 'run_created') {
          const runData = (data as RunCreatedEventRequest).eventData;
          run = {
            runId: effectiveRunId,
            deploymentId: runData.deploymentId,
            workflowName: runData.workflowName,
            status: 'pending',
            specVersion: effectiveSpecVersion,
            executionContext: runData.executionContext,
            input: runData.input,
            output: undefined,
            error: undefined,
            startedAt: undefined,
            completedAt: undefined,
            createdAt: now,
            updatedAt: now,
          };
          store.runs.set(run.runId, run);
        } else if (data.eventType === 'run_started') {
          if (!currentRun) {
            throw new WorkflowAPIError(`Run not found: ${effectiveRunId}`, { status: 404 });
          }
          run = {
            ...currentRun,
            status: 'running',
            startedAt: currentRun.startedAt ?? now,
            output: undefined,
            error: undefined,
            completedAt: undefined,
            updatedAt: now,
          };
          store.runs.set(run.runId, run);
        } else if (data.eventType === 'run_completed') {
          if (!currentRun) {
            throw new WorkflowAPIError(`Run not found: ${effectiveRunId}`, { status: 404 });
          }
          run = {
            ...currentRun,
            status: 'completed',
            output: data.eventData?.output,
            error: undefined,
            completedAt: now,
            updatedAt: now,
          };
          store.runs.set(run.runId, run);
          cleanupHooksForRun(store, run.runId);
        } else if (data.eventType === 'run_failed') {
          if (!currentRun) {
            throw new WorkflowAPIError(`Run not found: ${effectiveRunId}`, { status: 404 });
          }
          run = {
            ...currentRun,
            status: 'failed',
            output: undefined,
            error: {
              message:
                typeof data.eventData.error === 'string'
                  ? data.eventData.error
                  : (data.eventData.error?.message ?? 'Unknown error'),
              stack:
                data.eventData.error?.stack,
              code: data.eventData.errorCode,
            },
            completedAt: now,
            updatedAt: now,
          };
          store.runs.set(run.runId, run);
          cleanupHooksForRun(store, run.runId);
        } else if (data.eventType === 'run_cancelled') {
          if (!currentRun) {
            throw new WorkflowAPIError(`Run not found: ${effectiveRunId}`, { status: 404 });
          }
          run = {
            ...currentRun,
            status: 'cancelled',
            output: undefined,
            error: undefined,
            completedAt: now,
            updatedAt: now,
          };
          store.runs.set(run.runId, run);
          cleanupHooksForRun(store, run.runId);
        } else if (data.eventType === 'step_created') {
          if (!data.correlationId) {
            throw new WorkflowAPIError('Step events require correlationId', {
              status: 400,
            });
          }
          const existingStep = readStep(store, effectiveRunId, data.correlationId);
          if (existingStep) {
            throw new WorkflowAPIError(`Step '${data.correlationId}' already exists`, {
              status: 409,
            });
          }
          step = {
            runId: effectiveRunId,
            stepId: data.correlationId,
            stepName: data.eventData.stepName,
            status: 'pending',
            input: data.eventData.input,
            output: undefined,
            error: undefined,
            attempt: 0,
            startedAt: undefined,
            completedAt: undefined,
            createdAt: now,
            updatedAt: now,
            retryAfter: undefined,
            specVersion: effectiveSpecVersion,
          };
          writeStep(store, step);
        } else if (data.eventType === 'step_started') {
          if (!validatedStep || !data.correlationId) {
            throw new WorkflowAPIError('Step not found for step_started', { status: 404 });
          }

          if (
            validatedStep.retryAfter &&
            validatedStep.retryAfter.getTime() > Date.now()
          ) {
            const err = new WorkflowAPIError(
              `Cannot start step '${data.correlationId}' before retryAfter`,
              { status: 425 }
            );
            (err as WorkflowAPIError & { meta?: Record<string, string> }).meta = {
              stepId: data.correlationId,
              retryAfter: validatedStep.retryAfter.toISOString(),
            };
            throw err;
          }

          step = {
            ...validatedStep,
            status: 'running',
            startedAt: validatedStep.startedAt ?? now,
            attempt: validatedStep.attempt + 1,
            retryAfter: undefined,
            updatedAt: now,
          };
          writeStep(store, step);
        } else if (data.eventType === 'step_completed') {
          if (!validatedStep) {
            throw new WorkflowAPIError('Step not found for step_completed', { status: 404 });
          }

          step = {
            ...validatedStep,
            status: 'completed',
            output: data.eventData.result,
            completedAt: now,
            updatedAt: now,
          };
          writeStep(store, step);
        } else if (data.eventType === 'step_failed') {
          if (!validatedStep) {
            throw new WorkflowAPIError('Step not found for step_failed', { status: 404 });
          }

          step = {
            ...validatedStep,
            status: 'failed',
            error: {
              message:
                typeof data.eventData.error === 'string'
                  ? data.eventData.error
                  : (data.eventData.error?.message ?? 'Unknown error'),
              stack: data.eventData.stack,
            },
            completedAt: now,
            updatedAt: now,
          };
          writeStep(store, step);
        } else if (data.eventType === 'step_retrying') {
          if (!validatedStep) {
            throw new WorkflowAPIError('Step not found for step_retrying', { status: 404 });
          }

          step = {
            ...validatedStep,
            status: 'pending',
            error: {
              message:
                typeof data.eventData.error === 'string'
                  ? data.eventData.error
                  : (data.eventData.error?.message ?? 'Unknown error'),
              stack: data.eventData.stack,
            },
            retryAfter: data.eventData.retryAfter,
            updatedAt: now,
          };
          writeStep(store, step);
        } else if (data.eventType === 'hook_created') {
          const existingHookId = store.hookIdsByToken.get(data.eventData.token);
          if (existingHookId) {
            const conflictEvent: Event = {
              eventType: 'hook_conflict',
              correlationId: data.correlationId,
              eventData: {
                token: data.eventData.token,
              },
              runId: effectiveRunId,
              eventId,
              createdAt: now,
              specVersion: effectiveSpecVersion,
            } as Event;
            store.events.set(conflictEvent.eventId, conflictEvent);
            return {
              event: filterEventData(conflictEvent, resolveData),
              run,
              step,
              hook: undefined,
            };
          }

          hook = {
            runId: effectiveRunId,
            hookId: data.correlationId,
            token: data.eventData.token,
            metadata: data.eventData.metadata,
            ownerId: 'starter-owner',
            projectId: 'starter-project',
            environment: 'development',
            createdAt: now,
            specVersion: effectiveSpecVersion,
          };
          store.hooks.set(hook.hookId, hook);
          store.hookIdsByToken.set(hook.token, hook.hookId);
        } else if (data.eventType === 'hook_disposed') {
          if (data.correlationId) {
            const existingHook = store.hooks.get(data.correlationId);
            if (existingHook) {
              store.hooks.delete(existingHook.hookId);
              store.hookIdsByToken.delete(existingHook.token);
            }
          }
        }

        store.events.set(baseEvent.eventId, baseEvent);

        return {
          event: filterEventData(baseEvent, resolveData),
          run: run ? deepClone(run) : undefined,
          step: step ? deepClone(step) : undefined,
          hook: hook ? deepClone(hook) : undefined,
        };
      },

      async list(params: ListEventsParams) {
        const forRun = Array.from(store.events.values()).filter(
          (event) => event.runId === params.runId
        );

        const page = paginate(
          forRun,
          (event) => event.eventId,
          {
            sortOrder: params.pagination?.sortOrder,
            limit: params.pagination?.limit,
            cursor: params.pagination?.cursor,
          },
          'asc',
          10000
        );

        return {
          data: page.data.map((event) => filterEventData(event, params.resolveData)),
          cursor: page.cursor,
          hasMore: page.hasMore,
        };
      },

      async listByCorrelationId(params: ListEventsByCorrelationIdParams) {
        const matching = Array.from(store.events.values()).filter(
          (event) => event.correlationId === params.correlationId
        );

        const page = paginate(
          matching,
          (event) => event.eventId,
          {
            sortOrder: params.pagination?.sortOrder,
            limit: params.pagination?.limit,
            cursor: params.pagination?.cursor,
          },
          'asc',
          100
        );

        return {
          data: page.data.map((event) => filterEventData(event, params.resolveData)),
          cursor: page.cursor,
          hasMore: page.hasMore,
        };
      },
    },

    hooks: {
      async get(hookId: string, params?: GetHookParams) {
        const hook = store.hooks.get(hookId);
        if (!hook) {
          throw new WorkflowAPIError(`Hook not found: ${hookId}`, {
            status: 404,
          });
        }

        return filterHookData(hook, params?.resolveData);
      },

      async getByToken(token: string, params?: GetHookParams) {
        const hookId = store.hookIdsByToken.get(token);
        if (!hookId) {
          throw new WorkflowAPIError(`Hook not found for token: ${token}`, {
            status: 404,
          });
        }

        const hook = store.hooks.get(hookId);
        if (!hook) {
          throw new WorkflowAPIError(`Hook not found: ${hookId}`, {
            status: 404,
          });
        }

        return filterHookData(hook, params?.resolveData);
      },

      async list(params: ListHooksParams) {
        let hooks = Array.from(store.hooks.values());

        if (params.runId) {
          hooks = hooks.filter((hook) => hook.runId === params.runId);
        }

        const page = paginate(
          hooks,
          (hook) => hook.hookId,
          {
            sortOrder: params.pagination?.sortOrder,
            limit: params.pagination?.limit,
            cursor: params.pagination?.cursor,
          },
          'desc',
          100
        );

        return {
          data: page.data.map((hook) => filterHookData(hook, params.resolveData)),
          cursor: page.cursor,
          hasMore: page.hasMore,
        };
      },
    },
  };

  return storage as unknown as Storage;
}
