# World Starter

This is a working in-memory World implementation that passes all tests.

## Development Workflow
1. `pnpm install` - Install dependencies
2. `pnpm build` - Compile TypeScript
3. `pnpm test` - Run test suite (must pass before any changes)

## Implementing Your Backend

Replace each file incrementally, testing after each:

### 1. storage.ts (largest)
- Replace Maps with your database (MongoDB, PostgreSQL, etc.)
- Keep deep cloning pattern for in-memory caches
- Maintain ULID prefixes (wrun_, wstep_, wevt_, whook_)

### 2. queue.ts
- Replace setTimeout with your queue (BullMQ, Agenda, SQS)
- Use your queue's native idempotency features
- Keep the HTTP handler pattern

### 3. streamer.ts
- Replace EventEmitter with pub/sub (Redis, Kafka, etc.)
- Maintain chunk ordering with ULIDs

## Test Suite
All 5 tests must pass:
- addition: Basic workflow execution
- idempotency: 110 steps, state reconstruction
- hooks: Hook/resume mechanism
- errors: RetryableError, FatalError
- nullByte: Binary data handling

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Entry point, exports `createWorld` |
| `src/storage.ts` | Runs, steps, events, hooks storage |
| `src/queue.ts` | Message queue with idempotency |
| `src/streamer.ts` | Real-time output streaming |
| `test/spec.test.ts` | Test suite configuration |

## Error Handling

Use `WorkflowAPIError` from `@workflow/errors` for storage errors:

```typescript
import { WorkflowAPIError } from '@workflow/errors';

// 404 for not found
throw new WorkflowAPIError(`Run not found: ${id}`, { status: 404 });

// 409 for conflicts/duplicates
throw new WorkflowAPIError(`Hook with token ${token} already exists`, { status: 409 });
```

## Common Issues

| Issue | Solution |
|-------|----------|
| `step.retryAfter.getTime is not a function` | Use `structuredClone()` instead of JSON.parse/stringify |
| Idempotency deadlock | Use TTL-based deduplication, not inflight tracking |
| Events out of order | Ensure events.list returns ascending sort (oldest first) |
| Hooks test hanging | Check events.create handles `hook_received` type |
| Generic 500 errors | Use `WorkflowAPIError` with proper status codes |
