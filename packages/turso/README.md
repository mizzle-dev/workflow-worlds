# Turso World

[![npm version](https://img.shields.io/npm/v/@workflow-worlds/turso.svg)](https://www.npmjs.com/package/@workflow-worlds/turso)
[![license](https://img.shields.io/npm/l/@workflow-worlds/turso.svg)](https://github.com/mizzle-dev/workflow-worlds/blob/main/LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue.svg)](https://www.typescriptlang.org/)

A complete Turso/libSQL-backed World implementation for the Workflow DevKit.

## Features

- **Storage**: Uses SQL tables for runs, steps, events, and hooks
- **Queue**: Polling-based with persistent messages, exponential backoff, graceful shutdown
- **Streaming**: Real-time output via EventEmitter (single-process)
- **Embedded or Remote**: Supports local SQLite files or remote Turso databases

## Installation

```bash
npm install @workflow-worlds/turso @libsql/client
# or
pnpm add @workflow-worlds/turso @libsql/client
```

## Setup

Before using the Turso World, you must run the database setup command to create the schema:

```bash
# Set environment variables (or use .env file)
export WORKFLOW_TURSO_DATABASE_URL=libsql://your-database.turso.io
export WORKFLOW_TURSO_AUTH_TOKEN=your-auth-token

# Run setup
pnpm exec workflow-turso-setup
```

For local development with a file-based database:

```bash
# Uses file:workflow.db by default
pnpm exec workflow-turso-setup
```

The setup command uses Drizzle migrations and is safe to run multiple times - it only applies pending migrations.

## Usage

```typescript
import { createWorld } from '@workflow-worlds/turso';

// Local embedded database
const world = createWorld({
  databaseUrl: 'file:workflow.db',
});

// Remote Turso database
const world = createWorld({
  databaseUrl: 'libsql://your-database.turso.io',
  authToken: 'your-auth-token',
});

// Use with the Workflow runtime
export default world;
```

## Configuration

All configuration options can be set via code or environment variables. Environment variables follow the `WORKFLOW_` prefix convention.

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `WORKFLOW_TURSO_DATABASE_URL` | Database URL (`file:...` or `libsql://...`) | `file:workflow.db` |
| `WORKFLOW_TURSO_AUTH_TOKEN` | Auth token for remote Turso databases | - |
| `WORKFLOW_SERVICE_URL` | Base URL for HTTP callbacks | `http://localhost:{PORT}` |
| `WORKFLOW_CONCURRENCY` | Max concurrent message processing | `20` |

### Programmatic Configuration

```typescript
interface TursoWorldConfig {
  // Database URL (libsql://... for remote, file:... for local)
  // Env: WORKFLOW_TURSO_DATABASE_URL
  databaseUrl?: string;

  // Auth token for remote Turso databases
  // Env: WORKFLOW_TURSO_AUTH_TOKEN
  authToken?: string;

  // Base URL for HTTP callbacks (queue)
  // Env: WORKFLOW_SERVICE_URL
  baseUrl?: string;

  // Maximum concurrent message processing
  // Env: WORKFLOW_CONCURRENCY
  concurrency?: number;

  // Idempotency TTL in milliseconds
  // Default: 5000 (5 seconds)
  idempotencyTtlMs?: number;

  // Maximum retry attempts for queue messages
  // Default: 3
  maxRetries?: number;

  // Polling interval in milliseconds
  // Default: 100
  pollIntervalMs?: number;
}
```

### Configuration Priority

All options follow the same priority order:

1. **Programmatic config** - passed to `createWorld()`
2. **Environment variable** - `WORKFLOW_*` prefixed
3. **Default value**

```typescript
// Example: config takes priority over env var
const world = createWorld({
  databaseUrl: 'file:my-app.db', // This wins over WORKFLOW_TURSO_DATABASE_URL
});
```

## Database Schema

The Turso World creates the following tables:

### workflow_runs
Stores workflow run records with status, input/output, and timestamps.

### workflow_steps
Stores step execution records linked to runs.

### workflow_events
Event log for workflow replay, ordered by event ID.

### workflow_hooks
Hook registrations for pausing and resuming workflows.

### queue_messages
Persistent message queue with status tracking, retry counts, and scheduling.

### stream_chunks
Stream output chunks stored as binary blobs.

## Development

### Prerequisites

- Node.js 22+
- pnpm

### Building

```bash
pnpm install
pnpm build
```

### Running Tests

```bash
pnpm test
```

The tests use a local file-based SQLite database with automatic migration setup.

## Key Patterns

### Polling-Based Queue

The queue uses database polling for message processing:

```typescript
// Messages stored immediately
await world.queue(queueName, message);

// Processing starts only when start() is called
await world.start();

// Without start(), messages are stored but not processed
```

**Key features:**
- **Persistent Storage**: Messages survive restarts
- **TTL-Based Idempotency**: 5-second window to catch network retries
- **Exponential Backoff**: Failures retry with increasing delays (1s -> 60s max)
- **Graceful Shutdown**: Waits for in-flight messages before stopping
- **Atomic Claiming**: Uses write transactions to prevent race conditions

### Lazy Initialization

The World initializes database connections lazily on first use:

```typescript
const world = createWorld(config);
// Database connection happens on first operation
await world.runs.create({ ... });
```

### Connection Caching

Database clients are cached per URL to share connections across multiple `createWorld()` calls:

```typescript
// Both worlds share the same connection
const world1 = createWorld({ databaseUrl: 'file:app.db' });
const world2 = createWorld({ databaseUrl: 'file:app.db' });
```

### Real-Time Streaming

Uses EventEmitter for single-process real-time notifications:

```typescript
// Write chunk - emits event immediately
await world.writeToStream('output', runId, chunk);

// Read stream - receives chunks via EventEmitter
const stream = await world.readFromStream('output');
```

For multi-process deployments, consider using an external pub/sub system.

## Error Handling

The implementation uses `WorkflowAPIError` from `@workflow/errors` for consistent HTTP status codes:

- `404` - Resource not found (run, step, hook, event)
- `409` - Conflict (duplicate hook token)

## Production Considerations

1. **Remote Turso**: For production, use a remote Turso database for durability and replication

2. **Connection Pooling**: libSQL client is cached per database URL

3. **Single-Process Streaming**: The EventEmitter-based streamer works for single-process deployments; for multi-process, add external pub/sub

4. **Schema Migrations**: Run `pnpm exec workflow-turso-setup` before first use and after package upgrades to apply any new migrations

5. **Graceful Shutdown**: The queue waits up to 30 seconds for in-flight messages during shutdown

6. **Monitoring**: Monitor polling performance and queue_messages table growth

7. **SQLite Concurrency**: WAL (Write-Ahead Logging) mode is enabled automatically for better concurrent access. A 5-second busy timeout is configured to handle lock contention gracefully

## License

MIT
