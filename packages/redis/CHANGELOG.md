# @workflow-worlds/redis

## 0.2.2

### Patch Changes

- [#29](https://github.com/mizzle-dev/workflow-worlds/pull/29) [`67def3c`](https://github.com/mizzle-dev/workflow-worlds/commit/67def3c1468d0df1b8c46336bfd4459f7f065f59) Thanks [@dustintownsend](https://github.com/dustintownsend)! - Fix webhook e2e regressions where webhook endpoints could return 404 in Redis and Turso worlds.

  - Redis: avoid closing stream readers before final persisted chunks are drained.
  - Turso: avoid closing stream readers during initial replay before buffered chunks are delivered.
  - Turso: normalize hook metadata nulls to undefined to preserve expected hydration behavior.

## 0.2.1

### Patch Changes

- [#25](https://github.com/mizzle-dev/workflow-worlds/pull/25) [`e91a2b2`](https://github.com/mizzle-dev/workflow-worlds/commit/e91a2b2e3b234dcf0c8694886424d72f468a314d) Thanks [@dustintownsend](https://github.com/dustintownsend)! - Accept client-provided runId for run_created events

  The upstream @workflow/core runtime now generates runId client-side and passes it to events.create() for run_created events. Updated all world implementations to accept the client-provided runId instead of rejecting non-null values. Falls back to server-generated runId when null is passed for backward compatibility.

## 0.2.0

### Minor Changes

- [#19](https://github.com/mizzle-dev/workflow-worlds/pull/19) [`6e68eba`](https://github.com/mizzle-dev/workflow-worlds/commit/6e68eba752b4bec485d5cc7e98a1974a2573a69f) Thanks [@dustintownsend](https://github.com/dustintownsend)! - Migrate world implementations to the Workflow 4.1 event-sourced storage contract.

  - Route runtime writes through `storage.events.create(...)`.
  - Add guarded legacy-run compatibility behavior.
  - Add stream lookup support with `listStreamsByRunId`.
  - Add Turso migrations for `workflow_run_versions` and `stream_runs`.
  - Update test helpers for mixed legacy/current storage behavior.

## 0.1.0

### Minor Changes

- [`b49f049`](https://github.com/mizzle-dev/workflow-worlds/commit/b49f049987b88a630986983e662de52702022168) Thanks [@dustintownsend](https://github.com/dustintownsend)! - Release all packages with minor bump
