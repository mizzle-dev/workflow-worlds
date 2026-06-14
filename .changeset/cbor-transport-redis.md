---
"@workflow-worlds/redis": patch
---

Add `CborTransport`/`DualTransport` and BullMQ wrapping helpers (`src/cbor-transport.ts`) and the `@vercel/queue` dependency for use with Workflow SDK spec version 3 (CBOR queue transport). Not yet wired into the default queue — see the upstream PR description for the migration checklist.
