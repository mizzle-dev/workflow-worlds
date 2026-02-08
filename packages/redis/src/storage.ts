/**
 * Redis Storage Implementation
 *
 * This file implements the Storage interface using Redis data structures:
 * - Runs: Hash for document, Sorted Sets for indexes
 * - Steps: Hash with composite key, Sorted Set index by runId
 * - Events: Sorted Set with ULID scores for ordering
 * - Hooks: Hash with token lookup key
 */

import type {
  Storage,
  WorkflowRun,
  Step,
  Event,
  Hook,
  AnyEventRequest,
  CreateEventParams,
  CreateWorkflowRunRequest,
  CreateStepRequest,
  UpdateStepRequest,
  EventResult,
  CreateHookRequest,
  PaginatedResponse,
} from '@workflow/world';
import {
  isLegacySpecVersion,
  requiresNewerWorld,
  SPEC_VERSION_CURRENT,
} from '@workflow/world';
import { RunNotSupportedError, WorkflowAPIError } from '@workflow/errors';
import { monotonicFactory } from 'ulid';
import type { Redis } from 'ioredis';
import {
  serializeForRedis,
  deserializeFromRedis,
  ulidToScore,
  deepClone,
  toCbor,
  fromCbor,
} from './utils.js';

const generateUlid = monotonicFactory();

type UpdateWorkflowRunRequest = {
  status?: WorkflowRun['status'];
  output?: unknown;
  error?: WorkflowRun['error'];
  executionContext?: Record<string, unknown>;
};

type ResolveDataParams = { resolveData?: 'none' | 'all' };

type LegacyStorage = {
  runs: {
    create(
      data: CreateWorkflowRunRequest & { specVersion?: number; runId?: string }
    ): Promise<WorkflowRun>;
    get(id: string, params?: ResolveDataParams): Promise<WorkflowRun>;
    update(id: string, data: UpdateWorkflowRunRequest): Promise<WorkflowRun>;
    list(params?: any): Promise<PaginatedResponse<WorkflowRun>>;
  };
  steps: {
    create(
      runId: string,
      data: CreateStepRequest & { specVersion?: number }
    ): Promise<Step>;
    get(
      runId: string | undefined,
      stepId: string,
      params?: ResolveDataParams
    ): Promise<Step>;
    update(runId: string, stepId: string, data: UpdateStepRequest): Promise<Step>;
    list(params: any): Promise<PaginatedResponse<Step>>;
  };
  events: {
    create(
      runId: string,
      data: AnyEventRequest,
      params?: CreateEventParams
    ): Promise<Event>;
    list(params: any): Promise<PaginatedResponse<Event>>;
    listByCorrelationId(params: any): Promise<PaginatedResponse<Event>>;
  };
  hooks: {
    create(
      runId: string,
      data: CreateHookRequest & { specVersion?: number },
      params?: ResolveDataParams
    ): Promise<Hook>;
    get(hookId: string, params?: ResolveDataParams): Promise<Hook>;
    getByToken(token: string, params?: ResolveDataParams): Promise<Hook>;
    list(params: any): Promise<PaginatedResponse<Hook>>;
    dispose(hookId: string, params?: ResolveDataParams): Promise<Hook>;
  };
};

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

/**
 * Helper to filter data based on resolveData setting.
 */
function filterRunData(
  run: WorkflowRun,
  resolveData: 'none' | 'all' = 'all'
): WorkflowRun {
  const cloned = deepClone(run);
  if (resolveData === 'none') {
    return { ...cloned, input: undefined, output: undefined } as WorkflowRun;
  }
  return cloned;
}

function filterStepData(step: Step, resolveData: 'none' | 'all' = 'all'): Step {
  const cloned = deepClone(step);
  if (resolveData === 'none') {
    return { ...cloned, input: undefined, output: undefined } as Step;
  }
  return cloned;
}

