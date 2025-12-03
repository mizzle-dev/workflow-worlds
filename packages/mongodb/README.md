# MongoDB World

[![npm version](https://img.shields.io/npm/v/@workflow-worlds/mongodb.svg)](https://www.npmjs.com/package/@workflow-worlds/mongodb)
[![license](https://img.shields.io/npm/l/@workflow-worlds/mongodb.svg)](https://github.com/mizzle-dev/workflow-worlds/blob/main/LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue.svg)](https://www.typescriptlang.org/)

A complete MongoDB-backed World implementation for the Workflow DevKit.

## Features

- **Storage**: Uses MongoDB collections for runs, steps, events, and hooks
- **Queue**: Production-ready with persistent messages, exponential backoff, graceful shutdown
- **Streaming**: Real-time output via MongoDB change streams (with fallback to polling)
- **Production-ready**: Proper indexing, error handling, connection pooling, and lock management

## Installation

```bash
npm install @workflow-worlds/mongodb mongodb
# or
pnpm add @workflow-worlds/mongodb mongodb
```

## Usage

```typescript
import { createWorld } from '@workflow-worlds/mongodb';

// The world will connect to MongoDB when first used
const world = createWorld({
  mongoUrl: 'mongodb://localhost:27017',
  databaseName: 'workflow', // optional, defaults to 'workflow'
});

// Use with the Workflow runtime
export default world;
```

## Configuration

All configuration options can be set via code or environment variables. Environment variables follow the `WORKFLOW_` prefix convention.

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `WORKFLOW_MONGODB_URI` | MongoDB connection string | `mongodb://localhost:27017` |
| `WORKFLOW_MONGODB_DATABASE_NAME` | Database name | `workflow` |
| `WORKFLOW_MONGODB_CHANGE_STREAMS` | Enable change streams (`true`/`false`) | `true` |
| `WORKFLOW_SERVICE_URL` | Base URL for HTTP callbacks | `http://localhost:{PORT}` |
| `WORKFLOW_CONCURRENCY` | Max concurrent message processing | `20` |

### Programmatic Configuration

```typescript
interface MongoDBWorldConfig {
  // MongoDB connection string
  // Env: WORKFLOW_MONGODB_URI
  mongoUrl?: string;

  // Database name to use
  // Env: WORKFLOW_MONGODB_DATABASE_NAME
  databaseName?: string;

  // Base URL for HTTP callbacks (queue)
  // Env: WORKFLOW_SERVICE_URL
  baseUrl?: string;

  // Maximum concurrent message processing
  // Env: WORKFLOW_CONCURRENCY
  concurrency?: number;

  // Whether to use MongoDB Change Streams for real-time updates
  // Env: WORKFLOW_MONGODB_CHANGE_STREAMS
  // Note: Requires MongoDB replica set
  useChangeStreams?: boolean;
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
  databaseName: 'my-app', // This wins over WORKFLOW_MONGODB_DATABASE_NAME
});
```

## Collections

The MongoDB World creates the following collections:

- `runs` - Workflow run records
- `steps` - Step execution records
- `events` - Event log for workflow replay
- `hooks` - Hook registrations for pausing workflows
- `stream_chunks` - Stream output chunks
- `queue_messages` - Persistent message queue with status tracking

## Indexes

Proper indexes are created automatically on first use:

### Runs Collection
- `{ runId: 1 }` (unique)
- `{ workflowName: 1 }`
- `{ status: 1 }`
- `{ createdAt: -1 }`

### Steps Collection
- `{ runId: 1, stepId: 1 }` (unique)
- `{ stepId: 1 }`
- `{ runId: 1, createdAt: 1 }`

### Events Collection
- `{ eventId: 1 }` (unique)
- `{ runId: 1, eventId: 1 }`
- `{ correlationId: 1 }`

### Hooks Collection
- `{ hookId: 1 }` (unique)
- `{ token: 1 }` (unique)
- `{ runId: 1 }`

### Stream Chunks Collection
- `{ streamName: 1, chunkId: 1 }`
- `{ chunkId: 1 }` (unique)

### Queue Messages Collection
- `{ messageId: 1 }` (unique)
- `{ status: 1, scheduledFor: 1, createdAt: 1 }` (polling)
- `{ idempotencyKey: 1 }` (unique, partial - for deduplication)
- `{ status: 1, lockedUntil: 1 }` (partial on processing - for recovery)
- `{ updatedAt: 1 }` (TTL index - auto-deletes completed/failed after 7 days)

## Development

### Prerequisites

- Node.js 22+
- pnpm
- Docker (for running tests)

### Building

```bash
pnpm install
pnpm build
```

### Running Tests

The test suite uses Docker to spin up a MongoDB container:

```bash
# Make sure Docker is running
pnpm test
```

The tests will:
1. Start a MongoDB 7 container on port 27017
2. Run the full @workflow/world-testing test suite
3. Clean up the container when done

If you already have MongoDB running locally, the tests will use the existing instance.

## Key Patterns

### Production Queue

The queue implementation is production-ready with:

**Persistent Message Storage:**
```typescript
// Messages are stored in queue_messages collection
interface QueueMessage {
  messageId: string;
  queueName: string;
  payload: Buffer;           // Binary data via BSON
  status: 'pending' | 'processing' | 'completed' | 'failed';
  attempt: number;
  maxRetries: number;
  scheduledFor: Date;        // Supports delayed processing
  lockedUntil?: Date;        // Lock expiration
  lockToken?: string;        // Ownership verification
  idempotencyKey?: string;   // Deduplication
  lastError?: { message: string; status?: number; timestamp: Date };
}
```

**Atomic Idempotency:** Uses `findOneAndUpdate` with upsert (not check-then-insert):
```typescript
await messagesCollection.findOneAndUpdate(
  { idempotencyKey, createdAt: { $gt: cutoff } },
  { $setOnInsert: { /* new message */ }, $set: { updatedAt: now } },
  { upsert: true, returnDocument: 'after' }
);
```

**Lock Management:** Prevents duplicate processing with token verification:
```typescript
// Acquire: atomically set status + lockToken + lockedUntil
// Complete: verify lockToken still valid before marking done
// Recover: periodically reset stuck messages with expired locks
```

**Exponential Backoff:** Failures retry with increasing delays (1s → 60s max, with jitter).

**Graceful Shutdown:** Waits for in-flight messages before stopping, releases locks on timeout.

### Lazy Initialization

The World initializes MongoDB connections lazily on first use. This allows the `createWorld` function to return synchronously while deferring database connections until needed:

```typescript
const world = createWorld(config);
// MongoDB connection happens on first operation
await world.runs.create({ ... });
```

### Change Streams for Real-Time Updates

When available, the streamer uses MongoDB change streams for real-time notifications:

```typescript
const changeStream = chunksCollection.watch();
changeStream.on('change', (change) => {
  if (change.operationType === 'insert') {
    // Emit real-time notification
    emitter.emit(`chunk:${streamName}`, chunk);
  }
});
```

## Error Handling

The implementation uses `WorkflowAPIError` from `@workflow/errors` for consistent HTTP status codes:

- `404` - Resource not found (run, step, hook, event)
- `409` - Conflict (duplicate hook token)

## Production Considerations

1. **Connection Pooling**: MongoDB client is cached per connection string to share across multiple `createWorld()` calls

2. **Replica Sets**: For production, use a MongoDB replica set to enable change streams and high availability

3. **Indexes**: All required indexes are created automatically, but monitor query performance

4. **Message Cleanup**: Completed/failed messages auto-delete after 7 days via TTL index (configurable)

5. **Stuck Message Recovery**: Messages with expired locks are automatically recovered on startup and every 60 seconds

6. **Graceful Shutdown**: Call `start()` to begin processing; the queue waits up to 30 seconds for in-flight messages during shutdown

7. **Monitoring**: Monitor MongoDB metrics (connections, operations, replication lag, queue_messages collection size)

## License

MIT
