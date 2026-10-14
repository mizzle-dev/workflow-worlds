/**
 * Turso Storage Implementation
 *
 * Implements the Workflow 5 event-sourced Storage surface on Turso/libSQL.
 *
 * Every `events.create()` commits its entity change and its event in one
 * `client.batch(..., 'write')`, which libSQL runs as a single write
 * transaction. The event's ID is its position in the run's log, computed by
 * the INSERT that appends it (see `slotIdExpr`), so the position is taken in
 * the same atomic operation as the commit and nothing can land behind it.
 *
 * Guarded writes use `changes()`: an UPDATE that matches no row (a step that
 * already finished, a run that already ended) leaves `changes()` at 0, and the
 * event INSERT that follows it selects nothing, so the batch commits neither.
 */

import type { Client, InStatement, InValue, ResultSet, Row } from '@libsql/client';
import {
  EntityConflictError,
  HookNotFoundError,
  RunExpiredError,
  RunNotSupportedError,
  TooEarlyError,
  WorkflowRunNotFoundError,
  WorkflowWorldError,
} from '@workflow/errors';
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
  SPEC_VERSION_SUPPORTS_SLOT_IDENTITY,
  slotToEventId,
  stripEventDataRefs,
  validateAttributeChanges,
  validateUlidTimestamp,
} from '@workflow/world';
import { decode, encode } from 'cbor-x';
import { generateUlid } from './utils.js';


const TERMINAL_RUN_SQL = `('completed', 'failed', 'cancelled')`;
const TERMINAL_STEP_SQL = `('completed', 'failed', 'cancelled')`;

/** How many times an attribute write retries a lost compare-and-set. */
const ATTR_SET_MAX_ATTEMPTS = 20;

// =============================================================================
// Encoding helpers
// =============================================================================

/**
 * CBOR column encoding shared with the Drizzle schema: an empty buffer means
 * `undefined`, so `null` round-trips as a value.
 */
function encodeCbor(value: unknown): Uint8Array {
  if (value === undefined) {
    return new Uint8Array(0);
  }
  return new Uint8Array(encode(value));
}

function decodeCbor<T>(value: unknown): T | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  let bytes: Uint8Array;
  if (value instanceof ArrayBuffer) {
    bytes = new Uint8Array(value);
  } else if (ArrayBuffer.isView(value)) {
    bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  } else {
    return undefined;
  }
  if (bytes.byteLength === 0) {
    return undefined;
  }
  return decode(bytes) as T;
}

function toDate(value: unknown): Date | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  return new Date(String(value));
}

function toIso(date: Date | undefined): string | null {
  return date ? date.toISOString() : null;
}

function toNumber(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  return Number(value);
}

/**
 * The ID of the next position in `runId`'s log, computed inside the statement
 * that appends the event. libSQL runs a write batch as one write transaction,
 * and SQLite admits one writer at a time, so the maximum read here cannot move
 * before the insert commits. The `(run_id, event_id)` primary key would reject
 * a duplicate position anyway.
 *
 * Every ID body is zero-padded to the same width, so ordering by `event_id` is
 * ordering by position, and the subquery is a single primary-key seek.
 */
function slotIdExpr(): string {
  return `'${EVENT_ID_PREFIX}' || printf('%0${EVENT_ID_BODY_LENGTH}d', COALESCE((SELECT CAST(substr(prev.event_id, ${EVENT_ID_PREFIX.length + 1}) AS INTEGER) FROM workflow_events prev WHERE prev.run_id = ? ORDER BY prev.event_id DESC LIMIT 1), ${FIRST_EVENT_SLOT - 1}) + 1)`;
}

// =============================================================================
// Row mappers
// =============================================================================

function rowToRun(row: Row): WorkflowRun {
  const status = String(row.status) as WorkflowRun['status'];
  return {
    runId: String(row.run_id),
    deploymentId: String(row.deployment_id),
    workflowName: String(row.workflow_name),
    specVersion: toNumber(row.spec_version),
    status,
    input: decodeCbor(row.input),
    output: decodeCbor(row.output),
    error: decodeCbor(row.error),
    errorCode: (row.error_code as string | null) ?? undefined,
    executionContext: decodeCbor(row.execution_context),
    attributes: decodeCbor<Record<string, string>>(row.attributes) ?? {},
    startedAt: toDate(row.started_at),
    completedAt: toDate(row.completed_at),
    createdAt: toDate(row.created_at) ?? new Date(),
    updatedAt: toDate(row.updated_at) ?? new Date(),
  } as WorkflowRun;
}

function rowToStep(row: Row): Step {
  return {
    runId: String(row.run_id),
    stepId: String(row.step_id),
    stepName: (row.step_name as string | null) ?? '',
    status: String(row.status) as Step['status'],
    input: decodeCbor(row.input),
    output: decodeCbor(row.output),
    error: decodeCbor(row.error),
    attempt: Number(row.attempt ?? 0),
    retryAfter: toDate(row.retry_after),
    startedAt: toDate(row.started_at),
    completedAt: toDate(row.completed_at),
    createdAt: toDate(row.created_at) ?? new Date(),
    updatedAt: toDate(row.updated_at) ?? new Date(),
    specVersion: toNumber(row.spec_version),
  };
}

function rowToEvent(row: Row): Event {
  const payload = decodeCbor<Record<string, unknown>>(row.payload) ?? {};
  return {
    ...payload,
    eventType: String(row.type),
    correlationId: (row.correlation_id as string | null) ?? undefined,
    runId: String(row.run_id),
    eventId: String(row.event_id),
    specVersion: toNumber(row.spec_version) ?? payload.specVersion,
    createdAt: toDate(row.created_at) ?? new Date(),
  } as Event;
}

