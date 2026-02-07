# Implementation Guide

A step-by-step tutorial for building a custom World implementation.

> **Workflow 4.1 note:** New write paths should be centered in `storage.events.create(...)` with read/list methods on `runs`, `steps`, and `hooks`. See [07 - Workflow 4.1 Migration Guide](./07-workflow-4.1-migration.md) for the migration strategy.

## Project Setup

### 1. Package Structure

Create a new package with this structure:

```
packages/world-mybackend/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts        # Main entry point
│   ├── storage.ts      # Storage implementation
│   ├── queue.ts        # Queue implementation
│   └── streamer.ts     # Streamer implementation
└── test/
    └── spec.test.ts    # Test suite
```

### 2. package.json

```json
{
  "name": "@workflow/world-mybackend",
  "version": "1.0.0",
  "type": "module",
  "main": "dist/index.js",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    }
  },
  "scripts": {
    "build": "tsc",
    "dev": "tsc --watch",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@vercel/queue": "catalog:",
    "@workflow/world": "workspace:*",
    "ulid": "3.0.1",
    "zod": "catalog:"
  },
  "devDependencies": {
    "@types/node": "catalog:",
    "@workflow/errors": "workspace:*",
    "@workflow/tsconfig": "workspace:*",
    "@workflow/world-testing": "workspace:*",
    "vitest": "catalog:"
  }
}
```

### 3. tsconfig.json

```json
{
  "extends": "@workflow/tsconfig/base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src/**/*"]
}
```

### 4. Main Entry Point (src/index.ts)

```typescript
import type { World } from '@workflow/world';
import { createQueue } from './queue.js';
import { createStorage } from './storage.js';
import { createStreamer } from './streamer.js';

export interface MyBackendConfig {
  // Your configuration options
  connectionString?: string;
}

export function createWorld(config: MyBackendConfig = {}): World {
  const storage = createStorage(config);
  const queue = createQueue(config);
  const streamer = createStreamer(config);

  return {
    ...storage,
    ...queue,
    ...streamer,
    // Optional: start background workers
    async start() {
      // Start queue workers, cleanup jobs, etc.
    },
  };
}

// Default export for WORKFLOW_TARGET_WORLD
// The runtime will import and call this function.
export default createWorld;
```

---

## Implementing Storage

Storage is the largest component. Start with `runs`, then add `steps`, `events`, and `hooks`.

