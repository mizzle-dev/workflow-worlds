/**
 * In-Memory Storage Implementation
 *
 * This file implements the Storage interface using in-memory Maps.
 * Replace each Map with your actual database operations.
 *
 * TODO markers indicate where to swap in your real backend.
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

// Monotonic ULID factory ensures IDs are always increasing
const generateUlid = monotonicFactory();

/**
 * Deep clone an object to prevent mutation of stored data.
 * Uses structuredClone which properly handles Date objects, Maps, Sets, etc.
 */
function deepClone<T>(obj: T): T {
  return structuredClone(obj);
}

/**
 * Helper to filter data based on resolveData setting.
 * When resolveData is 'none', omit large payload fields to reduce bandwidth.
 *
 * IMPORTANT: These functions return deep clones to prevent callers from
 * mutating the in-memory stored data. The core may mutate returned objects
 * (e.g., hydrating hook.metadata), which would corrupt stored data.
 */
function filterRunData(
  run: WorkflowRun,
  resolveData: 'none' | 'all' = 'all'
): WorkflowRun {
  // Deep clone to prevent mutation of stored data
  const cloned = deepClone(run);
  if (resolveData === 'none') {
    return { ...cloned, input: [], output: undefined };
  }
  return cloned;
}

function filterStepData(step: Step, resolveData: 'none' | 'all' = 'all'): Step {
  // Deep clone to prevent mutation of stored data
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
  // Deep clone to prevent mutation of stored data
  const cloned = deepClone(event);
  if (resolveData === 'none') {
    // Filter out eventData when not resolving data
    if ('eventData' in cloned) {
      delete (cloned as Record<string, unknown>).eventData;
    }
  }
  return cloned;
}

function filterHookData(hook: Hook, resolveData: 'none' | 'all' = 'all'): Hook {
  // Deep clone to prevent mutation of stored data
  const cloned = deepClone(hook);
  if (resolveData === 'none') {
    // Filter out metadata when not resolving data
    delete (cloned as Record<string, unknown>).metadata;
  }
  return cloned;
}

/**
 * Creates the Storage implementation.
 *
 * TODO: Replace the in-memory Maps with your database client.
 */
