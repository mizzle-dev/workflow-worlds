# MongoDB World

A complete MongoDB-backed World implementation for the Workflow DevKit.

## Features

- **Storage**: Uses MongoDB collections for runs, steps, events, and hooks
- **Queue**: TTL-based idempotency tracking with MongoDB
- **Streaming**: Real-time output via MongoDB change streams (with fallback to polling)
- **Production-ready**: Proper indexing, error handling, and connection management

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
- `idempotency_keys` - TTL-based idempotency tracking (auto-expires)

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

### Idempotency Keys Collection
- `{ createdAt: 1 }` (TTL index, expires after 60 seconds)
- `{ key: 1 }` (unique, sparse)

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

### TTL-Based Idempotency

The queue implementation uses MongoDB's TTL indexes for idempotency tracking. This prevents duplicate message processing while allowing legitimate workflow continuations:

```typescript
// Track recently queued messages with automatic cleanup
const idempotencyCollection = db.collection('idempotency_keys');
await idempotencyCollection.createIndex(
  { createdAt: 1 },
  { expireAfterSeconds: 60 }
);
```

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

1. **Connection Pooling**: The MongoDB driver handles connection pooling automatically

2. **Replica Sets**: For production, use a MongoDB replica set to enable change streams and high availability

3. **Indexes**: All required indexes are created automatically, but monitor query performance

4. **Cleanup**: The idempotency keys collection uses TTL indexes for automatic cleanup

5. **Monitoring**: Monitor MongoDB metrics (connections, operations, replication lag)

## License

Apache-2.0
