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
  CreateWorkflowRunRequest,
  UpdateWorkflowRunRequest,
  CreateStepRequest,
  UpdateStepRequest,
  CreateEventRequest,
  CreateHookRequest,
  PaginatedResponse,
} from '@workflow/world';
import { WorkflowAPIError } from '@workflow/errors';
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
    return { ...cloned, input: [], output: undefined };
  }
  return cloned;
}

function filterStepData(step: Step, resolveData: 'none' | 'all' = 'all'): Step {
  const cloned = deepClone(step);
  if (resolveData === 'none') {
    return { ...cloned, input: [], output: undefined };
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

  const storage: Storage = {
    // =========================================================================
    // RUNS STORAGE
    // =========================================================================
    runs: {
      async create(data: CreateWorkflowRunRequest): Promise<WorkflowRun> {
        const runId = `wrun_${generateUlid()}`;
        const now = new Date();
        const score = ulidToScore(runId);

        const run: WorkflowRun = {
          runId,
          deploymentId: data.deploymentId,
          status: 'pending',
          workflowName: data.workflowName,
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

      async cancel(id, params): Promise<WorkflowRun> {
        const run = await this.update(id, { status: 'cancelled' });
        return filterRunData(run, params?.resolveData);
      },

      async pause(id, params): Promise<WorkflowRun> {
        const run = await this.update(id, { status: 'paused' });
        return filterRunData(run, params?.resolveData);
      },

      async resume(id, params): Promise<WorkflowRun> {
        const run = await this.update(id, { status: 'running' });
        return filterRunData(run, params?.resolveData);
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
      async create(runId, data: CreateEventRequest, params): Promise<Event> {
        const eventId = `wevt_${generateUlid()}`;
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
              `${prefix}:hooks:whook_*`,
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

  return { storage };
}
