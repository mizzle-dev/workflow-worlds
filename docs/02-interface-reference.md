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

Manages workflow run records.

```typescript
runs: {
  create(data: CreateWorkflowRunRequest): Promise<WorkflowRun>;
  get(id: string, params?: GetWorkflowRunParams): Promise<WorkflowRun>;
  update(id: string, data: UpdateWorkflowRunRequest): Promise<WorkflowRun>;
  list(params?: ListWorkflowRunsParams): Promise<PaginatedResponse<WorkflowRun>>;
  cancel(id: string, params?: CancelWorkflowRunParams): Promise<WorkflowRun>;
  pause(id: string, params?: PauseWorkflowRunParams): Promise<WorkflowRun>;
  resume(id: string, params?: ResumeWorkflowRunParams): Promise<WorkflowRun>;
}
```

#### `runs.create()`

Creates a new workflow run.

**Parameters:**

```typescript
interface CreateWorkflowRunRequest {
  deploymentId: string;          // From getDeploymentId()
  workflowName: string;          // Name of the workflow function
  input: SerializedData[];       // Serialized function arguments
  executionContext?: SerializedData;  // Optional user context
}
```

**Returns:** A `WorkflowRun` with status `'pending'`

**Implementation notes:**
- Generate a ULID-based `runId` (e.g., `wrun_01HX...`)
- Set `createdAt` and `updatedAt` to current time
- Initialize `status` as `'pending'`

#### `runs.get()`

Retrieves a workflow run by ID.

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `id` | `string` | The run ID |
| `params.resolveData` | `'all' \| 'none'` | Whether to include input/output data |

**Returns:** The `WorkflowRun` or throws `WorkflowRunNotFoundError`

#### `runs.update()`

Updates a workflow run's state.

**Parameters:**

```typescript
interface UpdateWorkflowRunRequest {
  status?: WorkflowRunStatus;
  output?: SerializedData;
  error?: StructuredError;
  executionContext?: Record<string, any>;
}
```

**Implementation notes:**
- Set `startedAt` only the first time status becomes `'running'`
- Set `completedAt` when status becomes terminal (`'completed'`, `'failed'`, `'cancelled'`)
- Update `updatedAt` on every change
- Clean up associated hooks when transitioning to terminal status

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

#### `runs.cancel()`, `runs.pause()`, `runs.resume()`

Lifecycle methods that update status and return the updated run.

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
}

type WorkflowRunStatus = 'pending' | 'running' | 'completed' | 'failed' | 'paused' | 'cancelled';
```

---

### Storage.steps

Manages step execution records.

```typescript
steps: {
  create(runId: string, data: CreateStepRequest): Promise<Step>;
  get(runId: string | undefined, stepId: string, params?: GetStepParams): Promise<Step>;
  update(runId: string, stepId: string, data: UpdateStepRequest): Promise<Step>;
  list(params: ListWorkflowRunStepsParams): Promise<PaginatedResponse<Step>>;
}
```

#### `steps.create()`

Creates a new step execution record.

```typescript
interface CreateStepRequest {
  stepId: string;    // Unique step identifier
  stepName: string;  // Human-readable step name
  input: SerializedData;  // Step function arguments
}
```

**Returns:** A `Step` with status `'pending'` and `attempt: 0`

#### `steps.get()`

Retrieves a step by ID. Note that `runId` can be `undefined` - in this case, search across all runs to find the step.

#### `steps.update()`

Updates step state.

```typescript
interface UpdateStepRequest {
  attempt?: number;
  status?: StepStatus;
  output?: SerializedData;
  error?: StructuredError;
  retryAfter?: Date;  // For retryable errors
}
```

**Implementation notes:**
- Set `startedAt` only the first time status becomes `'running'`
- Set `completedAt` when status becomes `'completed'` or `'failed'`
- Track `attempt` count for retries

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

Manages the event log for workflow replay.

```typescript
events: {
  create(runId: string, data: CreateEventRequest, params?: CreateEventParams): Promise<Event>;
  list(params: ListEventsParams): Promise<PaginatedResponse<Event>>;
  listByCorrelationId(params: ListEventsByCorrelationIdParams): Promise<PaginatedResponse<Event>>;
}
```

#### `events.create()`

Creates a new event in the log.

```typescript
type CreateEventRequest =
  | { eventType: 'step_completed'; correlationId: string; eventData: { result: any } }
  | { eventType: 'step_failed'; correlationId: string; eventData: { error: any; stack?: string; fatal?: boolean } }
  | { eventType: 'step_started'; correlationId: string }
  | { eventType: 'step_retrying'; correlationId: string; eventData: { attempt: number } }
  | { eventType: 'hook_created'; correlationId: string }
  | { eventType: 'hook_received'; correlationId: string; eventData: { payload: any } }
  | { eventType: 'hook_disposed'; correlationId: string }
  | { eventType: 'wait_created'; correlationId: string; eventData: { resumeAt: Date } }
  | { eventType: 'wait_completed'; correlationId: string }
  | { eventType: 'workflow_started' }
  | { eventType: 'workflow_completed' }
  | { eventType: 'workflow_failed'; eventData: { error: any } };
```

**Implementation notes:**
- Generate a ULID-based `eventId` (e.g., `wevt_01HX...`)
- Store events in chronological order

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
  | 'step_completed' | 'step_failed' | 'step_retrying' | 'step_started'
  | 'hook_created' | 'hook_received' | 'hook_disposed'
  | 'wait_created' | 'wait_completed'
  | 'workflow_completed' | 'workflow_failed' | 'workflow_started';
```

---

### Storage.hooks

Manages webhook/callback registrations.

```typescript
hooks: {
  create(runId: string, data: CreateHookRequest, params?: GetHookParams): Promise<Hook>;
  get(hookId: string, params?: GetHookParams): Promise<Hook>;
  getByToken(token: string, params?: GetHookParams): Promise<Hook>;
  list(params: ListHooksParams): Promise<PaginatedResponse<Hook>>;
  dispose(hookId: string, params?: GetHookParams): Promise<Hook>;
}
```

#### `hooks.create()`

Creates a new hook registration.

```typescript
interface CreateHookRequest {
  hookId: string;               // Unique hook identifier
  token: string;                // Security token for resuming
  metadata?: SerializedData;    // User-provided metadata
}
```

**Implementation notes:**
- Enforce token uniqueness (one token per project)
- Set `ownerId`, `projectId`, `environment` based on your context

#### `hooks.getByToken()`

Retrieves a hook by its security token. Used when an external caller resumes a hook.

#### `hooks.dispose()`

Deletes a hook (called when hook is received or run completes).

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
