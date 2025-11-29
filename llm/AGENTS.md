# AI Agent Instructions for World Building

This document provides structured instructions for AI agents assisting with Workflow DevKit World implementations.

## Task Definition

**Goal:** Help users create custom World implementations for the Workflow DevKit framework.

**Input:** User's target infrastructure (MongoDB, Redis, PostgreSQL, DynamoDB, etc.)

**Output:** A working World implementation that passes `@workflow/world-testing` test suite.

## Agent Capabilities Required

- File reading and writing
- Code generation (TypeScript)
- Test execution
- Package management (pnpm)

## Workflow

### Phase 1: Discovery

1. Identify user's target backend:
   - Database: MongoDB, PostgreSQL, MySQL, DynamoDB, etc.
   - Queue: BullMQ, Agenda, SQS, RabbitMQ, etc.
   - Streaming: Redis Streams, Kafka, database polling, etc.

2. Reference implementations:
   - `packages/starter/` - Working in-memory implementation (in this repo)
   - `@workflow/world-postgres` - PostgreSQL production reference (npm package)

3. Determine if user has existing infrastructure or starting fresh.

### Phase 2: Setup

1. Copy starter:
   ```bash
   cp -r packages/starter packages/{backend}
   ```

2. Update `package.json`:
   - Change name to `@workflow-worlds/{backend}` (or custom name)
   - Add backend-specific dependencies

3. Verify baseline:
   ```bash
   cd packages/{backend}
   pnpm install && pnpm build && pnpm test
   ```

### Phase 3: Implementation

Implement in this order (each component should pass tests before moving on):

#### 3.1 Storage Implementation

Replace in-memory Maps with database operations:

```
src/storage.ts
├── runs: CRUD + lifecycle (cancel, pause, resume)
├── steps: CRUD with retry tracking
├── events: append-only log with correlation ID support
└── hooks: webhook registration with token lookup
```

Key patterns:
- Use database transactions where needed
- Implement cursor-based pagination
- Handle `resolveData` filtering
- Clean up hooks on run completion
- Use `WorkflowAPIError` from `@workflow/errors` with proper status codes (404, 409)

#### 3.2 Queue Implementation

Replace setTimeout with actual queue:

```
src/queue.ts
├── getDeploymentId(): Return deployment identifier
├── queue(): Enqueue with idempotency key
└── createQueueHandler(): HTTP handler for processing
```

Key patterns:
- Use `@vercel/queue` JsonTransport for serialization
- Implement idempotency: TTL-based for in-memory, database-level for distributed (see docs/04-patterns-and-practices.md)
- **Warning**: Don't use inflight tracking that blocks until processing completes - it deadlocks workflows
- Handle retry via 503 response with timeoutSeconds

#### 3.3 Streamer Implementation

Replace EventEmitter with distributed pub/sub:

```
src/streamer.ts
├── writeToStream(): Store chunk + notify
├── closeStream(): Store EOF marker + notify
└── readFromStream(): Return ReadableStream with real-time updates
```

Key patterns:
- Use ULID for chunk ordering
- Handle deduplication between historical and real-time
- Support startIndex for resumption

### Phase 4: Testing

Run the full test suite:

```bash
pnpm build && pnpm test
```

If tests fail:
1. Check error messages for specific failures
2. Review docs/05-testing.md for common issues
3. Add logging to identify the issue
4. Fix and re-test

### Phase 5: Documentation

Create README.md with:
- Installation instructions
- Configuration options
- Environment variables
- Quick start example

## Interface Reference

For complete interface documentation, see `docs/02-interface-reference.md`.

### Storage.runs

| Method | Description |
|--------|-------------|
| `create(data)` | Create pending run with ULID |
| `get(id, params?)` | Retrieve run by ID |
| `update(id, data)` | Update status, output, error |
| `list(params?)` | List with filters and pagination |
| `cancel(id)` | Set status to 'cancelled' |
| `pause(id)` | Set status to 'paused' |
| `resume(id)` | Set status to 'running' |

### Storage.steps

| Method | Description |
|--------|-------------|
| `create(runId, data)` | Create pending step |
| `get(runId, stepId, params?)` | Retrieve step (runId can be undefined) |
| `update(runId, stepId, data)` | Update status, output, attempt |
| `list(params)` | List steps for a run |

