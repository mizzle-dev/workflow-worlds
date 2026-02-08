# Workflow 4.1 Migration Guide

This guide covers a safe migration path for world implementations moving to the Workflow 4.1 contract.

## What Changed in 4.1

Workflow 4.1 moves world state transitions to an event-sourced flow.

- Runtime writes now flow through `storage.events.create(...)`.
- `run_created` must be created with `runId = null`.
- World adapters should expose read operations on `runs`, `steps`, and `hooks`, while writes are driven by events.
- Streamers now support `listStreamsByRunId(runId)`.

## Migration Checklist

1. Update dependencies to the same `@workflow/*` 4.1 beta line across all packages.
2. Move storage write paths into `events.create` handling.
3. Keep read APIs (`runs.get/list`, `steps.get/list`, `hooks.get/list/getByToken`) stable.
4. Add `listStreamsByRunId` in streamer implementations.
5. Verify `resolveData: 'none'` behavior is still correct for runs, steps, events, and hooks.
6. Add or update tests for legacy-run handling.
7. Enforce terminal-state guards consistently:
   - reject run state transitions on terminal runs (except idempotent `run_cancelled`)
   - reject step mutations on terminal steps
   - reject step/hook creation on terminal runs

## Legacy Run Compatibility

Legacy runs must remain readable and safely constrained.

- Supported for legacy runs:
  - `run_cancelled` (updates run state directly)
  - `wait_completed` and `hook_received` (append-only event writes)
- Rejected for legacy runs:
  - Other event types should return `409` conflict
- Future-only runs:
  - If a run requires a newer world spec version, return `RunNotSupportedError`

This is implemented across `starter`, `mongodb`, `redis`, and `turso`.

## Data and Schema Migration Requirements

### Redis

- No manual schema migration script required.
- New stream-to-run mapping is key-based and created on write.

### MongoDB

- No manual migration script required.
- New collections/indexes are created lazily at initialization, including `stream_runs`.

### Turso/libSQL

- Migration scripts are required and included via Drizzle migrations.
- New tables:
  - `workflow_run_versions`
  - `stream_runs`
- Run setup before first use and after upgrades:

```bash
pnpm exec workflow-turso-setup
```

## Verification Commands

Use package-level tests to validate behavior:

```bash
pnpm --filter @workflow-worlds/starter test
pnpm --filter @workflow-worlds/mongodb test
pnpm --filter @workflow-worlds/redis test
pnpm --filter @workflow-worlds/turso test
```

## Release Readiness Checklist

1. Ensure this migration doc and package READMEs are updated.
2. Add a Changeset describing 4.1 migration and Turso migration requirements.
3. Run tests for affected packages.
4. Merge to `main` so the release workflow can open/publish the release PR.
