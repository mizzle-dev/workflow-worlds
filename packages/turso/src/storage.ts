/**
 * Turso Storage Implementation
 *
 * Implements the Storage interface using Turso/libSQL with Drizzle ORM.
 * Uses CBOR columns for type-preserving data storage.
 */

import type { Client } from '@libsql/client';
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
import { drizzle } from 'drizzle-orm/libsql';
import { eq, desc, asc, gt, lt, and } from 'drizzle-orm';
import * as schema from './drizzle/schema.js';

const generateUlid = monotonicFactory();

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Deep clone an object to prevent mutation of stored data.
 */
function deepClone<T>(obj: T): T {
  return structuredClone(obj);
}

/**
 * Converts ISO string to Date or undefined.
 */
function toDate(value: string | null | undefined): Date | undefined {
  if (!value) return undefined;
  return new Date(value);
}

/**
 * Converts Date to ISO string or null.
 */
function toIsoString(date: Date | undefined): string | null {
  if (!date) return null;
  return date.toISOString();
}

// =============================================================================
// Filter Functions
// =============================================================================

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

// =============================================================================
// Row Conversion Functions
// =============================================================================

type RunRow = typeof schema.runs.$inferSelect;
type StepRow = typeof schema.steps.$inferSelect;
type EventRow = typeof schema.events.$inferSelect;
type HookRow = typeof schema.hooks.$inferSelect;

function toWorkflowRun(row: RunRow): WorkflowRun {
  return {
    runId: row.runId,
    deploymentId: row.deploymentId,
    workflowName: row.workflowName,
    status: row.status,
    input: row.input ?? [],
    output: row.output ?? undefined,
    error: row.error ?? undefined,
    executionContext: row.executionContext ?? undefined,
    startedAt: toDate(row.startedAt),
    completedAt: toDate(row.completedAt),
    createdAt: toDate(row.createdAt) ?? new Date(),
    updatedAt: toDate(row.updatedAt) ?? new Date(),
  } as WorkflowRun;
}

function toStep(row: StepRow): Step {
  return {
    runId: row.runId,
    stepId: row.stepId,
    stepName: row.stepName ?? '',
    status: row.status as Step['status'],
    input: row.input ?? [],
    output: row.output ?? undefined,
    error: (row.error ?? undefined) as Step['error'],
    attempt: row.attempt ?? 0,
    startedAt: toDate(row.startedAt),
    completedAt: toDate(row.completedAt),
    createdAt: toDate(row.createdAt) ?? new Date(),
    updatedAt: toDate(row.updatedAt) ?? new Date(),
  };
}

function toEvent(row: EventRow): Event {
  const payload = row.payload ?? {};
  return {
    eventId: row.eventId,
    runId: row.runId,
    createdAt: toDate(row.createdAt) ?? new Date(),
    ...payload,
  } as Event;
}

function toHook(row: HookRow): Hook {
  return {
    hookId: row.hookId,
    runId: row.runId,
    token: row.token,
    metadata: row.metadata ?? undefined,
    ownerId: row.ownerId,
    projectId: row.projectId,
    environment: row.environment,
    createdAt: toDate(row.createdAt) ?? new Date(),
  };
}

// =============================================================================
// Storage Implementation
// =============================================================================

export interface StorageConfig {
  client: Client;
}

/**
 * Creates the Storage implementation using Turso/libSQL with Drizzle ORM.
 */
