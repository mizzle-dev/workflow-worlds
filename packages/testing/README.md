# @workflow-worlds/testing

[![npm version](https://img.shields.io/npm/v/@workflow-worlds/testing.svg)](https://www.npmjs.com/package/@workflow-worlds/testing)
[![license](https://img.shields.io/npm/l/@workflow-worlds/testing.svg)](https://github.com/mizzle-dev/workflow-worlds/blob/main/LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue.svg)](https://www.typescriptlang.org/)

Extended testing utilities for [Workflow World](https://github.com/vercel/workflow) implementations. Complements `@workflow/world-testing` with additional test suites for edge cases.

## Features

- **Serialization Tests** - Date preservation, nested data, undefined vs null handling
- **Queue Tests** - resumeAt dates, payload preservation, idempotency
- **Hook Cleanup Tests** - Token reuse after workflow completion
- **Streamer Tests** - Binary data, named streams, null bytes
- **Output Preservation Tests** - Null/undefined distinction in step outputs
- **Event Sourcing Contract Tests** - Workflow 4.1 contract guards and compatibility behavior
- **Workflow 4.1 Compatibility Helpers** - Supports legacy and event-sourced storage paths

## Installation

```bash
npm install -D @workflow-worlds/testing
# or
pnpm add -D @workflow-worlds/testing
```

## Requirements

- Node.js 22+
- [Vitest](https://vitest.dev/) 2.0+

## Usage

Import the test suites and provide factory functions for your implementations:

### Serialization Tests

Tests that your storage correctly preserves data types:

```typescript
import { serializationTests } from '@workflow-worlds/testing';

serializationTests({
  createStorage: async () => {
    const storage = createStorage({ /* your config */ });
    return { storage };
  },
});
```

### Queue Tests

Tests queue behavior including resumeAt scheduling:

```typescript
import { queueTests } from '@workflow-worlds/testing';

queueTests({
  createQueue: async () => {
    const queue = createQueue({ /* your config */ });
    return { queue };
  },
});
```

### Hook Cleanup Tests

Tests that hook tokens can be reused after workflow completion:

```typescript
import { hookCleanupTests } from '@workflow-worlds/testing';

hookCleanupTests({
  createStorage: async () => {
    const storage = createStorage({ /* your config */ });
    return { storage };
  },
});
```

### Streamer Tests

Tests streaming with binary data and named streams:

```typescript
import { streamerTests } from '@workflow-worlds/testing';

streamerTests({
  createStreamer: async () => {
    const streamer = createStreamer({ /* your config */ });
    return { streamer };
  },
});
```

### Output Preservation Tests

Tests that null and undefined are preserved distinctly in step outputs:

```typescript
import { outputPreservationTests } from '@workflow-worlds/testing';

outputPreservationTests({
  createStorage: async () => {
    const storage = createStorage({ /* your config */ });
    return { storage };
  },
});
```

### Event Sourcing Contract Tests

Tests Workflow 4.1 event-sourcing contract behavior:

```typescript
import { eventSourcingTests } from '@workflow-worlds/testing';

eventSourcingTests({
  createStorage: async () => {
    const storage = createStorage({ /* your config */ });
    return { storage };
  },
});
```

## Test Suites

| Suite | Tests | Description |
|-------|-------|-------------|
| `serializationTests` | 8 | Date objects, nested data, event ordering/shape |
| `queueTests` | 4 | deployment ID and idempotent queueing |
| `hookCleanupTests` | 6 | Token cleanup, reuse, conflict behavior |
| `streamerTests` | 7 | Binary chunks, named streams, stream indexing |
| `outputPreservationTests` | 14 | Run/step output and input preservation |
| `eventSourcingTests` | 14 | Event contract guards, resolveData=none, legacy/future behavior |

## Example: Full Test File

```typescript
// test/world.test.ts
import { describe } from 'vitest';
import {
  serializationTests,
  queueTests,
  hookCleanupTests,
  streamerTests,
  outputPreservationTests,
  eventSourcingTests,
} from '@workflow-worlds/testing';
import { createWorld } from '../src/index.js';

describe('MyWorld', () => {
  const createStorage = async () => {
    const world = createWorld();
    return { storage: world };
  };

  const createQueue = async () => {
    const world = createWorld();
    return { queue: world };
  };

  const createStreamer = async () => {
    const world = createWorld();
    return { streamer: world };
  };

  serializationTests({ createStorage });
  queueTests({ createQueue });
  hookCleanupTests({ createStorage });
  streamerTests({ createStreamer });
  outputPreservationTests({ createStorage });
  eventSourcingTests({ createStorage });
});
```

## Relationship to @workflow/world-testing

This package provides **supplementary** tests that focus on edge cases not covered by the core `@workflow/world-testing` package:

| Package | Focus |
|---------|-------|
| `@workflow/world-testing` | Full workflow lifecycle (spawns HTTP server, runs real workflows) |
| `@workflow-worlds/testing` | Component-level tests for serialization, edge cases, isolated behaviors |

Both packages should be used together for comprehensive test coverage.

## License

MIT
