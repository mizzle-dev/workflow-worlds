# Interface Reference

Complete API documentation for the World interface and all its components.

> **Source:** All TypeScript interfaces are exported from the `@workflow/world` npm package.
> Install with `npm install @workflow/world` to get type definitions.
>
> **Workflow 4.1 note:** Runtime writes are event-sourced through `storage.events.create(...)`.
> For migration guidance and legacy-run behavior, see [07 - Workflow 4.1 Migration Guide](./07-workflow-4.1-migration.md).

## World Interface

```typescript
// From @workflow/world

export interface World extends Queue, Storage, Streamer {
  /**
   * Optional method called to start background tasks.
   * Use this to start queue workers, cleanup jobs, etc.
   * Not needed for serverless environments.
   */
  start?(): Promise<void>;
}
```

---

## Queue Interface

```typescript
// From @workflow/world

export interface Queue {
  getDeploymentId(): Promise<string>;

  queue(
    queueName: ValidQueueName,
    message: QueuePayload,
    opts?: {
      deploymentId?: string;
      idempotencyKey?: string;
    }
  ): Promise<{ messageId: MessageId }>;

  createQueueHandler(
    queueNamePrefix: QueuePrefix,
    handler: (
      message: unknown,
      meta: { attempt: number; queueName: ValidQueueName; messageId: MessageId }
    ) => Promise<void | { timeoutSeconds: number }>
  ): (req: Request) => Promise<Response>;
}
```

### `getDeploymentId()`

Returns a unique identifier for the current deployment.

**Returns:** `Promise<string>` - Deployment ID (e.g., `"dpl_abc123"` or `"dpl_embedded"`)

**Usage:** Used to track which deployment started a workflow run.

### `queue()`

Enqueues a message for processing by a workflow or step handler.

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `queueName` | `ValidQueueName` | Queue name with prefix (`__wkf_workflow_*` or `__wkf_step_*`) |
| `message` | `QueuePayload` | The message payload (workflow or step invocation) |
| `opts.deploymentId` | `string?` | Optional target deployment |
| `opts.idempotencyKey` | `string?` | Key to prevent duplicate processing |

**Returns:** `Promise<{ messageId: MessageId }>` - Unique message identifier

