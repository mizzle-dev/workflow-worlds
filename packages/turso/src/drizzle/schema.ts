/**
 * Drizzle Schema Definitions for Turso World
 *
 * Defines all database tables using Drizzle ORM with CBOR columns
 * for type-preserving data storage.
 */

import {
  sqliteTable,
  text,
  integer,
  blob,
  index,
  uniqueIndex,
  customType,
  primaryKey,
} from 'drizzle-orm/sqlite-core';
import { encode, decode } from 'cbor-x';
import { sql } from 'drizzle-orm';

/**
 * Custom CBOR column type for Drizzle.
 * Stores data as BLOB with automatic CBOR encoding/decoding.
 * CBOR preserves Date, undefined, Map, Set, BigInt, and null types automatically.
 */
function Cbor<T>() {
  return customType<{ data: T; driverData: Buffer }>({
    dataType: () => 'blob',
    fromDriver: (value): T => {
      // No data from database
      if (value === null || value === undefined) {
        return undefined as unknown as T;
      }
      // Empty buffer means undefined was stored
      const buf = value as Buffer;
      if (buf.length === 0) {
        return undefined as unknown as T;
      }
      // Decode CBOR - this preserves null, Date, etc.
      return decode(buf) as T;
    },
    toDriver: (value): Buffer => {
      // Only treat undefined as "no value" - null should be encoded
      if (value === undefined) {
        return Buffer.alloc(0);
      }
      // CBOR encodes null as a proper value (0xf6)
      return Buffer.from(encode(value));
    },
  });
}

// =============================================================================
// Workflow Runs
// =============================================================================