function rowToHook(row: Row): Hook {
  return {
    hookId: String(row.hook_id),
    runId: String(row.run_id),
    token: String(row.token),
    metadata: decodeCbor(row.metadata),
    ownerId: String(row.owner_id),
    projectId: String(row.project_id),
    environment: String(row.environment),
    createdAt: toDate(row.created_at) ?? new Date(),
    specVersion: toNumber(row.spec_version),
    isWebhook: row.is_webhook === null ? undefined : Boolean(row.is_webhook),
    isSystem: row.is_system === null ? undefined : Boolean(row.is_system),
  };
}

function rowToWait(row: Row): Wait {
  return {
    waitId: String(row.wait_id),
    runId: String(row.run_id),
    status: String(row.status) as Wait['status'],
    resumeAt: toDate(row.resume_at),
    completedAt: toDate(row.completed_at),
    createdAt: toDate(row.created_at) ?? new Date(),
    updatedAt: toDate(row.updated_at) ?? new Date(),
    specVersion: toNumber(row.spec_version),
  };
}

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
    const { eventData: _eventData, ...rest } = event as Event & {
      eventData?: unknown;
    };
    return rest as Event;
  }
  return stripEventDataRefs(event, resolveData);
}

function isUniqueViolation(error: unknown): boolean {
  const message = String((error as { message?: unknown })?.message ?? '');
  const code = String((error as { code?: unknown })?.code ?? '');
  return (
    code.includes('CONSTRAINT') ||
    message.includes('UNIQUE constraint failed') ||
    message.includes('PRIMARY KEY')
  );
}

// =============================================================================
// Storage
// =============================================================================

export interface StorageConfig {
  client: Client;
}

