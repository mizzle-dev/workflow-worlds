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

### Queue (3 methods)

- `getDeploymentId()` - Return deployment identifier
- `queue()` - Enqueue messages with idempotency
- `createQueueHandler()` - Create HTTP handler for processing

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

## Starter Template

Use `packages/starter/` as your starting point. It has:
- Complete in-memory implementation that passes all tests
- TODO markers for each replacement point
- Proper error handling with WorkflowAPIError

## When Asked to Build a World

1. First, ask what backend they're using (MongoDB, Redis, etc.)
2. Copy `packages/starter/` to `packages/{backend}/`
3. Implement Storage first (largest component)
4. Then Queue (depends on their queue system)
5. Then Streamer (real-time notifications)
6. Run tests after each component: `pnpm build && pnpm test`