**Notes:**
- Idempotency keys should prevent duplicate messages with the same key
- Messages should be processed asynchronously (don't block on execution)

### `createQueueHandler()`

Creates an HTTP request handler for processing queued messages.

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `queueNamePrefix` | `QueuePrefix` | Either `'__wkf_step_'` or `'__wkf_workflow_'` |
| `handler` | `Function` | The message handler function |

The handler function receives:
- `message`: The deserialized message payload
- `meta.attempt`: Current attempt number (1-indexed)
- `meta.queueName`: Full queue name
- `meta.messageId`: Unique message ID

The handler returns:
- `void` - Success, message is acknowledged
- `{ timeoutSeconds: number }` - Retry after specified delay

**Returns:** `(req: Request) => Promise<Response>` - HTTP handler function

### Queue Types

```typescript
// Queue name prefixes
export type QueuePrefix = '__wkf_step_' | '__wkf_workflow_';

// Valid queue name (prefix + workflow/step name)
export type ValidQueueName = `${QueuePrefix}${string}`;

// Message ID (branded string)
export type MessageId = string & { __brand: 'MessageId' };

// Workflow invocation payload
export interface WorkflowInvokePayload {
  runId: string;
  traceCarrier?: Record<string, string>;  // OpenTelemetry context
}

// Step invocation payload
export interface StepInvokePayload {
  workflowName: string;
  workflowRunId: string;
  workflowStartedAt: number;  // Timestamp
  stepId: string;
  traceCarrier?: Record<string, string>;
}

// Union of both payload types
export type QueuePayload = WorkflowInvokePayload | StepInvokePayload;
```

---

## Storage Interface

```typescript
// From @workflow/world

export interface Storage {
  runs: { /* ... */ };
  steps: { /* ... */ };
  events: { /* ... */ };
  hooks: { /* ... */ };
}
```

### Storage.runs

Read-only run materialized view.

```typescript
runs: {
  get(id: string, params?: GetWorkflowRunParams): Promise<WorkflowRun>;
  list(params?: ListWorkflowRunsParams): Promise<PaginatedResponse<WorkflowRun>>;
}
```

#### `runs.get()`

Retrieves a workflow run by ID.

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `id` | `string` | The run ID |
| `params.resolveData` | `'all' \| 'none'` | Whether to include input/output data |

**Returns:** The `WorkflowRun` or throws `WorkflowRunNotFoundError`

#### `runs.list()`

Lists workflow runs with filtering and pagination.

**Parameters:**

```typescript
interface ListWorkflowRunsParams {
  workflowName?: string;         // Filter by workflow name
  status?: WorkflowRunStatus;    // Filter by status
  pagination?: PaginationOptions;
  resolveData?: ResolveData;
}
```

**Returns:** `PaginatedResponse<WorkflowRun>`

`runs` does not expose mutators in Workflow 4.1. State changes are applied through `events.create(...)`.

### WorkflowRun Type

```typescript
interface WorkflowRun {
  runId: string;                 // e.g., "wrun_01HX..."
  status: WorkflowRunStatus;     // 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'
  deploymentId: string;
  workflowName: string;
  input: any[];                  // Function arguments
  output?: any;                  // Return value (if completed)
  error?: StructuredError;       // Error details (if failed)
  executionContext?: Record<string, any>;
  startedAt?: Date;              // First transition to 'running'
  completedAt?: Date;            // Transition to terminal status
  createdAt: Date;
  updatedAt: Date;
}

type WorkflowRunStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
```

---

### Storage.steps

Read-only step materialized view.

```typescript
steps: {
  get(runId: string | undefined, stepId: string, params?: GetStepParams): Promise<Step>;
  list(params: ListWorkflowRunStepsParams): Promise<PaginatedResponse<Step>>;
}
```

#### `steps.get()`

Retrieves a step by ID. Note that `runId` can be `undefined` - in this case, search across all runs to find the step.

`steps` does not expose mutators in Workflow 4.1. Step lifecycle updates are driven by `events.create(...)`.

### Step Type

```typescript
interface Step {
  runId: string;
  stepId: string;
  stepName: string;
  status: StepStatus;           // 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'
  input: any[];
  output?: any;
  error?: StructuredError;
  attempt: number;              // Current attempt (0 = first try)
  startedAt?: Date;
  completedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
  retryAfter?: Date;            // When to retry (for retryable errors)
}

type StepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
```

---

### Storage.events

Manages the append-only event log and all state mutations.

```typescript
events: {
  create(runId: null, data: RunCreatedEventRequest, params?: CreateEventParams): Promise<EventResult>;
  create(runId: string, data: CreateEventRequest, params?: CreateEventParams): Promise<EventResult>;
  list(params: ListEventsParams): Promise<PaginatedResponse<Event>>;
  listByCorrelationId(params: ListEventsByCorrelationIdParams): Promise<PaginatedResponse<Event>>;
}
```

#### `events.create()`

Creates an event and atomically applies the corresponding run/step/hook state transition.

```typescript
type CreateEventRequest =
  | { eventType: 'run_started' }
  | { eventType: 'run_completed'; eventData: { output?: any } }
  | { eventType: 'run_failed'; eventData: { error: any; errorCode?: string } }
  | { eventType: 'run_cancelled' }
  | { eventType: 'step_created'; correlationId: string; eventData: { stepName: string; input: any } }
  | { eventType: 'step_completed'; correlationId: string; eventData: { result: any } }
  | { eventType: 'step_failed'; correlationId: string; eventData: { error: any; stack?: string } }
  | { eventType: 'step_started'; correlationId: string; eventData?: { attempt?: number } }
  | { eventType: 'step_retrying'; correlationId: string; eventData: { error: any; stack?: string; retryAfter?: Date } }
  | { eventType: 'hook_created'; correlationId: string; eventData: { token: string; metadata?: any } }
  | { eventType: 'hook_received'; correlationId: string; eventData: { payload: any } }
  | { eventType: 'hook_disposed'; correlationId: string }
  | { eventType: 'wait_created'; correlationId: string; eventData: { resumeAt: Date } }
  | { eventType: 'wait_completed'; correlationId: string };

type RunCreatedEventRequest = {
  eventType: 'run_created';
  eventData: {
    deploymentId: string;
    workflowName: string;
    input: any;
    executionContext?: Record<string, any>;
  };
};
```

**Implementation notes:**
- `run_created` must be called with `runId = null`; world generates runId
- World may return `hook_conflict` event for duplicate hook tokens
- Legacy runs may return `event: undefined` for `run_cancelled`

#### `events.list()`

Lists events for a specific run.

```typescript
interface ListEventsParams {
  runId: string;
  pagination?: PaginationOptions;
  resolveData?: ResolveData;
}
```

**Note:** Default sort order should be `'asc'` (oldest first) for proper replay.

#### `events.listByCorrelationId()`

Lists events with a specific correlation ID (e.g., all events for a step).

### Event Type

```typescript
interface Event {
  runId: string;
  eventId: string;              // e.g., "wevt_01HX..."
  eventType: EventType;
  correlationId?: string;       // Links related events
  eventData?: object;           // Event-specific data
  createdAt: Date;
}

type EventType =
  | 'run_created' | 'run_started' | 'run_completed' | 'run_failed' | 'run_cancelled'
  | 'step_created' | 'step_completed' | 'step_failed' | 'step_retrying' | 'step_started'
  | 'hook_created' | 'hook_received' | 'hook_disposed'
  | 'wait_created' | 'wait_completed'
  | 'hook_conflict';
```

---

### Storage.hooks

Read-only hook materialized view.

```typescript
hooks: {
  get(hookId: string, params?: GetHookParams): Promise<Hook>;
  getByToken(token: string, params?: GetHookParams): Promise<Hook>;
  list(params: ListHooksParams): Promise<PaginatedResponse<Hook>>;
}
```

#### `hooks.getByToken()`

Retrieves a hook by its security token. Used when an external caller resumes a hook.

`hooks` creation/disposal is performed via `events.create(hook_created|hook_disposed|hook_received)`.

### Hook Type

```typescript
interface Hook {
  runId: string;
  hookId: string;
  token: string;                // Unique security token
  ownerId: string;              // User/owner identifier
  projectId: string;            // Project identifier
  environment: string;          // Environment (e.g., "production")
  metadata?: any;
  createdAt: Date;
}
```

---

## Streamer Interface

```typescript
// From @workflow/world

export interface Streamer {
  writeToStream(
    name: string,
    runId: string | Promise<string>,
    chunk: string | Uint8Array
  ): Promise<void>;

  closeStream(
    name: string,
    runId: string | Promise<string>
  ): Promise<void>;

  readFromStream(
    name: string,
    startIndex?: number
  ): Promise<ReadableStream<Uint8Array>>;

  listStreamsByRunId(runId: string): Promise<string[]>;
}
```

### `writeToStream()`

Writes a chunk of data to a named stream.

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `name` | `string` | Stream identifier |
| `runId` | `string \| Promise<string>` | Associated run ID (may be a promise) |
| `chunk` | `string \| Uint8Array` | Data to write |

**Implementation notes:**
- Await `runId` if it's a promise before writing
- Generate ULID for chunk ordering
- Emit real-time notifications if supported

### `closeStream()`

Signals the end of a stream.

**Implementation notes:**
- Write an EOF marker
- Notify readers that stream is complete

### `readFromStream()`

Returns a `ReadableStream` for consuming stream data.

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `name` | `string` | Stream identifier |
| `startIndex` | `number?` | Resume from this chunk index |

**Returns:** `Promise<ReadableStream<Uint8Array>>`

**Implementation notes:**
- Load existing chunks from storage
- Subscribe to real-time notifications for new chunks
- Deduplicate chunks that arrive via both mechanisms
- Close stream when EOF marker is received

---

## Shared Types

### PaginationOptions

```typescript
interface PaginationOptions {
  limit?: number;              // Max items (default varies, max 1000)
  cursor?: string;             // Cursor from previous response
  sortOrder?: 'asc' | 'desc';  // Sort direction
}
```

### PaginatedResponse

```typescript
interface PaginatedResponse<T> {
  data: T[];                   // Items for this page
  cursor: string | null;       // Cursor for next page (null if no more)
  hasMore: boolean;            // Whether more pages exist
}
```

### ResolveData

```typescript
type ResolveData = 'none' | 'all';
```

- `'all'` - Include full input/output data
- `'none'` - Omit input/output (return `[]` and `undefined`)

### StructuredError

```typescript
interface StructuredError {
  message: string;
  stack?: string;
  code?: string;
}
```

---

## Next Steps

Continue to [03 - Implementation Guide](./03-implementation-guide.md) for a step-by-step tutorial on building each component.
