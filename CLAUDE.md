# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Repository for building custom World implementations for the Workflow DevKit. A "World" provides three capabilities: Storage (persistence), Queue (async execution), and Streamer (real-time output).

## Commands

```bash
pnpm install        # Install all dependencies
pnpm build          # Build all packages
pnpm test           # Run test suite (requires build first)
pnpm typecheck      # TypeScript type checking
pnpm clean          # Clean build artifacts

# Single package development
cd packages/{name} && pnpm build && pnpm test
```

## Architecture

### World Interface

```typescript
interface World extends Queue, Storage, Streamer {
  start?(): Promise<void>;  // Optional initialization
}
```

- **Storage** - 4 namespaces: `runs`, `steps`, `events`, `hooks`
- **Queue** - `getDeploymentId()`, `queue()`, `createQueueHandler()`
- **Streamer** - `writeToStream()`, `closeStream()`, `readFromStream()`

### Export Pattern

```typescript
// CORRECT - export the function
export default createWorld;

// WRONG - calling it
export default createWorld();
```

The runtime imports and calls this function via `WORKFLOW_TARGET_WORLD`.

### ID Generation

Use monotonic ULIDs with prefixes:
```typescript
import { monotonicFactory } from 'ulid';
const generateUlid = monotonicFactory();

const runId = `wrun_${generateUlid()}`;
const stepId = `wstep_${generateUlid()}`;
const eventId = `wevt_${generateUlid()}`;
const hookId = `whook_${generateUlid()}`;
```

## Critical Patterns

### Deep Cloning (In-Memory Only)

Use `structuredClone()`, NOT `JSON.parse(JSON.stringify())`. The core mutates returned objects, and JSON serialization breaks Date objects.

### TTL-Based Idempotency

**Do NOT use inflight tracking** - it deadlocks workflows. Use TTL-based deduplication (5 seconds) to catch network retries only. Each step has a unique idempotency key, so workflow duration doesn't affect idempotency.

### Event Ordering

Events MUST be returned in ascending order (oldest first) for deterministic replay.

### Timestamp Idempotency

- `startedAt`: Set ONLY ONCE when status first becomes 'running'
- `completedAt`: Set only when reaching terminal status

### Hook Cleanup

Delete all hooks when runs reach terminal status ('completed', 'failed', 'cancelled').

### Error Handling

Use `WorkflowAPIError` from `@workflow/errors`:
```typescript
import { WorkflowAPIError } from '@workflow/errors';

throw new WorkflowAPIError(`Run not found: ${id}`, { status: 404 });
throw new WorkflowAPIError(`Duplicate token`, { status: 409 });
```

Plain `Error` results in 500; only `WorkflowAPIError` propagates proper status codes.

### Environment Variables

All World implementations must follow these conventions:

1. **Prefix with `WORKFLOW_`**: All env vars must start with `WORKFLOW_`
2. **Use `URI` not `URL`**: For connection strings (e.g., `WORKFLOW_MONGODB_URI`)
3. **Priority**: config > env var > default
4. **Make configurable**: All options should be settable via env vars where practical

```typescript
// Connection string example
const mongoUri = config.mongoUrl
  ?? process.env.WORKFLOW_MONGODB_URI
  ?? 'mongodb://localhost:27017';

// Boolean option example
const useFeature = config.useFeature
  ?? (process.env.WORKFLOW_MY_FEATURE !== undefined
    ? process.env.WORKFLOW_MY_FEATURE === 'true'
    : true);
```

### Debug Logging

All worlds must implement configurable debug logging via `WORKFLOW_DEBUG`. Logs must be written to stderr (not stdout) to avoid interfering with CLI JSON parsing.

**Usage:**
```bash
# Enable all debug output
WORKFLOW_DEBUG=1 pnpm test

# Enable specific worlds
WORKFLOW_DEBUG=redis-world pnpm test
WORKFLOW_DEBUG=mongodb-world,turso-world pnpm test
```

| Namespace | World |
|-----------|-------|
| `redis-world` | Redis |
| `mongodb-world` | MongoDB |
| `turso-world` | Turso |
| `starter-world` | Starter |
| `workbench` | Workbench plugin |

**Implementation:** Create `src/utils.ts` with a debug logger (copy from `packages/starter/src/utils.ts`):

```typescript
function createDebugLogger(namespace: string) {
  return (...args: unknown[]) => {
    const debug = process.env.WORKFLOW_DEBUG;
    if (!debug) return;

    const enabled =
      debug === '1' ||
      debug === 'true' ||
      debug === '*' ||
      debug.split(',').some((ns) => ns.trim() === namespace);

    if (!enabled) return;

    const timestamp = new Date().toISOString();
    const prefix = `[${timestamp}] [${namespace}]`;
    const message = args
      .map((arg) =>
        typeof arg === 'object' ? JSON.stringify(arg, null, 2) : String(arg)
      )
      .join(' ');

    process.stderr.write(`${prefix} ${message}\n`);
  };
}

export const debug = createDebugLogger('{your-world}-world');
```

**IMPORTANT:** Never use `console.log` or `console.warn` in world implementations - they write to stdout/stderr and can corrupt CLI JSON output. Always use the debug logger instead.

## Building a New World

1. Copy starter: `cp -r packages/starter packages/{backend}`
2. Update package.json name and add dependencies
3. Run `pnpm build && pnpm test` to verify baseline
4. Implement in order: runs → steps → events → hooks → queue → streamer
5. Run tests after each component

## Key Files

| File | Purpose |
|------|---------|
| `docs/02-interface-reference.md` | Complete API documentation |
| `docs/04-patterns-and-practices.md` | Critical patterns and gotchas |
| `docs/05-testing.md` | Test suite details and common errors |
| `packages/starter/src/storage.ts` | Reference storage implementation |
| `packages/starter/src/queue.ts` | Reference queue with TTL idempotency |
| `llm/AGENTS.md` | Detailed agent instructions |

## Test Suites

5 test suites from `@workflow/world-testing`:
- **addition** - Basic workflow execution (12s)
- **idempotency** - State reconstruction with 110 steps (30s)
- **hooks** - Hook/resume mechanism (15s)
- **errors** - Retry semantics (30s)
- **nullByte** - Binary data handling

All must pass before implementation is complete.
