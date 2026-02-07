# Production Checklist

A comprehensive checklist for ensuring your World implementation is production-ready.

> **Workflow 4.1 note:** treat direct `runs/steps/hooks` writes as adapter internals; runtime transitions should be validated through `storage.events.create(...)`.

## Core Functionality

### Storage

- [ ] **All CRUD operations work correctly**
  - Runs: create, get, update, list, cancel, pause, resume
  - Steps: create, get, update, list
  - Events: create, list, listByCorrelationId
  - Hooks: create, get, getByToken, list, dispose

- [ ] **Status transitions are correct**
  - `startedAt` set only once when status → `running`
  - `completedAt` set on terminal status (`completed`, `failed`, `cancelled`)
  - `updatedAt` updated on every change

- [ ] **Pagination works correctly**
  - Cursor-based pagination returns correct results
  - `hasMore` flag is accurate
  - Empty results return `hasMore: false`

- [ ] **Data resolution filtering works**
  - `resolveData: 'none'` returns empty `input: []` and `output: undefined`
  - `resolveData: 'all'` returns full data

### Queue

- [ ] **Messages are delivered reliably**
  - No message loss under normal conditions
  - Retries work when handler returns `{ timeoutSeconds }`

- [ ] **Idempotency keys prevent duplicates**
  - Same key returns same `messageId`
  - Duplicate processing is prevented

- [ ] **Queue handlers parse requests correctly**
  - Required headers validated
  - Message deserialization works
  - Error responses have correct status codes

### Streamer

- [ ] **Chunks are stored and retrieved in order**
  - ULID-based ordering maintains chronology
  - No chunks are lost or duplicated

- [ ] **Real-time notifications work**
  - New chunks are delivered to active readers
  - EOF closes the stream

- [ ] **Stream resumption works**
  - `startIndex` parameter skips earlier chunks
  - Deduplication prevents duplicate delivery

---

## Reliability

### Error Handling

- [ ] **All errors are properly caught and reported**
  - Storage errors don't crash the process
  - Queue errors are logged
  - Streaming errors close connections gracefully

- [ ] **StructuredError format is used**
  - Errors include `message`, optional `stack`, optional `code`
  - JSON serialization/deserialization works

- [ ] **Not-found errors throw appropriate exceptions**
  - `WorkflowRunNotFoundError` for missing runs
  - Clear error messages for missing steps/hooks

### Concurrency

- [ ] **Concurrent operations are safe**
  - Multiple workers can process different messages
  - Database operations use proper isolation

- [ ] **Rate limiting is implemented (if needed)**
  - Queue concurrency is bounded
  - Database connections are pooled

### Data Integrity

- [ ] **Hook cleanup on run completion**
  - All hooks disposed when run reaches terminal status
  - No orphaned hooks remain

- [ ] **Event ordering is preserved**
  - Events list returns chronological order
  - ULID ordering is consistent

---

## Performance

### Database

- [ ] **Queries are optimized**
  - Indexes on frequently queried columns:
    - `runs.status`
    - `runs.workflowName`
    - `events.runId`
    - `events.correlationId`
    - `steps.runId`
    - `hooks.runId`
    - `hooks.token`

- [ ] **Connection pooling is configured**
  - Pool size appropriate for workload
  - Idle timeout prevents connection leaks

- [ ] **Query patterns are efficient**
  - Cursor-based pagination (not offset)
  - Limited result sets (max 1000)

### Queue

- [ ] **Concurrency is tuned**
  - Worker count matches infrastructure capacity
  - Backpressure handling prevents overload

- [ ] **Message processing is efficient**
  - Serialization/deserialization is fast
  - No unnecessary database round-trips

### Streaming

- [ ] **Memory usage is bounded**
  - Chunks are streamed, not buffered entirely
  - Old chunks can be garbage collected

- [ ] **Real-time latency is acceptable**
  - Notification mechanism has low latency
  - No polling with long intervals

---

## Scalability

### Horizontal Scaling

- [ ] **Multiple instances can run concurrently**
  - Shared state is in database, not in-memory
  - Queue messages are distributed correctly

- [ ] **No single points of failure**
  - Database is replicated (if production-critical)
  - Queue backend is reliable

### Data Growth

- [ ] **Old data can be cleaned up**
  - Retention policies defined
  - Cleanup job implemented (or planned)

- [ ] **Storage costs are manageable**
  - Binary serialization (CBOR) for large payloads
  - Unnecessary data not stored

---

## Monitoring & Observability

### Logging

- [ ] **Key operations are logged**
  - Run creation/completion
  - Step execution
  - Errors and retries

- [ ] **Log levels are appropriate**
  - Debug: detailed operations
  - Info: normal operations
  - Error: failures

### Metrics (Optional but Recommended)

- [ ] **Queue metrics**
  - Messages queued/processed
  - Processing latency
  - Retry counts

- [ ] **Storage metrics**
  - Query latency
  - Active runs count
  - Error rates

### Tracing (Optional)

- [ ] **Distributed tracing supported**
  - `traceCarrier` propagated through queue
  - Spans created for key operations

---

## Security

### Data Protection

- [ ] **Sensitive data is protected**
  - Connection strings not logged
  - Hook tokens are unguessable (UUIDs or similar)

- [ ] **Input validation is performed**
  - Zod schemas validate incoming data
  - SQL injection prevented (parameterized queries)

### Access Control

- [ ] **Hook tokens provide isolation**
  - Tokens are unique per hook
  - `getByToken` only returns matching hook

- [ ] **Owner/project isolation (if multi-tenant)**
  - Queries filter by ownerId/projectId
  - Cross-tenant access prevented

---

## Deployment

### Configuration

- [ ] **Environment variables documented**
  - Connection strings
  - Queue configuration
  - Concurrency settings

- [ ] **Sensible defaults provided**
  - Works out of box for development
  - Production requires explicit configuration

### Migrations

- [ ] **Database migrations are versioned**
  - Migration files track schema changes
  - Rollback strategy defined

- [ ] **Migration tool is included**
  - CLI command or setup script
  - Clear documentation

### Health Checks

- [ ] **Health endpoint available (if server-based)**
  - Database connectivity check
  - Queue connectivity check

---

## Testing

- [ ] **All `@workflow/world-testing` tests pass**
  - addition
  - idempotency
  - hooks
  - errors
  - nullByte

- [ ] **CI pipeline configured**
  - Tests run on every PR
  - Database containers for integration tests

- [ ] **Edge cases tested**
  - Empty inputs
  - Large payloads
  - Special characters

---

## Documentation

- [ ] **README includes**
  - Installation instructions
  - Configuration options
  - Quick start example

- [ ] **API is documented**
  - Configuration interface
  - Exported functions
  - Error types

---

## Final Checks

Before releasing:

- [ ] Version number updated
- [ ] Changelog written
- [ ] Package published (or ready to publish)
- [ ] Integration tested with real workflows
- [ ] Performance benchmarked under expected load

---

## Example Production Configuration

```typescript
import { createWorld } from '@workflow/world-mybackend';

const world = createWorld({
  connectionString: process.env.DATABASE_URL,
  poolSize: 20,
  queueConcurrency: 10,
  retentionDays: 30,
});

// Start background workers
await world.start?.();

// Graceful shutdown
process.on('SIGTERM', async () => {
  await world.stop?.();
  process.exit(0);
});
```
