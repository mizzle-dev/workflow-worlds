/**
 * Redis Storage Implementation
 *
 * This file implements the Storage interface using Redis data structures:
 * - Runs: Hash for document, Sorted Sets for indexes
 * - Steps: Hash with composite key, Sorted Set index by runId
 * - Events: per-run Hash of eventId -> event, a Sorted Set of eventIds scored
 *   by position, and a per-run sequence counter
 * - Hooks: Hash with token lookup key
 * - Waits: Hash per wait, Set index by runId
 *
 * Each `events.create()` reads the state it depends on, decides, and then
 * commits through one guarded Lua script (see `commit.ts`) that re-checks
 * that state, applies the entity writes and appends the event atomically. A
 * guard that no longer holds writes nothing, and the create decides again from
 * a fresh read.
 */

import type {
  AnyEventRequest,
  CreateEventParams,
  Event,
  EventResult,
  EventsResolveData,
  Hook,
  ListWorkflowRunsParams,
  PaginatedResponse,
  ResolveData,
  Step,
  Storage,
  Wait,
  WorkflowRun,
} from '@workflow/world';
import {
  ATTRIBUTE_MAX_PER_RUN,
  AttributeValidationError,
  applyAttributeChanges,
  EVENT_ID_BODY_LENGTH,
  EVENT_ID_PREFIX,
  entityResolveData,
  eventIdToSlot,
  FIRST_EVENT_SLOT,
  isChildEntityCreationEvent,
  isLegacySpecVersion,
  isTerminalRunEventType,
  isTerminalStepStatus,
  isTerminalWorkflowRunStatus,
  requiresNewerWorld,
  SPEC_VERSION_CURRENT,
  stripEventDataRefs,
  TERMINAL_STEP_STATUSES,
  TERMINAL_WORKFLOW_RUN_STATUSES,
  validateAttributeChanges,
  validateUlidTimestamp,
} from '@workflow/world';
import {
  EntityConflictError,
  HookNotFoundError,
  RunExpiredError,
  RunNotSupportedError,
  TooEarlyError,
  WorkflowRunNotFoundError,
  WorkflowWorldError,
} from '@workflow/errors';
import type { Redis } from 'ioredis';
import { commit, type EventAppend, type Guard, type Op } from './commit.js';
import {
  serializeForRedis,
  deserializeFromRedis,
  ulidToScore,
  toCbor,
  fromCbor,
  generateUlid,
} from './utils.js';


/**
 * How many times one create re-reads and re-decides after a guard it
 * committed under stopped holding. Reached only under sustained contention on
 * a single entity.
 */
const MAX_COMMIT_ATTEMPTS = 25;

const TERMINAL_RUN = [...TERMINAL_WORKFLOW_RUN_STATUSES] as string[];
const TERMINAL_STEP = [...TERMINAL_STEP_STATUSES] as string[];

/**
 * Configuration for Redis storage.
 */
export interface RedisStorageConfig {
  /**
   * Key prefix for all Redis keys.
   * Default: 'workflow'
   */
  keyPrefix?: string;
}

/** Signals that a guard failed and the create should decide again. */
class Retry {}

function filterRun(run: WorkflowRun, resolveData: ResolveData = 'all'): WorkflowRun {
  if (resolveData === 'none') {
    return { ...run, input: undefined, output: undefined } as WorkflowRun;
  }
  return run;
}

function filterStep(step: Step, resolveData: ResolveData = 'all'): Step {
  if (resolveData === 'none') {
    return { ...step, input: undefined, output: undefined } as Step;
  }
  return step;
}

function filterHook(hook: Hook, resolveData: ResolveData = 'all'): Hook {
  if (resolveData === 'none') {
    const { metadata: _metadata, ...rest } = hook;
    return rest as Hook;
  }
  return hook;
}

function filterEvent(event: Event, resolveData: EventsResolveData = 'all'): Event {
  if (resolveData === 'none') {
    const { eventData: _eventData, ...rest } = event as Event & { eventData?: unknown };
    return rest as Event;
  }
  return stripEventDataRefs(event, resolveData);
}

/** Hash fields for an entity; `undefined` fields are left out. */
function fieldsOf(entity: object): string[] {
  return Object.entries(serializeForRedis(entity as Record<string, unknown>)).flat();
}

/**
 * Creates the Storage implementation for Redis.
 */
