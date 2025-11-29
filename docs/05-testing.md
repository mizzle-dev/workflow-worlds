# Testing Your World

The `@workflow/world-testing` package provides a comprehensive test suite to validate any World implementation.

## Overview

The test suite runs real workflows against your World implementation, verifying that:

1. Basic workflow execution works correctly
2. Step execution and state replay is deterministic
3. Hooks and resume mechanisms function properly
4. Error handling and retries work as expected
5. Edge cases (like null bytes) are handled correctly

## Setup

### 1. Add Dependencies

In your world package's `package.json`:

```json
{
  "devDependencies": {
    "@workflow/world-testing": "workspace:*",
    "vitest": "catalog:"
  }
}
```

### 2. Create Test File

Create `test/spec.test.ts`:

```typescript
import { createTestSuite } from '@workflow/world-testing';

// Run the full test suite against your World
createTestSuite('./dist/index.js');
```

### 3. Run Tests

```bash
# Build your world first
pnpm build

# Run the test suite
pnpm test
```

## Test Suite Details

The `createTestSuite()` function runs 5 test groups:

### 1. Addition Test

**File:** `@workflow/world-testing/src/addition.mts`

Tests basic workflow execution with a simple async addition operation.

**What it tests:**
- Creating a workflow run
- Executing a step that performs async computation
- Completing a workflow with output
- Run ID format (`wrun_*`)

**Workflow:**
```typescript
async function addition(num1: number, num2: number) {
  "use workflow";
  return await add(num1, num2);
}

async function add(a: number, b: number) {
  "use step";
  await new Promise(r => setTimeout(r, 100));
  return a + b;
}
```

**Timeout:** 12 seconds

### 2. Idempotency Test

**File:** `@workflow/world-testing/src/idempotency.mts`

Tests that the World correctly handles state reconstruction through deterministic replay.

**What it tests:**
- Running many steps in batches (10 + 100)
- State replay after workflow continuation
- Idempotent step execution
- Concurrent step handling

**Workflow:**
```typescript
async function brokenWf() {
  "use workflow";
  // Run 10 steps, then 100 more
  const results = await Promise.all(
    Array.from({ length: 110 }, (_, i) => step(i))
  );
  return results.reduce((a, b) => a + b, 0);
}
```

**Timeout:** 60 seconds

### 3. Hooks Test

**File:** `@workflow/world-testing/src/hooks.mts`

Tests the hook/resume mechanism for long-running operations.

**What it tests:**
- Creating hooks with tokens
- Resuming hooks with payloads
- Event streaming (JSON Lines format)
- Multiple resume payloads collected
- Proper hook metadata

**Workflow:**
```typescript
async function collectWithHook(token: string, customData: object) {
  "use workflow";
  const hook = createHook({ token, metadata: customData });
  const payloads = [];

  while (payloads.length < 3) {
    const payload = await hook.receive();
    payloads.push(payload);
  }

  return payloads;
}
```

**Timeout:** 60 seconds

### 4. Errors Test

**File:** `@workflow/world-testing/src/errors.mts`

Tests retry semantics and fatal error handling.

**What it tests:**
- `RetryableError` with `retryAfter` timing
- `FatalError` stops execution immediately
- Step attempt counting
- Retry delay enforcement (>= 2000ms)
- Step metadata accuracy

**Workflow:**
```typescript
async function retryableAndFatalErrorWorkflow() {
  "use workflow";
  await retryableStep();  // Throws RetryableError once
  await fatalStep();      // Throws FatalError
}
```

**Timeout:** 59 seconds

### 5. Null Byte Test

**File:** `@workflow/world-testing/src/null-byte.mts`

Tests handling of edge cases with binary data.

**What it tests:**
- Strings containing null bytes (`\0`)
- Proper serialization/deserialization of binary data
- No data corruption through storage/retrieval

**Workflow:**
```typescript
async function nullByteWorkflow() {
  "use workflow";
  return await nullByteStep();
}

async function nullByteStep() {
  "use step";
  return "test\0value";  // String with null byte
}
```

**Timeout:** 12 seconds

## Test Infrastructure

The test suite uses:

### HTTP Server

The testing framework spawns an HTTP server with your World:

```typescript
const server = await startServer({ world: './dist/index.js' });
```

Endpoints:
- `POST /.well-known/workflow/v1/flow` - Workflow execution
- `POST /.well-known/workflow/v1/step` - Step execution
- `POST /invoke` - Start a workflow
- `POST /hooks/:token` - Resume a hook
- `GET /runs/:runId` - Get run status
- `GET /runs/:runId/readable` - Stream events

