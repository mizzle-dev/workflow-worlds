# Introduction to Worlds

> **Workflow 4.1 note:** Runtime state transitions are event-sourced through `storage.events.create(...)`. See [07 - Workflow 4.1 Migration Guide](./07-workflow-4.1-migration.md) for upgrade-specific behavior.

## What is a World?

A **World** is the interface that abstracts how workflows communicate with the outside world. It provides three core capabilities:

1. **Storage** - Persisting workflow state (runs, steps, events, hooks)
2. **Queue** - Message passing for workflow and step invocations
3. **Streamer** - Real-time streaming I/O

The World interface allows the workflow runtime to be infrastructure-agnostic. Whether you're running on PostgreSQL, MongoDB, Redis, or a cloud platform like Vercel, the runtime code remains the same - only the World implementation changes.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                      Workflow Runtime                           │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────┐  │
│  │  Workflow   │  │    Step     │  │   Hook/Wait Handling    │  │
│  │  Executor   │  │  Executor   │  │                         │  │
│  └──────┬──────┘  └──────┬──────┘  └────────────┬────────────┘  │
│         │                │                      │               │
│         └────────────────┼──────────────────────┘               │
│                          │                                      │
│                          ▼                                      │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │                      World Interface                      │  │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────────┐    │  │
│  │  │   Storage   │  │    Queue    │  │    Streamer     │    │  │
│  │  │             │  │             │  │                 │    │  │
│  │  │ • runs      │  │ • queue()   │  │ • writeToStream │    │  │
│  │  │ • steps     │  │ • handler   │  │ • closeStream   │    │  │
│  │  │ • events    │  │ • deployId  │  │ • readFromStream│    │  │
│  │  │ • hooks     │  │             │  │                 │    │  │
│  │  └─────────────┘  └─────────────┘  └─────────────────┘    │  │
│  └───────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Your Implementation                          │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │  MongoDB / PostgreSQL / Redis / DynamoDB / Cloud Services   ││
│  └─────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────┘
```

## The World Interface

The World interface is defined in `@workflow/world` and combines three sub-interfaces:

```typescript
export interface World extends Queue, Storage, Streamer {
  /**
   * Optional: Called to start background tasks (e.g., queue workers).
   * Not needed for serverless environments where work is triggered by HTTP.
   */
  start?(): Promise<void>;
}
```

### Storage Interface

Storage manages the persistence of workflow data across four namespaces:

| Namespace | Purpose |
|-----------|---------|
| `runs` | Workflow execution instances with status, input/output, timing |
| `steps` | Individual step executions with retry tracking |
| `events` | Event log for replay (step results, hook activity, waits) |
| `hooks` | Webhook/callback registrations for external integrations |

### Queue Interface

The Queue handles asynchronous message passing:

| Method | Purpose |
|--------|---------|
| `getDeploymentId()` | Returns unique deployment identifier |
| `queue()` | Enqueues messages for workflow/step execution |
| `createQueueHandler()` | Creates HTTP handlers for processing queued messages |

### Streamer Interface

The Streamer provides real-time I/O:

| Method | Purpose |
|--------|---------|
| `writeToStream()` | Writes a chunk to a named stream |
| `closeStream()` | Signals end of stream |
| `readFromStream()` | Returns a ReadableStream for consuming output |

## Execution Flow

Understanding the execution flow helps you implement a World correctly:

### 1. Workflow Invocation

```
Client → start() API → World.runs.create() → World.queue() → Queue Handler
```

1. Client calls `start()` to begin a workflow
2. Runtime creates a run record via `storage.runs.create()`
3. Runtime queues a workflow invocation message
4. Queue handler picks up the message and executes the workflow

### 2. Step Execution

```
Workflow → step() call → World.steps.create() → World.events.create() → World.queue()
```

1. Workflow calls a step function
2. Runtime creates a step record via `storage.steps.create()`
3. Runtime logs a `step_started` event
4. Runtime queues a step invocation message
5. Step handler executes and updates step status

### 3. Replay/Recovery

```
Cold Start → World.events.list() → Deterministic Replay → Resume Execution
```

1. After restart or scaling, workflow resumes from a queue message
2. Runtime fetches all events for the run via `storage.events.list()`
3. Workflow code replays deterministically using cached results
4. Execution continues from where it left off

## Existing Implementations Compared

| Feature | world-local | world-postgres | world-vercel |
|---------|-------------|----------------|--------------|
| **Storage** | Filesystem (JSON) | PostgreSQL + Drizzle ORM | Vercel KV/API |
| **Queue** | In-process HTTP | pgboss (PostgreSQL) | Vercel Queue |
| **Streamer** | Filesystem + EventEmitter | PostgreSQL LISTEN/NOTIFY | Vercel Streaming |
| **Serialization** | JSON | CBOR (binary) | Platform-specific |
| **Multi-process** | No | Yes | Yes |
| **Use Case** | Local development | Self-hosted production | Vercel platform |

### world-local

The simplest implementation using filesystem for storage and in-process HTTP for queuing:

- Stores data as JSON files in `.workflow-data/`
- Queue uses `fetch()` to localhost with semaphore-based concurrency
- Streamer uses `EventEmitter` for real-time notifications
- Single-process only (no shared state between processes)

### world-postgres

Production-ready implementation using PostgreSQL:

- Uses Drizzle ORM with 5 tables (runs, steps, events, hooks, stream_chunks)
- Queue via pgboss with configurable concurrency
- Streaming via PostgreSQL LISTEN/NOTIFY
- CBOR binary serialization for efficiency
- Supports multiple workers/processes

### world-vercel

Optimized for Vercel's serverless platform:

- Integrates with Vercel's queue infrastructure
- Uses platform-specific storage and streaming APIs
- Handles serverless cold starts efficiently
- No `start()` method needed (serverless model)

## Key Concepts

### ULID-based IDs

All implementations use ULIDs (Universally Unique Lexicographically Sortable Identifiers) with prefixes:

- `wrun_` - Workflow runs
- `wstep_` or `step_` - Steps
- `wevt_` or `evnt_` - Events
- `whook_` - Hooks
- `msg_` - Queue messages
- `strm_` or `chnk_` - Stream chunks

ULIDs provide:
- Chronological sorting (embedded timestamp)
- No coordination required (unlike auto-increment)
- URL-safe characters

### Status State Machines

**Workflow Run Status:**
```
pending → running → completed
                  → failed
                  → cancelled
         → paused → running (resume)
```

**Step Status:**
```
pending → running → completed
                  → failed
                  → cancelled
```

### Event Sourcing

The events table is the source of truth for replay. Event types include:

- `step_started` / `step_completed` / `step_failed` / `step_retrying`
- `hook_created` / `hook_received` / `hook_disposed`
- `wait_created` / `wait_completed`
- `workflow_started` / `workflow_completed` / `workflow_failed`

### Correlation IDs

Events use correlation IDs to link related events (e.g., a `step_started` and its corresponding `step_completed` share the same correlation ID). This enables efficient querying for specific step or hook lifecycle events.

## Next Steps

Continue to [02 - Interface Reference](./02-interface-reference.md) for complete API documentation.
