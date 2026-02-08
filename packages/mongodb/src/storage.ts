/**
 * MongoDB Storage Implementation (Event-Sourced)
 */

import {
  RunNotSupportedError,
  WorkflowAPIError,
  WorkflowRunNotFoundError,
} from '@workflow/errors';
import {
  isLegacySpecVersion,
  requiresNewerWorld,
  SPEC_VERSION_CURRENT,
  type AnyEventRequest,
  type CreateEventParams,
  type Event,
  type EventResult,
  type GetHookParams,
  type GetStepParams,
  type GetWorkflowRunParams,
  type Hook,
  type ListEventsByCorrelationIdParams,
  type ListEventsParams,
  type ListHooksParams,
  type ListWorkflowRunStepsParams,
  type ListWorkflowRunsParams,
  type PaginatedResponse,
  type RunCreatedEventRequest,
  type Step,
  type Storage,
  type WorkflowRun,
} from '@workflow/world';
import { MongoClient } from 'mongodb';
import { monotonicFactory } from 'ulid';

const generateUlid = monotonicFactory();

interface WorkflowRunDocument extends Omit<WorkflowRun, 'createdAt' | 'updatedAt' | 'startedAt' | 'completedAt'> {
  createdAt: Date;
  updatedAt: Date;
  startedAt?: Date;
  completedAt?: Date;
}

interface StepDocument extends Omit<Step, 'createdAt' | 'updatedAt' | 'startedAt' | 'completedAt'> {
  createdAt: Date;
  updatedAt: Date;
  startedAt?: Date;
  completedAt?: Date;
}

interface EventDocument extends Omit<Event, 'createdAt'> {
  createdAt: Date;
}

interface HookDocument extends Omit<Hook, 'createdAt'> {
  createdAt: Date;
}

function deepClone<T>(obj: T): T {
  return structuredClone(obj);
}

function isMongoBinaryLike(value: unknown): value is { _bsontype: string; value: () => Buffer } {
  return (
    typeof value === 'object' &&
    value !== null &&
    '_bsontype' in value &&
    (value as { _bsontype?: unknown })._bsontype === 'Binary' &&
    'value' in value &&
    typeof (value as { value?: unknown }).value === 'function'
  );
}

function isMongoDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 11000
  );
}

function stripUndefined<T>(doc: T): T {
  if (doc === null || doc === undefined) return doc;
  if (typeof doc !== 'object') return doc;
  if (ArrayBuffer.isView(doc)) return doc;
  if (isMongoBinaryLike(doc)) return doc.value() as T;
  if (Array.isArray(doc)) return doc.map(stripUndefined) as T;
  if (doc instanceof Date) return doc as T;

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(doc as object)) {
    if (value === undefined) continue;
    result[key] =
      typeof value === 'object' && value !== null && !(value instanceof Date)
        ? stripUndefined(value)
        : value;
  }
  return result as T;
}

function cleanMongoDoc<T>(doc: T): T {
  if (doc === null || doc === undefined) return doc;
  if (typeof doc !== 'object') return doc;
  if (ArrayBuffer.isView(doc)) return doc;
  if (isMongoBinaryLike(doc)) return doc.value() as T;
  if (Array.isArray(doc)) return doc.map(cleanMongoDoc) as T;
  if (doc instanceof Date) return doc;

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(doc as object)) {
    if (key === '_id') continue;
    result[key] =
      typeof value === 'object' && value !== null && !(value instanceof Date)
        ? cleanMongoDoc(value)
        : value;
  }
  return result as T;
}

