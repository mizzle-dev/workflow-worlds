/**
 * Database Schema for Turso World
 *
 * Defines SQL tables for workflow runs, steps, events, hooks, queue messages, and stream chunks.
 * Uses CBOR-encoded columns for type-preserving data storage (Date, undefined, etc.)
 * and indexed columns for efficient querying.
 */

import type { Client } from '@libsql/client';
import { encode as cborEncode, decode as cborDecode } from 'cbor-x';

/**
 * SQL schema for all tables.
 * Each table is created with appropriate indexes for efficient querying.
 */
export const SCHEMA_SQL = `
-- Workflow runs (main state machine)
CREATE TABLE IF NOT EXISTS workflow_runs (
  run_id TEXT PRIMARY KEY,
  deployment_id TEXT NOT NULL,
  workflow_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  input TEXT,
  output TEXT,
  error TEXT,
  execution_context TEXT,
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_runs_status ON workflow_runs(status, run_id DESC);
CREATE INDEX IF NOT EXISTS idx_runs_workflow ON workflow_runs(workflow_name, run_id DESC);
CREATE INDEX IF NOT EXISTS idx_runs_deployment ON workflow_runs(deployment_id, run_id DESC);

-- Step invocations
CREATE TABLE IF NOT EXISTS workflow_steps (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  step_id TEXT NOT NULL,
  step_name TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  input TEXT,
  output TEXT,
  error TEXT,
  attempt INTEGER DEFAULT 0,
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_steps_run ON workflow_steps(run_id, id ASC);
CREATE INDEX IF NOT EXISTS idx_steps_step_id ON workflow_steps(step_id);

-- Event log (deterministic replay)
CREATE TABLE IF NOT EXISTS workflow_events (
  event_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  step_id TEXT,
  type TEXT NOT NULL,
  correlation_id TEXT,
  payload TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_run ON workflow_events(run_id, event_id ASC);
CREATE INDEX IF NOT EXISTS idx_events_correlation ON workflow_events(correlation_id, event_id ASC);

-- Hooks for async callbacks
CREATE TABLE IF NOT EXISTS workflow_hooks (
  hook_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  display_name TEXT,
  metadata TEXT,
  owner_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  environment TEXT NOT NULL,
  received_at TEXT,
  disposed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_hooks_run ON workflow_hooks(run_id);
CREATE INDEX IF NOT EXISTS idx_hooks_token ON workflow_hooks(token);

-- Queue messages (polling-based)
CREATE TABLE IF NOT EXISTS queue_messages (
  message_id TEXT PRIMARY KEY,
  queue_name TEXT NOT NULL,
  payload TEXT NOT NULL,
  idempotency_key TEXT,
  status TEXT DEFAULT 'pending',
  lock_token TEXT,
  attempt INTEGER DEFAULT 0,
  max_attempts INTEGER DEFAULT 3,
  not_before TEXT,
  created_at TEXT NOT NULL,
  processed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_queue_pending ON queue_messages(queue_name, status, not_before);
CREATE UNIQUE INDEX IF NOT EXISTS idx_queue_idempotency ON queue_messages(idempotency_key)
  WHERE idempotency_key IS NOT NULL AND status = 'pending';

-- Stream chunks
CREATE TABLE IF NOT EXISTS stream_chunks (
  chunk_id TEXT PRIMARY KEY,
  stream_name TEXT NOT NULL,
  data BLOB,
  is_eof INTEGER DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chunks_stream ON stream_chunks(stream_name, chunk_id ASC);
`;

/**
 * Initializes the database schema.
 * Creates all required tables and indexes.
 */
export async function initializeSchema(client: Client): Promise<void> {
  // Enable WAL mode for better concurrent access (reduces SQLITE_BUSY errors)
  // WAL allows concurrent reads while writing
  await client.execute('PRAGMA journal_mode = WAL');

  // Set busy timeout to wait for locks instead of failing immediately
  // 5000ms should be enough for most operations
  await client.execute('PRAGMA busy_timeout = 5000');

  // Split by semicolons and execute each statement
  const statements = SCHEMA_SQL
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  for (const sql of statements) {
    await client.execute(sql);
  }
}

// CBOR prefix to distinguish from legacy JSON data
const CBOR_PREFIX = 'cbor:';

/**
 * Helper to serialize values using CBOR for storage.
 * CBOR preserves Date, undefined, Map, Set, BigInt types automatically.
 * Uses base64 encoding with 'cbor:' prefix for TEXT column storage.
 */
export function toJson(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  const buffer = cborEncode(value);
  return CBOR_PREFIX + Buffer.from(buffer).toString('base64');
}

/**
 * Helper to deserialize CBOR/JSON from storage.
 * Supports both CBOR (new) and JSON (legacy) formats.
 * Returns undefined for null values.
 */
export function fromJson<T>(value: string | null): T | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  // CBOR-encoded data (new format)
  if (value.startsWith(CBOR_PREFIX)) {
    const base64 = value.slice(CBOR_PREFIX.length);
    const buffer = Buffer.from(base64, 'base64');
    return cborDecode(buffer) as T;
  }
  // Legacy JSON data - parse with JSON
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
}

/**
 * Converts a Date to ISO string for storage.
 */
export function toIsoString(date: Date | undefined): string | null {
  if (!date) {
    return null;
  }
  return date.toISOString();
}

/**
 * Converts an ISO string from storage to a Date.
 */
export function fromIsoString(value: string | null): Date | undefined {
  if (!value) {
    return undefined;
  }
  return new Date(value);
}