### Fetcher Utilities

Tests use a `createFetcher()` helper:

```typescript
const fetcher = createFetcher(server);

// Invoke a workflow
const result = await fetcher.invoke('workflows/addition.ts', 'addition', [1, 2]);

// Poll for completion
const run = await vi.waitFor(async () => {
  const run = await fetcher.getRun(result.runId);
  expect(run.status).toBe('completed');
  return run;
}, { timeout: 10_000 });

// Resume a hook
await fetcher.resumeHook(token, { data: 'payload' });

// Get event stream
const readable = await fetcher.getReadable(result.runId);
```

### JSON Lines Streaming

Event streams use JSON Lines format:

```typescript
import { jsonlines } from '@workflow/world-testing';

const readable = await fetcher.getReadable(result.runId);
for await (const event of jsonlines(readable)) {
  if (event?.event === 'hookCreated') {
    // Handle hook created
  }
  if (event?.event === 'hookResumed') {
    // Handle hook resumed
  }
}
```

## Database Testing with Containers

For database-backed worlds, use test containers.

### PostgreSQL Example

```typescript
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestSuite } from '@workflow/world-testing';
import { execSync } from 'node:child_process';
import { afterAll, beforeAll } from 'vitest';

let container: Awaited<ReturnType<PostgreSqlContainer['start']>>;

beforeAll(async () => {
  // Start PostgreSQL container
  container = await new PostgreSqlContainer('postgres:15-alpine').start();

  // Set connection string
  process.env.WORKFLOW_POSTGRES_URL = container.getConnectionUri();

  // Run migrations
  execSync('pnpm db:push', { stdio: 'inherit' });
}, 120_000);  // 2 minute timeout for container startup

afterAll(async () => {
  if (container) {
    await container.stop();
  }
});

// Run the test suite
createTestSuite('./dist/index.js');
```

### MongoDB Example

```typescript
import { MongoDBContainer } from '@testcontainers/mongodb';
import { createTestSuite } from '@workflow/world-testing';
import { afterAll, beforeAll } from 'vitest';

let container: Awaited<ReturnType<MongoDBContainer['start']>>;

beforeAll(async () => {
  container = await new MongoDBContainer('mongo:7').start();
  process.env.WORKFLOW_MONGODB_URI = container.getConnectionString() + '?directConnection=true';
}, 120_000);

afterAll(async () => {
  if (container) {
    await container.stop();
  }
});

createTestSuite('./dist/index.js');
```

## Debugging Test Failures

### Common Issues

#### 1. "Run not found" errors

Your `storage.runs.create()` might not be storing correctly, or `storage.runs.get()` isn't finding the run.

**Debug:**
```typescript
async create(data) {
  const run = { /* ... */ };
  console.log('Creating run:', run.runId);
  // ...
}

async get(id) {
  console.log('Getting run:', id);
  const run = /* ... */;
  console.log('Found:', run ? 'yes' : 'no');
  // ...
}
```

#### 2. Hooks test hanging

The hook resume mechanism might not be triggering workflow continuation.

**Check:**
- `hooks.getByToken()` returns the correct hook
- Events are being created with correct correlation IDs
- Queue messages are being processed

#### 3. Idempotency test failing

State replay might not be deterministic.

**Check:**
- Events are returned in chronological order (`sortOrder: 'asc'`)
- All step events are being stored
- Correlation IDs match between events

#### 4. Retry timing test failing

The `errors` test checks that retry delays are >= 2000ms.

**Check:**
- `step.retryAfter` is being stored correctly
- Time comparison logic accounts for timing variance

### Viewing Test Output

Run with verbose output:

```bash
pnpm vitest run --reporter=verbose
```

Run a single test:

```bash
pnpm vitest run -t "addition"
pnpm vitest run -t "hooks"
```

## Continuous Integration

Example GitHub Actions workflow:

```yaml
name: Test World
on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: pnpm/action-setup@v2
        with:
          version: 10

      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: pnpm

      - run: pnpm install

      - run: pnpm build
        working-directory: packages/world-mybackend

      - run: pnpm test
        working-directory: packages/world-mybackend
```

For database tests, add services:

```yaml
services:
  postgres:
    image: postgres:15-alpine
    env:
      POSTGRES_PASSWORD: test
    ports:
      - 5432:5432
    options: >-
      --health-cmd pg_isready
      --health-interval 10s
      --health-timeout 5s
      --health-retries 5
```

## Next Steps

Once all tests pass, review the [06 - Production Checklist](./06-production-checklist.md) before deploying.