> **⚠️ Important for In-Memory Storage**: The workflow core mutates objects returned from storage. If using Maps for in-memory storage, you **must** deep clone all returned data using `structuredClone()`. See [Deep Cloning for In-Memory Storage](./04-patterns-and-practices.md#deep-cloning-for-in-memory-storage) for details.

### Storage Structure

```typescript
// src/storage.ts
import type { Storage } from '@workflow/world';
import { monotonicFactory } from 'ulid';

const generateUlid = monotonicFactory();

export function createStorage(config: MyBackendConfig): Storage {
  return {
    runs: createRunsStorage(config),
    steps: createStepsStorage(config),
    events: createEventsStorage(config),
    hooks: createHooksStorage(config),
  };
}
```

### Implementing Runs Storage

```typescript
function createRunsStorage(config: MyBackendConfig): Storage['runs'] {
  // TODO: Replace with your database connection
  const runs = new Map<string, WorkflowRun>();

  return {
    async create(data) {
      const runId = `wrun_${generateUlid()}`;
      const now = new Date();

      const run: WorkflowRun = {
        runId,
        deploymentId: data.deploymentId,
        status: 'pending',
        workflowName: data.workflowName,
        input: data.input as any[],
        output: undefined,
        error: undefined,
        executionContext: data.executionContext as Record<string, any> | undefined,
        startedAt: undefined,
        completedAt: undefined,
        createdAt: now,
        updatedAt: now,
      };

      // TODO: Insert into your database
      runs.set(runId, run);
      return run;
    },

    async get(id, params) {
      // TODO: Query your database
      const run = runs.get(id);
      if (!run) {
        throw new WorkflowRunNotFoundError(id);
      }

      // Apply resolveData filtering
      if (params?.resolveData === 'none') {
        return { ...run, input: [], output: undefined };
      }
      return run;
    },

    async update(id, data) {
      const existing = runs.get(id);
      if (!existing) {
        throw new WorkflowRunNotFoundError(id);
      }

      const now = new Date();
      const updated: WorkflowRun = {
        ...existing,
        ...data,
        updatedAt: now,
      };

      // Set startedAt only once when transitioning to 'running'
      if (data.status === 'running' && !updated.startedAt) {
        updated.startedAt = now;
      }

      // Set completedAt on terminal states
      const isTerminal = data.status === 'completed' ||
                         data.status === 'failed' ||
                         data.status === 'cancelled';
      if (isTerminal) {
        updated.completedAt = now;
        // TODO: Clean up hooks for this run
      }

      // TODO: Update in your database
      runs.set(id, updated);
      return updated;
    },

    async list(params) {
      // TODO: Query your database with filters
      let results = Array.from(runs.values());

      // Apply filters
      if (params?.workflowName) {
        results = results.filter(r => r.workflowName === params.workflowName);
      }
      if (params?.status) {
        results = results.filter(r => r.status === params.status);
      }

      // Sort by ULID (chronological) - default descending
      const sortOrder = params?.pagination?.sortOrder ?? 'desc';
      results.sort((a, b) => {
        const cmp = a.runId.localeCompare(b.runId);
        return sortOrder === 'desc' ? -cmp : cmp;
      });

      // Apply pagination
      const limit = params?.pagination?.limit ?? 100;
      const cursor = params?.pagination?.cursor;

      if (cursor) {
        const cursorIndex = results.findIndex(r => r.runId === cursor);
        if (cursorIndex !== -1) {
          results = results.slice(cursorIndex + 1);
        }
      }

      const hasMore = results.length > limit;
      const data = results.slice(0, limit);
      const nextCursor = hasMore ? data[data.length - 1].runId : null;

      // Apply resolveData filtering
      if (params?.resolveData === 'none') {
        return {
          data: data.map(r => ({ ...r, input: [], output: undefined })),
          cursor: nextCursor,
          hasMore,
        };
      }

      return { data, cursor: nextCursor, hasMore };
    },

    async cancel(id, params) {
      const run = await this.update(id, { status: 'cancelled' });
      if (params?.resolveData === 'none') {
        return { ...run, input: [], output: undefined };
      }
      return run;
    },

    async pause(id, params) {
      const run = await this.update(id, { status: 'paused' });
      if (params?.resolveData === 'none') {
        return { ...run, input: [], output: undefined };
      }
      return run;
    },

    async resume(id, params) {
      const run = await this.update(id, { status: 'running' });
      if (params?.resolveData === 'none') {
        return { ...run, input: [], output: undefined };
      }
      return run;
    },
  };
}
```

### Implementing Steps Storage

```typescript
function createStepsStorage(config: MyBackendConfig): Storage['steps'] {
  const steps = new Map<string, Step>();

  // Helper to create composite key
  const key = (runId: string, stepId: string) => `${runId}-${stepId}`;

  return {
    async create(runId, data) {
      const now = new Date();
      const step: Step = {
        runId,
        stepId: data.stepId,
        stepName: data.stepName,
        status: 'pending',
        input: data.input as any[],
        output: undefined,
        error: undefined,
        attempt: 0,
        startedAt: undefined,
        completedAt: undefined,
        createdAt: now,
        updatedAt: now,
      };

      steps.set(key(runId, data.stepId), step);
      return step;
    },

    async get(runId, stepId, params) {
      // If runId is undefined, search all steps
      if (!runId) {
        for (const step of steps.values()) {
          if (step.stepId === stepId) {
            if (params?.resolveData === 'none') {
              return { ...step, input: [], output: undefined };
            }
            return step;
          }
        }
        throw new Error(`Step ${stepId} not found`);
      }

      const step = steps.get(key(runId, stepId));
      if (!step) {
        throw new Error(`Step ${stepId} in run ${runId} not found`);
      }

      if (params?.resolveData === 'none') {
        return { ...step, input: [], output: undefined };
      }
      return step;
    },

    async update(runId, stepId, data) {
      const existing = steps.get(key(runId, stepId));
      if (!existing) {
        throw new Error(`Step ${stepId} in run ${runId} not found`);
      }

      const now = new Date();
      const updated: Step = {
        ...existing,
        ...data,
        updatedAt: now,
      };

      if (data.status === 'running' && !updated.startedAt) {
        updated.startedAt = now;
      }
      if (data.status === 'completed' || data.status === 'failed') {
        updated.completedAt = now;
      }

      steps.set(key(runId, stepId), updated);
      return updated;
    },

    async list(params) {
      let results = Array.from(steps.values())
        .filter(s => s.runId === params.runId);

      const sortOrder = params.pagination?.sortOrder ?? 'desc';
      results.sort((a, b) => {
        const cmp = a.createdAt.getTime() - b.createdAt.getTime();
        return sortOrder === 'desc' ? -cmp : cmp;
      });

      const limit = params.pagination?.limit ?? 100;
      const hasMore = results.length > limit;
      const data = results.slice(0, limit);
      const nextCursor = hasMore ? data[data.length - 1].stepId : null;

      if (params.resolveData === 'none') {
        return {
          data: data.map(s => ({ ...s, input: [], output: undefined })),
          cursor: nextCursor,
          hasMore,
        };
      }

      return { data, cursor: nextCursor, hasMore };
    },
  };
}
```

### Implementing Events Storage

```typescript
function createEventsStorage(config: MyBackendConfig): Storage['events'] {
  const events = new Map<string, Event>();

  return {
    async create(runId, data, params) {
      const eventId = `wevt_${generateUlid()}`;
      const now = new Date();

      const event: Event = {
        ...data,
        runId,
        eventId,
        createdAt: now,
      };

      events.set(eventId, event);

      if (params?.resolveData === 'none') {
        const { eventData, ...rest } = event as any;
        return rest;
      }
      return event;
    },

    async list(params) {
      let results = Array.from(events.values())
        .filter(e => e.runId === params.runId);

      // Events default to ascending order (oldest first) for replay
      const sortOrder = params.pagination?.sortOrder ?? 'asc';
      results.sort((a, b) => {
        const cmp = a.eventId.localeCompare(b.eventId);
        return sortOrder === 'asc' ? cmp : -cmp;
      });

      const limit = params.pagination?.limit ?? 100;
      const hasMore = results.length > limit;
      const data = results.slice(0, limit);
      const nextCursor = hasMore ? data[data.length - 1].eventId : null;

      if (params.resolveData === 'none') {
        return {
          data: data.map(e => {
            const { eventData, ...rest } = e as any;
            return rest;
          }),
          cursor: nextCursor,
          hasMore,
        };
      }

      return { data, cursor: nextCursor, hasMore };
    },

    async listByCorrelationId(params) {
      let results = Array.from(events.values())
        .filter(e => e.correlationId === params.correlationId);

      const sortOrder = params.pagination?.sortOrder ?? 'asc';
      results.sort((a, b) => {
        const cmp = a.eventId.localeCompare(b.eventId);
        return sortOrder === 'asc' ? cmp : -cmp;
      });

      const limit = params.pagination?.limit ?? 100;
      const hasMore = results.length > limit;
      const data = results.slice(0, limit);
      const nextCursor = hasMore ? data[data.length - 1].eventId : null;

      if (params.resolveData === 'none') {
        return {
          data: data.map(e => {
            const { eventData, ...rest } = e as any;
            return rest;
          }),
          cursor: nextCursor,
          hasMore,
        };
      }

      return { data, cursor: nextCursor, hasMore };
    },
  };
}
```

### Implementing Hooks Storage

```typescript
function createHooksStorage(config: MyBackendConfig): Storage['hooks'] {
  const hooks = new Map<string, Hook>();

  return {
    async create(runId, data, params) {
      // Check for token uniqueness
      for (const hook of hooks.values()) {
        if (hook.token === data.token) {
          throw new Error(`Hook with token ${data.token} already exists`);
        }
      }

      const now = new Date();
      const hook: Hook = {
        runId,
        hookId: data.hookId,
        token: data.token,
        metadata: data.metadata,
        ownerId: 'default-owner',      // TODO: Get from context
        projectId: 'default-project',  // TODO: Get from context
        environment: 'development',    // TODO: Get from context
        createdAt: now,
      };

      hooks.set(data.hookId, hook);

      if (params?.resolveData === 'none') {
        const { metadata, ...rest } = hook;
        return rest as Hook;
      }
      return hook;
    },

    async get(hookId, params) {
      const hook = hooks.get(hookId);
      if (!hook) {
        throw new Error(`Hook ${hookId} not found`);
      }

      if (params?.resolveData === 'none') {
        const { metadata, ...rest } = hook;
        return rest as Hook;
      }
      return hook;
    },

    async getByToken(token, params) {
      for (const hook of hooks.values()) {
        if (hook.token === token) {
          if (params?.resolveData === 'none') {
            const { metadata, ...rest } = hook;
            return rest as Hook;
          }
          return hook;
        }
      }
      throw new Error(`Hook with token ${token} not found`);
    },

    async list(params) {
      let results = Array.from(hooks.values());

      if (params.runId) {
        results = results.filter(h => h.runId === params.runId);
      }

      const limit = params.pagination?.limit ?? 100;
      const hasMore = results.length > limit;
      const data = results.slice(0, limit);
      const nextCursor = hasMore ? data[data.length - 1].hookId : null;

      if (params.resolveData === 'none') {
        return {
          data: data.map(h => {
            const { metadata, ...rest } = h;
            return rest as Hook;
          }),
          cursor: nextCursor,
          hasMore,
        };
      }

      return { data, cursor: nextCursor, hasMore };
    },

    async dispose(hookId, params) {
      const hook = hooks.get(hookId);
      if (!hook) {
        throw new Error(`Hook ${hookId} not found`);
      }

      hooks.delete(hookId);

      if (params?.resolveData === 'none') {
        const { metadata, ...rest } = hook;
        return rest as Hook;
      }
      return hook;
    },
  };
}
```

---

## Implementing Queue

The Queue handles message passing between components.

> **⚠️ Important**: Workflow continuations reuse the same idempotency key. A naive "inflight tracking" approach will deadlock workflows. Use **TTL-based deduplication** instead. See [Idempotency Key Handling](./04-patterns-and-practices.md#idempotency-key-handling) for the correct pattern.

```typescript
// src/queue.ts
import { JsonTransport } from '@vercel/queue';
import type { Queue, MessageId, ValidQueueName, QueuePrefix } from '@workflow/world';
import { monotonicFactory } from 'ulid';
import { z } from 'zod';

const generateUlid = monotonicFactory();

export function createQueue(config: MyBackendConfig): Queue {
  const transport = new JsonTransport();

  // TTL-based idempotency tracking (see patterns doc for details)
  const recentlyQueuedKeys = new Map<
    string,
    { messageId: MessageId; timestamp: number }
  >();
  const IDEMPOTENCY_TTL_MS = 5000;

  return {
    async getDeploymentId() {
      // Return a unique identifier for this deployment
      return 'dpl_mybackend';
    },

    async queue(queueName, message, opts) {
      // Check TTL-based idempotency
      if (opts?.idempotencyKey) {
        const existing = recentlyQueuedKeys.get(opts.idempotencyKey);
        const now = Date.now();
        if (existing && now - existing.timestamp < IDEMPOTENCY_TTL_MS) {
          return { messageId: existing.messageId };
        }
      }

      const messageId = `msg_${generateUlid()}` as MessageId;

      // Track for short-term deduplication
      if (opts?.idempotencyKey) {
        recentlyQueuedKeys.set(opts.idempotencyKey, {
          messageId,
          timestamp: Date.now(),
        });
      }

      // Serialize the message
      const serialized = transport.serialize(message);

      // TODO: Replace with your queue system (BullMQ, Agenda, etc.)
      // This example uses setTimeout for async processing
      setTimeout(async () => {
        // Determine endpoint based on queue type
        let pathname: string;
        if (queueName.startsWith('__wkf_step_')) {
          pathname = 'step';
        } else if (queueName.startsWith('__wkf_workflow_')) {
          pathname = 'flow';
        } else {
          throw new Error('Unknown queue prefix');
        }

        // Make HTTP request to handler
        // TODO: Replace with your base URL
        const baseUrl = 'http://localhost:3000';
        const response = await fetch(
          `${baseUrl}/.well-known/workflow/v1/${pathname}`,
          {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-vqs-queue-name': queueName,
              'x-vqs-message-id': messageId,
              'x-vqs-message-attempt': '1',
            },
            body: serialized,
          }
        );

        if (!response.ok) {
          console.error('Queue message processing failed:', await response.text());
        }
      }, 0);

      return { messageId };
    },

    createQueueHandler(prefix, handler) {
      const HeaderParser = z.object({
        'x-vqs-queue-name': z.string(),
        'x-vqs-message-id': z.string(),
        'x-vqs-message-attempt': z.coerce.number(),
      });

      return async (req: Request): Promise<Response> => {
        const headers = HeaderParser.safeParse(
          Object.fromEntries(req.headers)
        );

        if (!headers.success || !req.body) {
          return Response.json(
            { error: 'Missing required headers or body' },
            { status: 400 }
          );
        }

        const queueName = headers.data['x-vqs-queue-name'] as ValidQueueName;
        const messageId = headers.data['x-vqs-message-id'] as MessageId;
        const attempt = headers.data['x-vqs-message-attempt'];

        if (!queueName.startsWith(prefix)) {
          return Response.json(
            { error: 'Unhandled queue' },
            { status: 400 }
          );
        }

        // Deserialize message
        const body = await new JsonTransport().deserialize(req.body);

        try {
          const result = await handler(body, { attempt, queueName, messageId });

          // Check if retry is requested
          if (result?.timeoutSeconds) {
            return Response.json(
              { timeoutSeconds: result.timeoutSeconds },
              { status: 503 }
            );
          }

          return Response.json({ ok: true });
        } catch (error) {
          return Response.json(String(error), { status: 500 });
        }
      };
    },
  };
}
```

---

## Implementing Streamer

The Streamer handles real-time I/O for workflow output.

```typescript
// src/streamer.ts
import { EventEmitter } from 'node:events';
import type { Streamer } from '@workflow/world';
import { monotonicFactory } from 'ulid';

const generateUlid = monotonicFactory();

interface StreamChunk {
  chunkId: string;
  data: Uint8Array;
  eof: boolean;
}

export function createStreamer(config: MyBackendConfig): Streamer {
  // In-memory storage (replace with your backend)
  const streams = new Map<string, StreamChunk[]>();

  // Event emitter for real-time notifications
  const emitter = new EventEmitter();

  return {
    async writeToStream(name, runId, chunk) {
      // Await runId if it's a promise
      await runId;

      const chunkId = `chnk_${generateUlid()}`;

      // Convert to Uint8Array
      let data: Uint8Array;
      if (typeof chunk === 'string') {
        data = new TextEncoder().encode(chunk);
      } else {
        data = chunk;
      }

      const streamChunk: StreamChunk = {
        chunkId,
        data,
        eof: false,
      };

      // Store the chunk
      if (!streams.has(name)) {
        streams.set(name, []);
      }
      streams.get(name)!.push(streamChunk);

      // Emit real-time notification
      emitter.emit(`chunk:${name}`, streamChunk);
    },

    async closeStream(name, runId) {
      await runId;

      const chunkId = `chnk_${generateUlid()}`;
      const streamChunk: StreamChunk = {
        chunkId,
        data: new Uint8Array(0),
        eof: true,
      };

      if (!streams.has(name)) {
        streams.set(name, []);
      }
      streams.get(name)!.push(streamChunk);

      emitter.emit(`close:${name}`);
    },

    async readFromStream(name, startIndex = 0) {
      return new ReadableStream<Uint8Array>({
        start(controller) {
          const deliveredChunkIds = new Set<string>();

          // Handler for new chunks
          const chunkHandler = (chunk: StreamChunk) => {
            if (deliveredChunkIds.has(chunk.chunkId)) return;
            deliveredChunkIds.add(chunk.chunkId);

            if (chunk.data.byteLength > 0) {
              controller.enqueue(Uint8Array.from(chunk.data));
            }
          };

          // Handler for stream close
          const closeHandler = () => {
            emitter.off(`chunk:${name}`, chunkHandler);
            emitter.off(`close:${name}`, closeHandler);
            try {
              controller.close();
            } catch {
              // Ignore if already closed
            }
          };

          // Subscribe to events
          emitter.on(`chunk:${name}`, chunkHandler);
          emitter.on(`close:${name}`, closeHandler);

          // Deliver existing chunks
          const existingChunks = streams.get(name) ?? [];
          for (let i = startIndex; i < existingChunks.length; i++) {
            const chunk = existingChunks[i];
            if (chunk.eof) {
              closeHandler();
              return;
            }
            if (!deliveredChunkIds.has(chunk.chunkId)) {
              deliveredChunkIds.add(chunk.chunkId);
              if (chunk.data.byteLength > 0) {
                controller.enqueue(Uint8Array.from(chunk.data));
              }
            }
          }
        },
      });
    },
  };
}
```

---

## Putting It All Together

Your final `src/index.ts`:

```typescript
import type { World } from '@workflow/world';
import { createQueue } from './queue.js';
import { createStorage } from './storage.js';
import { createStreamer } from './streamer.js';

export interface MyBackendConfig {
  connectionString?: string;
  // Add your configuration options
}

export function createWorld(config: MyBackendConfig = {}): World {
  return {
    ...createStorage(config),
    ...createQueue(config),
    ...createStreamer(config),
  };
}

// Export the function, not an instance
export default createWorld;
```

---

## Next Steps

1. **Run the tests** - See [05 - Testing](./05-testing.md)
2. **Apply production patterns** - See [04 - Patterns & Practices](./04-patterns-and-practices.md)
3. **Review the checklist** - See [06 - Production Checklist](./06-production-checklist.md)
