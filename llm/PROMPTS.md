# World Building Prompts

Ready-to-use prompts for common world-building tasks.

## Full World Implementation

### MongoDB World

```
Build a complete MongoDB World implementation for the Workflow DevKit.

Read the documentation in this repository:
- docs/02-interface-reference.md for the interface specifications
- docs/04-patterns-and-practices.md for critical patterns

Requirements:
- Use Mongoose for schema/models
- Use Agenda for job queue
- Use MongoDB Change Streams for real-time streaming
- Store all data in a single database with collections:
  - workflow_runs
  - workflow_steps
  - workflow_events
  - workflow_hooks
  - workflow_stream_chunks

Start from packages/starter/
Copy to packages/mongodb/

Run tests after each component to verify correctness.
```

### Redis World

```
Build a complete Redis World implementation for the Workflow DevKit.

Read the documentation in this repository:
- docs/02-interface-reference.md for the interface specifications
- docs/04-patterns-and-practices.md for critical patterns

Requirements:
- Use ioredis for Redis connection
- Use BullMQ for job queue
- Use Redis Streams for real-time streaming
- Store runs/steps/events/hooks as JSON in Redis
- Use Hash for run/step data
- Use Sorted Sets for event ordering

Start from packages/starter/
Copy to packages/redis/

Run tests after each component to verify correctness.
```

### DynamoDB World

```
Build a complete DynamoDB World implementation for the Workflow DevKit.

Read the documentation in this repository:
- docs/02-interface-reference.md for the interface specifications
- docs/04-patterns-and-practices.md for critical patterns

Requirements:
- Use AWS SDK v3
- Use SQS for job queue
- Tables:
  - WorkflowRuns (PK: runId)
  - WorkflowSteps (PK: runId, SK: stepId)
  - WorkflowEvents (PK: runId, SK: eventId) with GSI on correlationId
  - WorkflowHooks (PK: hookId) with GSI on token
  - WorkflowStreamChunks (PK: streamId, SK: chunkId)

Start from packages/starter/
Copy to packages/dynamodb/

Run tests after each component to verify correctness.
```

## Component-Specific Prompts

### Implement Storage Only

```
Implement the Storage interface for {BACKEND} in an existing World package.

Read docs/02-interface-reference.md for the Storage interface.
Read packages/starter/src/storage.ts for a working reference.

Requirements:
- Implement runs, steps, events, hooks namespaces
- Use ULID for ID generation with prefixes (wrun_, step_, evnt_, hook_)
- Handle pagination with cursor-based approach
- Support resolveData filtering
- Clean up hooks on run completion
- Use WorkflowAPIError from @workflow/errors with proper status codes (404, 409)

File to modify: src/storage.ts

Run tests after implementation: pnpm build && pnpm test
```

### Implement Queue Only

```
Implement the Queue interface for {BACKEND} in an existing World package.

Read docs/02-interface-reference.md for the Queue interface.
Read packages/starter/src/queue.ts for a working reference.

Requirements:
- Use @vercel/queue JsonTransport for message serialization
- Implement idempotency key handling (TTL-based, see docs/04-patterns-and-practices.md)
- Return 503 with timeoutSeconds for retry requests
- Handle concurrent message processing

File to modify: src/queue.ts

Run tests after implementation: pnpm build && pnpm test
```

### Implement Streamer Only

```
Implement the Streamer interface for {BACKEND} in an existing World package.

Read docs/02-interface-reference.md for the Streamer interface.
Read packages/starter/src/streamer.ts for a working reference.

Requirements:
- Use ULID for chunk ordering
- Support real-time notifications
- Handle startIndex for resumption
- Deduplicate chunks from historical and real-time sources
- Properly close stream on EOF

File to modify: src/streamer.ts

Run tests after implementation: pnpm build && pnpm test
```

## Debugging Prompts

### Fix Failing Tests

```
The @workflow/world-testing test suite is failing for my World implementation.

Failing test: {TEST_NAME}
Error message: {ERROR}

Reference the working implementation at:
- packages/starter/src/storage.ts
- packages/starter/src/queue.ts
- packages/starter/src/streamer.ts

Check docs/05-testing.md for common test issues and solutions.

Identify the issue and fix it.
```

### Debug Hook Resume

```
The hooks test is hanging in my World implementation.

The workflow creates a hook and waits for resume, but it never completes.

Debug steps:
1. Check that hooks.create stores the hook correctly
2. Check that hooks.getByToken returns the hook
3. Check that events.create is called with 'hook_received' type
4. Check that the queue message is processed after hook resume

Reference packages/starter/src/storage.ts for correct hook handling.
```

### Debug Event Replay

```
The idempotency test is failing - state reconstruction isn't deterministic.

This usually means events are not being returned in the correct order.

Check:
1. events.list returns events in ascending order (oldest first)
2. All step events (step_started, step_completed) are being stored
3. Correlation IDs match between related events
4. No events are being lost or duplicated

Reference packages/starter/src/storage.ts for correct event handling.
See docs/04-patterns-and-practices.md for the idempotency pattern.
```

## Review Prompts

### Code Review

```
Review my World implementation for correctness and best practices.

Files to review:
- src/index.ts
- src/storage.ts
- src/queue.ts
- src/streamer.ts

Check for:
- Correct ULID usage and prefixes
- Proper timestamp management (startedAt, completedAt)
- Hook cleanup on run completion
- Event ordering (ascending)
- Pagination correctness
- Error handling with WorkflowAPIError
- Connection pooling (if applicable)

Compare with patterns in:
- docs/04-patterns-and-practices.md
- packages/starter/src/
```

### Production Readiness

```
Review my World implementation for production readiness.

Use the checklist at:
- docs/06-production-checklist.md

Focus on:
- All tests passing
- Proper error handling with WorkflowAPIError
- Connection pooling
- Concurrency management
- Data cleanup strategy
- Monitoring hooks
- Documentation
```

## External References

For production-grade examples, reference these npm packages:
- `@workflow/world-postgres` - PostgreSQL reference implementation
- `@workflow/world` - TypeScript interfaces and types
- `@workflow/world-testing` - Test suite
- `@workflow/errors` - Error types (WorkflowAPIError, etc.)
