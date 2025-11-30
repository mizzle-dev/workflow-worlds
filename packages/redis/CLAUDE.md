# Redis World

A production-ready World implementation using Redis for storage, BullMQ for queue processing, and Redis Streams for real-time output.

## Quick Start

```bash
pnpm install
pnpm build
pnpm test
```

## Configuration

```typescript
import { createWorld } from '@workflow-worlds/redis';

const world = createWorld({
  // Redis connection (defaults to WORKFLOW_REDIS_URI env var, then localhost:6379)
  redisUrl: 'redis://localhost:6379',

  // Optional: pass an existing ioredis client
  client: existingRedisClient,

  // Key prefix for all Redis keys (default: 'workflow')
  keyPrefix: 'myapp',

  // Queue settings
  concurrency: 20,        // Max concurrent job processing
  maxRetries: 3,          // Retry attempts for failed jobs
  idempotencyTtlMs: 60000, // TTL for deduplication (1 minute)

  // Streamer settings
  streamMaxLen: 10000,    // Max entries per Redis Stream
});

// Start queue workers (required for processing)
await world.start();
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `WORKFLOW_REDIS_URI` | Redis connection string | `redis://localhost:6379` |
| `PORT` | HTTP callback port for queue workers | `3000` |

## Architecture

### Storage (`storage.ts`)
- **Runs**: Redis Hash + Sorted Sets for indexing
- **Steps**: Hash with composite key `{prefix}:steps:{runId}:{stepId}`
- **Events**: Sorted Set with ULID scores for ordering
- **Hooks**: Hash with token lookup, auto-cleanup on terminal status

### Queue (`queue.ts`)
- **BullMQ** with two fixed queues: `__wkf_workflow` and `__wkf_step`
- **Native deduplication** via `deduplication: { id, ttl }`
- HTTP callbacks to `/.well-known/workflow/v1/{flow,step}`
- Exponential backoff retries

### Streamer (`streamer.ts`)
- **Redis Streams** (XADD/XREAD) for chunk storage
- **Pub/Sub** for real-time notifications
- Base64 encoding for binary data

## Key Patterns

### Redis Key Structure
```
{prefix}:runs:{runId}              # Hash - run document
{prefix}:runs:idx:all              # ZSet - all runs by ULID score
{prefix}:runs:idx:status:{status}  # ZSet - runs by status
{prefix}:runs:idx:workflow:{name}  # ZSet - runs by workflow name

{prefix}:steps:{runId}:{stepId}    # Hash - step document
{prefix}:steps:idx:run:{runId}     # ZSet - steps by run

{prefix}:events:{runId}            # ZSet - events (JSON as member, ULID as score)

{prefix}:hooks:{hookId}            # Hash - hook document
{prefix}:hooks:token:{token}       # String - token → hookId mapping
{prefix}:hooks:idx:run:{runId}     # Set - hooks by run

{prefix}:stream:{name}             # Stream - output chunks
{prefix}:stream:{name}:closed      # String - stream closed flag
{prefix}:stream:channel:{name}     # Pub/Sub channel
```

### BullMQ Native Deduplication
```typescript
// Uses BullMQ's built-in deduplication with TTL
jobOptions.deduplication = {
  id: opts.idempotencyKey,
  ttl: idempotencyTtlMs,
};
```

## Test Suite

All 5 tests must pass:
- **addition**: Basic workflow execution
- **idempotency**: 110 steps, state reconstruction
- **hooks**: Hook/resume mechanism
- **errors**: RetryableError, FatalError handling
- **nullByte**: Binary data in step results

## Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Entry point, lazy initialization, client caching |
| `src/storage.ts` | Runs, steps, events, hooks using Redis Hash/ZSet |
| `src/queue.ts` | BullMQ integration with native deduplication |
| `src/streamer.ts` | Redis Streams + Pub/Sub for output |
| `src/utils.ts` | Serialization helpers, ULID scoring |
| `test/spec.test.ts` | Test suite with Redis container |

## Common Issues

| Issue | Solution |
|-------|----------|
| Connection failures | Ensure Redis is running, check `WORKFLOW_REDIS_URI` |
| BullMQ errors | Verify `maxRetriesPerRequest: null` in connection |
| Stream race conditions | Fixed: uses last seen stream ID instead of `$` |
| Hooks test timeout | Fixed: proper stream polling with tracked IDs |
