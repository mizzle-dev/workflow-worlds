# Patterns & Practices

Key patterns extracted from production World implementations.

## ULID Generation

All implementations use ULIDs (Universally Unique Lexicographically Sortable Identifiers) for IDs.

### Why ULIDs?

- **Chronological sorting** - ULIDs encode timestamp, so lexicographic sort = chronological order
- **No coordination** - Unlike auto-increment, no central counter needed
- **URL-safe** - Only alphanumeric characters
- **Distributed** - Safe to generate across multiple processes

### Implementation

```typescript
import { monotonicFactory } from 'ulid';

// Monotonic factory ensures ULIDs increase even within same millisecond
const generateUlid = monotonicFactory();

// Generate IDs with prefixes for type identification
const runId = `wrun_${generateUlid()}`;     // Workflow run
const stepId = `step_${generateUlid()}`;    // Step
const eventId = `evnt_${generateUlid()}`;   // Event
const hookId = `hook_${generateUlid()}`;    // Hook
const messageId = `msg_${generateUlid()}`;  // Queue message
const chunkId = `chnk_${generateUlid()}`;   // Stream chunk
```

### Extracting Timestamps

```typescript
import { decodeTime } from 'ulid';

function ulidToDate(ulid: string): Date {
  return new Date(decodeTime(ulid));
}

// Usage
const eventId = 'evnt_01HX7K8J4Q5R6S7T8U9V0W1X2Y';
const ulid = eventId.replace(/^evnt_/, '');
const createdAt = ulidToDate(ulid);
```

---

## Error Serialization

Errors need special handling for storage and transmission.

### StructuredError Type

```typescript
interface StructuredError {
  message: string;
  stack?: string;
  code?: string;
}
```

### Serializing Errors

```typescript
function serializeError(error: unknown): StructuredError {
  if (error instanceof Error) {
    return {
      message: error.message,
      stack: error.stack,
      code: (error as any).code,
    };
  }
  return {
    message: String(error),
  };
}

// Store as JSON string in database
const errorJson = JSON.stringify(serializeError(error));
```

### Deserializing Errors

```typescript
function deserializeError(stored: string | null): StructuredError | undefined {
  if (!stored) return undefined;

  try {
    const parsed = JSON.parse(stored);
    return {
      message: parsed.message ?? 'Unknown error',
      stack: parsed.stack,
      code: parsed.code,
    };
  } catch {
    // Handle plain string errors (backwards compatibility)
    return { message: stored };
  }
}
```

---

## API Error Handling

Use `WorkflowAPIError` from `@workflow/errors` for all storage errors. This ensures consistent HTTP status codes across World implementations.

### Installation

```typescript
import { WorkflowAPIError } from '@workflow/errors';
```

### Error Types and Status Codes

| Scenario | Status Code | Example |
|----------|-------------|---------|
| Resource not found | `404` | Run, step, hook, or event not found |
| Conflict/duplicate | `409` | Hook with token already exists |

### Pattern

```typescript
// ✅ CORRECT - Returns proper HTTP status
async get(id: string): Promise<WorkflowRun> {
  const run = await db.query.runs.findFirst({ where: eq(runs.id, id) });
  if (!run) {
    throw new WorkflowAPIError(`Run not found: ${id}`, { status: 404 });
  }
  return run;
}

// ✅ CORRECT - Conflict error for duplicates
async create(data: CreateHookRequest): Promise<Hook> {
  const existing = await findByToken(data.token);
  if (existing) {
    throw new WorkflowAPIError(
      `Hook with token ${data.token} already exists`,
      { status: 409 }
    );
  }
  // ... create hook
}
```

### Why Not Plain Error?

Plain `Error` objects don't carry HTTP status information. The core runtime catches `WorkflowAPIError` and translates it to the appropriate HTTP response. Using plain errors results in generic 500 responses.

```typescript
// ❌ WRONG - Results in 500 Internal Server Error
throw new Error(`Run ${id} not found`);

// ✅ CORRECT - Results in 404 Not Found
throw new WorkflowAPIError(`Run not found: ${id}`, { status: 404 });
```

---

## Cursor-Based Pagination

Use ULID-based cursors for efficient pagination.

### Pattern

