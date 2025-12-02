/**
 * Turso Storage Implementation
 *
 * Implements the Storage interface using Turso/libSQL.
 * Uses SQL tables for runs, steps, events, and hooks with JSON columns for flexible data.
 */

import type { Client, Row, InValue } from '@libsql/client';
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
import { toJson, fromJson, toIsoString, fromIsoString } from './schema.js';

const generateUlid = monotonicFactory();

/**
 * Deep clone an object to prevent mutation of stored data.
 */
function deepClone<T>(obj: T): T {
  return structuredClone(obj);
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
 * Converts a database row to a WorkflowRun object.
 */
function rowToRun(row: Row): WorkflowRun {
  const status = row.status as string;
  const runId = row.run_id as string;
  const deploymentId = row.deployment_id as string;
  const workflowName = row.workflow_name as string;
  const input = fromJson<unknown[]>(row.input as string | null) ?? [];
  const output = fromJson<unknown>(row.output as string | null);
  const error = fromJson<{ message: string; stack?: string; code?: string }>(
    row.error as string | null
  );
  const executionContext = fromJson<Record<string, unknown>>(
    row.execution_context as string | null
  );
  const startedAt = fromIsoString(row.started_at as string | null);
  const completedAt = fromIsoString(row.completed_at as string | null);
  const createdAt = fromIsoString(row.created_at as string | null) ?? new Date();
  const updatedAt = fromIsoString(row.updated_at as string | null) ?? new Date();

  // Return a generic object that matches any WorkflowRun variant
  return {
    runId,
    deploymentId,
    workflowName,
    status,
    input,
    output,
    error,
    executionContext,
    startedAt,
    completedAt,
    createdAt,
    updatedAt,
  } as WorkflowRun;
}

/**
 * Converts a database row to a Step object.
 */
function rowToStep(row: Row): Step {
  return {
    runId: row.run_id as string,
    stepId: row.step_id as string,
    stepName: (row.step_name as string) ?? '',
    status: row.status as Step['status'],
    input: fromJson<unknown[]>(row.input as string | null) ?? [],
    output: fromJson<unknown>(row.output as string | null),
    error: fromJson<Step['error']>(row.error as string | null),
    attempt: (row.attempt as number) ?? 0,
    startedAt: fromIsoString(row.started_at as string | null),
    completedAt: fromIsoString(row.completed_at as string | null),
    createdAt: fromIsoString(row.created_at as string | null) ?? new Date(),
    updatedAt: fromIsoString(row.updated_at as string | null) ?? new Date(),
  };
}

/**
 * Converts a database row to an Event object.
 * CBOR automatically preserves Date types in eventData, no manual conversion needed.
 */
function rowToEvent(row: Row): Event {
  const payload = fromJson<Record<string, unknown>>(
    row.payload as string | null
  ) ?? {};

  const baseEvent = {
    eventId: row.event_id as string,
    runId: row.run_id as string,
    createdAt: fromIsoString(row.created_at as string | null) ?? new Date(),
  };

  // Merge the payload which contains eventType, correlationId, eventData, etc.
  return {
    ...baseEvent,
    ...payload,
  } as Event;
}

/**
 * Converts a database row to a Hook object.
 */
function rowToHook(row: Row): Hook {
  return {
    hookId: row.hook_id as string,
    runId: row.run_id as string,
    token: row.token as string,
    metadata: fromJson<unknown>(row.metadata as string | null),
    ownerId: row.owner_id as string,
    projectId: row.project_id as string,
    environment: row.environment as string,
    createdAt: fromIsoString(row.created_at as string | null) ?? new Date(),
  };
}

export interface StorageConfig {
  client: Client;
}

/**
 * Creates the Storage implementation using Turso/libSQL.
 */
export function createStorage(config: StorageConfig): Storage {
  const { client } = config;

  return {
    // =========================================================================
    // RUNS STORAGE
    // =========================================================================
    runs: {
      async create(data: CreateWorkflowRunRequest): Promise<WorkflowRun> {
        const runId = `wrun_${generateUlid()}`;
        const now = new Date();
        const nowStr = toIsoString(now);

        await client.execute({
          sql: `INSERT INTO workflow_runs
                (run_id, deployment_id, workflow_name, status, input, output, error,
                 execution_context, started_at, completed_at, created_at, updated_at)
                VALUES (?, ?, ?, 'pending', ?, NULL, NULL, ?, NULL, NULL, ?, ?)`,
          args: [
            runId,
            data.deploymentId,
            data.workflowName,
            toJson(data.input ?? []),
            toJson(data.executionContext),
            nowStr,
            nowStr,
          ] as InValue[],
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
        const result = await client.execute({
          sql: 'SELECT * FROM workflow_runs WHERE run_id = ?',
          args: [id],
        });

        if (result.rows.length === 0) {
          throw new WorkflowAPIError(`Run not found: ${id}`, { status: 404 });
        }

        const run = rowToRun(result.rows[0]);
        return filterRunData(run, params?.resolveData);
      },

      async update(id, data: UpdateWorkflowRunRequest): Promise<WorkflowRun> {
        // First, get the existing run
        const existing = await this.get(id);
        const now = new Date();
        const nowStr = toIsoString(now);

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
          await client.execute({
            sql: 'DELETE FROM workflow_hooks WHERE run_id = ?',
            args: [id],
          });
        }

        // Update the database
        await client.execute({
          sql: `UPDATE workflow_runs SET
                status = ?,
                input = ?,
                output = ?,
                error = ?,
                execution_context = ?,
                started_at = ?,
                completed_at = ?,
                updated_at = ?
                WHERE run_id = ?`,
          args: [
            updated.status,
            toJson(updated.input),
            toJson(updated.output),
            toJson(updated.error),
            toJson(updated.executionContext),
            toIsoString(updated.startedAt),
            toIsoString(updated.completedAt),
            nowStr,
            id,
          ] as InValue[],
        });

        return updated;
      },

      async list(params): Promise<PaginatedResponse<WorkflowRun>> {
        const sortOrder = params?.pagination?.sortOrder ?? 'desc';
        const limit = params?.pagination?.limit ?? 100;
        const cursor = params?.pagination?.cursor;

        // Build the WHERE clause
        const conditions: string[] = [];
        const args: InValue[] = [];

        if (params?.workflowName) {
          conditions.push('workflow_name = ?');
          args.push(params.workflowName);
        }
        if (params?.status) {
          conditions.push('status = ?');
          args.push(params.status);
        }
        if (cursor) {
          if (sortOrder === 'desc') {
            conditions.push('run_id < ?');
          } else {
            conditions.push('run_id > ?');
          }
          args.push(cursor);
        }

        const whereClause =
          conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
        const orderClause = `ORDER BY run_id ${sortOrder === 'desc' ? 'DESC' : 'ASC'}`;

        // Fetch one extra to check for hasMore
        args.push(limit + 1);

        const result = await client.execute({
          sql: `SELECT * FROM workflow_runs ${whereClause} ${orderClause} LIMIT ?`,
          args,
        });

        const hasMore = result.rows.length > limit;
        const rows = result.rows.slice(0, limit);
        const data = rows.map((row) => rowToRun(row));
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
        const nowStr = toIsoString(now);
        const id = `${runId}-${data.stepId}`;

        await client.execute({
          sql: `INSERT INTO workflow_steps
                (id, run_id, step_id, step_name, status, input, output, error,
                 attempt, started_at, completed_at, created_at, updated_at)
                VALUES (?, ?, ?, ?, 'pending', ?, NULL, NULL, 0, NULL, NULL, ?, ?)`,
          args: [
            id,
            runId,
            data.stepId,
            data.stepName ?? null,
            toJson(data.input ?? []),
            nowStr,
            nowStr,
          ] as InValue[],
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
          result = await client.execute({
            sql: 'SELECT * FROM workflow_steps WHERE step_id = ? LIMIT 1',
            args: [stepId],
          });
        } else {
          const id = `${runId}-${stepId}`;
          result = await client.execute({
            sql: 'SELECT * FROM workflow_steps WHERE id = ?',
            args: [id],
          });
        }

        if (result.rows.length === 0) {
          throw new WorkflowAPIError(`Step not found: ${stepId}`, {
            status: 404,
          });
        }

        const step = rowToStep(result.rows[0]);
        return filterStepData(step, params?.resolveData);
      },

      async update(runId, stepId, data: UpdateStepRequest): Promise<Step> {
        const id = `${runId}-${stepId}`;
        const existing = await this.get(runId, stepId);
        const now = new Date();
        const nowStr = toIsoString(now);

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

        await client.execute({
          sql: `UPDATE workflow_steps SET
                status = ?,
                input = ?,
                output = ?,
                error = ?,
                attempt = ?,
                started_at = ?,
                completed_at = ?,
                updated_at = ?
                WHERE id = ?`,
          args: [
            updated.status,
            toJson(updated.input),
            toJson(updated.output),
            toJson(updated.error),
            updated.attempt,
            toIsoString(updated.startedAt),
            toIsoString(updated.completedAt),
            nowStr,
            id,
          ] as InValue[],
        });

        return updated;
      },

      async list(params): Promise<PaginatedResponse<Step>> {
        const sortOrder = params.pagination?.sortOrder ?? 'desc';
        const limit = params.pagination?.limit ?? 100;

        const result = await client.execute({
          sql: `SELECT * FROM workflow_steps
                WHERE run_id = ?
                ORDER BY created_at ${sortOrder === 'desc' ? 'DESC' : 'ASC'}
                LIMIT ?`,
          args: [params.runId, limit + 1],
        });

        const hasMore = result.rows.length > limit;
        const rows = result.rows.slice(0, limit);
        const data = rows.map((row) => rowToStep(row));
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
        const nowStr = toIsoString(now);

        // Store the entire event data as payload JSON
        await client.execute({
          sql: `INSERT INTO workflow_events
                (event_id, run_id, step_id, type, correlation_id, payload, created_at)
                VALUES (?, ?, NULL, ?, ?, ?, ?)`,
          args: [
            eventId,
            runId,
            data.eventType,
            data.correlationId ?? null,
            toJson(data),
            nowStr,
          ] as InValue[],
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

        const conditions: string[] = ['run_id = ?'];
        const args: InValue[] = [params.runId];

        if (cursor) {
          if (sortOrder === 'asc') {
            conditions.push('event_id > ?');
          } else {
            conditions.push('event_id < ?');
          }
          args.push(cursor);
        }

        const whereClause = conditions.join(' AND ');
        const orderClause = `ORDER BY event_id ${sortOrder === 'asc' ? 'ASC' : 'DESC'}`;

        args.push(limit + 1);

        const result = await client.execute({
          sql: `SELECT * FROM workflow_events WHERE ${whereClause} ${orderClause} LIMIT ?`,
          args,
        });

        const hasMore = result.rows.length > limit;
        const rows = result.rows.slice(0, limit);
        const data = rows.map((row) => rowToEvent(row));
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

        const result = await client.execute({
          sql: `SELECT * FROM workflow_events
                WHERE correlation_id = ?
                ORDER BY event_id ${sortOrder === 'asc' ? 'ASC' : 'DESC'}
                LIMIT ?`,
          args: [params.correlationId, limit + 1],
        });

        const hasMore = result.rows.length > limit;
        const rows = result.rows.slice(0, limit);
        const data = rows.map((row) => rowToEvent(row));
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
        const nowStr = toIsoString(now);

        // Check for token uniqueness - if insert fails with UNIQUE constraint, throw 409
        try {
          await client.execute({
            sql: `INSERT INTO workflow_hooks
                  (hook_id, run_id, token, display_name, metadata, owner_id, project_id,
                   environment, received_at, disposed_at, created_at, updated_at)
                  VALUES (?, ?, ?, NULL, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
            args: [
              data.hookId,
              runId,
              data.token,
              toJson(data.metadata),
              'turso-owner',
              'turso-project',
              'development',
              nowStr,
              nowStr,
            ] as InValue[],
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
        const result = await client.execute({
          sql: 'SELECT * FROM workflow_hooks WHERE hook_id = ?',
          args: [hookId],
        });

        if (result.rows.length === 0) {
          throw new WorkflowAPIError(`Hook not found: ${hookId}`, {
            status: 404,
          });
        }

        const hook = rowToHook(result.rows[0]);
        return filterHookData(hook, params?.resolveData);
      },

      async getByToken(token, params): Promise<Hook> {
        const result = await client.execute({
          sql: 'SELECT * FROM workflow_hooks WHERE token = ?',
          args: [token],
        });

        if (result.rows.length === 0) {
          throw new WorkflowAPIError(`Hook not found for token: ${token}`, {
            status: 404,
          });
        }

        const hook = rowToHook(result.rows[0]);
        return filterHookData(hook, params?.resolveData);
      },

      async list(params): Promise<PaginatedResponse<Hook>> {
        const limit = params.pagination?.limit ?? 100;

        let result;
        if (params.runId) {
          result = await client.execute({
            sql: 'SELECT * FROM workflow_hooks WHERE run_id = ? LIMIT ?',
            args: [params.runId, limit + 1],
          });
        } else {
          result = await client.execute({
            sql: 'SELECT * FROM workflow_hooks LIMIT ?',
            args: [limit + 1],
          });
        }

        const hasMore = result.rows.length > limit;
        const rows = result.rows.slice(0, limit);
        const data = rows.map((row) => rowToHook(row));
        const nextCursor = hasMore ? data[data.length - 1]?.hookId : null;

        return {
          data: data.map((h) => filterHookData(h, params.resolveData)),
          cursor: nextCursor,
          hasMore,
        };
      },

      async dispose(hookId, params): Promise<Hook> {
        const hook = await this.get(hookId);

        await client.execute({
          sql: 'DELETE FROM workflow_hooks WHERE hook_id = ?',
          args: [hookId],
        });

        return filterHookData(hook, params?.resolveData);
      },
    },
  };
}
