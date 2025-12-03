/**
 * Extended Testing Utilities for Workflow Worlds
 *
 * This package provides supplementary test suites that complement
 * the @workflow/world-testing package. These tests focus on:
 *
 * - **Serialization**: Date preservation, complex nested data, undefined vs null
 * - **Queue**: resumeAt dates, payload preservation, idempotency
 * - **Hook Cleanup**: Token reuse after workflow completion
 * - **Streamer**: Binary data, named streams, null bytes
 *
 * ## Usage
 *
 * ```typescript
 * import { serializationTests, queueTests, hookCleanupTests, streamerTests } from '@workflow-worlds/testing';
 *
 * // In your test file:
 * serializationTests({
 *   createStorage: async () => {
 *     const { storage } = await createStorage({ ... });
 *     return { storage };
 *   },
 * });
 *
 * queueTests({
 *   createQueue: async () => {
 *     const { queue } = await createQueue({ ... });
 *     return { queue };
 *   },
 * });
 * ```
 */

export { serializationTests } from './serialization.js';
export type { SerializationTestOptions } from './serialization.js';

export { queueTests } from './queue.js';
export type { QueueTestOptions } from './queue.js';

export { hookCleanupTests } from './hooks.js';
export type { HookTestOptions } from './hooks.js';

export { streamerTests } from './streamer.js';
export type { StreamerTestOptions } from './streamer.js';

export { outputPreservationTests } from './output-preservation.js';
export type { OutputPreservationTestOptions } from './output-preservation.js';
