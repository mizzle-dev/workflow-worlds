# @workflow-worlds/starter

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

## 0.0.3

### Patch Changes

- [#6](https://github.com/mizzle-dev/workflow-worlds/pull/6) [`0d9826c`](https://github.com/mizzle-dev/workflow-worlds/commit/0d9826cb90e199ec40e8b954f6667f1cb90b5431) Thanks [@dustintownsend](https://github.com/dustintownsend)! - Updated README and Initial Release of Testing package
