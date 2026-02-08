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
    error: Cbor<{ message: string; stack?: string; code?: string }>()('error'),
    executionContext: Cbor<Record<string, unknown>>()('execution_context'),

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

export const events = sqliteTable(
  'workflow_events',
  {
    eventId: text('event_id').primaryKey(),
    runId: text('run_id').notNull(),
    stepId: text('step_id'),
    eventType: text('type').notNull(),
    correlationId: text('correlation_id'),

    // Full event payload as CBOR (preserves Date in eventData.resumeAt)
    payload: Cbor<Record<string, unknown>>()('payload'),

    createdAt: text('created_at').notNull(),
  },
  (table) => [
    index('idx_events_run').on(table.runId, table.eventId),
    index('idx_events_correlation').on(table.correlationId, table.eventId),
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
