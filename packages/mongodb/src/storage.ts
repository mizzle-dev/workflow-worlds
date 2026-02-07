/**
 * MongoDB Storage Implementation
 *
 * This file implements the Storage interface using MongoDB.
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
import { MongoClient } from 'mongodb';
import { monotonicFactory } from 'ulid';

// Monotonic ULID factory ensures IDs are always increasing
const generateUlid = monotonicFactory();

/**
 * MongoDB document interfaces that match our storage types
 */
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

/**
 * Helper to strip undefined values before storing in MongoDB.
 * MongoDB converts undefined to null, so we remove undefined keys entirely.
 * This preserves the semantic difference between explicit null and undefined.
 */
function stripUndefined<T>(doc: T): T {
  if (doc === null || doc === undefined) return doc;
  if (typeof doc !== 'object') return doc;
  if (Array.isArray(doc)) return doc.map(stripUndefined) as T;
  if (doc instanceof Date) return doc as T;

  const result: any = {};
  for (const [key, value] of Object.entries(doc as object)) {
    if (value === undefined) continue; // Skip undefined values
    result[key] = (typeof value === 'object' && value !== null && !(value instanceof Date))
      ? stripUndefined(value)
      : value;
  }
  return result;
}

/**
 * Helper to clean MongoDB documents.
 * Removes the MongoDB _id field and recursively cleans nested objects.
 * Preserves null values (does not convert to undefined).
 */
function cleanMongoDoc<T>(doc: T): T {
  if (doc === null) return null as T; // Preserve null at top level
  if (doc === undefined) return undefined as T;
  if (typeof doc !== 'object') return doc;
  if (Array.isArray(doc)) return doc.map(cleanMongoDoc) as T;
  if (doc instanceof Date) return doc as T;

  const result: any = {};
  for (const [key, value] of Object.entries(doc as object)) {
    if (key === '_id') continue; // Skip MongoDB _id field
    // Preserve null values - don't convert to undefined
    result[key] = (typeof value === 'object' && value !== null && !(value instanceof Date))
      ? cleanMongoDoc(value)
      : value;
  }
  return result;
}

/**
 * Helper to filter data based on resolveData setting.
 */
function filterRunData(
  run: WorkflowRun,
  resolveData: 'none' | 'all' = 'all'
): WorkflowRun {
  const cleaned = cleanMongoDoc(run);
  // error and executionContext should be undefined when not set (null from DB means not set)
  const result = {
    ...cleaned,
    error: cleaned.error ?? undefined,
    executionContext: cleaned.executionContext ?? undefined,
  } as WorkflowRun;
  if (resolveData === 'none') {
    return { ...result, input: [], output: undefined } as WorkflowRun;
  }
  return result;
}

function filterStepData(step: Step, resolveData: 'none' | 'all' = 'all'): Step {
  const cleaned = cleanMongoDoc(step);
  // error should be undefined when not set (null from DB means no error)
  const result = { ...cleaned, error: (cleaned.error ?? undefined) as Step['error'] };
  if (resolveData === 'none') {
    return { ...result, input: [], output: undefined };
  }
  return result;
}

function filterEventData(
  event: Event,
  resolveData: 'none' | 'all' = 'all'
): Event {
  const cleaned = cleanMongoDoc(event);
  if (resolveData === 'none') {
    const { eventData, ...rest } = cleaned as any;
    return rest;
  }
  return cleaned;
}

function filterHookData(hook: Hook, resolveData: 'none' | 'all' = 'all'): Hook {
  const cleaned = cleanMongoDoc(hook);
  if (resolveData === 'none') {
    const { metadata, ...rest } = cleaned as any;
    return rest;
  }
  return cleaned;
}

export interface MongoStorageConfig {
  /**
   * MongoDB connection string.
   * If not provided, uses WORKFLOW_MONGODB_URI environment variable.
   * Default: 'mongodb://localhost:27017'
   */
  mongoUrl?: string;

  /**
   * Database name to use.
   * If not provided, uses WORKFLOW_MONGODB_DATABASE_NAME environment variable.
   * Default: 'workflow'
   */
  databaseName?: string;

  /**
   * Optional MongoDB client instance.
   * If provided, mongoUrl will be ignored.
   */
  client?: MongoClient;
}

/**
 * Creates the Storage implementation using MongoDB.
 */
