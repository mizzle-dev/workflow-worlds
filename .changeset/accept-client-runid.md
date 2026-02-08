---
"@workflow-worlds/starter": patch
"@workflow-worlds/mongodb": patch
"@workflow-worlds/redis": patch
"@workflow-worlds/turso": patch
"@workflow-worlds/testing": patch
---

Accept client-provided runId for run_created events

The upstream @workflow/core runtime now generates runId client-side and passes it to events.create() for run_created events. Updated all world implementations to accept the client-provided runId instead of rejecting non-null values. Falls back to server-generated runId when null is passed for backward compatibility.
