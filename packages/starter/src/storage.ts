/**
 * In-Memory Storage Implementation (Event-Sourced)
 *
 * This implementation follows the Workflow 5 storage contract: state
 * mutations happen through events.create(), and an event's ID is its
 * position in its run's log (`evnt_` + a zero-padded, 1-based slot).
 *
 * Every create validates, mutates, and appends its event without awaiting in
 * between. JavaScript runs that stretch to completion, so in this in-memory
 * store each create is atomic, and the next position is simply the log's
 * length + 1.
 *
 * TODO: When you move to a real database, the decision and the writes must
 * stay atomic there too. Allocate the event's position in the same operation
 * that commits it, and let the store settle races for a position (a unique
 * key on (runId, eventId), a conditional write, or a transaction). See
 * https://workflow.dev/worlds/building-a-world.
 */

import {
  EntityConflictError,
  HookNotFoundError,
  RunExpiredError,
  RunNotSupportedError,
  TooEarlyError,
  WorkflowRunNotFoundError,
  WorkflowWorldError,
} from '@workflow/errors';
import {
  ATTRIBUTE_MAX_PER_RUN,
  AttributeValidationError,
  applyAttributeChanges,
  entityResolveData,
  FIRST_EVENT_SLOT,
  isChildEntityCreationEvent,
  isLegacySpecVersion,
  isTerminalRunEventType,
  isTerminalStepStatus,
  isTerminalWorkflowRunStatus,
  requiresNewerWorld,
  SPEC_VERSION_CURRENT,
  slotToEventId,
  stripEventDataRefs,
  validateAttributeChanges,
  validateUlidTimestamp,
  type AnyEventRequest,
  type CreateEventParams,
  type Event,
  type EventResult,
  type EventsResolveData,
  type GetHookParams,
  type GetStepParams,
  type GetWorkflowRunParams,
  type Hook,
  type ListEventsByCorrelationIdParams,
  type ListEventsParams,
  type ListHooksParams,
  type ListWorkflowRunStepsParams,
  type ListWorkflowRunsParams,
  type ResolveData,
  type Step,
  type Storage,
  type Wait,
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
  /** Each run's log, in position order: index i holds position i + 1. */
  events: Map<string, Event[]>;
  hooks: Map<string, Hook>;
  hookIdsByToken: Map<string, string>;
  waits: Map<string, Wait>;
}

function entityKey(runId: string, id: string): string {
  return `${runId}:${id}`;
}

function filterRun(run: WorkflowRun, resolveData: ResolveData = 'all'): WorkflowRun {
  const cloned = deepClone(run);
  if (resolveData === 'none') {
    return { ...cloned, input: undefined, output: undefined } as WorkflowRun;
  }
  return cloned;
}

function filterStep(step: Step, resolveData: ResolveData = 'all'): Step {
  const cloned = deepClone(step);
  if (resolveData === 'none') {
    return { ...cloned, input: undefined, output: undefined } as Step;
  }
  return cloned;
}

function filterEvent(event: Event, resolveData: EventsResolveData = 'all'): Event {
  const cloned = deepClone(event);
  if (resolveData === 'none') {
    const { eventData: _eventData, ...rest } = cloned as Event & { eventData?: unknown };
    return rest as Event;
  }
  return stripEventDataRefs(cloned, resolveData);
}

function filterHook(hook: Hook, resolveData: ResolveData = 'all'): Hook {
  const cloned = deepClone(hook);
  if (resolveData === 'none') {
    delete (cloned as Record<string, unknown>).metadata;
  }
  return cloned;
}