export async function createStorage(config: MongoStorageConfig = {}): Promise<{
  storage: Storage;
  client: MongoClient;
  close: () => Promise<void>;
}> {
  // Get or create MongoDB client
  const client = config.client ?? new MongoClient(
    config.mongoUrl ?? process.env.WORKFLOW_MONGODB_URI ?? 'mongodb://localhost:27017'
  );

  // Connect if we created the client
  if (!config.client) {
    await client.connect();
  }

  const db = client.db(
    config.databaseName ?? process.env.WORKFLOW_MONGODB_DATABASE_NAME ?? 'workflow'
  );

  // Get collections
  const runsCollection = db.collection<WorkflowRunDocument>('runs');
  const stepsCollection = db.collection<StepDocument>('steps');
  const eventsCollection = db.collection<EventDocument>('events');
  const hooksCollection = db.collection<HookDocument>('hooks');

  // Create indexes
  await Promise.all([
    // Runs indexes
    runsCollection.createIndex({ runId: 1 }, { unique: true }),
    runsCollection.createIndex({ workflowName: 1 }),
    runsCollection.createIndex({ status: 1 }),
    runsCollection.createIndex({ createdAt: -1 }),

    // Steps indexes
    stepsCollection.createIndex({ runId: 1, stepId: 1 }, { unique: true }),
    stepsCollection.createIndex({ stepId: 1 }),
    stepsCollection.createIndex({ runId: 1, createdAt: 1 }),

    // Events indexes
    eventsCollection.createIndex({ eventId: 1 }, { unique: true }),
    eventsCollection.createIndex({ runId: 1, eventId: 1 }),
    eventsCollection.createIndex({ correlationId: 1 }),

    // Hooks indexes
    hooksCollection.createIndex({ hookId: 1 }, { unique: true }),
    hooksCollection.createIndex({ token: 1 }, { unique: true }),
    hooksCollection.createIndex({ runId: 1 }),
  ]);

  const storage: Storage = {
    // =========================================================================
    // RUNS STORAGE
    // =========================================================================
    runs: {
      async create(data: CreateWorkflowRunRequest): Promise<WorkflowRun> {
        const runId = `wrun_${generateUlid()}`;
        const now = new Date();

        const run: WorkflowRunDocument = {
          runId,
          deploymentId: data.deploymentId,
          status: 'pending',
          workflowName: data.workflowName,
          // Strip undefined values to prevent MongoDB converting them to null
          input: stripUndefined((data.input ?? []) as unknown[]),
          output: undefined,
          error: undefined,
          executionContext: stripUndefined(data.executionContext as
            | Record<string, unknown>
            | undefined),
          startedAt: undefined,
          completedAt: undefined,
          createdAt: now,
          updatedAt: now,
        };

        await runsCollection.insertOne(run);
        return cleanMongoDoc(run) as WorkflowRun;
      },

      async get(id, params): Promise<WorkflowRun> {
        const run = await runsCollection.findOne({ runId: id });
        if (!run) {
          throw new WorkflowAPIError(`Run not found: ${id}`, { status: 404 });
        }
        return filterRunData(run as WorkflowRun, params?.resolveData);
      },

      async update(id, data: UpdateWorkflowRunRequest): Promise<WorkflowRun> {
        const existing = await runsCollection.findOne({ runId: id });
        if (!existing) {
          throw new WorkflowAPIError(`Run not found: ${id}`, { status: 404 });
        }

        const now = new Date();
        // Strip undefined values from complex fields
        const strippedData = {
          ...data,
          output: data.output !== undefined ? stripUndefined(data.output) : undefined,
          executionContext: data.executionContext !== undefined ? stripUndefined(data.executionContext) : undefined,
        };
        const updated: Partial<WorkflowRunDocument> = {
          ...strippedData,
          updatedAt: now,
        };

        // Only set startedAt the first time status becomes 'running'
        if (data.status === 'running' && !existing.startedAt) {
          updated.startedAt = now;
        }

        // Set completedAt on terminal states
        const isTerminal =
          data.status === 'completed' ||
          data.status === 'failed' ||
          data.status === 'cancelled';

        if (isTerminal) {
          updated.completedAt = now;

          // Clean up all hooks for this run
          await hooksCollection.deleteMany({ runId: id });
        }

        const result = await runsCollection.findOneAndUpdate(
          { runId: id },
          { $set: updated },
          { returnDocument: 'after' }
        );

        if (!result) {
          throw new WorkflowAPIError(`Run not found: ${id}`, { status: 404 });
        }

        return cleanMongoDoc(result) as WorkflowRun;
      },

      async list(params): Promise<PaginatedResponse<WorkflowRun>> {
        const filter: any = {};

        // Apply filters
        if (params?.workflowName) {
          filter.workflowName = params.workflowName;
        }
        if (params?.status) {
          filter.status = params.status;
        }

        // Apply cursor
        const sortOrder = params?.pagination?.sortOrder ?? 'desc';
        const cursor = params?.pagination?.cursor;
        if (cursor) {
          filter.runId = sortOrder === 'desc' ? { $lt: cursor } : { $gt: cursor };
        }

        const limit = params?.pagination?.limit ?? 100;

        // Fetch one extra to determine hasMore
        const results = await runsCollection
          .find(filter)
          .sort({ runId: sortOrder === 'desc' ? -1 : 1 })
          .limit(limit + 1)
          .toArray();

        const hasMore = results.length > limit;
        const data = results.slice(0, limit);
        const nextCursor = hasMore && data.length > 0
          ? data[data.length - 1].runId
          : null;

        return {
          data: data.map((r) => filterRunData(r as WorkflowRun, params?.resolveData)),
          cursor: nextCursor,
          hasMore,
        };
      },

      async cancel(id, params): Promise<WorkflowRun> {
        const run = await this.update(id, { status: 'cancelled' });
        return filterRunData(run, params?.resolveData);
      },
    },

    // =========================================================================
    // STEPS STORAGE
    // =========================================================================
    steps: {
      async create(runId, data: CreateStepRequest): Promise<Step> {
        const now = new Date();

        const step: StepDocument = {
          runId,
          stepId: data.stepId,
          stepName: data.stepName,
          status: 'pending',
          // Strip undefined values to prevent MongoDB converting them to null
          input: stripUndefined(data.input as unknown[]),
          output: undefined,
          error: undefined,
          attempt: 0,
          startedAt: undefined,
          completedAt: undefined,
          createdAt: now,
          updatedAt: now,
        };

        // Use findOneAndUpdate with upsert to handle idempotent step creation
        // If step already exists, return the existing one; otherwise insert
        const result = await stepsCollection.findOneAndUpdate(
          { runId, stepId: data.stepId },
          { $setOnInsert: step },
          { upsert: true, returnDocument: 'after' }
        );

        return cleanMongoDoc(result) as Step;
      },

      async get(runId, stepId, params): Promise<Step> {
        let step: StepDocument | null;

        if (!runId) {
          // Search all steps for this stepId
          step = await stepsCollection.findOne({ stepId });
        } else {
          step = await stepsCollection.findOne({ runId, stepId });
        }

        if (!step) {
          throw new WorkflowAPIError(`Step not found: ${stepId}`, { status: 404 });
        }
        return filterStepData(step as Step, params?.resolveData);
      },

      async update(runId, stepId, data: UpdateStepRequest): Promise<Step> {
        const existing = await stepsCollection.findOne({ runId, stepId });
        if (!existing) {
          throw new WorkflowAPIError(`Step not found: ${stepId}`, { status: 404 });
        }

        const now = new Date();
        // Strip undefined values from complex fields
        const strippedData = {
          ...data,
          output: data.output !== undefined ? stripUndefined(data.output) : undefined,
        };
        const updated: Partial<StepDocument> = {
          ...strippedData,
          updatedAt: now,
        };

        // Set startedAt only once when status becomes 'running'
        if (data.status === 'running' && !existing.startedAt) {
          updated.startedAt = now;
        }

        // Set completedAt on terminal states
        if (data.status === 'completed' || data.status === 'failed') {
          updated.completedAt = now;
        }

        const result = await stepsCollection.findOneAndUpdate(
          { runId, stepId },
          { $set: updated },
          { returnDocument: 'after' }
        );

        if (!result) {
          throw new WorkflowAPIError(`Step not found: ${stepId}`, { status: 404 });
        }

        return cleanMongoDoc(result) as Step;
      },

      async list(params): Promise<PaginatedResponse<Step>> {
        const filter: any = { runId: params.runId };

        const sortOrder = params.pagination?.sortOrder ?? 'desc';
        const limit = params.pagination?.limit ?? 100;

        const results = await stepsCollection
          .find(filter)
          .sort({ createdAt: sortOrder === 'desc' ? -1 : 1 })
          .limit(limit + 1)
          .toArray();

        const hasMore = results.length > limit;
        const data = results.slice(0, limit);
        const nextCursor = hasMore && data.length > 0
          ? data[data.length - 1].stepId
          : null;

        return {
          data: data.map((s) => filterStepData(s as Step, params.resolveData)),
          cursor: nextCursor,
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

        const event: EventDocument = {
          ...data,
          runId,
          eventId,
          createdAt: now,
        };

        await eventsCollection.insertOne(event);
        return filterEventData(event as Event, params?.resolveData);
      },

      async list(params): Promise<PaginatedResponse<Event>> {
        const filter: any = { runId: params.runId };

        // Events default to ascending order (oldest first) for replay
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
        const data = results.slice(0, limit);
        const nextCursor = hasMore && data.length > 0
          ? data[data.length - 1].eventId
          : null;

        return {
          data: data.map((e) => filterEventData(e as Event, params.resolveData)),
          cursor: nextCursor,
          hasMore,
        };
      },

      async listByCorrelationId(params): Promise<PaginatedResponse<Event>> {
        const filter: any = { correlationId: params.correlationId };

        const sortOrder = params.pagination?.sortOrder ?? 'asc';
        const limit = params.pagination?.limit ?? 100;

        const results = await eventsCollection
          .find(filter)
          .sort({ eventId: sortOrder === 'asc' ? 1 : -1 })
          .limit(limit + 1)
          .toArray();

        const hasMore = results.length > limit;
        const data = results.slice(0, limit);
        const nextCursor = hasMore && data.length > 0
          ? data[data.length - 1].eventId
          : null;

        return {
          data: data.map((e) => filterEventData(e as Event, params.resolveData)),
          cursor: nextCursor,
          hasMore,
        };
      },
    },

    // =========================================================================
    // HOOKS STORAGE
    // =========================================================================
    hooks: {
      async create(runId, data: CreateHookRequest, params): Promise<Hook> {
        // Check for token uniqueness
        const existing = await hooksCollection.findOne({ token: data.token });
        if (existing) {
          throw new WorkflowAPIError(
            `Hook with token ${data.token} already exists`,
            { status: 409 }
          );
        }

        const now = new Date();
        const hook: HookDocument = {
          runId,
          hookId: data.hookId,
          token: data.token,
          metadata: data.metadata,
          ownerId: 'mongodb-owner',
          projectId: 'mongodb-project',
          environment: 'development',
          createdAt: now,
        };

        await hooksCollection.insertOne(hook);
        return filterHookData(hook as Hook, params?.resolveData);
      },

      async get(hookId, params): Promise<Hook> {
        const hook = await hooksCollection.findOne({ hookId });
        if (!hook) {
          throw new WorkflowAPIError(`Hook not found: ${hookId}`, {
            status: 404,
          });
        }
        return filterHookData(hook as Hook, params?.resolveData);
      },

      async getByToken(token, params): Promise<Hook> {
        const hook = await hooksCollection.findOne({ token });
        if (!hook) {
          throw new WorkflowAPIError(`Hook not found for token: ${token}`, {
            status: 404,
          });
        }
        return filterHookData(hook as Hook, params?.resolveData);
      },

      async list(params): Promise<PaginatedResponse<Hook>> {
        const filter: any = {};

        if (params.runId) {
          filter.runId = params.runId;
        }

        const limit = params.pagination?.limit ?? 100;

        const results = await hooksCollection
          .find(filter)
          .limit(limit + 1)
          .toArray();

        const hasMore = results.length > limit;
        const data = results.slice(0, limit);
        const nextCursor = hasMore && data.length > 0
          ? data[data.length - 1].hookId
          : null;

        return {
          data: data.map((h) => filterHookData(h as Hook, params.resolveData)),
          cursor: nextCursor,
          hasMore,
        };
      },

      async dispose(hookId, params): Promise<Hook> {
        const hook = await hooksCollection.findOne({ hookId });
        if (!hook) {
          throw new WorkflowAPIError(`Hook not found: ${hookId}`, {
            status: 404,
          });
        }

        await hooksCollection.deleteOne({ hookId });
        return filterHookData(hook as Hook, params?.resolveData);
      },
    },
  };

  return {
    storage,
    client,
    close: async () => {
      if (!config.client) {
        await client.close();
      }
    },
  };
}