export async function createStorage(options: {
  redis: Redis;
  config?: RedisStorageConfig;
}): Promise<{ storage: Storage }> {
  const { redis, config = {} } = options;
  const prefix = config.keyPrefix ?? 'workflow';

  // Key helpers
  const keys = {
    // Runs
    run: (runId: string) => `${prefix}:runs:${runId}`,
    runsIdxAll: () => `${prefix}:runs:idx:all`,
    runsIdxWorkflow: (name: string) => `${prefix}:runs:idx:workflow:${name}`,
    runsIdxStatus: (status: string) => `${prefix}:runs:idx:status:${status}`,

    // Steps
    step: (runId: string, stepId: string) => `${prefix}:steps:${runId}:${stepId}`,
    stepsIdxRun: (runId: string) => `${prefix}:steps:idx:run:${runId}`,

    // Events, keyed by position within their run
    eventsHash: (runId: string) => `${prefix}:ev:${runId}`,
    eventsIdx: (runId: string) => `${prefix}:ev:idx:${runId}`,
    eventsSeq: (runId: string) => `${prefix}:ev:seq:${runId}`,
    eventsCorrelation: (runId: string, correlationId: string) =>
      `${prefix}:ev:corr:${runId}:${correlationId}`,
    // Events written before positional IDs: a Sorted Set of whole events.
    legacyEventsRun: (runId: string) => `${prefix}:events:${runId}`,

    // Hooks
    hookPrefix: () => `${prefix}:hooks:`,
    hook: (hookId: string) => `${prefix}:hooks:${hookId}`,
    hookTokenPrefix: () => `${prefix}:hooks:token:`,
    hookToken: (token: string) => `${prefix}:hooks:token:${token}`,
    hooksIdxRun: (runId: string) => `${prefix}:hooks:idx:run:${runId}`,

    // Waits
    waitPrefix: (runId: string) => `${prefix}:waits:${runId}:`,
    wait: (runId: string, waitId: string) => `${prefix}:waits:${runId}:${waitId}`,
    waitsIdxRun: (runId: string) => `${prefix}:waits:idx:run:${runId}`,
  };

  async function readHash<T>(key: string): Promise<T | null> {
    return deserializeFromRedis<T>(await redis.hgetall(key));
  }

  async function readRun(runId: string): Promise<WorkflowRun | null> {
    const run = await readHash<WorkflowRun>(keys.run(runId));
    if (run) run.attributes = run.attributes ?? {};
    return run;
  }

  const readStep = (runId: string, stepId: string) =>
    readHash<Step>(keys.step(runId, stepId));
  const readHook = (hookId: string) => readHash<Hook>(keys.hook(hookId));
  const readWait = (runId: string, waitId: string) =>
    readHash<Wait>(keys.wait(runId, waitId));

  function decodeEvent(runId: string, eventId: string, body: string | null): Event | null {
    const decoded = fromCbor<Record<string, unknown>>(body);
    if (!decoded) return null;
    return { ...decoded, runId, eventId } as Event;
  }

  async function readEvents(runId: string, eventIds: string[]): Promise<Event[]> {
    if (eventIds.length === 0) return [];
    const bodies = await redis.hmget(keys.eventsHash(runId), ...eventIds);
    const events: Event[] = [];
    eventIds.forEach((eventId, i) => {
      const event = decodeEvent(runId, eventId, bodies[i]);
      if (event) events.push(event);
    });
    return events;
  }

  function eventAppend(
    runId: string,
    body: Record<string, unknown>,
    correlationId?: string
  ): EventAppend {
    return {
      seq: keys.eventsSeq(runId),
      hash: keys.eventsHash(runId),
      idx: keys.eventsIdx(runId),
      corr: correlationId ? keys.eventsCorrelation(runId, correlationId) : undefined,
      prefix: EVENT_ID_PREFIX,
      width: EVENT_ID_BODY_LENGTH,
      body: toCbor(body),
    };
  }

  /**
   * Commits a plan, or throws {@link Retry} when a guard no longer holds.
   * Returns the committed event when the plan appended one.
   */
  async function commitOrRetry(
    runId: string,
    plan: { guards: Guard[]; ops: Op[]; event?: EventAppend },
    eventBody?: Record<string, unknown>
  ): Promise<Event | undefined> {
    const result = await commit(redis, plan);
    if (!result.ok) throw new Retry();
    if (!result.eventId || !eventBody) return undefined;
    return { ...eventBody, runId, eventId: result.eventId } as Event;
  }

  /**
   * The report half of bump-and-report: the events occupying the positions
   * between the one the writer expected (`eventCount + 1`) and the one its
   * write landed on. Every lower position was committed by a script that ran
   * before this one, so the whole span is readable.
   */
  async function reportSkipped(
    runId: string,
    committedEventId: string,
    eventCount: number | undefined,
    resolveData: EventsResolveData
  ): Promise<{ events: Event[]; cursor: null; hasMore: false } | undefined> {
    if (eventCount === undefined) return undefined;
    const committedSlot = eventIdToSlot(committedEventId);
    if (committedSlot === null || committedSlot <= eventCount + 1) return undefined;
    const ids = await redis.zrangebyscore(
      keys.eventsIdx(runId),
      `(${Math.max(eventCount, FIRST_EVENT_SLOT - 1)}`,
      `(${committedSlot}`
    );
    const events = await readEvents(runId, ids);
    return {
      events: events.map((event) => filterEvent(event, resolveData)),
      cursor: null,
      hasMore: false,
    };
  }

  function runStatusOps(run: WorkflowRun, nextStatus: string): Op[] {
    if (run.status === nextStatus) return [];
    return [
      { o: 'zrem', k: keys.runsIdxStatus(run.status), m: run.runId },
      { o: 'zadd', k: keys.runsIdxStatus(nextStatus), s: ulidToScore(run.runId), m: run.runId },
    ];
  }

  function newRunOps(run: WorkflowRun): Op[] {
    const score = ulidToScore(run.runId);
    return [
      { o: 'hset', k: keys.run(run.runId), fields: fieldsOf(run) },
      { o: 'zadd', k: keys.runsIdxAll(), s: score, m: run.runId },
      { o: 'zadd', k: keys.runsIdxWorkflow(run.workflowName), s: score, m: run.runId },
      { o: 'zadd', k: keys.runsIdxStatus(run.status), s: score, m: run.runId },
    ];
  }

  function newStepOps(step: Step): Op[] {
    return [
      { o: 'hset', k: keys.step(step.runId, step.stepId), fields: fieldsOf(step) },
      {
        o: 'zadd',
        k: keys.stepsIdxRun(step.runId),
        s: step.createdAt.getTime(),
        m: step.stepId,
      },
    ];
  }

  /**
   * Pre-event-sourcing runs (spec version 1) accept only the events an old
   * runtime may still send them: cancellation and wake-ups.
   */
  async function handleLegacyEvent(
    run: WorkflowRun,
    data: AnyEventRequest,
    resolveData: EventsResolveData
  ): Promise<EventResult> {
    const now = new Date();
    if (data.eventType === 'run_cancelled') {
      await commit(redis, {
        guards: [],
        ops: [
          {
            o: 'hset',
            k: keys.run(run.runId),
            fields: fieldsOf({ status: 'cancelled', completedAt: now, updatedAt: now }),
          },
          ...runStatusOps(run, 'cancelled'),
          {
            o: 'drop_hooks',
            idx: keys.hooksIdxRun(run.runId),
            hookPrefix: keys.hookPrefix(),
            tokenPrefix: keys.hookTokenPrefix(),
          },
        ],
      });
      const updated = await readRun(run.runId);
      return { run: updated ? filterRun(updated, entityResolveData(resolveData)) : undefined };
    }
    if (data.eventType === 'wait_completed' || data.eventType === 'hook_received') {
      const body = {
        eventType: data.eventType,
        correlationId: data.correlationId,
        eventData: 'eventData' in data ? data.eventData : undefined,
        specVersion: data.specVersion ?? SPEC_VERSION_CURRENT,
        createdAt: now,
      };
      const event = await commitOrRetry(
        run.runId,
        { guards: [], ops: [], event: eventAppend(run.runId, body, data.correlationId) },
        body
      );
      return { event: filterEvent(event!, resolveData) };
    }
    throw new EntityConflictError(`Event '${data.eventType}' is not supported for legacy runs`);
  }

  async function createRunEvent(
    runId: string | null,
    data: Extract<AnyEventRequest, { eventType: 'run_created' }>,
    resolveData: EventsResolveData
  ): Promise<EventResult> {
    const effectiveRunId = runId || `wrun_${generateUlid()}`;
    if (runId) {
      const validationError = validateUlidTimestamp(effectiveRunId, 'wrun_');
      if (validationError) {
        throw new WorkflowWorldError(validationError, { status: 400 });
      }
    }
    const eventData = data.eventData;
    validateAttributeChanges(
      Object.entries(eventData.attributes ?? {}).map(([key, value]) => ({ key, value })),
      { allowReservedAttributes: eventData.allowReservedAttributes === true }
    );
    const now = new Date();
    const specVersion = data.specVersion ?? SPEC_VERSION_CURRENT;
    const run: WorkflowRun = {
      runId: effectiveRunId,
      deploymentId: eventData.deploymentId,
      workflowName: eventData.workflowName,
      status: 'pending',
      specVersion,
      input: eventData.input,
      executionContext: eventData.executionContext,
      attributes: eventData.attributes ?? {},
      createdAt: now,
      updatedAt: now,
    } as WorkflowRun;
    const {
      dynamicWorkflowCode: _dynamicWorkflowCode,
      dynamicWorkflowCodeRef: _dynamicWorkflowCodeRef,
      ...storedEventData
    } = eventData;
    const body = {
      eventType: 'run_created',
      correlationId: data.correlationId,
      eventData: storedEventData,
      specVersion,
      createdAt: now,
    };
    const result = await commit(redis, {
      guards: [
        { t: 'absent', k: keys.run(effectiveRunId) },
        { t: 'absent', k: keys.eventsSeq(effectiveRunId) },
      ],
      ops: newRunOps(run),
      event: eventAppend(effectiveRunId, body, data.correlationId),
    });
    if (!result.ok) {
      throw new EntityConflictError(`Workflow run "${effectiveRunId}" already exists`);
    }
    const event = { ...body, runId: effectiveRunId, eventId: result.eventId! } as Event;
    return {
      event: filterEvent(event, resolveData),
      run: filterRun(run, entityResolveData(resolveData)),
    };
  }

  /**
   * One decision for one event: read, validate, commit under guards that hold
   * the decision's premises. Throws {@link Retry} when they stop holding.
   */
  async function attemptCreate(
    runId: string,
    data: AnyEventRequest,
    params: CreateEventParams | undefined
  ): Promise<EventResult> {
    const resolveData: EventsResolveData = params?.resolveData ?? 'all';
    const entityRD = entityResolveData(resolveData);
    const specVersion = data.specVersion ?? SPEC_VERSION_CURRENT;
    const now = new Date();
    const nowIso = now.toISOString();

    let currentRun = await readRun(runId);

    // Resilient start: a run_started for a run whose run_created never landed
    // carries what it takes to create the run here.
    if (data.eventType === 'run_started' && !currentRun && data.eventData) {
      const startData = data.eventData;
      if (startData.deploymentId && startData.workflowName && startData.input !== undefined) {
        try {
          await createRunEvent(
            runId,
            {
              eventType: 'run_created',
              specVersion,
              eventData: {
                deploymentId: startData.deploymentId,
                workflowName: startData.workflowName,
                input: startData.input,
                executionContext: startData.executionContext,
                attributes: startData.attributes,
                allowReservedAttributes: startData.allowReservedAttributes,
                encryptionPublicKey: startData.encryptionPublicKey,
              },
            },
            resolveData
          );
        } catch (error) {
          if (!EntityConflictError.is(error)) throw error;
        }
        currentRun = await readRun(runId);
      }
    }

    if (!currentRun) {
      throw new WorkflowRunNotFoundError(runId);
    }
    if (requiresNewerWorld(currentRun.specVersion)) {
      throw new RunNotSupportedError(currentRun.specVersion!, SPEC_VERSION_CURRENT);
    }
    if (isLegacySpecVersion(currentRun.specVersion)) {
      return handleLegacyEvent(currentRun, data, resolveData);
    }
    if ((await redis.exists(keys.eventsSeq(runId))) === 0) {
      // Written before positional event IDs: its log cannot be extended.
      if (data.eventType === 'run_cancelled') {
        return handleLegacyEvent(currentRun, data, resolveData);
      }
      throw new EntityConflictError(
        `Run "${runId}" predates positional event IDs; finish or cancel it on the World version that created it`
      );
    }

    const runKey = keys.run(runId);
    const runIsTerminal = isTerminalWorkflowRunStatus(currentRun.status);
    const lazyStepStart =
      data.eventType === 'step_started' && isChildEntityCreationEvent(data);
    const runAlive: Guard = { t: 'status_not_in', k: runKey, v: TERMINAL_RUN };

    const body: Record<string, unknown> = {
      eventType: data.eventType,
      correlationId: data.correlationId,
      eventData: 'eventData' in data ? data.eventData : undefined,
      specVersion,
      createdAt: now,
    };

    const finish = async (
      event: Event,
      entities: Omit<EventResult, 'event'> = {}
    ): Promise<EventResult> => {
      const skipped = await reportSkipped(runId, event.eventId, params?.eventCount, resolveData);
      return { ...entities, event: filterEvent(event, resolveData), ...(skipped ?? {}) } as EventResult;
    };

    // =========================================================================
    // Terminal run guards
    // =========================================================================
    if (runIsTerminal) {
      if (data.eventType === 'run_cancelled' && currentRun.status === 'cancelled') {
        const event = await commitOrRetry(
          runId,
          {
            guards: [{ t: 'status_in', k: runKey, v: ['cancelled'] }],
            ops: [],
            event: eventAppend(runId, body),
          },
          body
        );
        return finish(event!, { run: filterRun(currentRun, entityRD) });
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
        const startedBody = { ...body, eventData: undefined };
        const event = await commitOrRetry(
          runId,
          {
            guards: [{ t: 'status_in', k: runKey, v: ['pending'] }],
            ops: [
              {
                o: 'hset',
                k: runKey,
                fields: fieldsOf({ status: run.status, startedAt: run.startedAt, updatedAt: now }),
              },
              ...runStatusOps(currentRun, 'running'),
            ],
            event: eventAppend(runId, startedBody),
          },
          startedBody
        );
        return finish(event!, { run: filterRun(run, entityRD) });
      }

      case 'run_completed':
      case 'run_failed':
      case 'run_cancelled': {
        const status =
          data.eventType === 'run_completed'
            ? 'completed'
            : data.eventType === 'run_failed'
              ? 'failed'
              : 'cancelled';
        const changes: Record<string, unknown> = { status, completedAt: now, updatedAt: now };
        if (data.eventType === 'run_completed') changes.output = data.eventData.output;
        if (data.eventType === 'run_failed') {
          changes.error = data.eventData.error;
          changes.errorCode = data.eventData.errorCode;
        }
        const event = await commitOrRetry(
          runId,
          {
            guards: [{ t: 'status_in', k: runKey, v: [currentRun.status] }],
            ops: [
              { o: 'hset', k: runKey, fields: fieldsOf(changes) },
              ...runStatusOps(currentRun, status),
              // A run that ended releases its hook tokens and its waits.
              {
                o: 'drop_hooks',
                idx: keys.hooksIdxRun(runId),
                hookPrefix: keys.hookPrefix(),
                tokenPrefix: keys.hookTokenPrefix(),
              },
              { o: 'drop_set', idx: keys.waitsIdxRun(runId), prefix: keys.waitPrefix(runId) },
            ],
            event: eventAppend(runId, body),
          },
          body
        );
        const run = { ...currentRun, ...changes } as WorkflowRun;
        return finish(event!, { run: filterRun(run, entityRD) });
      }

      case 'attr_set': {
        const { changes, allowReservedAttributes } = data.eventData;
        if (data.correlationId && data.eventData.writer.type === 'workflow') {
          const ids = await redis.zrange(keys.eventsCorrelation(runId, data.correlationId), 0, -1);
          const existing = await readEvents(runId, ids);
          if (existing.some((event) => event.eventType === 'attr_set')) {
            throw new EntityConflictError(
              `attr_set for correlationId "${data.correlationId}" already exists in run "${runId}"`
            );
          }
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
        const previous = await redis.hget(runKey, 'attributes');
        const event = await commitOrRetry(
          runId,
          {
            // Compare-and-set on the stored attributes, so two writers cannot
            // both apply their changes to the same starting set.
            guards: [runAlive, { t: 'field_eq', k: runKey, f: 'attributes', v: previous }],
            ops: [{ o: 'hset', k: runKey, fields: fieldsOf({ attributes, updatedAt: now }) }],
            event: eventAppend(runId, body, data.correlationId),
          },
          body
        );
        const run = { ...currentRun, attributes, updatedAt: now } as WorkflowRun;
        return finish(event!, { run: filterRun(run, entityRD) });
      }

      // =======================================================================
      // Step lifecycle
      // =======================================================================
      case 'step_created': {
        const stepId = data.correlationId;
        const step: Step = {
          runId,
          stepId,
          stepName: data.eventData.stepName,
          status: 'pending',
          input: data.eventData.input,
          attempt: 0,
          createdAt: now,
          updatedAt: now,
          specVersion,
        };
        if (await redis.exists(keys.step(runId, stepId))) {
          throw new EntityConflictError(`Step "${stepId}" already exists`);
        }
        const event = await commitOrRetry(
          runId,
          {
            guards: [runAlive, { t: 'absent', k: keys.step(runId, stepId) }],
            ops: newStepOps(step),
            event: eventAppend(runId, body, stepId),
          },
          body
        );
        return finish(event!, { step: filterStep(step, entityRD) });
      }

      case 'step_started': {
        const stepId = data.correlationId;
        const stepKey = keys.step(runId, stepId);
        const existing = await readStep(runId, stepId);
        if (lazyStepStart && existing) {
          throw new EntityConflictError(`Step "${stepId}" already created`);
        }
        if (!lazyStepStart && !existing) {
          throw new WorkflowWorldError(`Step "${stepId}" not found`, { status: 404 });
        }
        if (existing) {
          if (isTerminalStepStatus(existing.status)) {
            throw new EntityConflictError(
              `Cannot modify step in terminal state "${existing.status}"`
            );
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
        const startedBody = { ...body, eventData: data.eventData ? startEventData : undefined };

        const guards: Guard[] = [runAlive];
        const ops: Op[] = [];
        const events: EventAppend[] = [];
        if (lazyStepStart) {
          // Lazy start: creating the step is the ownership claim. Only the
          // caller whose commit creates it runs the step body. The synthetic
          // step_created is appended in the same commit, ahead of the start,
          // so the log can never hold one without the other.
          const created: Step = {
            runId,
            stepId,
            stepName: String(startEventData.stepName),
            status: 'pending',
            input: lazyInput,
            attempt: 0,
            createdAt: now,
            updatedAt: now,
            specVersion,
          };
          guards.push({ t: 'absent', k: stepKey });
          ops.push(...newStepOps(created));
          events.push(
            eventAppend(
              runId,
              { ...body, eventType: 'step_created', eventData: { stepName: startEventData.stepName, input: lazyInput } },
              stepId
            )
          );
        } else {
          guards.push(
            { t: 'status_not_in', k: stepKey, v: TERMINAL_STEP },
            { t: 'field_le', k: stepKey, f: 'retryAfter', v: nowIso }
          );
        }
        ops.push(
          { o: 'hset', k: stepKey, fields: fieldsOf({ status: 'running', updatedAt: now }) },
          { o: 'hincrby', k: stepKey, f: 'attempt', by: 1 },
          { o: 'hsetnx', k: stepKey, f: 'startedAt', v: nowIso },
          { o: 'hdel', k: stepKey, fields: ['retryAfter'] }
        );
        events.push(eventAppend(runId, startedBody, stepId));
        const result = await commit(redis, { guards, ops, events });
        if (!result.ok) {
          if (lazyStepStart && result.failedGuard === 2) {
            throw new EntityConflictError(`Step "${stepId}" already created`);
          }
          throw new Retry();
        }
        const step = (await readStep(runId, stepId))!;
        const event = { ...startedBody, runId, eventId: result.eventId! } as Event;
        return finish(event, {
          step: filterStep(step, entityRD),
          ...(lazyStepStart ? { stepCreated: true as const } : {}),
        });
      }

      case 'step_completed':
      case 'step_failed':
      case 'step_retrying': {
        const stepId = data.correlationId;
        const stepKey = keys.step(runId, stepId);
        const existing = await readStep(runId, stepId);
        if (!existing) {
          throw new WorkflowWorldError(`Step "${stepId}" not found`, { status: 404 });
        }
        if (isTerminalStepStatus(existing.status)) {
          throw new EntityConflictError(`Cannot modify step in terminal state "${existing.status}"`);
        }
        const changes: Record<string, unknown> = { updatedAt: now };
        const removed: string[] = [];
        const guards: Guard[] = [{ t: 'status_in', k: stepKey, v: [existing.status] }];
        if (data.eventType === 'step_completed') {
          Object.assign(changes, { status: 'completed', output: data.eventData.result, completedAt: now });
        } else if (data.eventType === 'step_failed') {
          Object.assign(changes, { status: 'failed', error: data.eventData.error, completedAt: now });
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
          Object.assign(changes, {
            status: 'pending',
            error: data.eventData.error,
            retryAfter: data.eventData.retryAfter,
          });
          if (!data.eventData.retryAfter) removed.push('retryAfter');
        }
        const event = await commitOrRetry(
          runId,
          {
            guards,
            ops: [
              { o: 'hset', k: stepKey, fields: fieldsOf(changes) },
              { o: 'hdel', k: stepKey, fields: removed },
            ],
            event: eventAppend(runId, body, stepId),
          },
          body
        );
        const step = { ...existing, ...changes } as Step;
        return finish(event!, { step: filterStep(step, entityRD) });
      }

      // =======================================================================
      // Hooks
      // =======================================================================
      case 'hook_created': {
        const hookId = data.correlationId;
        const { token } = data.eventData;
        const owner = await redis.get(keys.hookToken(token));
        if (owner) {
          const ownerHook = await readHook(owner);
          if (owner === hookId && ownerHook?.runId === runId) {
            throw new EntityConflictError(`Hook "${hookId}" already created`);
          }
          const conflictBody = {
            ...body,
            eventType: 'hook_conflict',
            eventData: { token, conflictingRunId: ownerHook?.runId },
          };
          const event = await commitOrRetry(
            runId,
            {
              guards: [],
              ops: [],
              event: eventAppend(runId, conflictBody, hookId),
            },
            conflictBody
          );
          return finish(event!);
        }
        const hook: Hook = {
          runId,
          hookId,
          token,
          metadata: data.eventData.metadata,
          ownerId: 'redis-owner',
          projectId: 'redis-project',
          environment: 'development',
          createdAt: now,
          specVersion,
          isWebhook: data.eventData.isWebhook,
          isSystem: data.eventData.isSystem,
        };
        const event = await commitOrRetry(
          runId,
          {
            guards: [
              runAlive,
              { t: 'absent', k: keys.hookToken(token) },
              { t: 'absent', k: keys.hook(hookId) },
            ],
            ops: [
              { o: 'set', k: keys.hookToken(token), v: hookId },
              { o: 'hset', k: keys.hook(hookId), fields: fieldsOf(hook) },
              { o: 'sadd', k: keys.hooksIdxRun(runId), m: hookId },
            ],
            event: eventAppend(runId, body, hookId),
          },
          body
        );
        return finish(event!, { hook: filterHook(hook, entityRD) });
      }

      case 'hook_received': {
        // The existence check is a guard of the commit itself, so a delivery
        // cannot land after the disposal it races.
        const result = await commit(redis, {
          guards: [{ t: 'exists', k: keys.hook(data.correlationId) }],
          ops: [],
          event: eventAppend(runId, body, data.correlationId),
        });
        if (!result.ok) throw new HookNotFoundError(data.correlationId);
        return finish({ ...body, runId, eventId: result.eventId! } as Event);
      }

      case 'hook_disposed': {
        const hook = await readHook(data.correlationId);
        if (!hook || hook.runId !== runId) throw new HookNotFoundError(data.correlationId);
        const event = await commitOrRetry(
          runId,
          {
            guards: [{ t: 'exists', k: keys.hook(hook.hookId) }],
            ops: [
              { o: 'del', k: keys.hook(hook.hookId) },
              { o: 'del', k: keys.hookToken(hook.token) },
              { o: 'srem', k: keys.hooksIdxRun(runId), m: hook.hookId },
            ],
            event: eventAppend(runId, body, data.correlationId),
          },
          body
        );
        return finish(event!);
      }

      // =======================================================================
      // Waits
      // =======================================================================
      case 'wait_created': {
        const waitId = data.correlationId;
        const wait: Wait = {
          waitId,
          runId,
          status: 'waiting',
          resumeAt: data.eventData.resumeAt,
          createdAt: now,
          updatedAt: now,
          specVersion,
        };
        if (await redis.exists(keys.wait(runId, waitId))) {
          throw new EntityConflictError(`Wait "${waitId}" already exists`);
        }
        const event = await commitOrRetry(
          runId,
          {
            guards: [runAlive, { t: 'absent', k: keys.wait(runId, waitId) }],
            ops: [
              { o: 'hset', k: keys.wait(runId, waitId), fields: fieldsOf(wait) },
              { o: 'sadd', k: keys.waitsIdxRun(runId), m: waitId },
            ],
            event: eventAppend(runId, body, waitId),
          },
          body
        );
        return finish(event!, { wait });
      }

      case 'wait_completed': {
        const waitId = data.correlationId;
        const existing = await readWait(runId, waitId);
        if (!existing) {
          throw new WorkflowWorldError(`Wait "${waitId}" not found`, { status: 404 });
        }
        if (existing.status === 'completed') {
          throw new EntityConflictError(`Wait "${waitId}" already completed`);
        }
        const changes = { status: 'completed', completedAt: now, updatedAt: now };
        const event = await commitOrRetry(
          runId,
          {
            guards: [{ t: 'status_in', k: keys.wait(runId, waitId), v: ['waiting'] }],
            ops: [{ o: 'hset', k: keys.wait(runId, waitId), fields: fieldsOf(changes) }],
            event: eventAppend(runId, body, waitId),
          },
          body
        );
        return finish(event!, { wait: { ...existing, ...changes } as Wait });
      }

      default:
        throw new WorkflowWorldError(
          `Unsupported event type: ${(data as { eventType: string }).eventType}`,
          { status: 400 }
        );
    }
  }

  async function createEvent(
    runId: string | null,
    data: AnyEventRequest,
    params?: CreateEventParams
  ): Promise<EventResult> {
    if (data.eventType === 'run_created') {
      return createRunEvent(runId, data, params?.resolveData ?? 'all');
    }
    if (!runId) {
      throw new WorkflowWorldError('runId is required for non-run_created events', {
        status: 400,
      });
    }
    if (
      (data.eventType.startsWith('step_') ||
        data.eventType.startsWith('hook_') ||
        data.eventType.startsWith('wait_')) &&
      !data.correlationId
    ) {
      throw new WorkflowWorldError(`${data.eventType} requires a correlationId`, { status: 400 });
    }
    for (let attempt = 0; attempt < MAX_COMMIT_ATTEMPTS; attempt++) {
      try {
        return await attemptCreate(runId, data, params);
      } catch (error) {
        if (!(error instanceof Retry)) throw error;
      }
    }
    throw new WorkflowWorldError(
      `Could not commit ${data.eventType} for run "${runId}" after ${MAX_COMMIT_ATTEMPTS} attempts`,
      { status: 503 }
    );
  }

  // ===========================================================================
  // Reads
  // ===========================================================================

  async function listRuns(params?: ListWorkflowRunsParams) {
    const sortOrder = params?.pagination?.sortOrder ?? 'desc';
    const limit = params?.pagination?.limit ?? 100;
    const cursor = params?.pagination?.cursor;
    const statuses =
      params?.status === undefined
        ? undefined
        : Array.isArray(params.status)
          ? params.status
          : [params.status];
    if (statuses && statuses.length === 0) {
      return { data: [], cursor: null, hasMore: false };
    }

    // One index to page through; any other filter applies to the page.
    const indexKey = params?.workflowName
      ? keys.runsIdxWorkflow(params.workflowName)
      : statuses?.length === 1
        ? keys.runsIdxStatus(statuses[0])
        : keys.runsIdxAll();

    const data: WorkflowRun[] = [];
    let after = cursor ? await redis.zscore(indexKey, cursor) : null;
    let lastId = cursor;
    let hasMore = false;
    // Page through the index until the filtered page is full.
    while (data.length < limit) {
      const batch = 100;
      const ids =
        sortOrder === 'desc'
          ? await redis.zrevrangebyscore(indexKey, after !== null ? `(${after}` : '+inf', '-inf', 'LIMIT', 0, batch)
          : await redis.zrangebyscore(indexKey, after !== null ? `(${after}` : '-inf', '+inf', 'LIMIT', 0, batch);
      if (ids.length === 0) break;
      const pipeline = redis.pipeline();
      for (const id of ids) pipeline.hgetall(keys.run(id));
      const results = (await pipeline.exec()) ?? [];
      for (let i = 0; i < ids.length; i++) {
        const run = deserializeFromRedis<WorkflowRun>(results[i]?.[1] as Record<string, string>);
        lastId = ids[i];
        if (!run) continue;
        if (statuses && !statuses.includes(run.status)) continue;
        if (data.length === limit) {
          hasMore = true;
          break;
        }
        run.attributes = run.attributes ?? {};
        data.push(run);
      }
      if (hasMore || ids.length < batch) break;
      after = await redis.zscore(indexKey, ids[ids.length - 1]);
    }
    return {
      data: data.map((run) => filterRun(run, params?.resolveData)),
      cursor: hasMore ? (data[data.length - 1]?.runId ?? lastId ?? null) : null,
      hasMore,
    };
  }

  async function listEventPage(
    runId: string,
    indexKey: string,
    params: { pagination?: { sortOrder?: 'asc' | 'desc'; limit?: number; cursor?: string }; resolveData?: EventsResolveData },
    defaultLimit: number
  ): Promise<PaginatedResponse<Event>> {
    const sortOrder = params.pagination?.sortOrder ?? 'asc';
    const limit = params.pagination?.limit ?? defaultLimit;
    const cursorSlot = params.pagination?.cursor ? eventIdToSlot(params.pagination.cursor) : null;
    const ids =
      sortOrder === 'asc'
        ? await redis.zrangebyscore(indexKey, cursorSlot !== null ? `(${cursorSlot}` : '-inf', '+inf', 'LIMIT', 0, limit + 1)
        : await redis.zrevrangebyscore(indexKey, cursorSlot !== null ? `(${cursorSlot}` : '+inf', '-inf', 'LIMIT', 0, limit + 1);
    const hasMore = ids.length > limit;
    const events = await readEvents(runId, ids.slice(0, limit));
    return {
      data: events.map((event) => filterEvent(event, params.resolveData)),
      cursor: hasMore ? (events[events.length - 1]?.eventId ?? null) : null,
      hasMore,
    };
  }

  /** Events of a run written before positional IDs, oldest first. */
  async function listLegacyEvents(
    runId: string,
    resolveData: EventsResolveData | undefined,
    correlationId?: string
  ): Promise<PaginatedResponse<Event>> {
    const encoded = await redis.zrange(keys.legacyEventsRun(runId), 0, -1);
    const events = encoded
      .map((value) => fromCbor<Event>(value))
      .filter((event): event is Event => !!event)
      .filter((event) => !correlationId || event.correlationId === correlationId);
    return {
      data: events.map((event) => filterEvent(event, resolveData)),
      cursor: null,
      hasMore: false,
    };
  }

  const storage: Storage = {
    runs: {
      async get(id: string, params?: { resolveData?: ResolveData }) {
        const run = await readRun(id);
        if (!run) throw new WorkflowRunNotFoundError(id);
        return filterRun(run, params?.resolveData) as any;
      },
      list: listRuns as Storage['runs']['list'],
    } as Storage['runs'],

    steps: {
      async get(runId: string, stepId: string, params?: { resolveData?: ResolveData }) {
        const step = await readStep(runId, stepId);
        if (!step) throw new WorkflowWorldError(`Step "${stepId}" not found`, { status: 404 });
        return filterStep(step, params?.resolveData) as any;
      },

      async list(params) {
        const sortOrder = params.pagination?.sortOrder ?? 'desc';
        const limit = params.pagination?.limit ?? 100;
        const cursor = params.pagination?.cursor;
        const indexKey = keys.stepsIdxRun(params.runId);
        const after = cursor ? await redis.zscore(indexKey, cursor) : null;
        // Steps created in the same millisecond share a score, so the cursor
        // step itself is skipped by member rather than by score.
        const ids =
          sortOrder === 'desc'
            ? await redis.zrevrangebyscore(indexKey, after ?? '+inf', '-inf')
            : await redis.zrangebyscore(indexKey, after ?? '-inf', '+inf');
        const start = cursor ? ids.indexOf(cursor) + 1 : 0;
        const pageIds = ids.slice(start, start + limit + 1);
        const hasMore = pageIds.length > limit;
        const pipeline = redis.pipeline();
        for (const stepId of pageIds.slice(0, limit)) {
          pipeline.hgetall(keys.step(params.runId, stepId));
        }
        const results = (await pipeline.exec()) ?? [];
        const data = results
          .map(([, value]) => deserializeFromRedis<Step>(value as Record<string, string>))
          .filter((step): step is Step => step !== null);
        return {
          data: data.map((step) => filterStep(step, params.resolveData)),
          cursor: hasMore ? (data[data.length - 1]?.stepId ?? null) : null,
          hasMore,
        } as any;
      },
    } as Storage['steps'],

    events: {
      create: createEvent as Storage['events']['create'],

      async get(runId, eventId, params) {
        const [event] = await readEvents(runId, [eventId]);
        if (!event) {
          throw new WorkflowWorldError(`Event "${eventId}" not found in run "${runId}"`, {
            status: 404,
          });
        }
        return filterEvent(event, params?.resolveData);
      },

      async list(params) {
        if ((await redis.exists(keys.eventsSeq(params.runId))) === 0) {
          return listLegacyEvents(params.runId, params.resolveData);
        }
        return listEventPage(params.runId, keys.eventsIdx(params.runId), params, 10000);
      },

      async listByCorrelationId(params) {
        if ((await redis.exists(keys.eventsSeq(params.runId))) === 0) {
          return listLegacyEvents(params.runId, params.resolveData, params.correlationId);
        }
        return listEventPage(
          params.runId,
          keys.eventsCorrelation(params.runId, params.correlationId),
          params,
          100
        );
      },
    },

    hooks: {
      async get(hookId, params) {
        const hook = await readHook(hookId);
        if (!hook) throw new HookNotFoundError(hookId);
        return filterHook(hook, params?.resolveData);
      },

      async getByToken(token, params) {
        const hookId = await redis.get(keys.hookToken(token));
        const hook = hookId ? await readHook(hookId) : null;
        if (!hook) throw new HookNotFoundError(token);
        return filterHook(hook, params?.resolveData);
      },

      async list(params) {
        const limit = params.pagination?.limit ?? 100;
        const cursor = params.pagination?.cursor;

        let hookIds: string[];
        if (params.runId) {
          hookIds = await redis.smembers(keys.hooksIdxRun(params.runId));
        } else {
          // Scan for all hooks - this is less efficient but rarely used
          const keysList: string[] = [];
          let cursorIter = '0';
          do {
            const [nextCursor, foundKeys] = await redis.scan(
              cursorIter,
              'MATCH',
              `${prefix}:hooks:hook_*`,
              'COUNT',
              100
            );
            cursorIter = nextCursor;
            keysList.push(...foundKeys);
          } while (cursorIter !== '0');
          hookIds = keysList.map((k) => k.split(':').pop()!);
        }

        hookIds.sort();
        if (params.pagination?.sortOrder === 'desc') hookIds.reverse();
        const start = cursor ? hookIds.indexOf(cursor) + 1 : 0;
        const pageIds = hookIds.slice(start, start + limit + 1);
        const hasMore = pageIds.length > limit;

        const pipeline = redis.pipeline();
        for (const hookId of pageIds.slice(0, limit)) {
          pipeline.hgetall(keys.hook(hookId));
        }
        const results = (await pipeline.exec()) ?? [];
        const data = results
          .map(([, value]) => deserializeFromRedis<Hook>(value as Record<string, string>))
          .filter((hook): hook is Hook => hook !== null);

        return {
          data: data.map((hook) => filterHook(hook, params.resolveData)),
          cursor: hasMore ? (data[data.length - 1]?.hookId ?? null) : null,
          hasMore,
        };
      },
    },
  };

  return { storage };
}