export function createStorage(): Storage {
  // TODO: Replace these Maps with your database connection
  const runs = new Map<string, WorkflowRun>();
  const steps = new Map<string, Step>();
  const events = new Map<string, Event>();
  const hooks = new Map<string, Hook>();

  return {
    // =========================================================================
    // RUNS STORAGE
    // =========================================================================
    runs: {
      /**
       * Creates a new workflow run.
       *
       * TODO: Insert into your database's runs table.
       */
      async create(data: CreateWorkflowRunRequest): Promise<WorkflowRun> {
        const runId = `wrun_${generateUlid()}`;
        const now = new Date();

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

        // TODO: INSERT INTO runs VALUES (...)
        runs.set(runId, run);
        // Return a clone to prevent caller mutations from affecting stored data
        return deepClone(run);
      },

      /**
       * Retrieves a workflow run by ID.
       *
       * TODO: SELECT * FROM runs WHERE run_id = ?
       */
      async get(id, params): Promise<WorkflowRun> {
        // TODO: Query your database
        const run = runs.get(id);
        if (!run) {
          throw new WorkflowAPIError(`Run not found: ${id}`, { status: 404 });
        }
        return filterRunData(run, params?.resolveData);
      },

      /**
       * Updates a workflow run.
       *
       * Key behaviors:
       * - Set startedAt only once when status becomes 'running'
       * - Set completedAt when status becomes terminal
       * - Clean up hooks on terminal status
       *
       * TODO: UPDATE runs SET ... WHERE run_id = ?
       */
      async update(id, data: UpdateWorkflowRunRequest): Promise<WorkflowRun> {
        const existing = runs.get(id);
        if (!existing) {
          throw new WorkflowAPIError(`Run not found: ${id}`, { status: 404 });
        }

        const now = new Date();
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
          // TODO: DELETE FROM hooks WHERE run_id = ?
          for (const [hookId, hook] of hooks.entries()) {
            if (hook.runId === id) {
              hooks.delete(hookId);
            }
          }
        }

        // TODO: Update in your database
        runs.set(id, updated);
        // Return a clone to prevent caller mutations from affecting stored data
        return deepClone(updated);
      },

      /**
       * Lists workflow runs with optional filtering and pagination.
       *
       * TODO: SELECT * FROM runs WHERE ... ORDER BY run_id DESC LIMIT ?
       */
      async list(params): Promise<PaginatedResponse<WorkflowRun>> {
        let results = Array.from(runs.values());

        // Apply filters
        if (params?.workflowName) {
          results = results.filter(
            (r) => r.workflowName === params.workflowName
          );
        }
        if (params?.status) {
          results = results.filter((r) => r.status === params.status);
        }

        // Sort by ULID (chronological) - default descending (newest first)
        const sortOrder = params?.pagination?.sortOrder ?? 'desc';
        results.sort((a, b) => {
          const cmp = a.runId.localeCompare(b.runId);
          return sortOrder === 'desc' ? -cmp : cmp;
        });

        // Apply cursor-based pagination
        const limit = params?.pagination?.limit ?? 100;
        const cursor = params?.pagination?.cursor;

        if (cursor) {
          const cursorIndex = results.findIndex((r) => r.runId === cursor);
          if (cursorIndex !== -1) {
            results = results.slice(cursorIndex + 1);
          }
        }

        // Determine if there are more results
        const hasMore = results.length > limit;
        const data = results.slice(0, limit);
        const nextCursor = hasMore ? data[data.length - 1]?.runId : null;

        return {
          data: data.map((r) => filterRunData(r, params?.resolveData)),
          cursor: nextCursor,
          hasMore,
        };
      },

      /**
       * Cancels a workflow run.
       */
      async cancel(id, params): Promise<WorkflowRun> {
        const run = await this.update(id, { status: 'cancelled' });
        return filterRunData(run, params?.resolveData);
      },

      /**
       * Pauses a workflow run.
       */
      async pause(id, params): Promise<WorkflowRun> {
        const run = await this.update(id, { status: 'paused' });
        return filterRunData(run, params?.resolveData);
      },

      /**
       * Resumes a paused workflow run.
       */
      async resume(id, params): Promise<WorkflowRun> {
        const run = await this.update(id, { status: 'running' });
        return filterRunData(run, params?.resolveData);
      },
    },

    // =========================================================================
    // STEPS STORAGE
    // =========================================================================
    steps: {
      /**
       * Creates a new step execution record.
       *
       * TODO: INSERT INTO steps VALUES (...)
       */
      async create(runId, data: CreateStepRequest): Promise<Step> {
        const now = new Date();

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

        // Use composite key for storage
        const key = `${runId}-${data.stepId}`;
        // TODO: Insert into your database
        steps.set(key, step);
        // Return a clone to prevent caller mutations from affecting stored data
        return deepClone(step);
      },

      /**
       * Retrieves a step by ID.
       *
       * Note: runId can be undefined - in that case, search all steps.
       *
       * TODO: SELECT * FROM steps WHERE step_id = ? (AND run_id = ?)
       */
      async get(runId, stepId, params): Promise<Step> {
        if (!runId) {
          // Search all steps for this stepId
          for (const step of steps.values()) {
            if (step.stepId === stepId) {
              return filterStepData(step, params?.resolveData);
            }
          }
          throw new WorkflowAPIError(`Step not found: ${stepId}`, { status: 404 });
        }

        const key = `${runId}-${stepId}`;
        const step = steps.get(key);
        if (!step) {
          throw new WorkflowAPIError(`Step not found: ${stepId}`, { status: 404 });
        }
        return filterStepData(step, params?.resolveData);
      },

      /**
       * Updates a step execution.
       *
       * TODO: UPDATE steps SET ... WHERE run_id = ? AND step_id = ?
       */
      async update(runId, stepId, data: UpdateStepRequest): Promise<Step> {
        const key = `${runId}-${stepId}`;
        const existing = steps.get(key);
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

        // TODO: Update in your database
        steps.set(key, updated);
        // Return a clone to prevent caller mutations from affecting stored data
        return deepClone(updated);
      },

      /**
       * Lists steps for a workflow run.
       *
       * TODO: SELECT * FROM steps WHERE run_id = ? ORDER BY created_at
       */
      async list(params): Promise<PaginatedResponse<Step>> {
        let results = Array.from(steps.values()).filter(
          (s) => s.runId === params.runId
        );

        // Sort by creation time
        const sortOrder = params.pagination?.sortOrder ?? 'desc';
        results.sort((a, b) => {
          const cmp = a.createdAt.getTime() - b.createdAt.getTime();
          return sortOrder === 'desc' ? -cmp : cmp;
        });

        const limit = params.pagination?.limit ?? 100;
        const hasMore = results.length > limit;
        const data = results.slice(0, limit);
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
      /**
       * Creates a new event in the log.
       *
       * Events are the source of truth for workflow replay.
       *
       * TODO: INSERT INTO events VALUES (...)
       */
      async create(runId, data: CreateEventRequest, params): Promise<Event> {
        const eventId = `wevt_${generateUlid()}`;
        const now = new Date();

        const event: Event = {
          ...data,
          runId,
          eventId,
          createdAt: now,
        };

        // TODO: Insert into your database
        events.set(eventId, event);
        return filterEventData(event, params?.resolveData);
      },

      /**
       * Lists events for a workflow run.
       *
       * Important: Default sort order is 'asc' (oldest first) for proper replay.
       *
       * TODO: SELECT * FROM events WHERE run_id = ? ORDER BY event_id ASC
       */
      async list(params): Promise<PaginatedResponse<Event>> {
        let results = Array.from(events.values()).filter(
          (e) => e.runId === params.runId
        );

        // Events default to ascending order (oldest first) for replay
        const sortOrder = params.pagination?.sortOrder ?? 'asc';
        results.sort((a, b) => {
          const cmp = a.eventId.localeCompare(b.eventId);
          return sortOrder === 'asc' ? cmp : -cmp;
        });

        // High default limit to ensure all events are returned for replay
        // The idempotency test creates 220+ events (110 steps × 2)
        const limit = params.pagination?.limit ?? 10000;
        const cursor = params.pagination?.cursor;

        if (cursor) {
          const cursorIndex = results.findIndex((e) => e.eventId === cursor);
          if (cursorIndex !== -1) {
            results = results.slice(cursorIndex + 1);
          }
        }

        const hasMore = results.length > limit;
        const data = results.slice(0, limit);
        const nextCursor = hasMore ? data[data.length - 1]?.eventId : null;

        return {
          data: data.map((e) => filterEventData(e, params.resolveData)),
          cursor: nextCursor,
          hasMore,
        };
      },

      /**
       * Lists events by correlation ID.
       *
       * Correlation IDs link related events (e.g., step_started → step_completed).
       *
       * TODO: SELECT * FROM events WHERE correlation_id = ? ORDER BY event_id ASC
       */
      async listByCorrelationId(params): Promise<PaginatedResponse<Event>> {
        let results = Array.from(events.values()).filter(
          (e) => e.correlationId === params.correlationId
        );

        const sortOrder = params.pagination?.sortOrder ?? 'asc';
        results.sort((a, b) => {
          const cmp = a.eventId.localeCompare(b.eventId);
          return sortOrder === 'asc' ? cmp : -cmp;
        });

        const limit = params.pagination?.limit ?? 100;
        const hasMore = results.length > limit;
        const data = results.slice(0, limit);
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
      /**
       * Creates a new hook registration.
       *
       * Hooks allow workflows to wait for external events.
       *
       * TODO: INSERT INTO hooks VALUES (...)
       */
      async create(runId, data: CreateHookRequest, params): Promise<Hook> {
        // Check for token uniqueness
        for (const hook of hooks.values()) {
          if (hook.token === data.token) {
            throw new WorkflowAPIError(
              `Hook with token ${data.token} already exists`,
              { status: 409 }
            );
          }
        }

        const now = new Date();
        const hook: Hook = {
          runId,
          hookId: data.hookId,
          token: data.token,
          metadata: data.metadata,
          // These fields are for multi-tenant deployments.
          // For single-tenant setups, use placeholder values.
          ownerId: 'starter-owner',
          projectId: 'starter-project',
          environment: 'development',
          createdAt: now,
        };

        // TODO: Insert into your database
        hooks.set(data.hookId, hook);
        return filterHookData(hook, params?.resolveData);
      },

      /**
       * Retrieves a hook by ID.
       *
       * TODO: SELECT * FROM hooks WHERE hook_id = ?
       */
      async get(hookId, params): Promise<Hook> {
        const hook = hooks.get(hookId);
        if (!hook) {
          throw new WorkflowAPIError(`Hook not found: ${hookId}`, {
            status: 404,
          });
        }
        return filterHookData(hook, params?.resolveData);
      },

      /**
       * Retrieves a hook by its security token.
       *
       * Used when an external caller resumes a hook.
       *
       * TODO: SELECT * FROM hooks WHERE token = ?
       */
      async getByToken(token, params): Promise<Hook> {
        for (const hook of hooks.values()) {
          if (hook.token === token) {
            return filterHookData(hook, params?.resolveData);
          }
        }
        throw new WorkflowAPIError(`Hook not found for token: ${token}`, {
          status: 404,
        });
      },

      /**
       * Lists hooks, optionally filtered by run ID.
       *
       * TODO: SELECT * FROM hooks WHERE run_id = ?
       */
      async list(params): Promise<PaginatedResponse<Hook>> {
        let results = Array.from(hooks.values());

        if (params.runId) {
          results = results.filter((h) => h.runId === params.runId);
        }

        const limit = params.pagination?.limit ?? 100;
        const hasMore = results.length > limit;
        const data = results.slice(0, limit);
        const nextCursor = hasMore ? data[data.length - 1]?.hookId : null;

        return {
          data: data.map((h) => filterHookData(h, params.resolveData)),
          cursor: nextCursor,
          hasMore,
        };
      },

      /**
       * Deletes a hook.
       *
       * Called when a hook is received or when a run completes.
       *
       * TODO: DELETE FROM hooks WHERE hook_id = ?
       */
      async dispose(hookId, params): Promise<Hook> {
        const hook = hooks.get(hookId);
        if (!hook) {
          throw new WorkflowAPIError(`Hook not found: ${hookId}`, {
            status: 404,
          });
        }

        // TODO: Delete from your database
        hooks.delete(hookId);
        return filterHookData(hook, params?.resolveData);
      },
    },
  };
}