export function createStorage(config: StorageConfig): Storage {
  const { client } = config;

  async function getRunRow(runId: string): Promise<Row | undefined> {
    const result = await client.execute({
      sql: 'SELECT * FROM workflow_runs WHERE run_id = ?',
      args: [runId],
    });
    return result.rows[0];
  }

  async function getStepRow(runId: string, stepId: string): Promise<Row | undefined> {
    const result = await client.execute({
      sql: 'SELECT * FROM workflow_steps WHERE id = ?',
      args: [`${runId}-${stepId}`],
    });
    return result.rows[0];
  }

  async function getEventRow(runId: string, eventId: string): Promise<Row | undefined> {
    const result = await client.execute({
      sql: 'SELECT * FROM workflow_events WHERE run_id = ? AND event_id = ?',
      args: [runId, eventId],
    });
    return result.rows[0];
  }

  /**
   * A statement that appends one event. `guarded` makes it insert only when
   * the statement before it in the same batch changed a row.
   *
   * `eventId` is a literal for the run's first event and for runs that
   * predate slot numbering, and the computed next position otherwise.
   */
  function appendEventStatement(opts: {
    runId: string;
    eventId?: string;
    eventType: string;
    correlationId?: string;
    payload: Record<string, unknown>;
    specVersion: number;
    createdAt: string;
    guard?: 'changed' | { hookExists: string };
  }): InStatement {
    const idSql = opts.eventId === undefined ? slotIdExpr() : '?';
    const idArgs: InValue[] = opts.eventId === undefined ? [opts.runId] : [opts.eventId];
    let where = '';
    const whereArgs: InValue[] = [];
    if (opts.guard === 'changed') {
      where = 'WHERE changes() > 0';
    } else if (opts.guard) {
      where = 'WHERE EXISTS (SELECT 1 FROM workflow_hooks WHERE hook_id = ? AND run_id = ?)';
      whereArgs.push(opts.guard.hookExists, opts.runId);
    }
    return {
      sql: `INSERT INTO workflow_events (run_id, event_id, type, correlation_id, payload, spec_version, created_at)
            SELECT ?, ${idSql}, ?, ?, ?, ?, ? ${where}
            RETURNING *`,
      args: [
        opts.runId,
        ...idArgs,
        opts.eventType,
        opts.correlationId ?? null,
        encodeCbor(opts.payload),
        opts.specVersion,
        opts.createdAt,
        ...whereArgs,
      ],
    };
  }

  async function writeBatch(statements: InStatement[]): Promise<ResultSet[]> {
    return client.batch(statements, 'write');
  }

  /**
   * The report half of bump-and-report: the events occupying the positions
   * between the one the writer expected (`eventCount + 1`) and the one its
   * write landed on. SQLite commits writers one at a time, so every position
   * below the committed one is already readable here.
   */
  async function reportSkipped(
    runId: string,
    committedEventId: string,
    eventCount: number | undefined,
    resolveData: EventsResolveData
  ): Promise<{ events: Event[]; cursor: null; hasMore: false } | undefined> {
    if (eventCount === undefined) return undefined;
    const committedSlot = eventIdToSlot(committedEventId);
    if (committedSlot === null || committedSlot <= eventCount + 1) {
      return undefined;
    }
    const lower = eventCount >= FIRST_EVENT_SLOT ? slotToEventId(eventCount) : '';
    const result = await client.execute({
      sql: `SELECT * FROM workflow_events
            WHERE run_id = ? AND event_id > ? AND event_id < ?
            ORDER BY event_id ASC`,
      args: [runId, lower, committedEventId],
    });
    return {
      events: result.rows.map((row) => filterEvent(rowToEvent(row), resolveData)),
      cursor: null,
      hasMore: false,
    };
  }

  /**
   * The ID a run's next event takes when the run predates slot numbering:
   * such a run keeps minting ULIDs, which sort after its existing ones.
   */
  function legacyEventId(specVersion: number | undefined): string | undefined {
    if (specVersion === undefined || specVersion >= SPEC_VERSION_SUPPORTS_SLOT_IDENTITY) {
      return undefined;
    }
    return `${EVENT_ID_PREFIX}${generateUlid()}`;
  }

  /**
   * Pre-event-sourcing runs (spec version 1) accept only the events an old
   * runtime may still send them: cancellation and wake-ups.
   */
  async function handleLegacyEvent(
    runId: string,
    data: AnyEventRequest,
    resolveData: EventsResolveData
  ): Promise<EventResult> {
    const nowStr = new Date().toISOString();
    const specVersion = data.specVersion ?? SPEC_VERSION_CURRENT;
    if (data.eventType === 'run_cancelled') {
      await writeBatch([
        {
          sql: `UPDATE workflow_runs SET status = 'cancelled', completed_at = COALESCE(completed_at, ?), updated_at = ? WHERE run_id = ?`,
          args: [nowStr, nowStr, runId],
        },
        { sql: 'DELETE FROM workflow_hooks WHERE run_id = ?', args: [runId] },
      ]);
      const row = await getRunRow(runId);
      return { run: row ? filterRun(rowToRun(row), entityResolveData(resolveData)) : undefined };
    }
    if (data.eventType === 'wait_completed' || data.eventType === 'hook_received') {
      const [result] = await writeBatch([
        appendEventStatement({
          runId,
          eventId: `${EVENT_ID_PREFIX}${generateUlid()}`,
          eventType: data.eventType,
          correlationId: data.correlationId,
          payload: { eventData: 'eventData' in data ? data.eventData : undefined },
          specVersion,
          createdAt: nowStr,
        }),
      ]);
      return { event: filterEvent(rowToEvent(result.rows[0]), resolveData) };
    }
    throw new EntityConflictError(
      `Event '${data.eventType}' is not supported for legacy runs`
    );
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
    const nowStr = now.toISOString();

    // =========================================================================
    // run_created: the run row and the run's first event, together
    // =========================================================================
    if (data.eventType === 'run_created') {
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
      const {
        dynamicWorkflowCode: _dynamicWorkflowCode,
        dynamicWorkflowCodeRef: _dynamicWorkflowCodeRef,
        ...storedEventData
      } = eventData;
      let results: ResultSet[];
      try {
        results = await writeBatch([
          {
            sql: `INSERT INTO workflow_runs (run_id, deployment_id, workflow_name, status, input, execution_context, attributes, spec_version, created_at, updated_at)
                  VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)
                  RETURNING *`,
            args: [
              effectiveRunId,
              eventData.deploymentId,
              eventData.workflowName,
              encodeCbor(eventData.input),
              encodeCbor(eventData.executionContext),
              encodeCbor(eventData.attributes ?? {}),
              specVersion,
              nowStr,
              nowStr,
            ],
          },
          appendEventStatement({
            runId: effectiveRunId,
            eventId: slotToEventId(FIRST_EVENT_SLOT),
            eventType: 'run_created',
            correlationId: data.correlationId,
            payload: { eventData: storedEventData },
            specVersion,
            createdAt: nowStr,
          }),
        ]);
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new EntityConflictError(`Workflow run "${effectiveRunId}" already exists`);
        }
        throw error;
      }
      return {
        event: filterEvent(rowToEvent(results[1].rows[0]), resolveData),
        run: filterRun(rowToRun(results[0].rows[0]), entityRD),
      };
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
      throw new WorkflowWorldError(`${data.eventType} requires a correlationId`, {
        status: 400,
      });
    }

    let runRow = await getRunRow(runId);

    // Resilient start: a run_started for a run whose run_created never landed
    // carries what it takes to create the run here.
    if (data.eventType === 'run_started' && !runRow && data.eventData) {
      const startData = data.eventData;
      if (startData.deploymentId && startData.workflowName && startData.input !== undefined) {
        validateAttributeChanges(
          Object.entries(startData.attributes ?? {}).map(([key, value]) => ({ key, value })),
          { allowReservedAttributes: startData.allowReservedAttributes === true }
        );
        await writeBatch([
          {
            sql: `INSERT OR IGNORE INTO workflow_runs (run_id, deployment_id, workflow_name, status, input, execution_context, attributes, spec_version, created_at, updated_at)
                  VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)`,
            args: [
              runId,
              startData.deploymentId,
              startData.workflowName,
              encodeCbor(startData.input),
              encodeCbor(startData.executionContext),
              encodeCbor(startData.attributes ?? {}),
              specVersion,
              nowStr,
              nowStr,
            ],
          },
          appendEventStatement({
            runId,
            eventId: slotToEventId(FIRST_EVENT_SLOT),
            eventType: 'run_created',
            payload: {
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
            specVersion,
            createdAt: nowStr,
            guard: 'changed',
          }),
        ]);
        runRow = await getRunRow(runId);
      }
    }

    if (!runRow) {
      throw new WorkflowRunNotFoundError(runId);
    }

    const currentRun = rowToRun(runRow);
    if (requiresNewerWorld(currentRun.specVersion)) {
      throw new RunNotSupportedError(currentRun.specVersion!, SPEC_VERSION_CURRENT);
    }
    if (isLegacySpecVersion(currentRun.specVersion)) {
      return handleLegacyEvent(runId, data, resolveData);
    }

    const explicitEventId = legacyEventId(currentRun.specVersion);
    const runIsTerminal = isTerminalWorkflowRunStatus(currentRun.status);
    const lazyStepStart =
      data.eventType === 'step_started' && isChildEntityCreationEvent(data);

    // =========================================================================
    // Terminal run guards
    // =========================================================================
    if (runIsTerminal) {
      if (data.eventType === 'run_cancelled' && currentRun.status === 'cancelled') {
        const [result] = await writeBatch([
          appendEventStatement({
            runId,
            eventId: explicitEventId,
            eventType: 'run_cancelled',
            payload: { eventData: data.eventData },
            specVersion,
            createdAt: nowStr,
          }),
        ]);
        return {
          event: filterEvent(rowToEvent(result.rows[0]), resolveData),
          run: filterRun(currentRun, entityRD),
        };
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

    const append = (
      overrides: Partial<Parameters<typeof appendEventStatement>[0]> = {}
    ): InStatement =>
      appendEventStatement({
        runId,
        eventId: explicitEventId,
        eventType: data.eventType,
        correlationId: data.correlationId,
        payload: { eventData: 'eventData' in data ? data.eventData : undefined },
        specVersion,
        createdAt: nowStr,
        ...overrides,
      });

    const finish = async (
      eventRow: Row,
      entities: Omit<EventResult, 'event'> = {}
    ): Promise<EventResult> => {
      const event = rowToEvent(eventRow);
      const skipped = await reportSkipped(runId, event.eventId, params?.eventCount, resolveData);
      return {
        ...entities,
        event: filterEvent(event, resolveData),
        ...(skipped ?? {}),
      } as EventResult;
    };

    const stepNotUpdated = async (stepId: string): Promise<never> => {
      const existing = await getStepRow(runId, stepId);
      if (!existing) {
        throw new WorkflowWorldError(`Step "${stepId}" not found`, { status: 404 });
      }
      const status = String(existing.status);
      if (isTerminalStepStatus(status)) {
        throw new EntityConflictError(`Cannot modify step in terminal state "${status}"`);
      }
      const run = await getRunRow(runId);
      if (run && isTerminalWorkflowRunStatus(String(run.status))) {
        throw new RunExpiredError(
          `Cannot modify step on run in terminal state "${String(run.status)}"`,
          runId,
          String(run.status) as 'completed' | 'failed' | 'cancelled'
        );
      }
      const retryAfter = toDate(existing.retry_after);
      if (retryAfter && retryAfter.getTime() > Date.now()) {
        throw new TooEarlyError(
          `Cannot start step "${stepId}": retryAfter timestamp has not been reached yet`,
          { retryAfter: Math.ceil((retryAfter.getTime() - Date.now()) / 1000) }
        );
      }
      throw new EntityConflictError(`Step "${stepId}" could not be updated`);
    };

    switch (data.eventType) {
      // =======================================================================
      // Run lifecycle
      // =======================================================================
      case 'run_started': {
        if (currentRun.status === 'running') {
          return { run: filterRun(currentRun, entityRD) } as EventResult;
        }
        const results = await writeBatch([
          {
            sql: `UPDATE workflow_runs SET status = 'running', started_at = COALESCE(started_at, ?), updated_at = ?
                  WHERE run_id = ? AND status = 'pending'`,
            args: [nowStr, nowStr, runId],
          },
          append({ payload: {}, guard: 'changed' }),
        ]);
        const run = rowToRun((await getRunRow(runId))!);
        if (results[1].rows.length === 0) {
          if (isTerminalWorkflowRunStatus(run.status)) {
            throw new RunExpiredError(
              `Workflow run "${runId}" is already in terminal state "${run.status}"`,
              runId,
              run.status
            );
          }
          return { run: filterRun(run, entityRD) } as EventResult;
        }
        return finish(results[1].rows[0], { run: filterRun(run, entityRD) });
      }

      case 'run_completed':
      case 'run_failed':
      case 'run_cancelled': {
        let set: string;
        let setArgs: InValue[];
        if (data.eventType === 'run_completed') {
          set = `status = 'completed', output = ?`;
          setArgs = [encodeCbor(data.eventData.output)];
        } else if (data.eventType === 'run_failed') {
          set = `status = 'failed', error = ?, error_code = ?`;
          setArgs = [encodeCbor(data.eventData.error), data.eventData.errorCode ?? null];
        } else {
          set = `status = 'cancelled'`;
          setArgs = [];
        }
        const results = await writeBatch([
          {
            sql: `UPDATE workflow_runs SET ${set}, completed_at = ?, updated_at = ?
                  WHERE run_id = ? AND status NOT IN ${TERMINAL_RUN_SQL}`,
            args: [...setArgs, nowStr, nowStr, runId],
          },
          append({ guard: 'changed' }),
          // A run that ended releases its hook tokens and its waits.
          {
            sql: `DELETE FROM workflow_hooks WHERE run_id = ? AND (SELECT status FROM workflow_runs WHERE run_id = ?) IN ${TERMINAL_RUN_SQL}`,
            args: [runId, runId],
          },
          {
            sql: `DELETE FROM workflow_waits WHERE run_id = ? AND (SELECT status FROM workflow_runs WHERE run_id = ?) IN ${TERMINAL_RUN_SQL}`,
            args: [runId, runId],
          },
        ]);
        if (results[1].rows.length === 0) {
          const run = rowToRun((await getRunRow(runId))!);
          if (data.eventType === 'run_cancelled' && run.status === 'cancelled') {
            return createEvent(runId, data, params);
          }
          throw new EntityConflictError(
            `Cannot transition run from terminal state "${run.status}"`
          );
        }
        const run = rowToRun((await getRunRow(runId))!);
        return finish(results[1].rows[0], { run: filterRun(run, entityRD) });
      }

      case 'attr_set': {
        const { changes, allowReservedAttributes } = data.eventData;
        if (data.correlationId && data.eventData.writer.type === 'workflow') {
          const duplicate = await client.execute({
            sql: `SELECT 1 FROM workflow_events WHERE run_id = ? AND correlation_id = ? AND type = 'attr_set' LIMIT 1`,
            args: [runId, data.correlationId],
          });
          if (duplicate.rows.length > 0) {
            throw new EntityConflictError(
              `attr_set for correlationId "${data.correlationId}" already exists in run "${runId}"`
            );
          }
        }
        // Compare-and-set on the attribute blob, so two concurrent writers
        // cannot both apply their changes to the same starting set.
        for (let attempt = 0; attempt < ATTR_SET_MAX_ATTEMPTS; attempt++) {
          const row = attempt === 0 ? runRow : await getRunRow(runId);
          if (!row) throw new WorkflowRunNotFoundError(runId);
          if (isTerminalWorkflowRunStatus(String(row.status))) {
            throw new EntityConflictError(
              `Cannot set attributes on run in terminal state "${String(row.status)}"`
            );
          }
          const existing = decodeCbor<Record<string, string>>(row.attributes) ?? {};
          validateAttributeChanges(changes, {
            existingKeys: Object.keys(existing),
            allowReservedAttributes: allowReservedAttributes === true,
          });
          const next = applyAttributeChanges(existing, changes);
          if (Object.keys(next).length > ATTRIBUTE_MAX_PER_RUN) {
            throw new AttributeValidationError(
              `Run attribute count would exceed limit ${ATTRIBUTE_MAX_PER_RUN}`
            );
          }
          const previousBlob = (row.attributes ?? null) as InValue;
          const results = await writeBatch([
            {
              sql: `UPDATE workflow_runs SET attributes = ?, updated_at = ?
                    WHERE run_id = ? AND attributes IS ? AND status NOT IN ${TERMINAL_RUN_SQL}`,
              args: [encodeCbor(next), nowStr, runId, previousBlob],
            },
            append({ guard: 'changed' }),
          ]);
          if (results[1].rows.length > 0) {
            const run = rowToRun((await getRunRow(runId))!);
            return finish(results[1].rows[0], { run: filterRun(run, entityRD) });
          }
        }
        throw new WorkflowWorldError(
          `Could not apply attributes to run "${runId}" under contention`,
          { status: 503 }
        );
      }

      // =======================================================================
      // Step lifecycle
      // =======================================================================
      case 'step_created': {
        const stepId = data.correlationId;
        let results: ResultSet[];
        try {
          results = await writeBatch([
            {
              sql: `INSERT INTO workflow_steps (id, run_id, step_id, step_name, status, input, attempt, spec_version, created_at, updated_at)
                    SELECT ?, ?, ?, ?, 'pending', ?, 0, ?, ?, ?
                    WHERE (SELECT status FROM workflow_runs WHERE run_id = ?) NOT IN ${TERMINAL_RUN_SQL}`,
              args: [
                `${runId}-${stepId}`,
                runId,
                stepId,
                data.eventData.stepName,
                encodeCbor(data.eventData.input),
                specVersion,
                nowStr,
                nowStr,
                runId,
              ],
            },
            append({ guard: 'changed' }),
          ]);
        } catch (error) {
          if (isUniqueViolation(error)) {
            throw new EntityConflictError(`Step "${stepId}" already exists`);
          }
          throw error;
        }
        if (results[1].rows.length === 0) {
          throw new EntityConflictError(
            'Cannot create new entities on terminal run'
          );
        }
        const step = rowToStep((await getStepRow(runId, stepId))!);
        return finish(results[1].rows[0], { step: filterStep(step, entityRD) });
      }

      case 'step_started': {
        const stepId = data.correlationId;
        const existing = await getStepRow(runId, stepId);
        if (lazyStepStart && existing) {
          throw new EntityConflictError(`Step "${stepId}" already created`);
        }
        if (!lazyStepStart && !existing) {
          throw new WorkflowWorldError(`Step "${stepId}" not found`, { status: 404 });
        }
        if (existing) {
          const status = String(existing.status);
          if (isTerminalStepStatus(status)) {
            throw new EntityConflictError(`Cannot modify step in terminal state "${status}"`);
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
          const retryAfter = toDate(existing.retry_after);
          if (retryAfter && retryAfter.getTime() > Date.now()) {
            throw new TooEarlyError(
              `Cannot start step "${stepId}": retryAfter timestamp has not been reached yet`,
              { retryAfter: Math.ceil((retryAfter.getTime() - Date.now()) / 1000) }
            );
          }
        }

        // The step's input belongs on step_created, not on step_started.
        const { input: lazyInput, ...startEventData } = (data.eventData ?? {}) as {
          input?: unknown;
        } & Record<string, unknown>;

        const statements: InStatement[] = [];
        if (lazyStepStart) {
          // Lazy start: the step row INSERT is the ownership claim. Only the
          // caller that inserts it runs the step body.
          statements.push(
            {
              sql: `INSERT INTO workflow_steps (id, run_id, step_id, step_name, status, input, attempt, spec_version, created_at, updated_at)
                    SELECT ?, ?, ?, ?, 'pending', ?, 0, ?, ?, ?
                    WHERE (SELECT status FROM workflow_runs WHERE run_id = ?) NOT IN ${TERMINAL_RUN_SQL}`,
              args: [
                `${runId}-${stepId}`,
                runId,
                stepId,
                String(startEventData.stepName),
                encodeCbor(lazyInput),
                specVersion,
                nowStr,
                nowStr,
                runId,
              ],
            },
            append({
              eventType: 'step_created',
              payload: {
                eventData: { stepName: startEventData.stepName, input: lazyInput },
              },
              guard: 'changed',
            })
          );
        }
        statements.push(
          {
            sql: `UPDATE workflow_steps
                  SET status = 'running', attempt = attempt + 1, started_at = COALESCE(started_at, ?), retry_after = NULL, updated_at = ?
                  WHERE id = ? AND status NOT IN ${TERMINAL_STEP_SQL}
                    AND (retry_after IS NULL OR retry_after <= ?)
                    AND (SELECT status FROM workflow_runs WHERE run_id = ?) NOT IN ${TERMINAL_RUN_SQL}`,
            args: [nowStr, nowStr, `${runId}-${stepId}`, nowStr, runId],
          },
          append({ payload: { eventData: data.eventData ? startEventData : undefined }, guard: 'changed' })
        );

        let results: ResultSet[];
        try {
          results = await writeBatch(statements);
        } catch (error) {
          if (isUniqueViolation(error)) {
            throw new EntityConflictError(`Step "${stepId}" already created`);
          }
          throw error;
        }
        const eventRows = results[results.length - 1].rows;
        if (eventRows.length === 0) {
          if (lazyStepStart && results[0].rowsAffected === 0) {
            throw new EntityConflictError(
              'Cannot create new entities on terminal run'
            );
          }
          return stepNotUpdated(stepId);
        }
        const step = rowToStep((await getStepRow(runId, stepId))!);
        return finish(eventRows[0], {
          step: filterStep(step, entityRD),
          ...(lazyStepStart ? { stepCreated: true as const } : {}),
        });
      }

      case 'step_completed':
      case 'step_failed':
      case 'step_retrying': {
        const stepId = data.correlationId;
        let set: string;
        let setArgs: InValue[];
        let runGuard = '';
        if (data.eventType === 'step_completed') {
          set = `status = 'completed', output = ?, completed_at = ?`;
          setArgs = [encodeCbor(data.eventData.result), nowStr];
        } else if (data.eventType === 'step_failed') {
          set = `status = 'failed', error = ?, completed_at = ?`;
          setArgs = [encodeCbor(data.eventData.error), nowStr];
        } else {
          set = `status = 'pending', error = ?, retry_after = ?`;
          setArgs = [encodeCbor(data.eventData.error), toIso(data.eventData.retryAfter)];
          // A step in flight may still record its outcome on an ended run,
          // but a retry schedules more work, which an ended run never runs.
          runGuard = `AND (status = 'running' OR (SELECT status FROM workflow_runs WHERE run_id = ?) NOT IN ${TERMINAL_RUN_SQL})`;
        }
        const results = await writeBatch([
          {
            sql: `UPDATE workflow_steps SET ${set}, updated_at = ?
                  WHERE id = ? AND status NOT IN ${TERMINAL_STEP_SQL} ${runGuard}`,
            args: [...setArgs, nowStr, `${runId}-${stepId}`, ...(runGuard ? [runId] : [])],
          },
          append({ guard: 'changed' }),
        ]);
        if (results[1].rows.length === 0) {
          return stepNotUpdated(stepId);
        }
        const step = rowToStep((await getStepRow(runId, stepId))!);
        return finish(results[1].rows[0], { step: filterStep(step, entityRD) });
      }

      // =======================================================================
      // Hooks
      // =======================================================================
      case 'hook_created': {
        const hookId = data.correlationId;
        const { token } = data.eventData;
        const conflict = async (conflictingRunId: string | undefined) => {
          const [result] = await writeBatch([
            append({
              eventType: 'hook_conflict',
              payload: { eventData: { token, conflictingRunId } },
            }),
          ]);
          return finish(result.rows[0]);
        };
        const owner = await client.execute({
          sql: 'SELECT hook_id, run_id FROM workflow_hooks WHERE token = ?',
          args: [token],
        });
        if (owner.rows.length > 0) {
          const ownerRow = owner.rows[0];
          if (String(ownerRow.hook_id) === hookId && String(ownerRow.run_id) === runId) {
            throw new EntityConflictError(`Hook "${hookId}" already created`);
          }
          return conflict(String(ownerRow.run_id));
        }
        let results: ResultSet[];
        try {
          results = await writeBatch([
            {
              sql: `INSERT INTO workflow_hooks (hook_id, run_id, token, metadata, owner_id, project_id, environment, spec_version, is_webhook, is_system, created_at, updated_at)
                    SELECT ?, ?, ?, ?, 'turso-owner', 'turso-project', 'development', ?, ?, ?, ?, ?
                    WHERE (SELECT status FROM workflow_runs WHERE run_id = ?) NOT IN ${TERMINAL_RUN_SQL}`,
              args: [
                hookId,
                runId,
                token,
                encodeCbor(data.eventData.metadata),
                specVersion,
                data.eventData.isWebhook === undefined ? null : data.eventData.isWebhook ? 1 : 0,
                data.eventData.isSystem ? 1 : 0,
                nowStr,
                nowStr,
                runId,
              ],
            },
            append({ guard: 'changed' }),
          ]);
        } catch (error) {
          if (!isUniqueViolation(error)) throw error;
          const raced = await client.execute({
            sql: 'SELECT hook_id, run_id FROM workflow_hooks WHERE token = ?',
            args: [token],
          });
          const racedRow = raced.rows[0];
          if (
            !racedRow ||
            (String(racedRow.hook_id) === hookId && String(racedRow.run_id) === runId)
          ) {
            throw new EntityConflictError(`Hook "${hookId}" already created`);
          }
          return conflict(String(racedRow.run_id));
        }
        if (results[1].rows.length === 0) {
          throw new EntityConflictError('Cannot create new entities on terminal run');
        }
        const hookRow = await client.execute({
          sql: 'SELECT * FROM workflow_hooks WHERE hook_id = ?',
          args: [hookId],
        });
        return finish(results[1].rows[0], {
          hook: filterHook(rowToHook(hookRow.rows[0]), entityRD),
        });
      }

      case 'hook_received': {
        // The existence check is in the INSERT itself, so a delivery cannot
        // commit after the disposal it races.
        const [result] = await writeBatch([
          append({ guard: { hookExists: data.correlationId } }),
        ]);
        if (result.rows.length === 0) {
          throw new HookNotFoundError(data.correlationId);
        }
        return finish(result.rows[0]);
      }

      case 'hook_disposed': {
        const results = await writeBatch([
          {
            sql: 'DELETE FROM workflow_hooks WHERE hook_id = ? AND run_id = ?',
            args: [data.correlationId, runId],
          },
          append({ guard: 'changed' }),
        ]);
        if (results[1].rows.length === 0) {
          throw new HookNotFoundError(data.correlationId);
        }
        return finish(results[1].rows[0]);
      }

      // =======================================================================
      // Waits
      // =======================================================================
      case 'wait_created': {
        let results: ResultSet[];
        try {
          results = await writeBatch([
            {
              sql: `INSERT INTO workflow_waits (run_id, wait_id, status, resume_at, spec_version, created_at, updated_at)
                    SELECT ?, ?, 'waiting', ?, ?, ?, ?
                    WHERE (SELECT status FROM workflow_runs WHERE run_id = ?) NOT IN ${TERMINAL_RUN_SQL}`,
              args: [
                runId,
                data.correlationId,
                toIso(data.eventData.resumeAt),
                specVersion,
                nowStr,
                nowStr,
                runId,
              ],
            },
            append({ guard: 'changed' }),
          ]);
        } catch (error) {
          if (isUniqueViolation(error)) {
            throw new EntityConflictError(`Wait "${data.correlationId}" already exists`);
          }
          throw error;
        }
        if (results[1].rows.length === 0) {
          throw new EntityConflictError('Cannot create new entities on terminal run');
        }
        const waitRow = await client.execute({
          sql: 'SELECT * FROM workflow_waits WHERE run_id = ? AND wait_id = ?',
          args: [runId, data.correlationId],
        });
        return finish(results[1].rows[0], { wait: rowToWait(waitRow.rows[0]) });
      }

      case 'wait_completed': {
        let results: ResultSet[];
        try {
          results = await writeBatch([
            {
              sql: `UPDATE workflow_waits SET status = 'completed', completed_at = ?, updated_at = ?
                    WHERE run_id = ? AND wait_id = ? AND status = 'waiting'`,
              args: [nowStr, nowStr, runId, data.correlationId],
            },
            append({ guard: 'changed' }),
          ]);
        } catch (error) {
          if (isUniqueViolation(error)) {
            throw new EntityConflictError(`Wait "${data.correlationId}" already completed`);
          }
          throw error;
        }
        const waitRow = await client.execute({
          sql: 'SELECT * FROM workflow_waits WHERE run_id = ? AND wait_id = ?',
          args: [runId, data.correlationId],
        });
        if (results[1].rows.length === 0) {
          if (waitRow.rows.length === 0) {
            throw new WorkflowWorldError(`Wait "${data.correlationId}" not found`, {
              status: 404,
            });
          }
          throw new EntityConflictError(`Wait "${data.correlationId}" already completed`);
        }
        return finish(results[1].rows[0], { wait: rowToWait(waitRow.rows[0]) });
      }

      default:
        throw new WorkflowWorldError(
          `Unsupported event type: ${(data as { eventType: string }).eventType}`,
          { status: 400 }
        );
    }
  }

  // ===========================================================================
  // Public surface
  // ===========================================================================

  const storage: Storage = {
    runs: {
      async get(id: string, params?: { resolveData?: ResolveData }) {
        const row = await getRunRow(id);
        if (!row) throw new WorkflowRunNotFoundError(id);
        return filterRun(rowToRun(row), params?.resolveData) as any;
      },

      async list(params?: ListWorkflowRunsParams) {
        const sortOrder = params?.pagination?.sortOrder ?? 'desc';
        const limit = params?.pagination?.limit ?? 100;
        const cursor = params?.pagination?.cursor;
        const conditions: string[] = [];
        const args: InValue[] = [];
        if (params?.workflowName) {
          conditions.push('workflow_name = ?');
          args.push(params.workflowName);
        }
        if (params?.status !== undefined) {
          const statuses = Array.isArray(params.status) ? params.status : [params.status];
          if (statuses.length === 0) {
            return { data: [], cursor: null, hasMore: false };
          }
          conditions.push(`status IN (${statuses.map(() => '?').join(', ')})`);
          args.push(...statuses);
        }
        if (cursor) {
          conditions.push(sortOrder === 'desc' ? 'run_id < ?' : 'run_id > ?');
          args.push(cursor);
        }
        const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
        const result = await client.execute({
          sql: `SELECT * FROM workflow_runs ${where} ORDER BY run_id ${sortOrder === 'desc' ? 'DESC' : 'ASC'} LIMIT ?`,
          args: [...args, limit + 1],
        });
        const hasMore = result.rows.length > limit;
        const data = result.rows
          .slice(0, limit)
          .map((row) => filterRun(rowToRun(row), params?.resolveData));
        return {
          data,
          cursor: hasMore ? (data[data.length - 1]?.runId ?? null) : null,
          hasMore,
        } as any;
      },
    } as Storage['runs'],

    steps: {
      async get(runId: string, stepId: string, params?: { resolveData?: ResolveData }) {
        const row = await getStepRow(runId, stepId);
        if (!row) {
          throw new WorkflowWorldError(`Step "${stepId}" not found`, { status: 404 });
        }
        return filterStep(rowToStep(row), params?.resolveData) as any;
      },

      async list(params) {
        const sortOrder = params.pagination?.sortOrder ?? 'desc';
        const limit = params.pagination?.limit ?? 100;
        const cursor = params.pagination?.cursor;
        const args: InValue[] = [params.runId];
        let cursorSql = '';
        if (cursor) {
          cursorSql = sortOrder === 'desc' ? 'AND id < ?' : 'AND id > ?';
          args.push(`${params.runId}-${cursor}`);
        }
        const result = await client.execute({
          sql: `SELECT * FROM workflow_steps WHERE run_id = ? ${cursorSql}
                ORDER BY id ${sortOrder === 'desc' ? 'DESC' : 'ASC'} LIMIT ?`,
          args: [...args, limit + 1],
        });
        const hasMore = result.rows.length > limit;
        const data = result.rows
          .slice(0, limit)
          .map((row) => filterStep(rowToStep(row), params.resolveData));
        return {
          data,
          cursor: hasMore ? (data[data.length - 1]?.stepId ?? null) : null,
          hasMore,
        } as any;
      },
    } as Storage['steps'],

    events: {
      create: createEvent as Storage['events']['create'],

      async get(runId, eventId, params) {
        const row = await getEventRow(runId, eventId);
        if (!row) {
          throw new WorkflowWorldError(`Event "${eventId}" not found in run "${runId}"`, {
            status: 404,
          });
        }
        return filterEvent(rowToEvent(row), params?.resolveData);
      },

      async list(params) {
        const sortOrder = params.pagination?.sortOrder ?? 'asc';
        const limit = params.pagination?.limit ?? 10000;
        const cursor = params.pagination?.cursor;
        const args: InValue[] = [params.runId];
        let cursorSql = '';
        if (cursor) {
          cursorSql = sortOrder === 'asc' ? 'AND event_id > ?' : 'AND event_id < ?';
          args.push(cursor);
        }
        const result = await client.execute({
          sql: `SELECT * FROM workflow_events WHERE run_id = ? ${cursorSql}
                ORDER BY event_id ${sortOrder === 'asc' ? 'ASC' : 'DESC'} LIMIT ?`,
          args: [...args, limit + 1],
        });
        const hasMore = result.rows.length > limit;
        const data = result.rows
          .slice(0, limit)
          .map((row) => filterEvent(rowToEvent(row), params.resolveData));
        return {
          data,
          cursor: hasMore ? (data[data.length - 1]?.eventId ?? null) : null,
          hasMore,
        };
      },

      async listByCorrelationId(params) {
        const sortOrder = params.pagination?.sortOrder ?? 'asc';
        const limit = params.pagination?.limit ?? 100;
        const cursor = params.pagination?.cursor;
        const args: InValue[] = [params.runId, params.correlationId];
        let cursorSql = '';
        if (cursor) {
          cursorSql = sortOrder === 'asc' ? 'AND event_id > ?' : 'AND event_id < ?';
          args.push(cursor);
        }
        const result = await client.execute({
          sql: `SELECT * FROM workflow_events WHERE run_id = ? AND correlation_id = ? ${cursorSql}
                ORDER BY event_id ${sortOrder === 'asc' ? 'ASC' : 'DESC'} LIMIT ?`,
          args: [...args, limit + 1],
        });
        const hasMore = result.rows.length > limit;
        const data = result.rows
          .slice(0, limit)
          .map((row) => filterEvent(rowToEvent(row), params.resolveData));
        return {
          data,
          cursor: hasMore ? (data[data.length - 1]?.eventId ?? null) : null,
          hasMore,
        };
      },
    },

    hooks: {
      async get(hookId, params) {
        const result = await client.execute({
          sql: 'SELECT * FROM workflow_hooks WHERE hook_id = ?',
          args: [hookId],
        });
        if (result.rows.length === 0) throw new HookNotFoundError(hookId);
        return filterHook(rowToHook(result.rows[0]), params?.resolveData);
      },

      async getByToken(token, params) {
        const result = await client.execute({
          sql: 'SELECT * FROM workflow_hooks WHERE token = ?',
          args: [token],
        });
        if (result.rows.length === 0) throw new HookNotFoundError(token);
        return filterHook(rowToHook(result.rows[0]), params?.resolveData);
      },

      async list(params) {
        const sortOrder = params.pagination?.sortOrder ?? 'asc';
        const limit = params.pagination?.limit ?? 100;
        const cursor = params.pagination?.cursor;
        const conditions: string[] = [];
        const args: InValue[] = [];
        if (params.runId) {
          conditions.push('run_id = ?');
          args.push(params.runId);
        }
        if (cursor) {
          conditions.push(sortOrder === 'asc' ? 'hook_id > ?' : 'hook_id < ?');
          args.push(cursor);
        }
        const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
        const result = await client.execute({
          sql: `SELECT * FROM workflow_hooks ${where}
                ORDER BY hook_id ${sortOrder === 'asc' ? 'ASC' : 'DESC'} LIMIT ?`,
          args: [...args, limit + 1],
        });
        const hasMore = result.rows.length > limit;
        const data = result.rows
          .slice(0, limit)
          .map((row) => filterHook(rowToHook(row), params.resolveData));
        return {
          data,
          cursor: hasMore ? (data[data.length - 1]?.hookId ?? null) : null,
          hasMore,
        };
      },
    },
  };

  return storage;
}

export type TursoStorage = ReturnType<typeof createStorage>;
export type { PaginatedResponse };