```typescript
async function list(params: {
  pagination?: { limit?: number; cursor?: string; sortOrder?: 'asc' | 'desc' };
}): Promise<PaginatedResponse<T>> {
  const limit = params.pagination?.limit ?? 100;
  const cursor = params.pagination?.cursor;
  const sortOrder = params.pagination?.sortOrder ?? 'desc';

  // Build query with cursor
  let query = db.select().from(table);

  if (cursor) {
    if (sortOrder === 'desc') {
      query = query.where(lt(table.id, cursor));
    } else {
      query = query.where(gt(table.id, cursor));
    }
  }

  // Order and limit (fetch one extra to detect hasMore)
  query = query
    .orderBy(sortOrder === 'desc' ? desc(table.id) : asc(table.id))
    .limit(limit + 1);

  const results = await query;

  // Determine if there are more results
  const hasMore = results.length > limit;
  const data = results.slice(0, limit);
  const nextCursor = hasMore && data.length > 0
    ? data[data.length - 1].id
    : null;

  return { data, cursor: nextCursor, hasMore };
}
```

### Why Fetch limit + 1?

Fetching one extra item tells us if there are more pages without a separate count query:

```typescript
// If we got more than limit, there are more pages
const hasMore = results.length > limit;
// Return only the requested limit
const data = results.slice(0, limit);
```

---

## Idempotency Key Handling

Prevent duplicate message processing while allowing legitimate workflow continuations.

### Key Insight

The purpose of idempotency keys is to **deduplicate concurrent queue operations** (e.g., network retries, load balancer duplicates). Each step invocation gets a unique idempotency key, so workflow duration (minutes, hours, days) has no effect on idempotency behavior.

Use **TTL-based deduplication** that catches true concurrent duplicates within a short time window.

### How Idempotency Keys Work

Each step invocation generates a unique idempotency key:
- **Key format**: `step_${ULID}` (correlation ID from the step)
- **Generated**: Once per step invocation in `packages/core/src/step.ts`
- **Passed to**: `queue()` via `opts.idempotencyKey`

This means:
- A 5-day workflow with 100 steps has **100 different idempotency keys**
- The TTL window is **per-key**, not per-workflow
- Workflow duration has **no effect** on idempotency behavior

### Pattern: TTL-Based Deduplication

```typescript
// Track recently queued messages with timestamps
const recentlyQueuedKeys = new Map<
  string,
  { messageId: MessageId; timestamp: number }
>();

// Tunable: Must be long enough to catch network retries (typically sub-second)
// but short enough to not interfere with rapid step completions.
// 5 seconds is a reasonable default for most systems.
const IDEMPOTENCY_TTL_MS = 5000;

async function queue(
  queueName: string,
  message: unknown,
  opts?: { idempotencyKey?: string }
): Promise<{ messageId: MessageId }> {
  // Check if this key was queued recently (true duplicate)
  if (opts?.idempotencyKey) {
    const existing = recentlyQueuedKeys.get(opts.idempotencyKey);
    const now = Date.now();
    if (existing && now - existing.timestamp < IDEMPOTENCY_TTL_MS) {
      return { messageId: existing.messageId };
    }
  }

  const messageId = generateMessageId();

  // Track for short-term deduplication
  if (opts?.idempotencyKey) {
    recentlyQueuedKeys.set(opts.idempotencyKey, {
      messageId,
      timestamp: Date.now(),
    });

    // Periodically clean up old entries to prevent memory leaks
    if (recentlyQueuedKeys.size > 1000) {
      const cutoff = Date.now() - IDEMPOTENCY_TTL_MS;
      for (const [key, value] of recentlyQueuedKeys) {
        if (value.timestamp < cutoff) {
          recentlyQueuedKeys.delete(key);
        }
      }
    }
  }

  // Queue the message (async)
  processMessageAsync(message);

  return { messageId };
}
```

### Why Not Inflight Tracking?

The naive approach of tracking messages until processing completes:

```typescript
// ❌ WRONG - will deadlock workflows
inflightMessages.set(key, messageId);
processMessageAsync(message).finally(() => {
  inflightMessages.delete(key);  // Too late!
});
```

This fails because:
1. Workflow runs step A, queues continuation with key K
2. Step A completes, workflow continues, needs to queue again with key K
3. Key K is still "inflight" → blocked → deadlock

### Database-Level Idempotency

