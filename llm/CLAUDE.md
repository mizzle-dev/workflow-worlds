# Claude Instructions for Building Worlds

When helping users build custom World implementations for the Workflow DevKit, follow these guidelines.

## Context

A "World" is the abstraction layer that defines how workflows communicate with storage, queuing, and streaming infrastructure. Users want to build custom worlds for backends like MongoDB, Redis, DynamoDB, etc.

## Key Resources in This Repository

Before implementing, read these files:

**Documentation:**
```
docs/02-interface-reference.md      # Complete interface API documentation
docs/04-patterns-and-practices.md   # Critical patterns and gotchas
docs/05-testing.md                  # Test suite guidance
```

**Working Implementation:**
```
packages/starter/src/storage.ts     # In-memory Storage implementation
packages/starter/src/queue.ts       # In-memory Queue with TTL idempotency
packages/starter/src/streamer.ts    # EventEmitter-based Streamer
```

**External npm packages (for reference):**
- `@workflow/world` - TypeScript interfaces and types
- `@workflow/world-postgres` - PostgreSQL production reference
- `@workflow/world-testing` - Test suite
- `@workflow/errors` - Error types (WorkflowAPIError, etc.)

## World Interface Structure

```typescript
interface World extends Queue, Storage, Streamer {
  start?(): Promise<void>;  // Optional background task initialization
}
```

### Storage (4 namespaces)

1. **runs** - Workflow execution instances
   - `create`, `get`, `update`, `list`, `cancel`, `pause`, `resume`

2. **steps** - Individual step executions
   - `create`, `get`, `update`, `list`

3. **events** - Event log for replay (source of truth)
   - `create`, `list`, `listByCorrelationId`

4. **hooks** - Webhook registrations
   - `create`, `get`, `getByToken`, `list`, `dispose`

### Queue (3 methods + lifecycle)

- `getDeploymentId()` - Return deployment identifier
- `queue()` - Enqueue messages with idempotency
- `createQueueHandler()` - Create HTTP handler for processing
- `start()` - Start processing messages (called by runtime)

**Production queues should have:**
- Persistent message storage (survives restarts)
- Lock management with token verification
- Exponential backoff with jitter
- Graceful shutdown with in-flight tracking
- Stuck message recovery

### Streamer (3 methods)

- `writeToStream()` - Write chunk to named stream
- `closeStream()` - Signal end of stream
- `readFromStream()` - Return ReadableStream

## Implementation Patterns

### 1. ULID for IDs

Always use ULIDs with prefixes:
```typescript
import { monotonicFactory } from 'ulid';
const generateUlid = monotonicFactory();

const runId = `wrun_${generateUlid()}`;
const stepId = `wstep_${generateUlid()}`;
const eventId = `wevt_${generateUlid()}`;
```

### 2. Timestamp Management

```typescript
// Set startedAt ONLY ONCE when status becomes 'running'
if (data.status === 'running' && !updated.startedAt) {
  updated.startedAt = now;
}

// Set completedAt on terminal states
if (status === 'completed' || status === 'failed' || status === 'cancelled') {
  updated.completedAt = now;
}
```

### 3. Hook Cleanup

Clean up hooks when runs reach terminal status:
```typescript
if (isTerminal) {
  await deleteHooksForRun(runId);
}
```

### 4. Event Ordering

Events must be returned in ascending order (oldest first) for proper replay:
```typescript
const sortOrder = params.pagination?.sortOrder ?? 'asc';
```

### 5. Data Resolution

Support `resolveData: 'none' | 'all'` to reduce payload size:
```typescript
if (resolveData === 'none') {
  return { ...run, input: [], output: undefined };
}
```

### 6. Error Handling

Use `WorkflowAPIError` from `@workflow/errors` for proper HTTP status codes:
```typescript
import { WorkflowAPIError } from '@workflow/errors';

// 404 for not found
throw new WorkflowAPIError(`Run not found: ${id}`, { status: 404 });

// 409 for conflicts
throw new WorkflowAPIError(`Hook with token ${token} already exists`, { status: 409 });
```

## Testing

Use `@workflow/world-testing`:
```typescript
import { createTestSuite } from '@workflow/world-testing';
createTestSuite('./dist/index.js');
```

Five test suites:
1. `addition` - Basic workflow execution
2. `idempotency` - State replay correctness
3. `hooks` - Hook/resume mechanism
4. `errors` - Retry semantics
5. `nullByte` - Binary data handling

## Common Mistakes to Avoid

1. **Not using monotonic ULIDs** - Can cause ordering issues
2. **Setting startedAt multiple times** - Should only be set once
3. **Forgetting hook cleanup** - Leads to orphaned hooks
4. **Wrong event sort order** - Must be ascending for replay
5. **Not handling runId as Promise** - Streamer methods accept `Promise<string>`
6. **Missing idempotency handling** - Queue must prevent duplicates
7. **Using plain Error** - Use `WorkflowAPIError` with proper status codes
8. **Wrong env var naming** - Must use `WORKFLOW_` prefix and `URI` not `URL`
9. **Weak queue implementation** - Production needs: persistent storage, lock tokens, backoff, graceful shutdown
10. **Check-then-insert for idempotency** - Race condition; use atomic upsert instead

## Environment Variable Conventions

All World implementations MUST follow these conventions:

1. **Prefix with `WORKFLOW_`**: All env vars must start with `WORKFLOW_`
2. **Use `URI` not `URL`**: For connection strings (e.g., `WORKFLOW_MONGODB_URI`)
3. **Priority**: config > env var > default
4. **Make configurable**: All options should be settable via env vars

