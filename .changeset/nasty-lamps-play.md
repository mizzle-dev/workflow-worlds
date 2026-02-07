---
'@workflow-worlds/starter': minor
'@workflow-worlds/mongodb': minor
'@workflow-worlds/redis': minor
'@workflow-worlds/turso': minor
'@workflow-worlds/testing': minor
---

Migrate world implementations to the Workflow 4.1 event-sourced storage contract.

- Route runtime writes through `storage.events.create(...)`.
- Add guarded legacy-run compatibility behavior.
- Add stream lookup support with `listStreamsByRunId`.
- Add Turso migrations for `workflow_run_versions` and `stream_runs`.
- Update test helpers for mixed legacy/current storage behavior.
