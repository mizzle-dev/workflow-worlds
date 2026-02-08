/**
 * Turso Storage Implementation
 *
 * Implements Storage using Turso/libSQL with an internal legacy mutator layer,
 * then exposes the Workflow 4.1 event-sourced public Storage surface.
 */

import type { Client } from '@libsql/client';
import {
  RunNotSupportedError,
  WorkflowAPIError,
} from '@workflow/errors';
import type {
  AnyEventRequest,
  CreateEventParams,
  CreateHookRequest,
  CreateStepRequest,
  CreateWorkflowRunRequest,
  Event,
  EventResult,
  Hook,
  PaginatedResponse,
  Step,
  Storage,
  UpdateStepRequest,
  WorkflowRun,
} from '@workflow/world';
import {
  isLegacySpecVersion,
  requiresNewerWorld,
  SPEC_VERSION_CURRENT,
} from '@workflow/world';
import { and, asc, desc, eq, gt, lt } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { monotonicFactory } from 'ulid';
import * as schema from './drizzle/schema.js';

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

function deepClone<T>(obj: T): T {
  return structuredClone(obj);
}

function toDate(value: string | null | undefined): Date | undefined {
  if (!value) return undefined;
  return new Date(value);
}

function toIsoString(date: Date | undefined): string | null {
  if (!date) return null;
  return date.toISOString();
}

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

type RunRow = typeof schema.runs.$inferSelect;
type StepRow = typeof schema.steps.$inferSelect;
type EventRow = typeof schema.events.$inferSelect;
type HookRow = typeof schema.hooks.$inferSelect;

function toWorkflowRun(row: RunRow, specVersion?: number): WorkflowRun {
  return {
    runId: row.runId,
    deploymentId: row.deploymentId,
    workflowName: row.workflowName,
    specVersion,
    status: row.status as WorkflowRun['status'],
    input: row.input ?? [],
    output: row.output,
    error: row.error ?? undefined,
    executionContext: row.executionContext,
    startedAt: toDate(row.startedAt),
    completedAt: toDate(row.completedAt),
    createdAt: toDate(row.createdAt) ?? new Date(),
    updatedAt: toDate(row.updatedAt) ?? new Date(),
  } as WorkflowRun;
}