export function createStorage(config: StorageConfig): Storage {
  const db = drizzle(config.client, { schema });

  return {
    // =========================================================================
    // RUNS STORAGE
    // =========================================================================
    runs: {
      async create(data: CreateWorkflowRunRequest): Promise<WorkflowRun> {
        const runId = `wrun_${generateUlid()}`;
        const now = new Date();
        const nowStr = now.toISOString();

        await db.insert(schema.runs).values({
          runId,
          deploymentId: data.deploymentId,
          workflowName: data.workflowName,
          status: 'pending',
          input: (data.input ?? []) as unknown[],
          executionContext: data.executionContext as Record<string, unknown>,
          createdAt: nowStr,
          updatedAt: nowStr,
        });

        return {
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
      },

      async get(id, params): Promise<WorkflowRun> {
        const result = await db
          .select()
          .from(schema.runs)
          .where(eq(schema.runs.runId, id))
          .limit(1);

        if (result.length === 0) {
          throw new WorkflowAPIError(`Run not found: ${id}`, { status: 404 });
        }

        const run = toWorkflowRun(result[0]);
        return filterRunData(run, params?.resolveData);
      },

      async update(id, data: UpdateWorkflowRunRequest): Promise<WorkflowRun> {
        // First, get the existing run
        const existing = await this.get(id);
        const now = new Date();
        const nowStr = now.toISOString();

        // Build the updated run
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

          // Clean up all hooks for this run
          await db.delete(schema.hooks).where(eq(schema.hooks.runId, id));
        }

        // Update the database
        await db
          .update(schema.runs)
          .set({
            status: updated.status,
            input: updated.input as unknown[],
            output: updated.output,
            error: updated.error,
            executionContext: updated.executionContext,
            startedAt: toIsoString(updated.startedAt),
            completedAt: toIsoString(updated.completedAt),
            updatedAt: nowStr,
          })
          .where(eq(schema.runs.runId, id));

        return updated;
      },

      async list(params): Promise<PaginatedResponse<WorkflowRun>> {
        const sortOrder = params?.pagination?.sortOrder ?? 'desc';
        const limit = params?.pagination?.limit ?? 100;
        const cursor = params?.pagination?.cursor;

        // Build conditions
        const conditions = [];

        if (params?.workflowName) {
          conditions.push(eq(schema.runs.workflowName, params.workflowName));
        }
        if (params?.status) {
          conditions.push(eq(schema.runs.status, params.status));
        }
        if (cursor) {
          if (sortOrder === 'desc') {
            conditions.push(lt(schema.runs.runId, cursor));
          } else {
            conditions.push(gt(schema.runs.runId, cursor));
          }
        }

        const query = db
          .select()
          .from(schema.runs)
          .orderBy(
            sortOrder === 'desc' ? desc(schema.runs.runId) : asc(schema.runs.runId)
          )
          .limit(limit + 1);

        const result =
          conditions.length > 0
            ? await query.where(and(...conditions))
            : await query;

        const hasMore = result.length > limit;
        const rows = result.slice(0, limit);
        const data = rows.map((row) => toWorkflowRun(row));
        const nextCursor = hasMore ? data[data.length - 1]?.runId : null;

        return {
          data: data.map((r) => filterRunData(r, params?.resolveData)),
          cursor: nextCursor,
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
        const nowStr = now.toISOString();
        const id = `${runId}-${data.stepId}`;

        await db.insert(schema.steps).values({
          id,
          runId,
          stepId: data.stepId,
          stepName: data.stepName ?? null,
          status: 'pending',
          input: (data.input ?? []) as unknown[],
          attempt: 0,
          createdAt: nowStr,
          updatedAt: nowStr,
        });

        return {
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
      },

      async get(runId, stepId, params): Promise<Step> {
        let result;

        if (!runId) {
          // Search all steps for this stepId
          result = await db
            .select()
            .from(schema.steps)
            .where(eq(schema.steps.stepId, stepId))
            .limit(1);
        } else {
          const id = `${runId}-${stepId}`;
          result = await db
            .select()
            .from(schema.steps)
            .where(eq(schema.steps.id, id))
            .limit(1);
        }

        if (result.length === 0) {
          throw new WorkflowAPIError(`Step not found: ${stepId}`, {
            status: 404,
          });
        }

        const step = toStep(result[0]);
        return filterStepData(step, params?.resolveData);
      },

      async update(runId, stepId, data: UpdateStepRequest): Promise<Step> {
        const id = `${runId}-${stepId}`;
        const existing = await this.get(runId, stepId);
        const now = new Date();
        const nowStr = now.toISOString();

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

        await db
          .update(schema.steps)
          .set({
            status: updated.status,
            input: updated.input as unknown[],
            output: updated.output,
            error: updated.error,
            attempt: updated.attempt,
            startedAt: toIsoString(updated.startedAt),
            completedAt: toIsoString(updated.completedAt),
            updatedAt: nowStr,
          })
          .where(eq(schema.steps.id, id));

        return updated;
      },

      async list(params): Promise<PaginatedResponse<Step>> {
        const sortOrder = params.pagination?.sortOrder ?? 'desc';
        const limit = params.pagination?.limit ?? 100;

        const result = await db
          .select()
          .from(schema.steps)
          .where(eq(schema.steps.runId, params.runId))
          .orderBy(
            sortOrder === 'desc'
              ? desc(schema.steps.createdAt)
              : asc(schema.steps.createdAt)
          )
          .limit(limit + 1);

        const hasMore = result.length > limit;
        const rows = result.slice(0, limit);
        const data = rows.map((row) => toStep(row));
        const nextCursor = hasMore ? data[data.length - 1]?.stepId : null;

        return {
          data: data.map((s) => filterStepData(s, params.resolveData)),
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
        const nowStr = now.toISOString();

        await db.insert(schema.events).values({
          eventId,
          runId,
          eventType: data.eventType,
          correlationId: data.correlationId ?? null,
          payload: data as Record<string, unknown>,
          createdAt: nowStr,
        });

        const event: Event = {
          ...data,
          runId,
          eventId,
          createdAt: now,
        };

        return filterEventData(event, params?.resolveData);
      },

      async list(params): Promise<PaginatedResponse<Event>> {
        // Events default to ascending order (oldest first) for replay
        const sortOrder = params.pagination?.sortOrder ?? 'asc';
        // High default limit to ensure all events are returned for replay
        const limit = params.pagination?.limit ?? 10000;
        const cursor = params.pagination?.cursor;

        const conditions = [eq(schema.events.runId, params.runId)];

        if (cursor) {
          if (sortOrder === 'asc') {
            conditions.push(gt(schema.events.eventId, cursor));
          } else {
            conditions.push(lt(schema.events.eventId, cursor));
          }
        }

        const result = await db
          .select()
          .from(schema.events)
          .where(and(...conditions))
          .orderBy(
            sortOrder === 'asc'
              ? asc(schema.events.eventId)
              : desc(schema.events.eventId)
          )
          .limit(limit + 1);

        const hasMore = result.length > limit;
        const rows = result.slice(0, limit);
        const data = rows.map((row) => toEvent(row));
        const nextCursor = hasMore ? data[data.length - 1]?.eventId : null;

        return {
          data: data.map((e) => filterEventData(e, params.resolveData)),
          cursor: nextCursor,
          hasMore,
        };
      },

      async listByCorrelationId(params): Promise<PaginatedResponse<Event>> {
        const sortOrder = params.pagination?.sortOrder ?? 'asc';
        const limit = params.pagination?.limit ?? 100;

        const result = await db
          .select()
          .from(schema.events)
          .where(eq(schema.events.correlationId, params.correlationId))
          .orderBy(
            sortOrder === 'asc'
              ? asc(schema.events.eventId)
              : desc(schema.events.eventId)
          )
          .limit(limit + 1);

        const hasMore = result.length > limit;
        const rows = result.slice(0, limit);
        const data = rows.map((row) => toEvent(row));
        const nextCursor = hasMore ? data[data.length - 1]?.eventId : null;

        return {
          data: data.map((e) => filterEventData(e, params.resolveData)),
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
        const now = new Date();
        const nowStr = now.toISOString();

        // Check for token uniqueness - if insert fails with UNIQUE constraint, throw 409
        try {
          await db.insert(schema.hooks).values({
            hookId: data.hookId,
            runId,
            token: data.token,
            metadata: data.metadata,
            ownerId: 'turso-owner',
            projectId: 'turso-project',
            environment: 'development',
            createdAt: nowStr,
            updatedAt: nowStr,
          });
        } catch (error) {
          // Check if this is a UNIQUE constraint violation
          const message = (error as Error).message ?? '';
          if (
            message.includes('UNIQUE') ||
            message.includes('unique') ||
            message.includes('constraint')
          ) {
            throw new WorkflowAPIError(
              `Hook with token ${data.token} already exists`,
              { status: 409 }
            );
          }
          throw error;
        }

        const hook: Hook = {
          runId,
          hookId: data.hookId,
          token: data.token,
          metadata: data.metadata,
          ownerId: 'turso-owner',
          projectId: 'turso-project',
          environment: 'development',
          createdAt: now,
        };

        return filterHookData(hook, params?.resolveData);
      },

      async get(hookId, params): Promise<Hook> {
        const result = await db
          .select()
          .from(schema.hooks)
          .where(eq(schema.hooks.hookId, hookId))
          .limit(1);

        if (result.length === 0) {
          throw new WorkflowAPIError(`Hook not found: ${hookId}`, {
            status: 404,
          });
        }

        const hook = toHook(result[0]);
        return filterHookData(hook, params?.resolveData);
      },

      async getByToken(token, params): Promise<Hook> {
        const result = await db
          .select()
          .from(schema.hooks)
          .where(eq(schema.hooks.token, token))
          .limit(1);

        if (result.length === 0) {
          throw new WorkflowAPIError(`Hook not found for token: ${token}`, {
            status: 404,
          });
        }

        const hook = toHook(result[0]);
        return filterHookData(hook, params?.resolveData);
      },

      async list(params): Promise<PaginatedResponse<Hook>> {
        const limit = params.pagination?.limit ?? 100;

        let result;
        if (params.runId) {
          result = await db
            .select()
            .from(schema.hooks)
            .where(eq(schema.hooks.runId, params.runId))
            .limit(limit + 1);
        } else {
          result = await db.select().from(schema.hooks).limit(limit + 1);
        }

        const hasMore = result.length > limit;
        const rows = result.slice(0, limit);
        const data = rows.map((row) => toHook(row));
        const nextCursor = hasMore ? data[data.length - 1]?.hookId : null;

        return {
          data: data.map((h) => filterHookData(h, params.resolveData)),
          cursor: nextCursor,
          hasMore,
        };
      },

      async dispose(hookId, params): Promise<Hook> {
        const hook = await this.get(hookId);

        await db.delete(schema.hooks).where(eq(schema.hooks.hookId, hookId));

        return filterHookData(hook, params?.resolveData);
      },
    },
  };
}