For distributed systems, use database constraints with TTL:

```sql
-- PostgreSQL with expiring deduplication
INSERT INTO idempotency_keys (key, message_id, created_at)
VALUES ($1, $2, NOW())
ON CONFLICT (key)
WHERE created_at > NOW() - INTERVAL '5 seconds'
DO NOTHING;

-- Periodic cleanup
DELETE FROM idempotency_keys WHERE created_at < NOW() - INTERVAL '1 minute';
```

### Backend-Specific Approaches

Different queue backends handle idempotency differently:

| Backend | Approach | Duration |
|---------|----------|----------|
| In-memory (starter) | TTL-based Map | 5 seconds (tunable) |
| world-local | Inflight tracking | Until HTTP response completes |
| world-vercel | Vercel Queue native | Platform-managed |
| world-postgres | pg-boss singletonKey | Database-managed |

For production systems with external queue backends (BullMQ, SQS, etc.), use the queue system's native idempotency features rather than in-memory TTL.

---

## Deep Cloning for In-Memory Storage

When using in-memory storage (Maps), you **must** deep clone all returned data.

### Why Deep Clone?

The workflow core **mutates** objects returned from storage. For example, it hydrates `hook.metadata` after retrieval. Without deep cloning, these mutations corrupt your stored data.

### Use structuredClone, Not JSON

```typescript
// ✅ CORRECT - preserves Date objects, Maps, Sets, etc.
function deepClone<T>(obj: T): T {
  return structuredClone(obj);
}

// ❌ WRONG - converts Date to string, loses Date methods
function deepClone<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj));
}
```

The `JSON.parse(JSON.stringify(...))` approach breaks because:
- `Date` objects become ISO strings
- Calling `date.getTime()` on a string throws: `step.retryAfter.getTime is not a function`

### Pattern

Apply deep cloning to all storage getters and list methods:

```typescript
function createStorage(): Storage {
  const runs = new Map<string, WorkflowRun>();

  return {
    runs: {
      async get(id, params) {
        const run = runs.get(id);
        if (!run) {
          throw new WorkflowAPIError(`Run not found: ${id}`, { status: 404 });
        }
        // Deep clone before returning
        return filterRunData(deepClone(run), params?.resolveData);
      },

      async list(params) {
        const results = Array.from(runs.values());
        return {
          // Deep clone each item
          data: results.map(r => filterRunData(deepClone(r), params?.resolveData)),
          cursor: null,
          hasMore: false,
        };
      },
    },
  };
}
```

### Database-Backed Storage

If your storage uses a database, you typically don't need explicit deep cloning—each query returns fresh objects. But if you cache query results, apply the same pattern.

---

## Data Resolution Filtering

The `resolveData` parameter controls response payload size.

### Pattern

```typescript
function filterRunData(
  run: WorkflowRun,
  resolveData: 'none' | 'all'
): WorkflowRun {
  if (resolveData === 'none') {
    return {
      ...run,
      input: [],
      output: undefined,
    };
  }
  return run;
}

function filterEventData(
  event: Event,
  resolveData: 'none' | 'all'
): Event {
  if (resolveData === 'none') {
    const { eventData, ...rest } = event as any;
    return rest;
  }
  return event;
}
```

### When to Use

- `'all'` (default) - When you need full data for processing
- `'none'` - When listing for display, reduces bandwidth

---

## Timestamp Management

Proper timestamp handling for run and step lifecycle.

### startedAt Idempotency

Only set `startedAt` the first time status becomes `'running'`:

```typescript
async function update(id: string, data: UpdateRequest) {
  const existing = await get(id);
  const now = new Date();

  const updated = { ...existing, ...data, updatedAt: now };

  // Only set startedAt once
  if (data.status === 'running' && !updated.startedAt) {
    updated.startedAt = now;
  }

  await save(updated);
  return updated;
}
```

### completedAt on Terminal Status

Set `completedAt` when reaching any terminal state:

```typescript
const isTerminal =
  data.status === 'completed' ||
  data.status === 'failed' ||
  data.status === 'cancelled';

if (isTerminal) {
  updated.completedAt = now;
}
```

---

## Status State Machine

Valid status transitions for workflows and steps.

### Workflow Run States