function isTerminalRunStatus(status: WorkflowRun['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

function isTerminalStepStatus(status: Step['status']): boolean {
  return status === 'completed' || status === 'failed';
}

function filterRunData(
  run: WorkflowRun,
  resolveData: 'none' | 'all' = 'all'
): WorkflowRun {
  const cleaned = cleanMongoDoc(run);
  const base = {
    ...cleaned,
    error: cleaned.error ?? undefined,
    executionContext: cleaned.executionContext ?? undefined,
  } as WorkflowRun;

  if (resolveData === 'none') {
    return {
      ...base,
      input: undefined,
      output: undefined,
    } as WorkflowRun;
  }

  return deepClone(base);
}

function filterStepData(step: Step, resolveData: 'none' | 'all' = 'all'): Step {
  const cleaned = cleanMongoDoc(step);
  const base = {
    ...cleaned,
    error: cleaned.error ?? undefined,
  } as Step;

  if (resolveData === 'none') {
    return {
      ...base,
      input: undefined,
      output: undefined,
    } as Step;
  }

  return deepClone(base);
}

function filterEventData(event: Event, resolveData: 'none' | 'all' = 'all'): Event {
  const cleaned = cleanMongoDoc(event);
  if (resolveData === 'none') {
    const { eventData: _eventData, ...rest } = cleaned as Event & {
      eventData?: unknown;
    };
    return deepClone(rest as Event);
  }
  return deepClone(cleaned);
}

function filterHookData(hook: Hook, resolveData: 'none' | 'all' = 'all'): Hook {
  const cleaned = cleanMongoDoc(hook);
  if (resolveData === 'none') {
    const { metadata: _metadata, ...rest } = cleaned as Hook & {
      metadata?: unknown;
    };
    return deepClone(rest as Hook);
  }
  return deepClone(cleaned);
}

function resolveDataOption(params?: CreateEventParams): 'none' | 'all' {
  return params?.resolveData ?? 'all';
}

export interface MongoStorageConfig {
  mongoUrl?: string;
  databaseName?: string;
  client?: MongoClient;
}

export async function createStorage(config: MongoStorageConfig = {}): Promise<{
  storage: Storage;
  client: MongoClient;
  close: () => Promise<void>;
}> {
  const client =
    config.client ??
    new MongoClient(
      config.mongoUrl ?? process.env.WORKFLOW_MONGODB_URI ?? 'mongodb://localhost:27017'
    );

  if (!config.client) {
    await client.connect();
  }

  const db = client.db(
    config.databaseName ?? process.env.WORKFLOW_MONGODB_DATABASE_NAME ?? 'workflow'
  );

  const runsCollection = db.collection<WorkflowRunDocument>('runs');
  const stepsCollection = db.collection<StepDocument>('steps');
  const eventsCollection = db.collection<EventDocument>('events');
  const hooksCollection = db.collection<HookDocument>('hooks');

  await Promise.all([
    runsCollection.createIndex({ runId: 1 }, { unique: true }),
    runsCollection.createIndex({ workflowName: 1 }),
    runsCollection.createIndex({ status: 1 }),
    runsCollection.createIndex({ createdAt: -1 }),

    stepsCollection.createIndex({ runId: 1, stepId: 1 }, { unique: true }),
    stepsCollection.createIndex({ stepId: 1 }),
    stepsCollection.createIndex({ runId: 1, createdAt: 1 }),

    eventsCollection.createIndex({ eventId: 1 }, { unique: true }),
    eventsCollection.createIndex({ runId: 1, eventId: 1 }),
    eventsCollection.createIndex({ correlationId: 1 }),

    hooksCollection.createIndex({ hookId: 1 }, { unique: true }),
    hooksCollection.createIndex({ token: 1 }, { unique: true }),
    hooksCollection.createIndex({ runId: 1 }),
  ]);

  async function getRunById(runId: string): Promise<WorkflowRun | null> {
    const run = await runsCollection.findOne({ runId });
    return run ? (cleanMongoDoc(run) as WorkflowRun) : null;
  }

  async function upsertRun(run: WorkflowRun): Promise<void> {
    const serialized = stripUndefined(run) as WorkflowRunDocument;
    await runsCollection.replaceOne(
      { runId: run.runId },
      serialized,
      { upsert: true }
    );
  }

  async function getStepById(runId: string, stepId: string): Promise<Step | null> {
    const step = await stepsCollection.findOne({ runId, stepId });
    return step ? (cleanMongoDoc(step) as Step) : null;
  }

  async function upsertStep(step: Step): Promise<void> {
    const serialized = stripUndefined(step) as StepDocument;
    await stepsCollection.replaceOne(
      { runId: step.runId, stepId: step.stepId },
      serialized,
      { upsert: true }
    );
  }

  async function getHookById(hookId: string): Promise<Hook | null> {
    const hook = await hooksCollection.findOne({ hookId });
    return hook ? (cleanMongoDoc(hook) as Hook) : null;
  }

  async function getHookByToken(token: string): Promise<Hook | null> {
    const hook = await hooksCollection.findOne({ token });
    return hook ? (cleanMongoDoc(hook) as Hook) : null;
  }

  async function deleteAllHooksForRun(runId: string): Promise<void> {
    await hooksCollection.deleteMany({ runId });
  }

  async function handleLegacyEvent(
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
      await upsertRun(run);
      await deleteAllHooksForRun(runId);
      return {
        event: undefined,
        run: filterRunData(run, resolveData),
      };
    }

    if (data.eventType === 'wait_completed' || data.eventType === 'hook_received') {
      const event: Event = {
        ...data,
        runId,
        eventId: `evnt_${generateUlid()}`,
        createdAt: new Date(),
        specVersion: SPEC_VERSION_CURRENT,
      } as Event;
      await eventsCollection.insertOne(stripUndefined(event) as EventDocument);
      return { event: filterEventData(event, resolveData) };
    }

    throw new WorkflowAPIError(
      `Event '${data.eventType}' is not supported for legacy runs`,
      { status: 409 }
    );
  }

  const storage = {
    runs: {
      async get(id: string, params?: GetWorkflowRunParams) {
        const run = await getRunById(id);
        if (!run) {
          throw new WorkflowRunNotFoundError(id);
        }
        return filterRunData(run, params?.resolveData);
      },

      async list(params?: ListWorkflowRunsParams): Promise<PaginatedResponse<WorkflowRun>> {
        const filter: Record<string, unknown> = {};

        if (params?.workflowName) {
          filter.workflowName = params.workflowName;
        }
        if (params?.status) {
          filter.status = params.status;
        }

        const sortOrder = params?.pagination?.sortOrder ?? 'desc';
        const cursor = params?.pagination?.cursor;
        if (cursor) {
          filter.runId = sortOrder === 'desc' ? { $lt: cursor } : { $gt: cursor };
        }

        const limit = params?.pagination?.limit ?? 100;
        const results = await runsCollection
          .find(filter)
          .sort({ runId: sortOrder === 'desc' ? -1 : 1 })
          .limit(limit + 1)
          .toArray();

        const hasMore = results.length > limit;
        const rows = results.slice(0, limit);
        const data = rows.map((row) => cleanMongoDoc(row) as WorkflowRun);
        const nextCursor = hasMore && data.length > 0 ? data[data.length - 1].runId : null;

        return {
          data: data.map((run) => filterRunData(run, params?.resolveData)),
          cursor: nextCursor,
          hasMore,
        };
      },
    },

    steps: {
      async get(runId: string | undefined, stepId: string, params?: GetStepParams) {
        let step: Step | null;
        if (runId) {
          step = await getStepById(runId, stepId);
        } else {
          const raw = await stepsCollection.findOne({ stepId });
          step = raw ? (cleanMongoDoc(raw) as Step) : null;
        }

        if (!step) {
          throw new WorkflowAPIError(`Step not found: ${stepId}`, { status: 404 });
        }

        return filterStepData(step, params?.resolveData);
      },

      async list(params: ListWorkflowRunStepsParams): Promise<PaginatedResponse<Step>> {
        const filter: Record<string, unknown> = { runId: params.runId };
        const sortOrder = params.pagination?.sortOrder ?? 'desc';
        const limit = params.pagination?.limit ?? 100;

        const results = await stepsCollection
          .find(filter)
          .sort({ createdAt: sortOrder === 'desc' ? -1 : 1 })
          .limit(limit + 1)
          .toArray();

        const hasMore = results.length > limit;
        const rows = results.slice(0, limit);
        const data = rows.map((row) => cleanMongoDoc(row) as Step);
        const nextCursor = hasMore && data.length > 0 ? data[data.length - 1].stepId : null;

        return {
          data: data.map((step) => filterStepData(step, params.resolveData)),
          cursor: nextCursor,
          hasMore,
        };
      },
    },

    events: {
      async create(
        runId: string | null,
        data: AnyEventRequest,
        params?: CreateEventParams
      ): Promise<EventResult> {
        const now = new Date();
        const resolveData = resolveDataOption(params);
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

        const currentRun = await getRunById(effectiveRunId);

        if (currentRun) {
          if (requiresNewerWorld(currentRun.specVersion)) {
            throw new RunNotSupportedError(
              currentRun.specVersion as number,
              SPEC_VERSION_CURRENT
            );
          }

          if (isLegacySpecVersion(currentRun.specVersion)) {
            return handleLegacyEvent(effectiveRunId, data, currentRun, params);
          }

          if (isTerminalRunStatus(currentRun.status)) {
            const runTerminalEvents = new Set([
              'run_started',
              'run_completed',
              'run_failed',
              'run_cancelled',
            ]);

            if (data.eventType === 'run_cancelled' && currentRun.status === 'cancelled') {
              const idempotentEvent: Event = {
                ...data,
                runId: effectiveRunId,
                eventId: `evnt_${generateUlid()}`,
                createdAt: now,
                specVersion: effectiveSpecVersion,
              } as Event;
              await eventsCollection.insertOne(
                stripUndefined(idempotentEvent) as EventDocument
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
        }

        if (!currentRun && data.eventType !== 'run_created') {
          throw new WorkflowAPIError(`Run not found: ${effectiveRunId}`, {
            status: 404,
          });
        }

        let validatedStep: Step | null = null;
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

          validatedStep = await getStepById(effectiveRunId, data.correlationId);
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
          const existingHook = await getHookById(data.correlationId);
          if (!existingHook) {
            throw new WorkflowAPIError(`Hook '${data.correlationId}' not found`, {
              status: 404,
            });
          }
        }

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
            input: stripUndefined(runData.input),
            output: undefined,
            error: undefined,
            startedAt: undefined,
            completedAt: undefined,
            createdAt: now,
            updatedAt: now,
          };
          await upsertRun(run);
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
          await upsertRun(run);
        } else if (data.eventType === 'run_completed') {
          if (!currentRun) {
            throw new WorkflowAPIError(`Run not found: ${effectiveRunId}`, { status: 404 });
          }
          run = {
            ...currentRun,
            status: 'completed',
            output: stripUndefined(data.eventData?.output),
            error: undefined,
            completedAt: now,
            updatedAt: now,
          };
          await upsertRun(run);
          await deleteAllHooksForRun(run.runId);
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
              stack: data.eventData.error?.stack,
              code: data.eventData.errorCode,
            },
            completedAt: now,
            updatedAt: now,
          };
          await upsertRun(run);
          await deleteAllHooksForRun(run.runId);
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
          await upsertRun(run);
          await deleteAllHooksForRun(run.runId);
        } else if (data.eventType === 'step_created') {
          const existingStep = await getStepById(effectiveRunId, data.correlationId);
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
            input: stripUndefined(data.eventData.input),
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
          await upsertStep(step);
        } else if (data.eventType === 'step_started') {
          if (!validatedStep || !data.correlationId) {
            throw new WorkflowAPIError('Step not found for step_started', { status: 404 });
          }

          if (validatedStep.retryAfter && validatedStep.retryAfter.getTime() > Date.now()) {
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
          await upsertStep(step);
        } else if (data.eventType === 'step_completed') {
          if (!validatedStep) {
            throw new WorkflowAPIError('Step not found for step_completed', { status: 404 });
          }
          step = {
            ...validatedStep,
            status: 'completed',
            output: stripUndefined(data.eventData.result),
            completedAt: now,
            updatedAt: now,
          };
          await upsertStep(step);
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
          await upsertStep(step);
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
          await upsertStep(step);
        } else if (data.eventType === 'hook_created') {
          const existingByToken = await getHookByToken(data.eventData.token);
          if (existingByToken) {
            const conflictEvent: Event = {
              eventType: 'hook_conflict',
              correlationId: data.correlationId,
              eventData: { token: data.eventData.token },
              runId: effectiveRunId,
              eventId: `evnt_${generateUlid()}`,
              createdAt: now,
              specVersion: effectiveSpecVersion,
            } as Event;
            await eventsCollection.insertOne(stripUndefined(conflictEvent) as EventDocument);
            return {
              event: filterEventData(conflictEvent, resolveData),
              run,
              step,
              hook: undefined,
            };
          }

          const existingById = await getHookById(data.correlationId);
          if (existingById) {
            throw new WorkflowAPIError(`Hook '${data.correlationId}' already exists`, {
              status: 409,
            });
          }

          hook = {
            runId: effectiveRunId,
            hookId: data.correlationId,
            token: data.eventData.token,
            metadata: stripUndefined(data.eventData.metadata),
            ownerId: 'mongodb-owner',
            projectId: 'mongodb-project',
            environment: 'development',
            createdAt: now,
            specVersion: effectiveSpecVersion,
          };
          try {
            await hooksCollection.insertOne(stripUndefined(hook) as HookDocument);
          } catch (error) {
            if (isMongoDuplicateKeyError(error)) {
              const conflictEvent: Event = {
                eventType: 'hook_conflict',
                correlationId: data.correlationId,
                eventData: { token: data.eventData.token },
                runId: effectiveRunId,
                eventId: `wevt_${generateUlid()}`,
                createdAt: now,
                specVersion: effectiveSpecVersion,
              } as Event;
              await eventsCollection.insertOne(stripUndefined(conflictEvent) as EventDocument);
              return {
                event: filterEventData(conflictEvent, resolveData),
                run,
                step,
                hook: undefined,
              };
            }
            throw error;
          }
        } else if (data.eventType === 'hook_disposed') {
          if (data.correlationId) {
            await hooksCollection.deleteOne({ hookId: data.correlationId });
          }
        }

        const event: Event = {
          ...data,
          runId: effectiveRunId,
          eventId: `evnt_${generateUlid()}`,
          createdAt: now,
          specVersion: effectiveSpecVersion,
        } as Event;

        await eventsCollection.insertOne(stripUndefined(event) as EventDocument);

        return {
          event: filterEventData(event, resolveData),
          run: run ? deepClone(run) : undefined,
          step: step ? deepClone(step) : undefined,
          hook: hook ? deepClone(hook) : undefined,
        };
      },

      async list(params: ListEventsParams): Promise<PaginatedResponse<Event>> {
        const filter: Record<string, unknown> = { runId: params.runId };

        const sortOrder = params.pagination?.sortOrder ?? 'asc';
        const limit = params.pagination?.limit ?? 10000;
        const cursor = params.pagination?.cursor;

        if (cursor) {
          filter.eventId = sortOrder === 'asc' ? { $gt: cursor } : { $lt: cursor };
        }

        const results = await eventsCollection
          .find(filter)
          .sort({ eventId: sortOrder === 'asc' ? 1 : -1 })
          .limit(limit + 1)
          .toArray();

        const hasMore = results.length > limit;
        const rows = results.slice(0, limit);
        const data = rows.map((row) => cleanMongoDoc(row) as Event);
        const nextCursor = hasMore && data.length > 0 ? data[data.length - 1].eventId : null;

        return {
          data: data.map((event) => filterEventData(event, params.resolveData)),
          cursor: nextCursor,
          hasMore,
        };
      },

      async listByCorrelationId(
        params: ListEventsByCorrelationIdParams
      ): Promise<PaginatedResponse<Event>> {
        const filter: Record<string, unknown> = {
          correlationId: params.correlationId,
        };

        const sortOrder = params.pagination?.sortOrder ?? 'asc';
        const limit = params.pagination?.limit ?? 100;
        const cursor = params.pagination?.cursor;

        if (cursor) {
          filter.eventId = sortOrder === 'asc' ? { $gt: cursor } : { $lt: cursor };
        }

        const results = await eventsCollection
          .find(filter)
          .sort({ eventId: sortOrder === 'asc' ? 1 : -1 })
          .limit(limit + 1)
          .toArray();

        const hasMore = results.length > limit;
        const rows = results.slice(0, limit);
        const data = rows.map((row) => cleanMongoDoc(row) as Event);
        const nextCursor = hasMore && data.length > 0 ? data[data.length - 1].eventId : null;

        return {
          data: data.map((event) => filterEventData(event, params.resolveData)),
          cursor: nextCursor,
          hasMore,
        };
      },
    },

    hooks: {
      async get(hookId: string, params?: GetHookParams) {
        const hook = await getHookById(hookId);
        if (!hook) {
          throw new WorkflowAPIError(`Hook not found: ${hookId}`, { status: 404 });
        }
        return filterHookData(hook, params?.resolveData);
      },

      async getByToken(token: string, params?: GetHookParams) {
        const hook = await getHookByToken(token);
        if (!hook) {
          throw new WorkflowAPIError(`Hook not found for token: ${token}`, {
            status: 404,
          });
        }
        return filterHookData(hook, params?.resolveData);
      },

      async list(params: ListHooksParams): Promise<PaginatedResponse<Hook>> {
        const filter: Record<string, unknown> = {};
        if (params.runId) {
          filter.runId = params.runId;
        }

        const limit = params.pagination?.limit ?? 100;
        const results = await hooksCollection.find(filter).limit(limit + 1).toArray();

        const hasMore = results.length > limit;
        const rows = results.slice(0, limit);
        const data = rows.map((row) => cleanMongoDoc(row) as Hook);
        const nextCursor = hasMore && data.length > 0 ? data[data.length - 1].hookId : null;

        return {
          data: data.map((hook) => filterHookData(hook, params.resolveData)),
          cursor: nextCursor,
          hasMore,
        };
      },
    },
  };

  return {
    storage: storage as unknown as Storage,
    client,
    close: async () => {
      if (!config.client) {
        await client.close();
      }
    },
  };
}
