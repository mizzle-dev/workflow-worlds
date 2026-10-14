/**
 * MongoDB Storage Implementation (Event-Sourced)
 *
 * An event's ID is its position in its run's log. The position is chosen by
 * the insert that appends the event: read the run's highest position, insert
 * at the next one, and let the unique `(runId, eventId)` index reject the
 * insert when another writer took that position first. The loser re-reads and
 * takes the next free one, so a position is never reserved ahead of its
 * event, the log stays dense, and a position N is only ever written after
 * N - 1 is committed.
 *
 * Entity changes are guarded updates (`findOneAndUpdate` with the state the
 * decision depended on in the filter). When the deployment supports
 * transactions (a replica set or a sharded cluster) the entity change and the
 * event commit in one transaction. On a standalone server they are two writes,
 * entity first, and a process that dies between them leaves the entity ahead
 * of the log.
 */

import {
  EntityConflictError,
  HookNotFoundError,
  RunExpiredError,
  RunNotSupportedError,
  TooEarlyError,
  WorkflowRunNotFoundError,
  WorkflowWorldError,
} from '@workflow/errors';
import {
  ATTRIBUTE_MAX_PER_RUN,
  AttributeValidationError,
  applyAttributeChanges,
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
  TERMINAL_STEP_STATUSES,
  TERMINAL_WORKFLOW_RUN_STATUSES,
  validateAttributeChanges,
  validateUlidTimestamp,
  type AnyEventRequest,
  type CreateEventParams,
  type Event,
  type EventResult,
  type EventsResolveData,
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
  type ResolveData,
  type Step,
  type Storage,
  type Wait,
  type WorkflowRun,
} from '@workflow/world';
import { MongoClient, type ClientSession, type Collection, type Document } from 'mongodb';
import { generateUlid } from './utils.js';


/** Inserts one event tries before giving up under sustained contention. */
const SLOT_INSERT_MAX_ATTEMPTS = 40;
/** Collisions retried immediately before backing off with jitter. */
const SLOT_INSERT_IMMEDIATE_ATTEMPTS = 8;
/** Attribute writes retried after losing their compare-and-set. */
const ATTR_SET_MAX_ATTEMPTS = 20;

const TERMINAL_RUN = [...TERMINAL_WORKFLOW_RUN_STATUSES];
const TERMINAL_STEP = [...TERMINAL_STEP_STATUSES];

type WorkflowRunDocument = WorkflowRun & Document;
type StepDocument = Step & Document;
type HookDocument = Hook & Document;
type WaitDocument = Wait & Document;
interface EventDocument extends Document {
  runId: string;
  eventId: string;
  eventType: string;
  correlationId?: string;
  eventData?: unknown;
  specVersion?: number;
  createdAt: Date;
}

/** Thrown when the position an insert computed was taken first. */
class SlotTaken extends Error {}

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

/** A plain `Uint8Array` view of a Buffer, which not every consumer has. */
function toUint8Array(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/**
 * Converts a stored document back to its entity: drops `_id`, and turns BSON
 * Binary back into bytes. `Uint8Array` values (serialized payloads) are
 * stored as Binary.
 */
function cleanMongoDoc<T>(doc: T): T {
  if (doc === null || doc === undefined) return doc;
  if (typeof doc !== 'object') return doc;
  if (ArrayBuffer.isView(doc)) return doc;
  if (isMongoBinaryLike(doc)) return toUint8Array(doc.value()) as T;
  if (Array.isArray(doc)) return doc.map(cleanMongoDoc) as T;
  if (doc instanceof Date) return doc;

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(doc as object)) {
    if (key === '_id' || key === 'attributesVersion') continue;
    result[key] =
      typeof value === 'object' && value !== null && !(value instanceof Date)
        ? cleanMongoDoc(value)
        : value;
  }
  return result as T;
}

