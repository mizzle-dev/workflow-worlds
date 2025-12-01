# Workbench Benchmarks

This document explains how to run benchmarks locally and the relationship with the main Workflow repo.

## Quick Start

```bash
# Run benchmarks for a specific world
pnpm bench:starter   # In-memory starter world
pnpm bench:redis     # Redis world (requires Redis running)
pnpm bench:mongodb   # MongoDB world (requires MongoDB running)
```

## Available Benchmarks

| Benchmark | Description |
|-----------|-------------|
| `workflow with no steps` | Pure orchestration, no step execution |
| `workflow with 1 step` | Single step execution |
| `workflow with 10 sequential steps` | 10 steps executed in sequence |
| `workflow with 10 parallel steps` | 10 steps executed concurrently |
| `workflow with stream` | Stream generation and transformation |

## Running Benchmarks

### Prerequisites

Each world has different requirements:

```bash
# Starter (in-memory) - no external dependencies
pnpm bench:starter

# Redis - requires Redis server
docker run -d -p 6379:6379 redis:alpine
pnpm bench:redis

# MongoDB - requires MongoDB server
docker run -d -p 27017:27017 mongo:latest
pnpm bench:mongodb
```

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `WORKFLOW_TARGET_WORLD` | Package name of world to test | Required |
| `WORKFLOW_REDIS_URI` | Redis connection string | `redis://localhost:6379` |
| `WORKFLOW_MONGODB_URI` | MongoDB connection string | `mongodb://localhost:27017` |
| `DEPLOYMENT_URL` | URL of running workbench server | Set by bench script |
| `WORLD_NAME` | Name for output files | Derived from target world |

### Output Files

Benchmarks generate two files in `workbench/`:

- `bench-results-{world}.json` - Vitest benchmark results (ops/sec, iterations)
- `bench-timings-{world}.json` - Workflow execution timings (createdAt, startedAt, completedAt, TTFB)

## Benchmark Workflows

Defined in [workflows/bench.ts](workflows/bench.ts):

```typescript
// Pure orchestration - no steps
export async function noStepsWorkflow(input: number) {
  'use workflow';
  return input * 2;
}

// Single step
export async function oneStepWorkflow(input: number) {
  'use workflow';
  const result = await doWork();
  return result + input;
}

// Sequential steps
export async function tenSequentialStepsWorkflow() { ... }

// Parallel steps
export async function tenParallelStepsWorkflow() { ... }

// Streaming - generates and transforms a stream
export async function streamWorkflow() {
  'use workflow';
  const stream = await genBenchStream();    // Step: generates 10 chunks
  const doubled = await doubleNumbers(stream); // Step: transforms stream
  return doubled;
}
```

## Metrics Collected

### Execution Timing

For each workflow run:
- `createdAt` - When the run was created
- `startedAt` - When execution began
- `completedAt` - When execution finished
- `executionTimeMs` - Total time (completedAt - createdAt)

### Stream Metrics

For streaming workflows:
- `firstByteTimeMs` - Time to first byte (TTFB) from startedAt

### Summary Statistics

Aggregated across all iterations:
- `avgExecutionTimeMs`, `minExecutionTimeMs`, `maxExecutionTimeMs`
- `avgFirstByteTimeMs`, `minFirstByteTimeMs`, `maxFirstByteTimeMs` (streams only)
- `samples` - Number of valid samples

## Relationship with Workflow Repo

This workbench is derived from `github.com/vercel/workflow`. Key differences:

| Aspect | workflow repo | workflow-worlds |
|--------|--------------|-----------------|
| Purpose | Test multiple frameworks | Test world implementations |
| Structure | 2D matrix (frameworks × backends) | 1D array (worlds only) |
| File naming | `bench-results-{app}-{backend}.json` | `bench-results-{world}.json` |
| Workflows | `workbench/example/workflows/97_bench.ts` | `workbench/workflows/bench.ts` |
| Bench tests | `packages/core/e2e/bench.bench.ts` | `workbench/test/bench.bench.ts` |

### Syncing from Workflow Repo

Key files to sync:
1. Benchmark workflows (`97_bench.ts` → `bench.ts`)
2. Benchmark tests (`bench.bench.ts`)
3. GitHub Actions scripts (aggregate, render)

**Important transformation for `render.js`:**
- workflow repo: `render.js <benchmark-file> <app-name> <backend>` (3 args)
- workflow-worlds: `render.js <benchmark-file> <world>` (2 args)

The workflow repo tests multiple apps (nextjs, nitro, express) × backends, so it needs both app-name and backend. This repo only tests different world implementations against a single workbench app.

### World Configuration

Both repos use the same world configuration for consistency:

| World | Emoji | workflow | workflow-worlds |
|-------|-------|----------|-----------------|
| local | 💻 | Yes | Yes (built-in) |
| postgres | 🐘 | Yes | Yes |
| vercel | ▲ | Yes | Future |
| starter | 💾 | No | Yes |
| mongodb | 🍃 | No | Yes |
| redis | 🔴 | No | Yes |

## Debugging

### View benchmark output

```bash
# Check vitest results
cat workbench/bench-results-starter.json | jq '.testResults[0].benchmark'

# Check timing summary
cat workbench/bench-timings-starter.json | jq '.summary'
```

### Common issues

1. **"DEPLOYMENT_URL not set"** - The bench script should set this automatically
2. **Connection refused** - Ensure the required database is running
3. **Workflow not found** - Check that `streamWorkflow` is exported from `workflows/bench.ts`