### Storage.events

| Method | Description |
|--------|-------------|
| `create(runId, data, params?)` | Create event with ULID |
| `list(params)` | List events for a run (ascending order) |
| `listByCorrelationId(params)` | List events by correlation ID |

### Storage.hooks

| Method | Description |
|--------|-------------|
| `create(runId, data, params?)` | Create hook with unique token |
| `get(hookId, params?)` | Get hook by ID |
| `getByToken(token, params?)` | Get hook by security token |
| `list(params)` | List hooks (optionally by runId) |
| `dispose(hookId)` | Delete hook |

### Queue

| Method | Description |
|--------|-------------|
| `getDeploymentId()` | Return deployment ID string |
| `queue(name, message, opts?)` | Enqueue message, return messageId |
| `createQueueHandler(prefix, handler)` | Create HTTP request handler |

### Streamer

| Method | Description |
|--------|-------------|
| `writeToStream(name, runId, chunk)` | Write chunk (string or Uint8Array) |
| `closeStream(name, runId)` | Signal EOF |
| `readFromStream(name, startIndex?)` | Return ReadableStream |

## Error Handling

Use `WorkflowAPIError` from `@workflow/errors` for storage errors:

```typescript
import { WorkflowAPIError } from '@workflow/errors';

// 404 for not found
throw new WorkflowAPIError(`Run not found: ${id}`, { status: 404 });

// 409 for conflicts/duplicates
throw new WorkflowAPIError(`Hook with token ${token} already exists`, { status: 409 });
```

Error serialization for workflow failures:
```typescript
interface StructuredError {
  message: string;
  stack?: string;
  code?: string;
}
```

## Validation Checklist

Before considering implementation complete:

- [ ] All 5 test suites pass
- [ ] ULID prefixes used correctly (wrun_, wstep_, wevt_, whook_)
- [ ] startedAt set only once
- [ ] completedAt set on terminal status
- [ ] Hooks cleaned up on run completion
- [ ] Events returned in ascending order
- [ ] Pagination uses cursor (not offset)
- [ ] resolveData filtering implemented
- [ ] Idempotency keys handled
- [ ] Connection pooling configured (if applicable)
- [ ] WorkflowAPIError used with proper status codes
- [ ] Environment variables follow `WORKFLOW_` prefix convention

## Environment Variable Conventions

All World implementations should follow these conventions for environment variables:

### Naming Convention

1. **Prefix with `WORKFLOW_`**: All environment variables should start with `WORKFLOW_`
2. **Use `URI` not `URL`**: For connection strings, use `URI` (e.g., `WORKFLOW_MONGODB_URI` not `WORKFLOW_MONGODB_URL`)
3. **Use SCREAMING_SNAKE_CASE**: Standard env var naming convention

### Required Pattern

```typescript
// Priority: config > env var > default
const mongoUri = config.mongoUrl
  ?? process.env.WORKFLOW_MONGODB_URI
  ?? process.env.MONGODB_URL  // Legacy fallback (optional)
  ?? 'mongodb://localhost:27017';
```

### Common Environment Variables

| Variable | Description | Example |
|----------|-------------|---------|
| `WORKFLOW_TARGET_WORLD` | Path to World module | `./dist/index.js` |
| `WORKFLOW_POSTGRES_URL` | PostgreSQL connection | `postgres://...` |
| `WORKFLOW_MONGODB_URI` | MongoDB connection | `mongodb://...` |
| `WORKFLOW_REDIS_URL` | Redis connection | `redis://...` |
| `WORKFLOW_MONGODB_CHANGE_STREAMS` | Enable/disable change streams | `true` or `false` |

### Making Options Configurable

All configuration options should be settable via environment variables where practical:

```typescript
// Boolean options
const useFeature = config.useFeature
  ?? (process.env.WORKFLOW_MY_FEATURE !== undefined
    ? process.env.WORKFLOW_MY_FEATURE === 'true'
    : true);  // default value

// String options
const databaseName = config.databaseName
  ?? process.env.WORKFLOW_DATABASE_NAME
  ?? 'workflow';

// Number options
const timeout = config.timeout
  ?? (process.env.WORKFLOW_TIMEOUT
    ? parseInt(process.env.WORKFLOW_TIMEOUT, 10)
    : 5000);
```