function filterRun(run: WorkflowRun, resolveData: ResolveData = 'all'): WorkflowRun {
  const base = { ...run, attributes: run.attributes ?? {} } as WorkflowRun;
  if (resolveData === 'none') {
    return { ...base, input: undefined, output: undefined } as WorkflowRun;
  }
  return base;
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

export interface MongoStorageConfig {
  mongoUrl?: string;
  databaseName?: string;
  client?: MongoClient;
}

/**
 * Replaces the pre-positional `eventId` indexes. Event IDs are only unique
 * within their run now, so a collection-wide unique index on `eventId` would
 * reject the second run's first event.
 */
async function migrateEventIndexes(events: Collection<EventDocument>): Promise<void> {
  let existing: Document[] = [];
  try {
    existing = await events.listIndexes().toArray();
  } catch {
    // The collection does not exist yet.
  }
  for (const index of existing) {
    const key = JSON.stringify(index.key);
    const isGlobalEventId = key === JSON.stringify({ eventId: 1 });
    const isNonUniqueRunEventId =
      key === JSON.stringify({ runId: 1, eventId: 1 }) && !index.unique;
    const isGlobalCorrelation = key === JSON.stringify({ correlationId: 1 });
    if (isGlobalEventId || isNonUniqueRunEventId || isGlobalCorrelation) {
      await events.dropIndex(index.name as string).catch(() => undefined);
    }
  }
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
  const waitsCollection = db.collection<WaitDocument>('waits');

  await migrateEventIndexes(eventsCollection);

  await Promise.all([
    runsCollection.createIndex({ runId: 1 }, { unique: true }),
    runsCollection.createIndex({ workflowName: 1 }),
    runsCollection.createIndex({ status: 1 }),
    runsCollection.createIndex({ createdAt: -1 }),

    stepsCollection.createIndex({ runId: 1, stepId: 1 }, { unique: true }),
    stepsCollection.createIndex({ runId: 1, createdAt: 1 }),

    // The position arbiter: two writers cannot both commit one position.
    eventsCollection.createIndex({ runId: 1, eventId: 1 }, { unique: true }),
    eventsCollection.createIndex({ runId: 1, correlationId: 1, eventId: 1 }),

    hooksCollection.createIndex({ hookId: 1 }, { unique: true }),
    hooksCollection.createIndex({ token: 1 }, { unique: true }),
    hooksCollection.createIndex({ runId: 1 }),

    waitsCollection.createIndex({ runId: 1, waitId: 1 }, { unique: true }),
  ]);

  // Transactions need a replica set or a sharded cluster.
  const hello = await db.admin().command({ hello: 1 }).catch(() => ({}) as Document);
  const supportsTransactions = Boolean(hello.setName) || hello.msg === 'isdbgrid';

  /**
   * Runs `fn` in a transaction where the deployment supports one, and
   * directly otherwise. `fn` receives the session to pass to every write.
   */
  async function atomically<T>(fn: (session?: ClientSession) => Promise<T>): Promise<T> {
    if (!supportsTransactions) return fn(undefined);
    const session = client.startSession();
    try {
      let result: T | undefined;
      await session.withTransaction(async () => {
        result = await fn(session);
      });
      return result as T;
    } finally {
      await session.endSession();
    }
  }

  async function getRunById(runId: string): Promise<WorkflowRun | null> {
    const run = await runsCollection.findOne({ runId });
    return run ? (cleanMongoDoc(run) as WorkflowRun) : null;
  }

  async function getStepById(runId: string, stepId: string): Promise<Step | null> {
    const step = await stepsCollection.findOne({ runId, stepId });
    return step ? (cleanMongoDoc(step) as Step) : null;
  }

  function toEvent(doc: EventDocument): Event {
    return cleanMongoDoc(doc) as unknown as Event;
  }

  /** The highest position `runId` holds, or null when its log predates positions. */
  async function lastSlot(runId: string, session?: ClientSession): Promise<number | null> {
    const last = await eventsCollection.findOne(
      { runId },
      { sort: { eventId: -1 }, projection: { eventId: 1 }, session }
    );
    if (!last) return FIRST_EVENT_SLOT - 1;
    return eventIdToSlot(last.eventId);
  }

  /**
   * One insert at the next free position. Throws {@link SlotTaken} when
   * another writer committed that position first.
   */
  async function insertAtNextSlot(
    runId: string,
    body: Omit<EventDocument, 'runId' | 'eventId'>,
    session?: ClientSession
  ): Promise<Event> {
    const slot = await lastSlot(runId, session);
    if (slot === null) {
      throw new EntityConflictError(
        `Run "${runId}" predates positional event IDs; finish or cancel it on the World version that created it`
      );
    }
    const doc = stripUndefined({ ...body, runId, eventId: slotToEventId(slot + 1) }) as EventDocument;
    try {
      await eventsCollection.insertOne(doc, { session });
    } catch (error) {
      if (isMongoDuplicateKeyError(error)) throw new SlotTaken();
      throw error;
    }
    return toEvent(doc);
  }

  /** Appends one event outside any transaction, retrying lost positions. */
  async function appendEvent(
    runId: string,
    body: Omit<EventDocument, 'runId' | 'eventId'>
  ): Promise<Event> {
    for (let attempt = 0; attempt < SLOT_INSERT_MAX_ATTEMPTS; attempt++) {
      try {
        return await insertAtNextSlot(runId, body);
      } catch (error) {
        if (!(error instanceof SlotTaken)) throw error;
        if (attempt >= SLOT_INSERT_IMMEDIATE_ATTEMPTS) {
          const delay = Math.min(40, 2 * 2 ** (attempt - SLOT_INSERT_IMMEDIATE_ATTEMPTS));
          await new Promise((resolve) => setTimeout(resolve, Math.random() * delay));
        }
      }
    }
    throw new WorkflowWorldError(
      `Could not allocate an event slot for run "${runId}" after ${SLOT_INSERT_MAX_ATTEMPTS} attempts`,
      { status: 503 }
    );
  }

  /**
   * Applies `mutate` and appends the events it returns, atomically where the
   * deployment allows. Inside a transaction a lost position aborts the whole
   * attempt and it starts over; without one, the entity change has already
   * committed, so only the event insert is retried.
   */
  async function commitWith<T>(
    runId: string,
    mutate: (session?: ClientSession) => Promise<{ value: T; events: Omit<EventDocument, 'runId' | 'eventId'>[] }>
  ): Promise<{ value: T; events: Event[] }> {
    if (!supportsTransactions) {
      const { value, events } = await mutate(undefined);
      const appended: Event[] = [];
      for (const body of events) appended.push(await appendEvent(runId, body));
      return { value, events: appended };
    }
    for (let attempt = 0; attempt < SLOT_INSERT_MAX_ATTEMPTS; attempt++) {
      try {
        return await atomically(async (session) => {
          const { value, events } = await mutate(session);
          const appended: Event[] = [];
          for (const body of events) appended.push(await insertAtNextSlot(runId, body, session));
          return { value, events: appended };
        });
      } catch (error) {
        if (!(error instanceof SlotTaken)) throw error;
      }
    }
    throw new WorkflowWorldError(
      `Could not allocate an event slot for run "${runId}" after ${SLOT_INSERT_MAX_ATTEMPTS} attempts`,
      { status: 503 }
    );
  }

  /**
   * The report half of bump-and-report: the events occupying the positions
   * between the one the writer expected (`eventCount + 1`) and the one its
   * write landed on. A position is only written once the one below it is
   * committed, so the span is complete when this reads it.
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
    const lower = eventCount >= FIRST_EVENT_SLOT ? slotToEventId(eventCount) : '';
    const docs = await eventsCollection
      .find({ runId, eventId: { $gt: lower, $lt: committedEventId } })
      .sort({ eventId: 1 })
      .toArray();
    return {
      events: docs.map((doc) => filterEvent(toEvent(doc), resolveData)),
      cursor: null,
      hasMore: false,
    };
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
    const now = new Date();
    if (data.eventType === 'run_cancelled') {
      await runsCollection.updateOne(
        { runId },
        { $set: { status: 'cancelled', completedAt: now, updatedAt: now } }
      );
      await hooksCollection.deleteMany({ runId });
      const run = await getRunById(runId);
      return { run: run ? filterRun(run, entityResolveData(resolveData)) : undefined };
    }
    if (data.eventType === 'wait_completed' || data.eventType === 'hook_received') {
      const doc = stripUndefined({
        runId,
        eventId: `${EVENT_ID_PREFIX}${generateUlid()}`,
        eventType: data.eventType,
        correlationId: data.correlationId,
        eventData: 'eventData' in data ? data.eventData : undefined,
        specVersion: data.specVersion ?? SPEC_VERSION_CURRENT,
        createdAt: now,
      }) as EventDocument;
      await eventsCollection.insertOne(doc);
      return { event: filterEvent(toEvent(doc), resolveData) };
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
      if (validationError) throw new WorkflowWorldError(validationError, { status: 400 });
    }
    const eventData = data.eventData;
    validateAttributeChanges(
      Object.entries(eventData.attributes ?? {}).map(([key, value]) => ({ key, value })),
      { allowReservedAttributes: eventData.allowReservedAttributes === true }
    );
    const now = new Date();
    const specVersion = data.specVersion ?? SPEC_VERSION_CURRENT;
    const run = {
      runId: effectiveRunId,
      deploymentId: eventData.deploymentId,
      workflowName: eventData.workflowName,
      status: 'pending',
      specVersion,
      executionContext: eventData.executionContext,
      input: eventData.input,
      attributes: eventData.attributes ?? {},
      createdAt: now,
      updatedAt: now,
    } as WorkflowRun;
    const {
      dynamicWorkflowCode: _dynamicWorkflowCode,
      dynamicWorkflowCodeRef: _dynamicWorkflowCodeRef,
      ...storedEventData
    } = eventData;
    const eventDoc = stripUndefined({
      runId: effectiveRunId,
      eventId: slotToEventId(FIRST_EVENT_SLOT),
      eventType: 'run_created',
      correlationId: data.correlationId,
      eventData: storedEventData,
      specVersion,
      createdAt: now,
    }) as EventDocument;
    try {
      await atomically(async (session) => {
        await runsCollection.insertOne(stripUndefined(run) as WorkflowRunDocument, { session });
        await eventsCollection.insertOne(eventDoc, { session });
      });
    } catch (error) {
      if (isMongoDuplicateKeyError(error)) {
        throw new EntityConflictError(`Workflow run "${effectiveRunId}" already exists`);
      }
      throw error;
    }
    return {
      event: filterEvent(toEvent(eventDoc), resolveData),
      run: filterRun(run, entityResolveData(resolveData)),
    };
  }

  async function createEvent(
    runId: string | null,
    data: AnyEventRequest,
    params?: CreateEventParams
  ): Promise<EventResult> {
    const resolveData: EventsResolveData = params?.resolveData ?? 'all';
    const entityRD = entityResolveData(resolveData);
    if (data.eventType === 'run_created') {
      return createRunEvent(runId, data, resolveData);
    }
    if (!runId) {
      throw new WorkflowWorldError('runId is required for non-run_created events', { status: 400 });
    }
    if (
      (data.eventType.startsWith('step_') ||
        data.eventType.startsWith('hook_') ||
        data.eventType.startsWith('wait_')) &&
      !data.correlationId
    ) {
      throw new WorkflowWorldError(`${data.eventType} requires a correlationId`, { status: 400 });
    }

    const now = new Date();
    const specVersion = data.specVersion ?? SPEC_VERSION_CURRENT;
    let currentRun = await getRunById(runId);

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
        currentRun = await getRunById(runId);
      }
    }

    if (!currentRun) throw new WorkflowRunNotFoundError(runId);
    if (requiresNewerWorld(currentRun.specVersion)) {
      throw new RunNotSupportedError(currentRun.specVersion as number, SPEC_VERSION_CURRENT);
    }
    if (isLegacySpecVersion(currentRun.specVersion)) {
      return handleLegacyEvent(runId, data, resolveData);
    }
    if ((currentRun.specVersion ?? 0) < SPEC_VERSION_SUPPORTS_SLOT_IDENTITY) {
      // Written before positional event IDs: its log cannot be extended.
      if (data.eventType === 'run_cancelled') {
        return handleLegacyEvent(runId, data, resolveData);
      }
      throw new EntityConflictError(
        `Run "${runId}" predates positional event IDs; finish or cancel it on the World version that created it`
      );
    }

    const runIsTerminal = isTerminalWorkflowRunStatus(currentRun.status);
    const lazyStepStart =
      data.eventType === 'step_started' && isChildEntityCreationEvent(data);

    const body: Omit<EventDocument, 'runId' | 'eventId'> = {
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
        const event = await appendEvent(runId, body);
        return finish(event, { run: filterRun(currentRun, entityRD) });
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

    const stepNotUpdated = async (stepId: string): Promise<never> => {
      const existing = await getStepById(runId, stepId);
      if (!existing) {
        throw new WorkflowWorldError(`Step "${stepId}" not found`, { status: 404 });
      }
      if (isTerminalStepStatus(existing.status)) {
        throw new EntityConflictError(`Cannot modify step in terminal state "${existing.status}"`);
      }
      if (existing.retryAfter && existing.retryAfter.getTime() > Date.now()) {
        throw new TooEarlyError(
          `Cannot start step "${stepId}": retryAfter timestamp has not been reached yet`,
          { retryAfter: Math.ceil((existing.retryAfter.getTime() - Date.now()) / 1000) }
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
        const { value: run, events } = await commitWith(runId, async (session) => {
          const updated = await runsCollection.findOneAndUpdate(
            { runId, status: 'pending' },
            [{ $set: { status: 'running', startedAt: { $ifNull: ['$startedAt', now] }, updatedAt: now } }],
            { returnDocument: 'after', session }
          );
          return {
            value: updated ? (cleanMongoDoc(updated) as WorkflowRun) : null,
            events: updated ? [{ ...body, eventData: undefined }] : [],
          };
        });
        if (!run) {
          const latest = (await getRunById(runId))!;
          if (isTerminalWorkflowRunStatus(latest.status)) {
            throw new RunExpiredError(
              `Workflow run "${runId}" is already in terminal state "${latest.status}"`,
              runId,
              latest.status
            );
          }
          return { run: filterRun(latest, entityRD) } as EventResult;
        }
        return finish(events[0], { run: filterRun(run, entityRD) });
      }

      case 'run_completed':
      case 'run_failed':
      case 'run_cancelled': {
        const changes: Record<string, unknown> = { completedAt: now, updatedAt: now };
        if (data.eventType === 'run_completed') {
          Object.assign(changes, { status: 'completed', output: data.eventData.output });
        } else if (data.eventType === 'run_failed') {
          Object.assign(changes, {
            status: 'failed',
            error: data.eventData.error,
            errorCode: data.eventData.errorCode,
          });
        } else {
          changes.status = 'cancelled';
        }
        const { value: run, events } = await commitWith(runId, async (session) => {
          const updated = await runsCollection.findOneAndUpdate(
            { runId, status: { $nin: TERMINAL_RUN } },
            { $set: stripUndefined(changes) },
            { returnDocument: 'after', session }
          );
          if (updated) {
            // A run that ended releases its hook tokens and its waits.
            await hooksCollection.deleteMany({ runId }, { session });
            await waitsCollection.deleteMany({ runId }, { session });
          }
          return {
            value: updated ? (cleanMongoDoc(updated) as WorkflowRun) : null,
            events: updated ? [body] : [],
          };
        });
        if (!run) {
          const latest = (await getRunById(runId))!;
          if (data.eventType === 'run_cancelled' && latest.status === 'cancelled') {
            return createEvent(runId, data, params);
          }
          throw new EntityConflictError(
            `Cannot transition run from terminal state "${latest.status}"`
          );
        }
        return finish(events[0], { run: filterRun(run, entityRD) });
      }

      case 'attr_set': {
        const { changes, allowReservedAttributes } = data.eventData;
        if (data.correlationId && data.eventData.writer.type === 'workflow') {
          const duplicate = await eventsCollection.findOne({
            runId,
            correlationId: data.correlationId,
            eventType: 'attr_set',
          });
          if (duplicate) {
            throw new EntityConflictError(
              `attr_set for correlationId "${data.correlationId}" already exists in run "${runId}"`
            );
          }
        }
        for (let attempt = 0; attempt < ATTR_SET_MAX_ATTEMPTS; attempt++) {
          // Compare-and-set on a version counter, so two writers cannot both
          // apply their changes to the same starting set.
          const version = await runsCollection.findOne(
            { runId },
            { projection: { attributesVersion: 1, attributes: 1, status: 1 } }
          );
          if (!version) throw new WorkflowRunNotFoundError(runId);
          if (isTerminalWorkflowRunStatus(version.status)) {
            throw new EntityConflictError(
              `Cannot set attributes on run in terminal state "${version.status}"`
            );
          }
          const existing = (version.attributes as Record<string, string> | undefined) ?? {};
          validateAttributeChanges(changes, {
            existingKeys: Object.keys(existing),
            allowReservedAttributes: allowReservedAttributes === true,
          });
          const attributes = applyAttributeChanges(existing, changes);
          if (Object.keys(attributes).length > ATTRIBUTE_MAX_PER_RUN) {
            throw new AttributeValidationError(
              `Run attribute count would exceed limit ${ATTRIBUTE_MAX_PER_RUN}`
            );
          }
          const { value: run, events } = await commitWith(runId, async (session) => {
            const updated = await runsCollection.findOneAndUpdate(
              {
                runId,
                status: { $nin: TERMINAL_RUN },
                attributesVersion:
                  version.attributesVersion === undefined
                    ? { $exists: false }
                    : version.attributesVersion,
              },
              { $set: { attributes, updatedAt: now }, $inc: { attributesVersion: 1 } },
              { returnDocument: 'after', session }
            );
            return {
              value: updated ? (cleanMongoDoc(updated) as WorkflowRun) : null,
              events: updated ? [body] : [],
            };
          });
          if (run) return finish(events[0], { run: filterRun(run, entityRD) });
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
        try {
          const { events } = await commitWith(runId, async (session) => {
            await stepsCollection.insertOne(stripUndefined(step) as StepDocument, { session });
            return { value: undefined, events: [body] };
          });
          return finish(events[0], { step: filterStep(step, entityRD) });
        } catch (error) {
          if (isMongoDuplicateKeyError(error)) {
            throw new EntityConflictError(`Step "${stepId}" already exists`);
          }
          throw error;
        }
      }

      case 'step_started': {
        const stepId = data.correlationId;
        const existing = await getStepById(runId, stepId);
        if (lazyStepStart && existing) {
          throw new EntityConflictError(`Step "${stepId}" already created`);
        }
        if (!lazyStepStart && !existing) {
          throw new WorkflowWorldError(`Step "${stepId}" not found`, { status: 404 });
        }
        if (existing) {
          if (isTerminalStepStatus(existing.status)) {
            throw new EntityConflictError(`Cannot modify step in terminal state "${existing.status}"`);
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

        if (lazyStepStart) {
          // Lazy start: the step insert is the ownership claim. Only the
          // caller whose insert lands runs the step body.
          const step: Step = {
            runId,
            stepId,
            stepName: String(startEventData.stepName),
            status: 'running',
            input: lazyInput,
            attempt: 1,
            startedAt: now,
            createdAt: now,
            updatedAt: now,
            specVersion,
          };
          try {
            const { events } = await commitWith(runId, async (session) => {
              await stepsCollection.insertOne(stripUndefined(step) as StepDocument, { session });
              return {
                value: undefined,
                events: [
                  {
                    ...body,
                    eventType: 'step_created',
                    eventData: { stepName: startEventData.stepName, input: lazyInput },
                  },
                  startedBody,
                ],
              };
            });
            return finish(events[1], { step: filterStep(step, entityRD), stepCreated: true });
          } catch (error) {
            if (isMongoDuplicateKeyError(error)) {
              throw new EntityConflictError(`Step "${stepId}" already created`);
            }
            throw error;
          }
        }

        const { value: step, events } = await commitWith(runId, async (session) => {
          const updated = await stepsCollection.findOneAndUpdate(
            {
              runId,
              stepId,
              status: { $nin: TERMINAL_STEP },
              $or: [{ retryAfter: { $exists: false } }, { retryAfter: { $lte: now } }],
            },
            [
              {
                $set: {
                  status: 'running',
                  attempt: { $add: [{ $ifNull: ['$attempt', 0] }, 1] },
                  startedAt: { $ifNull: ['$startedAt', now] },
                  updatedAt: now,
                },
              },
              { $unset: 'retryAfter' },
            ],
            { returnDocument: 'after', session }
          );
          return {
            value: updated ? (cleanMongoDoc(updated) as Step) : null,
            events: updated ? [startedBody] : [],
          };
        });
        if (!step) return stepNotUpdated(stepId);
        return finish(events[0], { step: filterStep(step, entityRD) });
      }

      case 'step_completed':
      case 'step_failed':
      case 'step_retrying': {
        const stepId = data.correlationId;
        const set: Record<string, unknown> = { updatedAt: now };
        const unset: Record<string, ''> = {};
        const filter: Document = { runId, stepId, status: { $nin: TERMINAL_STEP } };
        if (data.eventType === 'step_completed') {
          Object.assign(set, { status: 'completed', output: data.eventData.result, completedAt: now });
        } else if (data.eventType === 'step_failed') {
          Object.assign(set, { status: 'failed', error: data.eventData.error, completedAt: now });
        } else {
          Object.assign(set, { status: 'pending', error: data.eventData.error });
          if (data.eventData.retryAfter) set.retryAfter = data.eventData.retryAfter;
          else unset.retryAfter = '';
          // A step in flight may still record its outcome on an ended run,
          // but a retry schedules more work, which an ended run never runs.
          if (runIsTerminal) filter.status = 'running';
        }
        const { value: step, events } = await commitWith(runId, async (session) => {
          const updated = await stepsCollection.findOneAndUpdate(
            filter,
            {
              $set: stripUndefined(set),
              ...(Object.keys(unset).length > 0 ? { $unset: unset } : {}),
            },
            { returnDocument: 'after', session }
          );
          return {
            value: updated ? (cleanMongoDoc(updated) as Step) : null,
            events: updated ? [body] : [],
          };
        });
        if (!step) {
          if (data.eventType === 'step_retrying' && runIsTerminal) {
            const latest = await getStepById(runId, stepId);
            if (latest && !isTerminalStepStatus(latest.status)) {
              throw new RunExpiredError(
                `Cannot modify non-running step on run in terminal state "${currentRun.status}"`,
                runId,
                currentRun.status as 'completed' | 'failed' | 'cancelled'
              );
            }
          }
          return stepNotUpdated(stepId);
        }
        return finish(events[0], { step: filterStep(step, entityRD) });
      }

      // =======================================================================
      // Hooks
      // =======================================================================
      case 'hook_created': {
        const hookId = data.correlationId;
        const { token } = data.eventData;
        const conflict = async (owner: Hook | null) => {
          if (owner && owner.hookId === hookId && owner.runId === runId) {
            throw new EntityConflictError(`Hook "${hookId}" already created`);
          }
          const event = await appendEvent(runId, {
            ...body,
            eventType: 'hook_conflict',
            eventData: { token, conflictingRunId: owner?.runId },
          });
          return finish(event);
        };
        const owner = await hooksCollection.findOne({ token });
        if (owner) return conflict(cleanMongoDoc(owner) as Hook);
        const hook: Hook = {
          runId,
          hookId,
          token,
          metadata: data.eventData.metadata,
          ownerId: 'mongodb-owner',
          projectId: 'mongodb-project',
          environment: 'development',
          createdAt: now,
          specVersion,
          isWebhook: data.eventData.isWebhook,
          isSystem: data.eventData.isSystem,
        };
        try {
          const { events } = await commitWith(runId, async (session) => {
            await hooksCollection.insertOne(stripUndefined(hook) as HookDocument, { session });
            return { value: undefined, events: [body] };
          });
          return finish(events[0], { hook: filterHook(hook, entityRD) });
        } catch (error) {
          if (!isMongoDuplicateKeyError(error)) throw error;
          const raced = await hooksCollection.findOne({ token });
          return conflict(raced ? (cleanMongoDoc(raced) as Hook) : null);
        }
      }

      case 'hook_received': {
        const hook = await hooksCollection.findOne({ hookId: data.correlationId, runId });
        if (!hook) throw new HookNotFoundError(data.correlationId);
        const { events } = await commitWith(runId, async (session) => {
          // Re-checked in the commit, so a delivery inside a transaction cannot
          // land after the disposal it races.
          if (session) {
            const stillThere = await hooksCollection.findOne(
              { hookId: data.correlationId, runId },
              { session }
            );
            if (!stillThere) throw new HookNotFoundError(data.correlationId);
          }
          return { value: undefined, events: [body] };
        });
        return finish(events[0]);
      }

      case 'hook_disposed': {
        const { value: removed, events } = await commitWith(runId, async (session) => {
          const deleted = await hooksCollection.findOneAndDelete(
            { hookId: data.correlationId, runId },
            { session }
          );
          return { value: deleted, events: deleted ? [body] : [] };
        });
        if (!removed) throw new HookNotFoundError(data.correlationId);
        return finish(events[0]);
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
        try {
          const { events } = await commitWith(runId, async (session) => {
            await waitsCollection.insertOne(stripUndefined(wait) as WaitDocument, { session });
            return { value: undefined, events: [body] };
          });
          return finish(events[0], { wait });
        } catch (error) {
          if (isMongoDuplicateKeyError(error)) {
            throw new EntityConflictError(`Wait "${waitId}" already exists`);
          }
          throw error;
        }
      }

      case 'wait_completed': {
        const waitId = data.correlationId;
        const { value: wait, events } = await commitWith(runId, async (session) => {
          const updated = await waitsCollection.findOneAndUpdate(
            { runId, waitId, status: 'waiting' },
            { $set: { status: 'completed', completedAt: now, updatedAt: now } },
            { returnDocument: 'after', session }
          );
          return {
            value: updated ? (cleanMongoDoc(updated) as Wait) : null,
            events: updated ? [body] : [],
          };
        });
        if (!wait) {
          const existing = await waitsCollection.findOne({ runId, waitId });
          if (!existing) {
            throw new WorkflowWorldError(`Wait "${waitId}" not found`, { status: 404 });
          }
          throw new EntityConflictError(`Wait "${waitId}" already completed`);
        }
        return finish(events[0], { wait });
      }

      default:
        throw new WorkflowWorldError(
          `Unsupported event type: ${(data as { eventType: string }).eventType}`,
          { status: 400 }
        );
    }
  }

  async function listEventPage(
    filter: Document,
    params: ListEventsParams | ListEventsByCorrelationIdParams,
    defaultLimit: number
  ): Promise<PaginatedResponse<Event>> {
    const sortOrder = params.pagination?.sortOrder ?? 'asc';
    const limit = params.pagination?.limit ?? defaultLimit;
    const cursor = params.pagination?.cursor;
    const query: Document = { ...filter };
    if (cursor) {
      query.eventId = sortOrder === 'asc' ? { $gt: cursor } : { $lt: cursor };
    }
    const docs = await eventsCollection
      .find(query)
      .sort({ eventId: sortOrder === 'asc' ? 1 : -1 })
      .limit(limit + 1)
      .toArray();
    const hasMore = docs.length > limit;
    const data = docs.slice(0, limit).map((doc) => filterEvent(toEvent(doc), params.resolveData));
    return {
      data,
      cursor: hasMore ? (data[data.length - 1]?.eventId ?? null) : null,
      hasMore,
    };
  }

  const storage: Storage = {
    runs: {
      async get(id: string, params?: GetWorkflowRunParams) {
        const run = await getRunById(id);
        if (!run) throw new WorkflowRunNotFoundError(id);
        return filterRun(run, params?.resolveData) as any;
      },

      async list(params?: ListWorkflowRunsParams) {
        const filter: Document = {};
        if (params?.workflowName) filter.workflowName = params.workflowName;
        if (params?.status !== undefined) {
          filter.status = Array.isArray(params.status) ? { $in: params.status } : params.status;
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
        const data = results
          .slice(0, limit)
          .map((row) => filterRun(cleanMongoDoc(row) as WorkflowRun, params?.resolveData));
        return {
          data,
          cursor: hasMore && data.length > 0 ? data[data.length - 1].runId : null,
          hasMore,
        } as any;
      },
    } as Storage['runs'],

    steps: {
      async get(runId: string, stepId: string, params?: GetStepParams) {
        const step = await getStepById(runId, stepId);
        if (!step) throw new WorkflowWorldError(`Step "${stepId}" not found`, { status: 404 });
        return filterStep(step, params?.resolveData) as any;
      },

      async list(params: ListWorkflowRunStepsParams) {
        const sortOrder = params.pagination?.sortOrder ?? 'desc';
        const limit = params.pagination?.limit ?? 100;
        const cursor = params.pagination?.cursor;
        const filter: Document = { runId: params.runId };
        if (cursor) {
          filter.stepId = sortOrder === 'desc' ? { $lt: cursor } : { $gt: cursor };
        }
        const results = await stepsCollection
          .find(filter)
          .sort({ stepId: sortOrder === 'desc' ? -1 : 1 })
          .limit(limit + 1)
          .toArray();
        const hasMore = results.length > limit;
        const data = results
          .slice(0, limit)
          .map((row) => filterStep(cleanMongoDoc(row) as Step, params.resolveData));
        return {
          data,
          cursor: hasMore && data.length > 0 ? data[data.length - 1].stepId : null,
          hasMore,
        } as any;
      },
    } as Storage['steps'],

    events: {
      create: createEvent as Storage['events']['create'],

      async get(runId, eventId, params) {
        const doc = await eventsCollection.findOne({ runId, eventId });
        if (!doc) {
          throw new WorkflowWorldError(`Event "${eventId}" not found in run "${runId}"`, {
            status: 404,
          });
        }
        return filterEvent(toEvent(doc), params?.resolveData);
      },

      async list(params: ListEventsParams) {
        return listEventPage({ runId: params.runId }, params, 10000);
      },

      async listByCorrelationId(params: ListEventsByCorrelationIdParams) {
        return listEventPage(
          { runId: params.runId, correlationId: params.correlationId },
          params,
          100
        );
      },
    },

    hooks: {
      async get(hookId: string, params?: GetHookParams) {
        const hook = await hooksCollection.findOne({ hookId });
        if (!hook) throw new HookNotFoundError(hookId);
        return filterHook(cleanMongoDoc(hook) as Hook, params?.resolveData);
      },

      async getByToken(token: string, params?: GetHookParams) {
        const hook = await hooksCollection.findOne({ token });
        if (!hook) throw new HookNotFoundError(token);
        return filterHook(cleanMongoDoc(hook) as Hook, params?.resolveData);
      },

      async list(params: ListHooksParams) {
        const filter: Document = {};
        if (params.runId) filter.runId = params.runId;
        const sortOrder = params.pagination?.sortOrder ?? 'asc';
        const cursor = params.pagination?.cursor;
        if (cursor) {
          filter.hookId = sortOrder === 'asc' ? { $gt: cursor } : { $lt: cursor };
        }
        const limit = params.pagination?.limit ?? 100;
        const results = await hooksCollection
          .find(filter)
          .sort({ hookId: sortOrder === 'asc' ? 1 : -1 })
          .limit(limit + 1)
          .toArray();
        const hasMore = results.length > limit;
        const data = results
          .slice(0, limit)
          .map((row) => filterHook(cleanMongoDoc(row) as Hook, params.resolveData));
        return {
          data,
          cursor: hasMore && data.length > 0 ? data[data.length - 1].hookId : null,
          hasMore,
        };
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