```
                    ┌──────────────────┐
                    │                  │
                    ▼                  │
┌─────────┐    ┌─────────┐    ┌───────────┐
│ pending │───▶│ running │───▶│ completed │
└─────────┘    └────┬────┘    └───────────┘
                    │
                    ├────────▶ failed
                    │
                    ├────────▶ cancelled
```

### Validation

```typescript
const validTransitions: Record<WorkflowRunStatus, WorkflowRunStatus[]> = {
  pending: ['running', 'cancelled'],
  running: ['completed', 'failed', 'cancelled'],
  completed: [], // Terminal
  failed: [],    // Terminal
  cancelled: [], // Terminal
};

function validateTransition(from: WorkflowRunStatus, to: WorkflowRunStatus) {
  if (!validTransitions[from].includes(to)) {
    throw new Error(`Invalid transition from ${from} to ${to}`);
  }
}
```

---

## Hook Cleanup

Clean up hooks when runs complete or are cancelled.

### Pattern

```typescript
async function updateRun(id: string, data: UpdateRequest) {
  const updated = await doUpdate(id, data);

  const isTerminal =
    data.status === 'completed' ||
    data.status === 'failed' ||
    data.status === 'cancelled';

  if (isTerminal) {
    // Delete all hooks for this run
    await deleteHooksForRun(id);
  }

  return updated;
}

async function deleteHooksForRun(runId: string) {
  const hooks = await storage.hooks.list({ runId });
  for (const hook of hooks.data) {
    await storage.events.create(runId, {
      eventType: 'hook_disposed',
      correlationId: hook.hookId,
      specVersion: 2,
    });
  }
}
```

---

## Binary Serialization (CBOR)

For production, consider CBOR instead of JSON for efficiency.

### Why CBOR?

- **Smaller** - Binary format is more compact than JSON
- **Faster** - Less parsing overhead
- **Type-rich** - Native support for dates, binary data

### Implementation

```typescript
import { encode, decode } from 'cbor-x';

// Custom Drizzle column type
export function Cbor<T>() {
  return customType<{ data: T; driverData: Buffer }>({
    dataType: () => 'bytea',
    fromDriver: (value) => decode(value),
    toDriver: (value) => encode(value),
  });
}

// Usage in schema
const table = pgTable('workflow_runs', {
  input: Cbor<any[]>()('input'),
  output: Cbor<any>()('output'),
});
```

### Migration Strategy

Keep both JSON and CBOR columns during migration:

```typescript
// Read: prefer CBOR, fallback to JSON
const input = row.input ?? row.inputJson;

// Write: write to CBOR only
await db.update(table).set({ input: newInput });
```

---

## Real-Time Streaming

Patterns for real-time stream updates.

### EventEmitter (Single Process)

```typescript
const emitter = new EventEmitter();

// Writer
emitter.emit(`chunk:${streamName}`, { chunkId, data });
emitter.emit(`close:${streamName}`);

// Reader
emitter.on(`chunk:${streamName}`, handler);
emitter.on(`close:${streamName}`, closeHandler);
```

### PostgreSQL LISTEN/NOTIFY (Multi-Process)

```typescript
// Writer
await sql.notify('workflow_chunk', JSON.stringify({ streamId, chunkId }));

// Reader
await sql.listen('workflow_chunk', (payload) => {
  const { streamId, chunkId } = JSON.parse(payload);
  // Handle new chunk
});
```

### Chunk Deduplication

When combining historical and real-time chunks:

```typescript
const deliveredChunkIds = new Set<string>();

function handleChunk(chunk: StreamChunk) {
  if (deliveredChunkIds.has(chunk.chunkId)) {
    return; // Already delivered
  }
  deliveredChunkIds.add(chunk.chunkId);
  controller.enqueue(chunk.data);
}
```

---

## Connection Pooling

For database-backed worlds, use connection pools.

### Pattern

```typescript
import postgres from 'postgres';

const sql = postgres(connectionString, {
  max: 20,           // Max connections in pool
  idle_timeout: 20,  // Close idle connections after 20s
  connect_timeout: 10,
});

// Use sql for all queries - pool managed automatically
const result = await sql`SELECT * FROM workflow_runs WHERE id = ${id}`;
```

---

## Next Steps

- [05 - Testing](./05-testing.md) - Validate your implementation
- [06 - Production Checklist](./06-production-checklist.md) - Prepare for production