export const runs = sqliteTable(
  'workflow_runs',
  {
    runId: text('run_id').primaryKey(),
    deploymentId: text('deployment_id').notNull(),
    workflowName: text('workflow_name').notNull(),
    status: text('status').notNull().default('pending'),

    // CBOR columns for type-preserving storage
    input: Cbor<unknown[]>()('input'),
    output: Cbor<unknown>()('output'),
    error: Cbor<unknown>()('error'),
    errorCode: text('error_code'),
    executionContext: Cbor<Record<string, unknown>>()('execution_context'),
    attributes: Cbor<Record<string, string>>()('attributes'),
    specVersion: integer('spec_version'),

    // Timestamps as TEXT (ISO strings) - SQLite doesn't have native timestamp
    startedAt: text('started_at'),
    completedAt: text('completed_at'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    index('idx_runs_status').on(table.status, table.runId),
    index('idx_runs_workflow').on(table.workflowName, table.runId),
    index('idx_runs_deployment').on(table.deploymentId, table.runId),
  ]
);

// =============================================================================
// Workflow Steps
// =============================================================================

export const steps = sqliteTable(
  'workflow_steps',
  {
    id: text('id').primaryKey(), // runId-stepId composite
    runId: text('run_id').notNull(),
    stepId: text('step_id').notNull(),
    stepName: text('step_name'),
    status: text('status').notNull().default('pending'),

    input: Cbor<unknown[]>()('input'),
    output: Cbor<unknown>()('output'),
    error: Cbor<unknown>()('error'),

    attempt: integer('attempt').default(0),
    retryAfter: text('retry_after'),
    specVersion: integer('spec_version'),
    startedAt: text('started_at'),
    completedAt: text('completed_at'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    index('idx_steps_run').on(table.runId, table.id),
    index('idx_steps_step_id').on(table.stepId),
  ]
);

// =============================================================================
// Workflow Events
// =============================================================================

// Event IDs are positions in their run's log (`evnt_` + a zero-padded slot),
// so they are only unique within a run: the primary key is (run_id, event_id).
// The partial unique index makes a second creation of the same step, hook or
// wait fail at the insert, whichever path the creation took. It only covers
// rows written since `spec_version` was recorded per event, because logs
// written before then were never deduplicated.
export const events = sqliteTable(
  'workflow_events',
  {
    runId: text('run_id').notNull(),
    eventId: text('event_id').notNull(),
    stepId: text('step_id'),
    eventType: text('type').notNull(),
    correlationId: text('correlation_id'),

    // Full event payload as CBOR (preserves Date in eventData.resumeAt)
    payload: Cbor<Record<string, unknown>>()('payload'),
    specVersion: integer('spec_version'),

    createdAt: text('created_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.runId, table.eventId] }),
    index('idx_events_correlation').on(
      table.runId,
      table.correlationId,
      table.eventId
    ),
    uniqueIndex('idx_events_entity_creation')
      .on(table.runId, table.correlationId, table.eventType)
      .where(
        sql`${table.eventType} IN ('step_created', 'hook_created', 'wait_created', 'wait_completed') AND ${table.specVersion} IS NOT NULL`
      ),
  ]
);

// =============================================================================
// Workflow Hooks
// =============================================================================

export const hooks = sqliteTable(
  'workflow_hooks',
  {
    hookId: text('hook_id').primaryKey(),
    runId: text('run_id').notNull(),
    token: text('token').notNull(),
    displayName: text('display_name'),
    metadata: Cbor<unknown>()('metadata'),
    specVersion: integer('spec_version'),
    isWebhook: integer('is_webhook', { mode: 'boolean' }),
    isSystem: integer('is_system', { mode: 'boolean' }),
    ownerId: text('owner_id').notNull(),
    projectId: text('project_id').notNull(),
    environment: text('environment').notNull(),
    receivedAt: text('received_at'),
    disposedAt: text('disposed_at'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    index('idx_hooks_run').on(table.runId),
    uniqueIndex('idx_hooks_token').on(table.token),
  ]
);

// =============================================================================
// Workflow Waits
// =============================================================================

export const waits = sqliteTable(
  'workflow_waits',
  {
    runId: text('run_id').notNull(),
    waitId: text('wait_id').notNull(),
    status: text('status').notNull().default('waiting'),
    resumeAt: text('resume_at'),
    completedAt: text('completed_at'),
    specVersion: integer('spec_version'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [primaryKey({ columns: [table.runId, table.waitId] })]
);

// =============================================================================
// Queue Messages
// =============================================================================

// Note: Queue payload is stored as TEXT (JSON string) since it's used directly
// in HTTP body transmission. This avoids double-serialization overhead.
export const queueMessages = sqliteTable(
  'queue_messages',
  {
    messageId: text('message_id').primaryKey(),
    queueName: text('queue_name').notNull(),
    payload: text('payload').notNull(),
    idempotencyKey: text('idempotency_key'),
    status: text('status').default('pending'),
    lockToken: text('lock_token'),
    attempt: integer('attempt').default(0),
    maxAttempts: integer('max_attempts').default(3),
    notBefore: text('not_before'),
    createdAt: text('created_at').notNull(),
    processedAt: text('processed_at'),
  },
  (table) => [
    index('idx_queue_pending').on(table.queueName, table.status, table.notBefore),
    // Unique idempotency key for pending messages only
    // Note: SQLite doesn't support partial unique indexes via Drizzle,
    // we'll handle idempotency in application code
  ]
);

// =============================================================================
// Stream Chunks
// =============================================================================

export const streamChunks = sqliteTable(
  'stream_chunks',
  {
    chunkId: text('chunk_id').primaryKey(),
    streamName: text('stream_name').notNull(),
    data: blob('data'),
    isEof: integer('is_eof').default(0),
    createdAt: text('created_at').notNull(),
  },
  (table) => [index('idx_chunks_stream').on(table.streamName, table.chunkId)]
);

// =============================================================================
// Run Spec Versions
// =============================================================================

// Legacy: spec versions now live on `workflow_runs.spec_version`. Kept so
// existing databases migrate; nothing reads or writes it.
export const runSpecVersions = sqliteTable('workflow_run_versions', {
  runId: text('run_id').primaryKey(),
  specVersion: integer('spec_version').notNull(),
});

// =============================================================================
// Stream to Run Mapping
// =============================================================================

export const streamRuns = sqliteTable(
  'stream_runs',
  {
    runId: text('run_id').notNull(),
    streamName: text('stream_name').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.runId, table.streamName] }),
    index('idx_stream_runs_run').on(table.runId),
  ]
);