function toStep(row: StepRow, specVersion?: number): Step {
  return {
    runId: row.runId,
    stepId: row.stepId,
    stepName: row.stepName ?? '',
    specVersion,
    status: row.status as Step['status'],
    input: row.input ?? [],
    output: row.output,
    error: (row.error ?? undefined) as Step['error'],
    attempt: row.attempt ?? 0,
    retryAfter: toDate(row.retryAfter),
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

function toHook(row: HookRow, specVersion?: number): Hook {
  return {
    hookId: row.hookId,
    runId: row.runId,
    token: row.token,
    metadata: row.metadata,
    ownerId: row.ownerId,
    projectId: row.projectId,
    environment: row.environment,
    createdAt: toDate(row.createdAt) ?? new Date(),
    specVersion,
  };
}

export interface StorageConfig {
  client: Client;
}

export function createStorage(config: StorageConfig): Storage {
  const db = drizzle(config.client, { schema });

  async function setRunSpecVersion(runId: string, specVersion: number): Promise<void> {
    await config.client.execute({
      sql: `INSERT INTO workflow_run_versions (run_id, spec_version)
            VALUES (?, ?)
            ON CONFLICT(run_id) DO UPDATE SET spec_version = excluded.spec_version`,
      args: [runId, specVersion],
    });
  }

  async function getRunSpecVersion(runId: string): Promise<number | undefined> {
    const result = await config.client.execute({
      sql: 'SELECT spec_version FROM workflow_run_versions WHERE run_id = ?',
      args: [runId],
    });
    const row = result.rows[0];
    if (!row || row.spec_version === null || row.spec_version === undefined) {
      return undefined;
    }
    return Number(row.spec_version);
  }

  const legacyStorage: LegacyStorage = {
    runs: {
      async create(
        data: CreateWorkflowRunRequest & { specVersion?: number; runId?: string }
      ): Promise<WorkflowRun> {
        const runId = data.runId ?? `wrun_${generateUlid()}`;
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

        if (data.specVersion !== undefined) {
          await setRunSpecVersion(runId, data.specVersion);
        }

        return {
          runId,
          deploymentId: data.deploymentId,
          status: 'pending',
          workflowName: data.workflowName,
          specVersion: data.specVersion,
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

      async get(id: string, params?: ResolveDataParams): Promise<WorkflowRun> {
        const result = await db
          .select()
          .from(schema.runs)
          .where(eq(schema.runs.runId, id))
          .limit(1);

        if (result.length === 0) {
          throw new WorkflowAPIError(`Run not found: ${id}`, { status: 404 });
        }

        const run = toWorkflowRun(result[0], await getRunSpecVersion(id));
        return filterRunData(run, params?.resolveData);
      },

      async update(id: string, data: UpdateWorkflowRunRequest): Promise<WorkflowRun> {
        const existing = await this.get(id, { resolveData: 'all' });
        const now = new Date();
        const nowStr = now.toISOString();

        const updated: WorkflowRun = {
          ...existing,
          ...data,
          updatedAt: now,
        } as WorkflowRun;

        if (data.status === 'running' && !updated.startedAt) {
          updated.startedAt = now;
        }

        const isTerminal =
          data.status === 'completed' ||
          data.status === 'failed' ||
          data.status === 'cancelled';

        if (isTerminal) {
          updated.completedAt = now;
          await db.delete(schema.hooks).where(eq(schema.hooks.runId, id));
        }

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

      async list(params?: any): Promise<PaginatedResponse<WorkflowRun>> {
        const sortOrder = params?.pagination?.sortOrder ?? 'desc';
        const limit = params?.pagination?.limit ?? 100;
        const cursor = params?.pagination?.cursor;

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
        const data = await Promise.all(
          rows.map(async (row) =>
            toWorkflowRun(row, await getRunSpecVersion(row.runId))
          )
        );
        const nextCursor = hasMore ? data[data.length - 1]?.runId : null;

        return {
          data: data.map((r) => filterRunData(r, params?.resolveData)),
          cursor: nextCursor,
          hasMore,
        };
      },
    },

    steps: {
      async create(
        runId: string,
        data: CreateStepRequest & { specVersion?: number }
      ): Promise<Step> {
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
          specVersion: data.specVersion,
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

      async get(
        runId: string | undefined,
        stepId: string,
        params?: ResolveDataParams
      ): Promise<Step> {
        let result;

        if (!runId) {
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
          throw new WorkflowAPIError(`Step not found: ${stepId}`, { status: 404 });
        }

        const step = toStep(result[0]);
        return filterStepData(step, params?.resolveData);
      },

      async update(runId: string, stepId: string, data: UpdateStepRequest): Promise<Step> {
        const id = `${runId}-${stepId}`;
        const existing = await this.get(runId, stepId, { resolveData: 'all' });
        const now = new Date();
        const nowStr = now.toISOString();

        const updated: Step = {
          ...existing,
          ...data,
          updatedAt: now,
        };

        if (data.status === 'running' && !updated.startedAt) {
          updated.startedAt = now;
        }

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
            retryAfter: toIsoString(updated.retryAfter),
            startedAt: toIsoString(updated.startedAt),
            completedAt: toIsoString(updated.completedAt),
            updatedAt: nowStr,
          })
          .where(eq(schema.steps.id, id));

        return updated;
      },

      async list(params: any): Promise<PaginatedResponse<Step>> {
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

    events: {
      async create(
        runId: string,
        data: AnyEventRequest,
        params?: CreateEventParams
      ): Promise<Event> {
        const eventId = `evnt_${generateUlid()}`;
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
        } as Event;

        return filterEventData(event, params?.resolveData);
      },

      async list(params: any): Promise<PaginatedResponse<Event>> {
        const sortOrder = params.pagination?.sortOrder ?? 'asc';
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

      async listByCorrelationId(params: any): Promise<PaginatedResponse<Event>> {
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

    hooks: {
      async create(
        runId: string,
        data: CreateHookRequest & { specVersion?: number },
        params?: ResolveDataParams
      ): Promise<Hook> {
        const now = new Date();
        const nowStr = now.toISOString();

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
          specVersion: data.specVersion,
        };

        return filterHookData(hook, params?.resolveData);
      },

      async get(hookId: string, params?: ResolveDataParams): Promise<Hook> {
        const result = await db
          .select()
          .from(schema.hooks)
          .where(eq(schema.hooks.hookId, hookId))
          .limit(1);

        if (result.length === 0) {
          throw new WorkflowAPIError(`Hook not found: ${hookId}`, { status: 404 });
        }

        const hook = toHook(result[0]);
        return filterHookData(hook, params?.resolveData);
      },

      async getByToken(token: string, params?: ResolveDataParams): Promise<Hook> {
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

      async list(params: any): Promise<PaginatedResponse<Hook>> {
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

      async dispose(hookId: string, params?: ResolveDataParams): Promise<Hook> {
        const hook = await this.get(hookId, { resolveData: 'all' });
        await db.delete(schema.hooks).where(eq(schema.hooks.hookId, hookId));
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
          default:
            throw new WorkflowAPIError(
              `Unsupported event type: ${(data as { eventType: string }).eventType}`,
              { status: 400 }
            );
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

  return storage as unknown as Storage;
}
