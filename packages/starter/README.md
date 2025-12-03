# @workflow-worlds/starter

[![npm version](https://img.shields.io/npm/v/@workflow-worlds/starter.svg)](https://www.npmjs.com/package/@workflow-worlds/starter)
[![license](https://img.shields.io/npm/l/@workflow-worlds/starter.svg)](https://github.com/mizzle-dev/workflow-worlds/blob/main/LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue.svg)](https://www.typescriptlang.org/)

A complete in-memory [World](https://github.com/vercel/workflow) implementation that serves as a starting point for building custom Worlds.

## Features

- **In-Memory Storage** - Runs, steps, events, and hooks stored in Maps
- **setTimeout Queue** - Simple queue processing via HTTP callbacks
- **In-Memory Streamer** - Real-time output streaming with event emitters
- **Full Test Coverage** - Passes all `@workflow/world-testing` suites
- **Well-Documented** - TODO markers show where to add your implementation

## Installation

```bash
npm install @workflow-worlds/starter
# or
pnpm add @workflow-worlds/starter
```

## Quick Start

```typescript
import { createWorld } from '@workflow-worlds/starter';

const world = createWorld();

// Start queue processing
await world.start();
```

## Building Your Own World

The starter is designed to be copied and modified:

### 1. Copy the starter

```bash
cp -r packages/starter my-world
cd my-world
```

### 2. Update package.json

```json
{
  "name": "@myorg/world-custom",
  "description": "My custom World implementation"
}
```

### 3. Verify tests pass

```bash
pnpm install
pnpm build
pnpm test
```

### 4. Replace implementations

Each component has TODO markers showing where to add your backend:

| File | Replace With |
|------|--------------|
| `src/storage.ts` | Database (MongoDB, PostgreSQL, etc.) |
| `src/queue.ts` | Job queue (BullMQ, SQS, etc.) |
| `src/streamer.ts` | Streaming (Redis Streams, WebSockets, etc.) |

### 5. Test incrementally

Run tests after each change to catch issues early:

```bash
pnpm test
```

## Project Structure

```
src/
├── index.ts      # World factory and exports
├── storage.ts    # Storage implementation (runs, steps, events, hooks)
├── queue.ts      # Queue implementation with HTTP callbacks
├── streamer.ts   # Output streaming implementation
└── utils.ts      # Shared utilities (ID generation, cloning)
```

## Configuration

```typescript
interface StarterWorldConfig {
  // Base URL for HTTP callbacks
  // Default: http://localhost:${PORT}
  baseUrl?: string;

  // Port for HTTP callbacks
  // Default: process.env.PORT ?? 3000
  port?: number;
}
```

## Usage with Workflow DevKit

Set the `WORKFLOW_TARGET_WORLD` environment variable:

```bash
WORKFLOW_TARGET_WORLD=@workflow-worlds/starter pnpm dev
```

Or export the factory function:

```typescript
// world.ts
import { createWorld } from '@workflow-worlds/starter';

export default createWorld;
```

## Test Suites

The starter passes all five test suites from `@workflow/world-testing`:

| Suite | Description | Duration |
|-------|-------------|----------|
| addition | Basic workflow execution | ~12s |
| idempotency | State reconstruction with 110 steps | ~30s |
| hooks | Hook/resume mechanism | ~15s |
| errors | Retry semantics | ~30s |
| nullByte | Binary data handling | ~5s |

Run tests:

```bash
pnpm test
```

## Important Patterns

### Deep Cloning

The starter uses `structuredClone()` for all returned objects to prevent mutation issues:

```typescript
// storage.ts
return deepClone(run);  // Not the original object
```

### Queue Buffering

Messages queued before `start()` are buffered and processed once started:

```typescript
const world = createWorld();
await world.queue(...);  // Buffered
await world.start();     // Now processed
```

### ID Generation

Uses monotonic ULIDs with prefixes for all entities:

```typescript
const runId = `wrun_${generateUlid()}`;
const stepId = `wstep_${generateUlid()}`;
```

## License

MIT