function filterEventData(
  event: Event,
  resolveData: 'none' | 'all' = 'all'
): Event {
  const cloned = deepClone(event);
  if (resolveData === 'none') {
    if ('eventData' in cloned) {
      delete (cloned as Record<string, unknown>).eventData;
    }
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

function isTerminalRunStatus(status: WorkflowRun['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

function isTerminalStepStatus(status: Step['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
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
    stepsIdxStepId: () => `${prefix}:steps:idx:stepId`,

    // Events
    eventsRun: (runId: string) => `${prefix}:events:${runId}`,
    eventsIdxCorrelation: (correlationId: string) =>
      `${prefix}:events:idx:correlation:${correlationId}`,

    // Hooks
    hook: (hookId: string) => `${prefix}:hooks:${hookId}`,
    hookToken: (token: string) => `${prefix}:hooks:token:${token}`,
    hooksIdxRun: (runId: string) => `${prefix}:hooks:idx:run:${runId}`,
  };

  const legacyStorage: LegacyStorage = {
    // =========================================================================
    // RUNS STORAGE
    // =========================================================================
    runs: {
      async create(data: CreateWorkflowRunRequest & { specVersion?: number; runId?: string }): Promise<WorkflowRun> {
        const runId = data.runId ?? `wrun_${generateUlid()}`;
        const now = new Date();
        const score = ulidToScore(runId);

        const run: WorkflowRun = {
          runId,
          deploymentId: data.deploymentId,
          status: 'pending',
          workflowName: data.workflowName,
          specVersion: (data as { specVersion?: number }).specVersion,
          input: (data.input ?? []) as unknown[],
          output: undefined,
          error: undefined,
          executionContext: data.executionContext as
            | Record<string, unknown>
            | undefined,
          startedAt: undefined,
          completedAt: undefined,
          createdAt: now,
          updatedAt: now,
        };

        const serialized = serializeForRedis(run as unknown as Record<string, unknown>);

        // Use pipeline for atomic operation
        const pipeline = redis.pipeline();
        pipeline.hset(keys.run(runId), serialized);
        pipeline.zadd(keys.runsIdxAll(), score, runId);
        pipeline.zadd(keys.runsIdxWorkflow(run.workflowName), score, runId);
        pipeline.zadd(keys.runsIdxStatus(run.status), score, runId);
        await pipeline.exec();

        return run;
      },

      async get(id, params): Promise<WorkflowRun> {
        const data = await redis.hgetall(keys.run(id));
        const run = deserializeFromRedis<WorkflowRun>(data);

        if (!run) {
          throw new WorkflowAPIError(`Run not found: ${id}`, { status: 404 });
        }

        return filterRunData(run, params?.resolveData);
      },

      async update(id, data: UpdateWorkflowRunRequest): Promise<WorkflowRun> {
        const existingData = await redis.hgetall(keys.run(id));
        const existing = deserializeFromRedis<WorkflowRun>(existingData);

        if (!existing) {
          throw new WorkflowAPIError(`Run not found: ${id}`, { status: 404 });
        }

        const now = new Date();
        const oldStatus = existing.status;
        const updated: WorkflowRun = {
          ...existing,
          ...data,
          updatedAt: now,
        } as WorkflowRun;

        // Only set startedAt the first time status becomes 'running'
        if (data.status === 'running' && !updated.startedAt) {
          updated.startedAt = now;
        }

        // Set completedAt on terminal states
        const isTerminal =
          data.status === 'completed' ||
          data.status === 'failed' ||
          data.status === 'cancelled';

        if (isTerminal) {
          updated.completedAt = now;
        }

        const serialized = serializeForRedis(updated as unknown as Record<string, unknown>);
        const score = ulidToScore(id);

        const pipeline = redis.pipeline();
        pipeline.hset(keys.run(id), serialized);

        // Update status index if changed
        if (data.status && data.status !== oldStatus) {
          pipeline.zrem(keys.runsIdxStatus(oldStatus), id);
          pipeline.zadd(keys.runsIdxStatus(data.status), score, id);
        }

        // Clean up hooks on terminal status
        if (isTerminal) {
          const hookIds = await redis.smembers(keys.hooksIdxRun(id));
          for (const hookId of hookIds) {
            const hookData = await redis.hgetall(keys.hook(hookId));
            const hook = deserializeFromRedis<Hook>(hookData);
            if (hook) {
              pipeline.del(keys.hook(hookId));
              pipeline.del(keys.hookToken(hook.token));
            }
          }
          pipeline.del(keys.hooksIdxRun(id));
        }

        await pipeline.exec();
        return updated;
      },

      async list(params): Promise<PaginatedResponse<WorkflowRun>> {
        const sortOrder = params?.pagination?.sortOrder ?? 'desc';
        const limit = params?.pagination?.limit ?? 100;
        const cursor = params?.pagination?.cursor;

        // Determine which index to use
        let indexKey: string;
        if (params?.workflowName && params?.status) {
          // Need to intersect - use workflow index and filter by status
          indexKey = keys.runsIdxWorkflow(params.workflowName);
        } else if (params?.workflowName) {
          indexKey = keys.runsIdxWorkflow(params.workflowName);
        } else if (params?.status) {
          indexKey = keys.runsIdxStatus(params.status);
        } else {
          indexKey = keys.runsIdxAll();
        }

        // Get cursor score if provided
        let cursorScore: number | undefined;
        if (cursor) {
          const score = await redis.zscore(indexKey, cursor);
          if (score) {
            cursorScore = Number(score);
          }
        }

        // Fetch runIds using ZRANGEBYSCORE or ZREVRANGEBYSCORE
        let runIds: string[];
        if (sortOrder === 'desc') {
          if (cursorScore !== undefined) {
            runIds = await redis.zrevrangebyscore(
              indexKey,
              `(${cursorScore}`,
              '-inf',
              'LIMIT',
              0,
              limit + 1
            );
          } else {
            runIds = await redis.zrevrangebyscore(
              indexKey,
              '+inf',
              '-inf',
              'LIMIT',
              0,
              limit + 1
            );
          }
        } else {
          if (cursorScore !== undefined) {
            runIds = await redis.zrangebyscore(
              indexKey,
              `(${cursorScore}`,
              '+inf',
              'LIMIT',
              0,
              limit + 1
            );
          } else {
            runIds = await redis.zrangebyscore(
              indexKey,
              '-inf',
              '+inf',
              'LIMIT',
              0,
              limit + 1
            );
          }
        }

        const hasMore = runIds.length > limit;
        const resultIds = runIds.slice(0, limit);

        if (resultIds.length === 0) {
          return { data: [], cursor: null, hasMore: false };
        }

        // Fetch full run data
        const pipeline = redis.pipeline();
        for (const runId of resultIds) {
          pipeline.hgetall(keys.run(runId));
        }
        const results = await pipeline.exec();

        let data = results
          ?.filter(([err, val]) => !err && val && Object.keys(val as object).length > 0)
          .map(([, val]) => deserializeFromRedis<WorkflowRun>(val as Record<string, string>)!)
          .filter((r): r is WorkflowRun => r !== null) ?? [];

        // Filter by status if we used workflow index and also need status filter
        if (params?.status && params?.workflowName) {
          data = data.filter((r) => r.status === params.status);
        }

        const nextCursor =
          hasMore && data.length > 0 ? data[data.length - 1]?.runId : null;

        return {
          data: data.map((r) => filterRunData(r, params?.resolveData)),
          cursor: nextCursor ?? null,
          hasMore,
        };
      },

    },

    // =========================================================================
    // STEPS STORAGE
    // =========================================================================
    steps: {
      async create(runId, data: CreateStepRequest): Promise<Step> {
        const now = new Date();
        const score = now.getTime();

        const step: Step = {
          runId,
          stepId: data.stepId,
          stepName: data.stepName,
          status: 'pending',
          input: data.input as unknown[],
          output: undefined,
          error: undefined,
          attempt: 0,
          startedAt: undefined,
          completedAt: undefined,
          createdAt: now,
          updatedAt: now,
          specVersion: (data as { specVersion?: number }).specVersion,
        };

        const serialized = serializeForRedis(step as unknown as Record<string, unknown>);

        const pipeline = redis.pipeline();
        pipeline.hset(keys.step(runId, data.stepId), serialized);
        pipeline.zadd(keys.stepsIdxRun(runId), score, data.stepId);
        // Also index by stepId for lookups without runId
        pipeline.hset(keys.stepsIdxStepId(), data.stepId, runId);
        await pipeline.exec();

        return step;
      },

      async get(runId, stepId, params): Promise<Step> {
        let actualRunId = runId;

        if (!actualRunId) {
          // Search for stepId in the global index
          const foundRunId = await redis.hget(keys.stepsIdxStepId(), stepId);
          if (!foundRunId) {
            throw new WorkflowAPIError(`Step not found: ${stepId}`, { status: 404 });
          }
          actualRunId = foundRunId;
        }

        const data = await redis.hgetall(keys.step(actualRunId, stepId));
        const step = deserializeFromRedis<Step>(data);

        if (!step) {
          throw new WorkflowAPIError(`Step not found: ${stepId}`, { status: 404 });
        }

        return filterStepData(step, params?.resolveData);
      },

      async update(runId, stepId, data: UpdateStepRequest): Promise<Step> {
        const existingData = await redis.hgetall(keys.step(runId, stepId));
        const existing = deserializeFromRedis<Step>(existingData);

        if (!existing) {
          throw new WorkflowAPIError(`Step not found: ${stepId}`, { status: 404 });
        }

        const now = new Date();
        const updated: Step = {
          ...existing,
          ...data,
          updatedAt: now,
        };

        // Set startedAt only once when status becomes 'running'
        if (data.status === 'running' && !updated.startedAt) {
          updated.startedAt = now;
        }

        // Set completedAt on terminal states
        if (data.status === 'completed' || data.status === 'failed') {
          updated.completedAt = now;
        }

        const serialized = serializeForRedis(updated as unknown as Record<string, unknown>);
        await redis.hset(keys.step(runId, stepId), serialized);

        return updated;
      },

      async list(params): Promise<PaginatedResponse<Step>> {
        const sortOrder = params.pagination?.sortOrder ?? 'desc';
        const limit = params.pagination?.limit ?? 100;

        // Get stepIds from the run index (fetch limit + 1 to determine hasMore)
        let stepIds: string[];
        if (sortOrder === 'desc') {
          stepIds = await redis.zrevrange(keys.stepsIdxRun(params.runId), 0, limit);
        } else {
          stepIds = await redis.zrange(keys.stepsIdxRun(params.runId), 0, limit);
        }

        const hasMore = stepIds.length > limit;
        const resultIds = stepIds.slice(0, limit);

        if (resultIds.length === 0) {
          return { data: [], cursor: null, hasMore: false };
        }

        // Fetch full step data
        const pipeline = redis.pipeline();
        for (const stepId of resultIds) {
          pipeline.hgetall(keys.step(params.runId, stepId));
        }
        const results = await pipeline.exec();

        const data = results
          ?.filter(([err, val]) => !err && val && Object.keys(val as object).length > 0)
          .map(([, val]) => deserializeFromRedis<Step>(val as Record<string, string>)!)
          .filter((s): s is Step => s !== null) ?? [];

        const nextCursor = hasMore && data.length > 0 ? data[data.length - 1]?.stepId : null;

        return {
          data: data.map((s) => filterStepData(s, params.resolveData)),
          cursor: nextCursor ?? null,
          hasMore,
        };
      },
    },

    // =========================================================================
    // EVENTS STORAGE
    // =========================================================================
    events: {
      async create(runId, data: AnyEventRequest, params): Promise<Event> {
        const eventId = `evnt_${generateUlid()}`;
        const now = new Date();
        const score = ulidToScore(eventId);

        const event: Event = {
          ...data,
          runId,
          eventId,
          createdAt: now,
        };

        // Use CBOR for type-preserving serialization (Date, etc.)
        const serialized = toCbor(event);

        const pipeline = redis.pipeline();
        // Store event in sorted set (member is the full event JSON)
        pipeline.zadd(keys.eventsRun(runId), score, serialized);

        // Index by correlation ID if present
        if (data.correlationId) {
          pipeline.zadd(keys.eventsIdxCorrelation(data.correlationId), score, serialized);
        }

        await pipeline.exec();

        return filterEventData(event, params?.resolveData);
      },

      async list(params): Promise<PaginatedResponse<Event>> {

        // Events default to ascending order (oldest first) for replay
        const sortOrder = params.pagination?.sortOrder ?? 'asc';
        const limit = params.pagination?.limit ?? 10000;
        const cursor = params.pagination?.cursor;

        const indexKey = keys.eventsRun(params.runId);

        // Get cursor score if provided
        let cursorScore: number | undefined;
        if (cursor) {
          // Need to find the score for this cursor (eventId)
          // We stored the full CBOR/JSON, so we need to scan
          const allEvents = await redis.zrange(indexKey, 0, -1, 'WITHSCORES');
          for (let i = 0; i < allEvents.length; i += 2) {
            const eventData = allEvents[i];
            const score = allEvents[i + 1];
            const event = fromCbor<Event>(eventData);
            if (event?.eventId === cursor) {
              cursorScore = Number(score);
              break;
            }
          }
        }

        // Fetch events
        let eventJsons: string[];
        if (sortOrder === 'asc') {
          if (cursorScore !== undefined) {
            eventJsons = await redis.zrangebyscore(
              indexKey,
              `(${cursorScore}`,
              '+inf',
              'LIMIT',
              0,
              limit + 1
            );
          } else {
            eventJsons = await redis.zrangebyscore(
              indexKey,
              '-inf',
              '+inf',
              'LIMIT',
              0,
              limit + 1
            );
          }
        } else {
          if (cursorScore !== undefined) {
            eventJsons = await redis.zrevrangebyscore(
              indexKey,
              `(${cursorScore}`,
              '-inf',
              'LIMIT',
              0,
              limit + 1
            );
          } else {
            eventJsons = await redis.zrevrangebyscore(
              indexKey,
              '+inf',
              '-inf',
              'LIMIT',
              0,
              limit + 1
            );
          }
        }

        const hasMore = eventJsons.length > limit;
        const resultJsons = eventJsons.slice(0, limit);

        // Deserialize events using CBOR (with JSON fallback for legacy data)
        const data: Event[] = [];
        for (const encoded of resultJsons) {
          const event = fromCbor<Event>(encoded);
          if (event) {
            data.push(event);
          }
        }

        const nextCursor = hasMore && data.length > 0 ? data[data.length - 1]?.eventId : null;

        return {
          data: data.map((e) => filterEventData(e, params.resolveData)),
          cursor: nextCursor ?? null,
          hasMore,
        };
      },

      async listByCorrelationId(params): Promise<PaginatedResponse<Event>> {
        const sortOrder = params.pagination?.sortOrder ?? 'asc';
        const limit = params.pagination?.limit ?? 100;

        const indexKey = keys.eventsIdxCorrelation(params.correlationId);

        let eventJsons: string[];
        if (sortOrder === 'asc') {
          eventJsons = await redis.zrange(indexKey, 0, limit);
        } else {
          eventJsons = await redis.zrevrange(indexKey, 0, limit);
        }

        const hasMore = eventJsons.length > limit;
        const resultJsons = eventJsons.slice(0, limit);

        // Deserialize events using CBOR (with JSON fallback for legacy data)
        const data: Event[] = [];
        for (const encoded of resultJsons) {
          const event = fromCbor<Event>(encoded);
          if (event) {
            data.push(event);
          }
        }

        const nextCursor = hasMore && data.length > 0 ? data[data.length - 1]?.eventId : null;

        return {
          data: data.map((e) => filterEventData(e, params.resolveData)),
          cursor: nextCursor ?? null,
          hasMore,
        };
      },
    },

    // =========================================================================
    // HOOKS STORAGE
    // =========================================================================
    hooks: {
      async create(runId, data: CreateHookRequest, params): Promise<Hook> {
        // Check for token uniqueness using SETNX
        const tokenKey = keys.hookToken(data.token);
        const isUnique = await redis.setnx(tokenKey, data.hookId);

        if (!isUnique) {
          throw new WorkflowAPIError(
            `Hook with token ${data.token} already exists`,
            { status: 409 }
          );
        }

        const now = new Date();
        const hook: Hook = {
          runId,
          hookId: data.hookId,
          token: data.token,
          metadata: data.metadata,
          ownerId: 'redis-owner',
          projectId: 'redis-project',
          environment: 'development',
          createdAt: now,
          specVersion: (data as { specVersion?: number }).specVersion,
        };

        const serialized = serializeForRedis(hook as unknown as Record<string, unknown>);

        const pipeline = redis.pipeline();
        pipeline.hset(keys.hook(data.hookId), serialized);
        pipeline.sadd(keys.hooksIdxRun(runId), data.hookId);
        await pipeline.exec();

        return filterHookData(hook, params?.resolveData);
      },

      async get(hookId, params): Promise<Hook> {
        const data = await redis.hgetall(keys.hook(hookId));
        const hook = deserializeFromRedis<Hook>(data);

        if (!hook) {
          throw new WorkflowAPIError(`Hook not found: ${hookId}`, { status: 404 });
        }

        return filterHookData(hook, params?.resolveData);
      },

      async getByToken(token, params): Promise<Hook> {
        const hookId = await redis.get(keys.hookToken(token));

        if (!hookId) {
          throw new WorkflowAPIError(`Hook not found for token: ${token}`, {
            status: 404,
          });
        }

        return this.get(hookId, params);
      },

      async list(params): Promise<PaginatedResponse<Hook>> {
        const limit = params.pagination?.limit ?? 100;

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

        if (hookIds.length === 0) {
          return { data: [], cursor: null, hasMore: false };
        }

        const hasMore = hookIds.length > limit;
        const resultIds = hookIds.slice(0, limit);

        // Fetch full hook data
        const pipeline = redis.pipeline();
        for (const hookId of resultIds) {
          pipeline.hgetall(keys.hook(hookId));
        }
        const results = await pipeline.exec();

        const data = results
          ?.filter(([err, val]) => !err && val && Object.keys(val as object).length > 0)
          .map(([, val]) => deserializeFromRedis<Hook>(val as Record<string, string>)!)
          .filter((h): h is Hook => h !== null) ?? [];

        const nextCursor = hasMore && data.length > 0 ? data[data.length - 1]?.hookId : null;

        return {
          data: data.map((h) => filterHookData(h, params.resolveData)),
          cursor: nextCursor ?? null,
          hasMore,
        };
      },

      async dispose(hookId, params): Promise<Hook> {
        const data = await redis.hgetall(keys.hook(hookId));
        const hook = deserializeFromRedis<Hook>(data);

        if (!hook) {
          throw new WorkflowAPIError(`Hook not found: ${hookId}`, { status: 404 });
        }

        const pipeline = redis.pipeline();
        pipeline.del(keys.hook(hookId));
        pipeline.del(keys.hookToken(hook.token));
        pipeline.srem(keys.hooksIdxRun(hook.runId), hookId);
        await pipeline.exec();

        return filterHookData(hook, params?.resolveData);
      },
    },
  };

  const appendEvent = legacyStorage.events.create.bind(
    legacyStorage.events
  ) as (
    runId: string,
    data: AnyEventRequest,
    params?: CreateEventParams
  ) => Promise<Event>;

  async function handleLegacyEvent(
    runId: string,
    data: AnyEventRequest,
    _currentRun: WorkflowRun,
    params?: CreateEventParams
  ): Promise<EventResult> {
    const resolveData = params?.resolveData ?? 'all';

    if (data.eventType === 'run_cancelled') {
      const run = await legacyStorage.runs.update(runId, {
        status: 'cancelled',
        output: undefined,
        error: undefined,
      });
      return { event: undefined, run: filterRunData(run, resolveData) };
    }

    if (data.eventType === 'wait_completed' || data.eventType === 'hook_received') {
      const event = await appendEvent(
        runId,
        { ...data, specVersion: SPEC_VERSION_CURRENT } as AnyEventRequest,
        params
      );
      return { event: filterEventData(event, resolveData) };
    }

    throw new WorkflowAPIError(
      `Event '${data.eventType}' is not supported for legacy runs`,
      { status: 409 }
    );
  }

  const storage = {
    runs: {
      async get(id: string, params?: any) {
        return legacyStorage.runs.get(id, params);
      },
      async list(params?: any) {
        return legacyStorage.runs.list(params);
      },
    },

    steps: {
      async get(runId: string | undefined, stepId: string, params?: any) {
        return legacyStorage.steps.get(runId, stepId, params);
      },
      async list(params: any) {
        return legacyStorage.steps.list(params);
      },
    },

    events: {
      async create(runId: string | null, data: AnyEventRequest, params?: CreateEventParams): Promise<EventResult> {
        const resolveData = params?.resolveData ?? 'all';
        const specVersion = data.specVersion ?? SPEC_VERSION_CURRENT;

        if (data.eventType === 'run_created') {
          const run = await legacyStorage.runs.create({
            runId: runId ?? undefined,
            deploymentId: data.eventData.deploymentId,
            workflowName: data.eventData.workflowName,
            input: data.eventData.input,
            executionContext: data.eventData.executionContext,
            specVersion,
          });
          const event = await appendEvent(
            run.runId,
            { ...data, specVersion } as AnyEventRequest,
            params
          );

          return {
            event: filterEventData(event, resolveData),
            run: filterRunData(run, resolveData),
          };
        }

        if (!runId) {
          throw new WorkflowAPIError('runId is required for this event type', {
            status: 400,
          });
        }

        const currentRun = await legacyStorage.runs.get(runId, {
          resolveData: 'all',
        });
        if (requiresNewerWorld(currentRun.specVersion)) {
          throw new RunNotSupportedError(
            currentRun.specVersion!,
            SPEC_VERSION_CURRENT
          );
        }
        if (isLegacySpecVersion(currentRun.specVersion)) {
          return handleLegacyEvent(runId, data, currentRun, params);
        }

        if (isTerminalRunStatus(currentRun.status)) {
          const runTerminalEvents = new Set([
            'run_started',
            'run_completed',
            'run_failed',
            'run_cancelled',
          ]);

          if (data.eventType === 'run_cancelled' && currentRun.status === 'cancelled') {
            const idempotentEvent = await appendEvent(
              runId,
              { ...data, specVersion } as AnyEventRequest,
              params
            );
            return {
              event: filterEventData(idempotentEvent, resolveData),
              run: filterRunData(currentRun, resolveData),
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

        let validatedStep: Step | undefined;
        const stepEvents = new Set([
          'step_started',
          'step_completed',
          'step_failed',
          'step_retrying',
        ]);

        if (stepEvents.has(data.eventType)) {
          if (!data.correlationId) {
            throw new WorkflowAPIError('Step events require correlationId', {
              status: 400,
            });
          }

          validatedStep = await legacyStorage.steps.get(runId, data.correlationId, {
            resolveData: 'all',
          });

          if (isTerminalStepStatus(validatedStep.status)) {
            throw new WorkflowAPIError(
              `Cannot modify step in terminal state '${validatedStep.status}'`,
              { status: 409 }
            );
          }

          if (isTerminalRunStatus(currentRun.status) && validatedStep.status !== 'running') {
            throw new WorkflowAPIError(
              `Cannot modify non-running step on terminal run '${currentRun.status}'`,
              { status: 410 }
            );
          }
        }

        if (
          (data.eventType === 'hook_received' || data.eventType === 'hook_disposed') &&
          data.correlationId
        ) {
          await legacyStorage.hooks.get(data.correlationId, { resolveData: 'all' });
        }

        let run: WorkflowRun | undefined;
        let step: Step | undefined;
        let hook: Hook | undefined;

        switch (data.eventType) {
          case 'run_started':
            run = await legacyStorage.runs.update(runId, { status: 'running' });
            run.specVersion = currentRun.specVersion;
            break;
          case 'run_completed':
            run = await legacyStorage.runs.update(runId, {
              status: 'completed',
              output: data.eventData.output,
              error: undefined,
            });
            run.specVersion = currentRun.specVersion;
            break;
          case 'run_failed': {
            const message =
              typeof data.eventData.error === 'string'
                ? data.eventData.error
                : (data.eventData.error?.message ?? 'Unknown error');
            run = await legacyStorage.runs.update(runId, {
              status: 'failed',
              output: undefined,
              error: {
                message,
                stack: data.eventData.error?.stack,
                code: data.eventData.errorCode,
              },
            });
            run.specVersion = currentRun.specVersion;
            break;
          }
          case 'run_cancelled':
            run = await legacyStorage.runs.update(runId, {
              status: 'cancelled',
              output: undefined,
              error: undefined,
            });
            run.specVersion = currentRun.specVersion;
            break;
          case 'step_created': {
            const stepId = data.correlationId;
            if (!stepId) {
              throw new WorkflowAPIError(
                'correlationId is required for step_created',
                { status: 400 }
              );
            }
            try {
              await legacyStorage.steps.get(runId, stepId, { resolveData: 'none' });
              throw new WorkflowAPIError(`Step '${stepId}' already exists`, {
                status: 409,
              });
            } catch (error) {
              if (
                error instanceof WorkflowAPIError &&
                (error as { status?: number }).status === 404
              ) {
                // Step does not exist yet; continue with creation.
              } else if (error instanceof WorkflowAPIError) {
                throw error;
              } else {
                throw error;
              }
            }
            step = await legacyStorage.steps.create(runId, {
              stepId,
              stepName: data.eventData.stepName,
              input: data.eventData.input,
              specVersion,
            });
            break;
          }
          case 'step_started': {
            const stepId = data.correlationId;
            if (!stepId || !validatedStep) {
              throw new WorkflowAPIError(
                'correlationId is required for step_started',
                { status: 400 }
              );
            }
            if (validatedStep.retryAfter && validatedStep.retryAfter.getTime() > Date.now()) {
              const err = new WorkflowAPIError(
                `Cannot start step '${stepId}' before retryAfter`,
                { status: 425 }
              );
              (err as WorkflowAPIError & { meta?: Record<string, string> }).meta = {
                stepId,
                retryAfter: validatedStep.retryAfter.toISOString(),
              };
              throw err;
            }
            step = await legacyStorage.steps.update(runId, stepId, {
              status: 'running',
              attempt: validatedStep.attempt + 1,
              retryAfter: undefined,
            });
            break;
          }
          case 'step_completed': {
            const stepId = data.correlationId;
            if (!stepId) {
              throw new WorkflowAPIError(
                'correlationId is required for step_completed',
                { status: 400 }
              );
            }
            step = await legacyStorage.steps.update(runId, stepId, {
              status: 'completed',
              output: data.eventData.result,
              error: undefined,
            });
            break;
          }
          case 'step_failed': {
            const stepId = data.correlationId;
            if (!stepId) {
              throw new WorkflowAPIError(
                'correlationId is required for step_failed',
                { status: 400 }
              );
            }
            const message =
              typeof data.eventData.error === 'string'
                ? data.eventData.error
                : (data.eventData.error?.message ?? 'Unknown error');
            step = await legacyStorage.steps.update(runId, stepId, {
              status: 'failed',
              output: undefined,
              error: {
                message,
                stack: data.eventData.stack,
              },
            });
            break;
          }
          case 'step_retrying': {
            const stepId = data.correlationId;
            if (!stepId) {
              throw new WorkflowAPIError(
                'correlationId is required for step_retrying',
                { status: 400 }
              );
            }
            const message =
              typeof data.eventData.error === 'string'
                ? data.eventData.error
                : (data.eventData.error?.message ?? 'Unknown error');
            step = await legacyStorage.steps.update(runId, stepId, {
              status: 'pending',
              error: {
                message,
                stack: data.eventData.stack,
              },
              retryAfter: data.eventData.retryAfter,
            });
            break;
          }
          case 'hook_created': {
            const hookId = data.correlationId;
            if (!hookId) {
              throw new WorkflowAPIError(
                'correlationId is required for hook_created',
                { status: 400 }
              );
            }
            try {
              hook = await legacyStorage.hooks.create(
                runId,
                {
                  hookId,
                  token: data.eventData.token,
                  metadata: data.eventData.metadata,
                  specVersion,
                },
                params
              );
            } catch (error) {
              if (
                error instanceof WorkflowAPIError &&
                (error as { status?: number }).status === 409
              ) {
                const conflictEvent = await appendEvent(
                  runId,
                  {
                    eventType: 'hook_conflict',
                    correlationId: hookId,
                    eventData: { token: data.eventData.token },
                    specVersion,
                  } as unknown as AnyEventRequest,
                  params
                );
                return { event: filterEventData(conflictEvent, resolveData) };
              }
              throw error;
            }
            break;
          }
          case 'hook_disposed': {
            const hookId = data.correlationId;
            if (!hookId) {
              throw new WorkflowAPIError(
                'correlationId is required for hook_disposed',
                { status: 400 }
              );
            }
            hook = await legacyStorage.hooks.dispose(hookId, params);
            break;
          }
          case 'hook_received':
          case 'wait_created':
          case 'wait_completed':
            break;
          default: {
            const exhaustiveCheck: never = data as never;
            throw new WorkflowAPIError(
              `Unsupported event type: ${(exhaustiveCheck as { eventType: string }).eventType}`,
              { status: 400 }
            );
          }
        }

        const event = await appendEvent(
          runId,
          { ...data, specVersion } as AnyEventRequest,
          params
        );
        return {
          event: filterEventData(event, resolveData),
          run: run ? filterRunData(run, resolveData) : undefined,
          step: step ? filterStepData(step, resolveData) : undefined,
          hook: hook ? filterHookData(hook, resolveData) : undefined,
        };
      },

      async list(params: any) {
        return legacyStorage.events.list(params);
      },

      async listByCorrelationId(params: any) {
        return legacyStorage.events.listByCorrelationId(params);
      },
    },

    hooks: {
      async get(hookId: string, params?: any) {
        return legacyStorage.hooks.get(hookId, params);
      },

      async getByToken(token: string, params?: any) {
        return legacyStorage.hooks.getByToken(token, params);
      },

      async list(params: any) {
        return legacyStorage.hooks.list(params);
      },
    },
  };

  return { storage: storage as unknown as Storage };
}
