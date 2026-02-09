---
"@workflow-worlds/redis": patch
"@workflow-worlds/turso": patch
---

Fix webhook e2e regressions where webhook endpoints could return 404 in Redis and Turso worlds.

- Redis: avoid closing stream readers before final persisted chunks are drained.
- Turso: avoid closing stream readers during initial replay before buffered chunks are delivered.
- Turso: normalize hook metadata nulls to undefined to preserve expected hydration behavior.