function page<T>(
  items: T[],
  idOf: (item: T) => string,
  pagination: { limit?: number; cursor?: string; sortOrder?: 'asc' | 'desc' } | undefined,
  defaults: { limit: number; sortOrder: 'asc' | 'desc' }
): { data: T[]; cursor: string | null; hasMore: boolean } {
  const sortOrder = pagination?.sortOrder ?? defaults.sortOrder;
  const limit = pagination?.limit ?? defaults.limit;
  const sorted = [...items].sort((a, b) =>
    sortOrder === 'asc' ? idOf(a).localeCompare(idOf(b)) : idOf(b).localeCompare(idOf(a))
  );
  const cursor = pagination?.cursor;
  const start = cursor
    ? sorted.findIndex((item) =>
        sortOrder === 'asc' ? idOf(item) > cursor : idOf(item) < cursor
      )
    : 0;
  const rest = start === -1 ? [] : sorted.slice(start);
  const data = rest.slice(0, limit);
  const hasMore = rest.length > limit;
  return { data, cursor: hasMore ? idOf(data[data.length - 1]) : null, hasMore };
}

/**
 * Creates the Storage implementation.
 *
 * TODO: Replace the in-memory Maps with your database client.
 */
export function createStorage(): Storage {
  const store: Store = {
    runs: new Map(),
    steps: new Map(),
    events: new Map(),
    hooks: new Map(),
    hookIdsByToken: new Map(),
    waits: new Map(),
  };

  /** Appends an event at the run's next position. */
  function append(runId: string, body: Record<string, unknown>): Event {
    let log = store.events.get(runId);
    if (!log) {
      log = [];
      store.events.set(runId, log);
    }
    const event = {
      ...body,
      runId,
      eventId: slotToEventId(FIRST_EVENT_SLOT + log.length),
    } as Event;
    log.push(event);
    return event;
  }

  /**
   * The report half of bump-and-report: the events occupying the positions
   * between the one the writer expected (`eventCount + 1`) and the one its
   * write landed on.
   */
  function skipped(
    runId: string,
    committed: Event,
    eventCount: number | undefined,
    resolveData: EventsResolveData
  ): { events: Event[]; cursor: null; hasMore: false } | undefined {
    if (eventCount === undefined) return undefined;
    const log = store.events.get(runId) ?? [];
    const committedIndex = log.indexOf(committed);
    if (committedIndex <= eventCount) return undefined;
    return {
      events: log.slice(eventCount, committedIndex).map((event) => filterEvent(event, resolveData)),
      cursor: null,
      hasMore: false,
    };
  }

  function dropRunHooksAndWaits(runId: string): void {
    for (const [hookId, hook] of store.hooks.entries()) {
      if (hook.runId === runId) {
        store.hooks.delete(hookId);
        store.hookIdsByToken.delete(hook.token);
      }
    }
    for (const [key, wait] of store.waits.entries()) {
      if (wait.runId === runId) store.waits.delete(key);
    }
  }

  /**
   * Pre-event-sourcing runs (spec version 1) accept only the events an old
   * runtime may still send them: cancellation and wake-ups.
   */
  function handleLegacyEvent(
    run: WorkflowRun,
    data: AnyEventRequest,
    resolveData: EventsResolveData
  ): EventResult {
    const now = new Date();
    if (data.eventType === 'run_cancelled') {
      const cancelled = { ...run, status: 'cancelled', completedAt: now, updatedAt: now } as WorkflowRun;
      store.runs.set(run.runId, cancelled);
      dropRunHooksAndWaits(run.runId);
      return { run: filterRun(cancelled, entityResolveData(resolveData)) };
    }
    if (data.eventType === 'wait_completed' || data.eventType === 'hook_received') {
      const event = append(run.runId, {
        eventType: data.eventType,
        correlationId: data.correlationId,
        eventData: 'eventData' in data ? data.eventData : undefined,
        specVersion: data.specVersion ?? SPEC_VERSION_CURRENT,
        createdAt: now,
      });
      return { event: filterEvent(event, resolveData) };
    }
    throw new EntityConflictError(`Event '${data.eventType}' is not supported for legacy runs`);
  }

  function createRun(
    runId: string,
    eventData: {
      deploymentId: string;
      workflowName: string;
      input: unknown;
      executionContext?: Record<string, unknown>;
      attributes?: Record<string, string>;
      allowReservedAttributes?: true;
      encryptionPublicKey?: string;
    },
    specVersion: number,
    correlationId: string | undefined,
    now: Date
  ): { run: WorkflowRun; event: Event } {
    validateAttributeChanges(
      Object.entries(eventData.attributes ?? {}).map(([key, value]) => ({ key, value })),
      { allowReservedAttributes: eventData.allowReservedAttributes === true }
    );
    if (store.runs.has(runId)) {
      throw new EntityConflictError(`Workflow run "${runId}" already exists`);
    }
    const run = {
      runId,
      deploymentId: eventData.deploymentId,
      workflowName: eventData.workflowName,
      status: 'pending',
      specVersion,
      executionContext: eventData.executionContext,
      input: eventData.input,
      attributes: eventData.attributes ?? {},
      createdAt: now,
      updatedAt: now,
    } as WorkflowRun;
    store.runs.set(runId, run);
    const event = append(runId, {
      eventType: 'run_created',
      correlationId,
      eventData,
      specVersion,
      createdAt: now,
    });
    return { run, event };
  }

  async function createEvent(
    runId: string | null,
    data: AnyEventRequest,
    params?: CreateEventParams
  ): Promise<EventResult> {
    const resolveData: EventsResolveData = params?.resolveData ?? 'all';
    const entityRD = entityResolveData(resolveData);
    const specVersion = data.specVersion ?? SPEC_VERSION_CURRENT;
    const now = new Date();

    if (data.eventType === 'run_created') {
      const effectiveRunId = runId || `wrun_${generateUlid()}`;
      if (runId) {
        const validationError = validateUlidTimestamp(effectiveRunId, 'wrun_');
        if (validationError) throw new WorkflowWorldError(validationError, { status: 400 });
      }
      const {
        dynamicWorkflowCode: _dynamicWorkflowCode,
        dynamicWorkflowCodeRef: _dynamicWorkflowCodeRef,
        ...eventData
      } = data.eventData;
      const { run, event } = createRun(effectiveRunId, eventData, specVersion, data.correlationId, now);
      return { event: filterEvent(event, resolveData), run: filterRun(run, entityRD) };
    }

    if (!runId) {
      throw new WorkflowWorldError('runId is required for non-run_created events', { status: 400 });
    }
    if (
      (data.eventType.startsWith('step_') ||
        data.eventType.startsWith('hook_') ||
        data.eventType.startsWith('wait_')) &&
      !data.correlationId
    ) {
      throw new WorkflowWorldError(`${data.eventType} requires a correlationId`, { status: 400 });
    }

    // Resilient start: a run_started for a run whose run_created never landed
    // carries what it takes to create the run here.
    if (data.eventType === 'run_started' && !store.runs.has(runId) && data.eventData) {
      const startData = data.eventData;
      if (startData.deploymentId && startData.workflowName && startData.input !== undefined) {
        createRun(
          runId,
          {
            deploymentId: startData.deploymentId,
            workflowName: startData.workflowName,
            input: startData.input,
            executionContext: startData.executionContext,
            attributes: startData.attributes,
            allowReservedAttributes: startData.allowReservedAttributes,
            encryptionPublicKey: startData.encryptionPublicKey,
          },
          specVersion,
          undefined,
          now
        );
      }
    }

    const currentRun = store.runs.get(runId);
    if (!currentRun) throw new WorkflowRunNotFoundError(runId);
    if (requiresNewerWorld(currentRun.specVersion)) {
      throw new RunNotSupportedError(currentRun.specVersion!, SPEC_VERSION_CURRENT);
    }
    if (isLegacySpecVersion(currentRun.specVersion)) {
      return handleLegacyEvent(currentRun, data, resolveData);
    }

    const runIsTerminal = isTerminalWorkflowRunStatus(currentRun.status);
    const lazyStepStart = data.eventType === 'step_started' && isChildEntityCreationEvent(data);
    const body: Record<string, unknown> = {
      eventType: data.eventType,
      correlationId: data.correlationId,
      eventData: 'eventData' in data ? deepClone(data.eventData) : undefined,
      specVersion,
      createdAt: now,
    };
    const finish = (event: Event, entities: Omit<EventResult, 'event'> = {}): EventResult =>
      ({
        ...entities,
        event: filterEvent(event, resolveData),
        ...(skipped(runId, event, params?.eventCount, resolveData) ?? {}),
      }) as EventResult;

    // =========================================================================
    // Terminal run guards
    // =========================================================================
    if (runIsTerminal) {
      if (data.eventType === 'run_cancelled' && currentRun.status === 'cancelled') {
        return finish(append(runId, body), { run: filterRun(currentRun, entityRD) });
      }
      if (data.eventType === 'run_started') {
        throw new RunExpiredError(
          `Workflow run "${runId}" is already in terminal state "${currentRun.status}"`,
          runId,
          currentRun.status
        );
      }
      if (isTerminalRunEventType(data.eventType)) {
        throw new EntityConflictError(
          `Cannot transition run from terminal state "${currentRun.status}"`
        );
      }
      if (
        data.eventType === 'step_created' ||
        data.eventType === 'hook_created' ||
        data.eventType === 'wait_created' ||
        lazyStepStart
      ) {
        throw new EntityConflictError(
          `Cannot create new entities on terminal run in state "${currentRun.status}"`
        );
      }
      if (data.eventType === 'attr_set') {
        throw new EntityConflictError(
          `Cannot set attributes on run in terminal state "${currentRun.status}"`
        );
      }
    }

    switch (data.eventType) {
      // =======================================================================
      // Run lifecycle
      // =======================================================================
      case 'run_started': {
        if (currentRun.status === 'running') {
          return { run: filterRun(currentRun, entityRD) } as EventResult;
        }
        const run = {
          ...currentRun,
          status: 'running',
          startedAt: currentRun.startedAt ?? now,
          updatedAt: now,
        } as WorkflowRun;
        store.runs.set(runId, run);
        return finish(append(runId, { ...body, eventData: undefined }), {
          run: filterRun(run, entityRD),
        });
      }

      case 'run_completed':
      case 'run_failed':
      case 'run_cancelled': {
        const run = { ...currentRun, completedAt: now, updatedAt: now } as WorkflowRun;
        if (data.eventType === 'run_completed') {
          Object.assign(run, { status: 'completed', output: data.eventData.output });
        } else if (data.eventType === 'run_failed') {
          Object.assign(run, {
            status: 'failed',
            error: data.eventData.error,
            errorCode: data.eventData.errorCode,
          });
        } else {
          run.status = 'cancelled';
        }
        store.runs.set(runId, run);
        // A run that ended releases its hook tokens and its waits.
        dropRunHooksAndWaits(runId);
        return finish(append(runId, body), { run: filterRun(run, entityRD) });
      }

      case 'attr_set': {
        const { changes, allowReservedAttributes } = data.eventData;
        if (
          data.correlationId &&
          data.eventData.writer.type === 'workflow' &&
          (store.events.get(runId) ?? []).some(
            (event) => event.eventType === 'attr_set' && event.correlationId === data.correlationId
          )
        ) {
          throw new EntityConflictError(
            `attr_set for correlationId "${data.correlationId}" already exists in run "${runId}"`
          );
        }
        validateAttributeChanges(changes, {
          existingKeys: Object.keys(currentRun.attributes ?? {}),
          allowReservedAttributes: allowReservedAttributes === true,
        });
        const attributes = applyAttributeChanges(currentRun.attributes ?? {}, changes);
        if (Object.keys(attributes).length > ATTRIBUTE_MAX_PER_RUN) {
          throw new AttributeValidationError(
            `Run attribute count would exceed limit ${ATTRIBUTE_MAX_PER_RUN}`
          );
        }
        const run = { ...currentRun, attributes, updatedAt: now } as WorkflowRun;
        store.runs.set(runId, run);
        return finish(append(runId, body), { run: filterRun(run, entityRD) });
      }

      // =======================================================================
      // Step lifecycle
      // =======================================================================
      case 'step_created': {
        const key = entityKey(runId, data.correlationId);
        if (store.steps.has(key)) {
          throw new EntityConflictError(`Step "${data.correlationId}" already exists`);
        }
        const step: Step = {
          runId,
          stepId: data.correlationId,
          stepName: data.eventData.stepName,
          status: 'pending',
          input: deepClone(data.eventData.input),
          attempt: 0,
          createdAt: now,
          updatedAt: now,
          specVersion,
        };
        store.steps.set(key, step);
        return finish(append(runId, body), { step: filterStep(step, entityRD) });
      }

      case 'step_started': {
        const stepId = data.correlationId;
        const key = entityKey(runId, stepId);
        const existing = store.steps.get(key);
        if (lazyStepStart && existing) {
          throw new EntityConflictError(`Step "${stepId}" already created`);
        }
        if (!lazyStepStart && !existing) {
          throw new WorkflowWorldError(`Step "${stepId}" not found`, { status: 404 });
        }
        if (existing) {
          if (isTerminalStepStatus(existing.status)) {
            throw new EntityConflictError(`Cannot modify step in terminal state "${existing.status}"`);
          }
          // A start on an ended run is refused even when the step reads
          // `running`: that is a redelivery of a start an earlier delivery
          // already claimed, and its outcome would never be read.
          if (runIsTerminal) {
            throw new RunExpiredError(
              `Cannot start step on run in terminal state "${currentRun.status}"`,
              runId,
              currentRun.status as 'completed' | 'failed' | 'cancelled'
            );
          }
          if (existing.retryAfter && existing.retryAfter.getTime() > Date.now()) {
            throw new TooEarlyError(
              `Cannot start step "${stepId}": retryAfter timestamp has not been reached yet`,
              { retryAfter: Math.ceil((existing.retryAfter.getTime() - Date.now()) / 1000) }
            );
          }
        }

        // The step's input belongs on step_created, not on step_started.
        const { input: lazyInput, ...startEventData } = (data.eventData ?? {}) as {
          input?: unknown;
        } & Record<string, unknown>;

        let base = existing;
        if (lazyStepStart) {
          // Lazy start: creating the step is the ownership claim, and the
          // synthetic step_created lands ahead of the start.
          base = {
            runId,
            stepId,
            stepName: String(startEventData.stepName),
            status: 'pending',
            input: deepClone(lazyInput),
            attempt: 0,
            createdAt: now,
            updatedAt: now,
            specVersion,
          };
          append(runId, {
            ...body,
            eventType: 'step_created',
            eventData: { stepName: startEventData.stepName, input: deepClone(lazyInput) },
          });
        }
        const step: Step = {
          ...base!,
          status: 'running',
          attempt: base!.attempt + 1,
          startedAt: base!.startedAt ?? now,
          retryAfter: undefined,
          updatedAt: now,
        };
        store.steps.set(key, step);
        const event = append(runId, {
          ...body,
          eventData: data.eventData ? deepClone(startEventData) : undefined,
        });
        return finish(event, {
          step: filterStep(step, entityRD),
          ...(lazyStepStart ? { stepCreated: true as const } : {}),
        });
      }

      case 'step_completed':
      case 'step_failed':
      case 'step_retrying': {
        const key = entityKey(runId, data.correlationId);
        const existing = store.steps.get(key);
        if (!existing) {
          throw new WorkflowWorldError(`Step "${data.correlationId}" not found`, { status: 404 });
        }
        if (isTerminalStepStatus(existing.status)) {
          throw new EntityConflictError(`Cannot modify step in terminal state "${existing.status}"`);
        }
        const step = { ...existing, updatedAt: now } as Step;
        if (data.eventType === 'step_completed') {
          Object.assign(step, { status: 'completed', output: deepClone(data.eventData.result), completedAt: now });
        } else if (data.eventType === 'step_failed') {
          Object.assign(step, { status: 'failed', error: deepClone(data.eventData.error), completedAt: now });
        } else {
          // A step in flight may still record its outcome on an ended run,
          // but a retry schedules more work, which an ended run never runs.
          if (runIsTerminal && existing.status !== 'running') {
            throw new RunExpiredError(
              `Cannot modify non-running step on run in terminal state "${currentRun.status}"`,
              runId,
              currentRun.status as 'completed' | 'failed' | 'cancelled'
            );
          }
          Object.assign(step, {
            status: 'pending',
            error: deepClone(data.eventData.error),
            retryAfter: data.eventData.retryAfter,
          });
        }
        store.steps.set(key, step);
        return finish(append(runId, body), { step: filterStep(step, entityRD) });
      }

      // =======================================================================
      // Hooks
      // =======================================================================
      case 'hook_created': {
        const hookId = data.correlationId;
        const { token } = data.eventData;
        const ownerId = store.hookIdsByToken.get(token);
        if (ownerId) {
          const owner = store.hooks.get(ownerId);
          if (ownerId === hookId && owner?.runId === runId) {
            throw new EntityConflictError(`Hook "${hookId}" already created`);
          }
          const event = append(runId, {
            ...body,
            eventType: 'hook_conflict',
            eventData: { token, conflictingRunId: owner?.runId },
          });
          return finish(event);
        }
        const hook: Hook = {
          runId,
          hookId,
          token,
          metadata: deepClone(data.eventData.metadata),
          ownerId: 'starter-owner',
          projectId: 'starter-project',
          environment: 'development',
          createdAt: now,
          specVersion,
          isWebhook: data.eventData.isWebhook,
          isSystem: data.eventData.isSystem,
        };
        store.hooks.set(hookId, hook);
        store.hookIdsByToken.set(token, hookId);
        return finish(append(runId, body), { hook: filterHook(hook, entityRD) });
      }

      case 'hook_received': {
        const hook = store.hooks.get(data.correlationId);
        if (!hook || hook.runId !== runId) throw new HookNotFoundError(data.correlationId);
        return finish(append(runId, body));
      }

      case 'hook_disposed': {
        const hook = store.hooks.get(data.correlationId);
        if (!hook || hook.runId !== runId) throw new HookNotFoundError(data.correlationId);
        store.hooks.delete(hook.hookId);
        store.hookIdsByToken.delete(hook.token);
        return finish(append(runId, body));
      }

      // =======================================================================
      // Waits
      // =======================================================================
      case 'wait_created': {
        const key = entityKey(runId, data.correlationId);
        if (store.waits.has(key)) {
          throw new EntityConflictError(`Wait "${data.correlationId}" already exists`);
        }
        const wait: Wait = {
          waitId: data.correlationId,
          runId,
          status: 'waiting',
          resumeAt: data.eventData.resumeAt,
          createdAt: now,
          updatedAt: now,
          specVersion,
        };
        store.waits.set(key, wait);
        return finish(append(runId, body), { wait: deepClone(wait) });
      }

      case 'wait_completed': {
        const key = entityKey(runId, data.correlationId);
        const existing = store.waits.get(key);
        if (!existing) {
          throw new WorkflowWorldError(`Wait "${data.correlationId}" not found`, { status: 404 });
        }
        if (existing.status === 'completed') {
          throw new EntityConflictError(`Wait "${data.correlationId}" already completed`);
        }
        const wait: Wait = { ...existing, status: 'completed', completedAt: now, updatedAt: now };
        store.waits.set(key, wait);
        return finish(append(runId, body), { wait: deepClone(wait) });
      }

      default:
        throw new WorkflowWorldError(
          `Unsupported event type: ${(data as { eventType: string }).eventType}`,
          { status: 400 }
        );
    }
  }

  const storage: Storage = {
    runs: {
      async get(id: string, params?: GetWorkflowRunParams) {
        const run = store.runs.get(id);
        if (!run) throw new WorkflowRunNotFoundError(id);
        return filterRun(run, params?.resolveData) as any;
      },

      async list(params?: ListWorkflowRunsParams) {
        const statuses =
          params?.status === undefined
            ? undefined
            : Array.isArray(params.status)
              ? params.status
              : [params.status];
        const matching = Array.from(store.runs.values()).filter(
          (run) =>
            (!params?.workflowName || run.workflowName === params.workflowName) &&
            (!statuses || statuses.includes(run.status))
        );
        const result = page(matching, (run) => run.runId, params?.pagination, {
          limit: 100,
          sortOrder: 'desc',
        });
        return {
          ...result,
          data: result.data.map((run) => filterRun(run, params?.resolveData)),
        } as any;
      },
    } as Storage['runs'],

    steps: {
      async get(runId: string, stepId: string, params?: GetStepParams) {
        const step = store.steps.get(entityKey(runId, stepId));
        if (!step) throw new WorkflowWorldError(`Step "${stepId}" not found`, { status: 404 });
        return filterStep(step, params?.resolveData) as any;
      },

      async list(params: ListWorkflowRunStepsParams) {
        const matching = Array.from(store.steps.values()).filter(
          (step) => step.runId === params.runId
        );
        const result = page(matching, (step) => step.stepId, params.pagination, {
          limit: 100,
          sortOrder: 'desc',
        });
        return {
          ...result,
          data: result.data.map((step) => filterStep(step, params.resolveData)),
        } as any;
      },
    } as Storage['steps'],

    events: {
      create: createEvent as Storage['events']['create'],

      async get(runId, eventId, params) {
        const event = (store.events.get(runId) ?? []).find((e) => e.eventId === eventId);
        if (!event) {
          throw new WorkflowWorldError(`Event "${eventId}" not found in run "${runId}"`, {
            status: 404,
          });
        }
        return filterEvent(event, params?.resolveData);
      },

      async list(params: ListEventsParams) {
        const result = page(store.events.get(params.runId) ?? [], (e) => e.eventId, params.pagination, {
          limit: 10000,
          sortOrder: 'asc',
        });
        return {
          ...result,
          data: result.data.map((event) => filterEvent(event, params.resolveData)),
        };
      },

      async listByCorrelationId(params: ListEventsByCorrelationIdParams) {
        const matching = (store.events.get(params.runId) ?? []).filter(
          (event) => event.correlationId === params.correlationId
        );
        const result = page(matching, (e) => e.eventId, params.pagination, {
          limit: 100,
          sortOrder: 'asc',
        });
        return {
          ...result,
          data: result.data.map((event) => filterEvent(event, params.resolveData)),
        };
      },
    },

    hooks: {
      async get(hookId: string, params?: GetHookParams) {
        const hook = store.hooks.get(hookId);
        if (!hook) throw new HookNotFoundError(hookId);
        return filterHook(hook, params?.resolveData);
      },

      async getByToken(token: string, params?: GetHookParams) {
        const hookId = store.hookIdsByToken.get(token);
        const hook = hookId ? store.hooks.get(hookId) : undefined;
        if (!hook) throw new HookNotFoundError(token);
        return filterHook(hook, params?.resolveData);
      },

      async list(params: ListHooksParams) {
        const matching = Array.from(store.hooks.values()).filter(
          (hook) => !params.runId || hook.runId === params.runId
        );
        const result = page(matching, (hook) => hook.hookId, params.pagination, {
          limit: 100,
          sortOrder: 'asc',
        });
        return {
          ...result,
          data: result.data.map((hook) => filterHook(hook, params.resolveData)),
        };
      },
    },
  };

  return storage;
}

