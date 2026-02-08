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

Manages workflow run records. **Read-only in event-sourced implementations** - all mutations happen through `storage.events.create()`.

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

### WorkflowRun Type

```typescript
interface WorkflowRun {
  runId: string;                 // e.g., "wrun_01HX..."
  status: WorkflowRunStatus;     // 'pending' | 'running' | 'completed' | 'failed' | 'paused' | 'cancelled'
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
  specVersion: number;           // Spec version for compatibility
}

type WorkflowRunStatus = 'pending' | 'running' | 'completed' | 'failed' | 'paused' | 'cancelled';
```

---

### Storage.steps

Manages step execution records. **Read-only in event-sourced implementations** - all mutations happen through `storage.events.create()`.

```typescript
steps: {
  get(runId: string | undefined, stepId: string, params?: GetStepParams): Promise<Step>;
  list(params: ListWorkflowRunStepsParams): Promise<PaginatedResponse<Step>>;
}
```

#### `steps.get()`

Retrieves a step by ID. Note that `runId` can be `undefined` - in this case, search across all runs to find the step.

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `runId` | `string \| undefined` | The run ID, or undefined to search all runs |
| `stepId` | `string` | The step ID |
| `params.resolveData` | `'all' \| 'none'` | Whether to include input/output data |

**Returns:** The `Step` or throws a 404 error

#### `steps.list()`

Lists steps for a specific workflow run.

**Parameters:**

```typescript
interface ListWorkflowRunStepsParams {
  runId: string;                 // Filter to specific run
  pagination?: PaginationOptions;
  resolveData?: ResolveData;
}
```

**Returns:** `PaginatedResponse<Step>`

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
  specVersion: number;          // Spec version for compatibility
}

type StepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
```

---

### Storage.events

Manages the event log for workflow replay. **This is the primary mutation interface** - all state changes flow through `events.create()`.

```typescript
events: {
  create(runId: string | null, data: AnyEventRequest, params?: CreateEventParams): Promise<EventResult>;
  list(params: ListEventsParams): Promise<PaginatedResponse<Event>>;
  listByCorrelationId(params: ListEventsByCorrelationIdParams): Promise<PaginatedResponse<Event>>;
}
```

#### `events.create()`

Creates a new event in the log. This is **the only way to mutate workflow state** in event-sourced implementations.

**Parameters:**

- `runId`: `string | null` - Run ID, or `null` for `run_created` events (runId is generated internally)
- `data`: Event request object with event-specific data
- `params.resolveData`: `'all' | 'none'` - Whether to include event data in response

**Event Types:**

**Run Lifecycle:**
```typescript
{ eventType: 'run_created'; eventData: { 
  deploymentId: string; 
  workflowName: string; 
  input: any[]; 
  executionContext?: Record<string, any>;
} }
{ eventType: 'run_started' }
{ eventType: 'run_completed'; eventData: { output: any } }
{ eventType: 'run_failed'; eventData: { error: any; stack?: string; errorCode?: string } }
{ eventType: 'run_cancelled' }
```

**Step Lifecycle:**
```typescript
{ eventType: 'step_created'; correlationId: string; eventData: { 
  stepName: string; 
  input: any[];
} }
{ eventType: 'step_started'; correlationId: string }
{ eventType: 'step_completed'; correlationId: string; eventData: { result: any } }
{ eventType: 'step_failed'; correlationId: string; eventData: { error: any; stack?: string } }
{ eventType: 'step_retrying'; correlationId: string; eventData: { 
  error: any; 
  stack?: string; 
  retryAfter: Date;
} }
```

**Hook/Wait Events:**
```typescript
{ eventType: 'hook_created'; correlationId: string; eventData: { 
  token: string; 
  metadata?: any;
} }
{ eventType: 'hook_received'; correlationId: string; eventData: { payload: any } }
{ eventType: 'hook_disposed'; correlationId: string }
{ eventType: 'wait_completed'; correlationId: string }
```

**Returns:** `EventResult` object containing:
- `event`: The created event (or conflict event for duplicate hooks)
- `run?`: Updated run state (if event affected run)
- `step?`: Updated step state (if event affected step)
- `hook?`: Created/updated hook (if event affected hook)

**Implementation notes:**
- Generate a ULID-based `eventId` (e.g., `wevt_01HX...`)
- For `run_created`, generate a new `runId` internally (runId parameter must be null)
- Validate terminal state transitions (can't modify completed/failed/cancelled runs)
- Store events in chronological order
- Handle idempotent `run_cancelled` on already-cancelled runs
- Support legacy run compatibility (only `run_cancelled`, `wait_completed`, `hook_received` allowed)

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
  correlationId?: string;       // Links related events (step ID, hook ID, etc.)
  eventData?: object;           // Event-specific data
  createdAt: Date;
  specVersion: number;          // Spec version for compatibility
}

type EventType =
  // Run lifecycle
  | 'run_created' | 'run_started' | 'run_completed' | 'run_failed' | 'run_cancelled'
  // Step lifecycle
  | 'step_created' | 'step_started' | 'step_completed' | 'step_failed' | 'step_retrying'
  // Hook/Wait events
  | 'hook_created' | 'hook_received' | 'hook_disposed' | 'hook_conflict'
  | 'wait_completed';
```

---

### Storage.hooks

Manages webhook/callback registrations. **Read-only in event-sourced implementations** - hook creation/disposal happens through `storage.events.create()`.

```typescript
hooks: {
  get(hookId: string, params?: GetHookParams): Promise<Hook>;
  getByToken(token: string, params?: GetHookParams): Promise<Hook>;
  list(params: ListHooksParams): Promise<PaginatedResponse<Hook>>;
}
```

#### `hooks.get()`

Retrieves a hook by its ID.

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `hookId` | `string` | The hook ID |
| `params.resolveData` | `'all' \| 'none'` | Whether to include metadata |

**Returns:** The `Hook` or throws a 404 error

#### `hooks.getByToken()`

Retrieves a hook by its security token. Used when an external caller resumes a hook.

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `token` | `string` | The unique security token |
| `params.resolveData` | `'all' \| 'none'` | Whether to include metadata |

**Returns:** The `Hook` or throws a 404 error

#### `hooks.list()`

Lists hooks with filtering.

**Parameters:**

```typescript
interface ListHooksParams {
  runId?: string;                // Filter to specific run
  pagination?: PaginationOptions;
  resolveData?: ResolveData;
}
```

**Returns:** `PaginatedResponse<Hook>`

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
  specVersion: number;          // Spec version for compatibility
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

### `listStreamsByRunId()`

Lists all stream names associated with a workflow run.

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `runId` | `string` | The workflow run ID |

**Returns:** `Promise<string[]>` - Array of stream names

**Implementation notes:**
- Track stream-to-run associations when `writeToStream()` or `closeStream()` are called
- Return empty array if run has no streams
- Added in Workflow 4.1 for better stream management

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
