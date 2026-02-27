# @workflow-worlds/redis

[![npm version](https://img.shields.io/npm/v/@workflow-worlds/redis.svg)](https://www.npmjs.com/package/@workflow-worlds/redis)
[![license](https://img.shields.io/npm/l/@workflow-worlds/redis.svg)](https://github.com/mizzle-dev/workflow-worlds/blob/main/LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue.svg)](https://www.typescriptlang.org/)

A production-ready [World](https://github.com/vercel/workflow) implementation using Redis for storage, BullMQ for queue processing, and Redis Streams for real-time output.

## Features

- **Redis Storage** - Runs, steps, events, and hooks stored in Redis Hashes with Sorted Set indexes
- **Workflow 4.1 Contract** - Event-sourced transitions with legacy-run compatibility
- **BullMQ Queues** - Production-grade job processing with native deduplication and retries
- **Redis Streams** - Real-time output streaming with Pub/Sub notifications
- **Connection Pooling** - Automatic client caching across multiple `createWorld()` calls
- **Lazy Initialization** - Components initialize on first use

## Installation

```bash
npm install @workflow-worlds/redis
# or
pnpm add @workflow-worlds/redis
```

## Requirements

- Node.js 22+
- Redis 6.2+ (for Streams and BullMQ compatibility)

## Quick Start

```typescript
import { createWorld } from '@workflow-worlds/redis';

const world = createWorld({
  redisUrl: 'redis://localhost:6379',
});

// Start queue workers (required for processing jobs)
await world.start();
```

## Configuration

```typescript
interface RedisWorldConfig {
  // Redis connection string
  // Default: process.env.WORKFLOW_REDIS_URI ?? 'redis://localhost:6379'
  redisUrl?: string;
  
  // TLS options for Redis connection
  tls?: {
    key?: string | Buffer<ArrayBufferLike> | (string | Buffer<ArrayBufferLike> | KeyObject)[];
    cert?: string | Buffer<ArrayBufferLike> | (string | Buffer<ArrayBufferLike>)[];
    ca?: string | Buffer<ArrayBufferLike> | (string | Buffer<ArrayBufferLike>)[];
  };

  // Pre-existing ioredis client (if provided, redisUrl and tls are ignored)
  client?: Redis;

  // Key prefix for all Redis keys
  // Default: 'workflow'
  keyPrefix?: string;

  // Queue settings
  concurrency?: number;        // Max concurrent jobs (default: 20)
  maxRetries?: number;         // Retry attempts (default: 3)
  idempotencyTtlMs?: number;   // Deduplication TTL (default: 60000)

  // Base URL for HTTP callbacks
  // Default: http://localhost:${PORT}
  baseUrl?: string;

  // Streamer settings
  streamMaxLen?: number;       // Max entries per stream (default: 10000)
}
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `WORKFLOW_REDIS_URI` | Redis connection string | `redis://localhost:6379` |
| `PORT` | HTTP callback port for queue workers | `3000` |

## Architecture

### Storage

Uses Redis data structures optimized for workflow patterns:

- **Runs**: Hash for document storage, Sorted Sets for indexing by status/workflow
- **Steps**: Hash with composite keys, indexed by run
- **Events**: Sorted Set with ULID scores for deterministic ordering
- **Hooks**: Hash with token lookup, automatic cleanup on terminal status

### Queue

Built on [BullMQ](https://docs.bullmq.io/) for reliable job processing:

- Two dedicated queues: `__wkf_workflow` and `__wkf_step`
- Native deduplication with configurable TTL
- Exponential backoff retries
- Graceful shutdown support

### Streamer

Uses Redis Streams for ordered, persistent chunk delivery:

- XADD/XREAD for chunk storage and retrieval
- Pub/Sub for real-time notifications
- Base64 encoding for binary data support

## Redis Key Structure

```
{prefix}:runs:{runId}              # Hash - run document
{prefix}:runs:idx:all              # ZSet - all runs
{prefix}:runs:idx:status:{status}  # ZSet - runs by status
{prefix}:runs:idx:workflow:{name}  # ZSet - runs by workflow

{prefix}:steps:{runId}:{stepId}    # Hash - step document
{prefix}:steps:idx:run:{runId}     # ZSet - steps by run

{prefix}:events:{runId}            # ZSet - events (JSON member, ULID score)

{prefix}:hooks:{hookId}            # Hash - hook document
{prefix}:hooks:token:{token}       # String - token to hookId mapping
{prefix}:hooks:idx:run:{runId}     # Set - hooks by run

{prefix}:stream:{name}             # Stream - output chunks
{prefix}:stream:{name}:closed      # String - stream closed flag
{prefix}:stream:runs:{runId}       # Set - stream names for a run
```

## Upgrade Notes (Workflow 4.1)

- No manual migration script is required for Redis.
- New structures are key-based and created on demand.
- Legacy runs are supported with guarded compatibility behavior to prevent invalid state transitions.

## Usage with Workflow DevKit

Set the `WORKFLOW_TARGET_WORLD` environment variable to use this World:

```bash
WORKFLOW_TARGET_WORLD=@workflow-worlds/redis pnpm dev
```

Or configure programmatically:

```typescript
import { createWorld } from '@workflow-worlds/redis';

export default createWorld({
  redisUrl: process.env.REDIS_URL,
  keyPrefix: 'myapp',
});
```

## Testing

The package includes a full test suite using [Testcontainers](https://testcontainers.com/):

```bash
pnpm test
```

Tests run against a real Redis instance in Docker, validating:
- Basic workflow execution
- Idempotency with 110 concurrent steps
- Hook/resume mechanism
- Error handling and retries
- Binary data (null bytes)

## License

MIT
