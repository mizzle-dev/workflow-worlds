---
"@workflow-worlds/turso": patch
---

Configure runtime local SQLite connections with `PRAGMA journal_mode = WAL` and `PRAGMA busy_timeout = 5000` to reduce transient `SQLITE_BUSY` lock failures under e2e workloads.