```typescript
// Connection string
const mongoUri = config.mongoUrl
  ?? process.env.WORKFLOW_MONGODB_URI
  ?? 'mongodb://localhost:27017';

// Boolean option
const useFeature = config.useFeature
  ?? (process.env.WORKFLOW_MY_FEATURE !== undefined
    ? process.env.WORKFLOW_MY_FEATURE === 'true'
    : true);
```

## Debug Logging

All worlds **must** implement configurable debug logging via `WORKFLOW_DEBUG`. Logs must be written to stderr (not stdout) to avoid interfering with CLI JSON parsing.

```bash
# Enable all debug output
WORKFLOW_DEBUG=1 pnpm test

# Enable specific worlds
WORKFLOW_DEBUG=redis-world pnpm test
WORKFLOW_DEBUG=mongodb-world,turso-world pnpm test
```

Available namespaces: `redis-world`, `mongodb-world`, `turso-world`, `starter-world`, `workbench`

### Implementing Debug Logging in New Worlds

When building a new world, create `src/utils.ts` with the debug logger:

```typescript
/**
 * Creates a debug logger that writes to stderr when enabled.
 */
function createDebugLogger(namespace: string) {
  return (...args: unknown[]) => {
    const debug = process.env.WORKFLOW_DEBUG;
    if (!debug) return;

    const enabled =
      debug === '1' ||
      debug === 'true' ||
      debug === '*' ||
      debug.split(',').some((ns) => ns.trim() === namespace);

    if (!enabled) return;

    const timestamp = new Date().toISOString();
    const prefix = `[${timestamp}] [${namespace}]`;
    const message = args
      .map((arg) =>
        typeof arg === 'object' ? JSON.stringify(arg, null, 2) : String(arg)
      )
      .join(' ');

    process.stderr.write(`${prefix} ${message}\n`);
  };
}

export const debug = createDebugLogger('{backend}-world');
```

Then import and use throughout your implementation:
```typescript
import { debug } from './utils.js';

// In index.ts
debug('Creating world with config:', config);
debug('Initialization complete');

// In queue.ts
debug('Starting queue processing...');
debug('Recovered', count, 'stuck messages');
debug('Queue shutdown complete');
```

**IMPORTANT:** Never use `console.log` or `console.warn` in world implementations - they write to stdout/stderr and can corrupt CLI JSON output. Always use the debug logger instead.

## Robust Queue Implementation

For production worlds, implement a robust queue with these patterns:

### Message Schema
```typescript
interface QueueMessage {
  messageId: string;
  queueName: string;
  payload: Buffer;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  attempt: number;
  maxRetries: number;
  scheduledFor: Date;        // When eligible for processing
  lockedUntil?: Date;        // Lock expiration
  lockToken?: string;        // Ownership verification
  idempotencyKey?: string;
  lastError?: { message: string; status?: number; timestamp: Date };
}
```

### Atomic Idempotency
Use upsert, NOT check-then-insert:
```typescript
// GOOD: Atomic upsert
const result = await messages.findOneAndUpdate(
  { idempotencyKey, createdAt: { $gt: cutoff } },
  { $setOnInsert: { /* new message */ }, $set: { updatedAt: now } },
  { upsert: true, returnDocument: 'after' }
);

// BAD: Race condition
const existing = await messages.findOne({ idempotencyKey });
if (!existing) await messages.insertOne({ /* ... */ });
```

### Lock Management
```typescript
// Acquire lock with unique token
const lockToken = generateUlid();
await messages.findOneAndUpdate(
  { messageId, status: 'pending' },
  { $set: { status: 'processing', lockToken, lockedUntil: expiry } }
);

// Verify lock before completion (prevents duplicate processing)
await messages.updateOne(
  { messageId, lockToken, status: 'processing', lockedUntil: { $gt: now } },
  { $set: { status: 'completed' } }
);
```

### Exponential Backoff with Jitter
```typescript
function calculateDelay(attempt: number): number {
  const delay = Math.min(1000 * Math.pow(2, attempt - 1), 60000);
  const jitter = delay * 0.2 * (Math.random() * 2 - 1);
  return Math.round(delay + jitter);
}
```

### 503 with timeoutSeconds
Handle Workflow DevKit's retry signal:
```typescript
if (response.status === 503) {
  const { timeoutSeconds } = await response.json();
  if (typeof timeoutSeconds === 'number') {
    // Reschedule without incrementing attempt
    await rescheduleMessage(messageId, lockToken, timeoutSeconds);
    return;
  }
}
```

### Graceful Shutdown
```typescript
async close() {
  state.isShuttingDown = true;
  await watcher.stop();

  // Wait for in-flight with timeout
  const deadline = Date.now() + 30000;
  while (inflightMessages.size > 0 && Date.now() < deadline) {
    await sleep(100);
  }

  // Release locks for remaining
  for (const [id, ctx] of inflightMessages) {
    ctx.abortController.abort();
    await releaseLock(id, ctx.lockToken);
  }
}
```

### Stuck Message Recovery
```typescript
// On start() and periodically:
await messages.updateMany(
  { status: 'processing', lockedUntil: { $lt: new Date() } },
  { $set: { status: 'pending' }, $unset: { lockToken: '', lockedUntil: '' } }
);
```

## Starter Template

Use `packages/starter/` as your starting point. It has:
- Complete in-memory implementation that passes all tests
- TODO markers for each replacement point
- Proper error handling with WorkflowAPIError

For production reference, see `packages/mongodb/` which implements the robust queue patterns above.

## When Asked to Build a World

1. First, ask what backend they're using (MongoDB, Redis, etc.)
2. Copy `packages/starter/` to `packages/{backend}/`
3. Implement Storage first (largest component)
4. Then Queue (depends on their queue system)
5. Then Streamer (real-time notifications)
6. Run tests after each component: `pnpm build && pnpm test`
