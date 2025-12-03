/**
 * Starter World Implementation
 *
 * This is a complete in-memory World implementation that passes all tests.
 * Use it as a starting point for building your custom World.
 *
 * To build your own World:
 * 1. Copy this starter to your project
 * 2. Run tests to verify everything works: `pnpm test`
 * 3. Incrementally replace each component with your real backend
 * 4. Keep running tests to ensure nothing breaks
 *
 * Each file has TODO markers showing where to swap in your implementation.
 */

import type { World } from '@workflow/world';
import { createQueue } from './queue.js';
import type { QueueConfig } from './queue.js';
import { createStorage } from './storage.js';
import { createStreamer } from './streamer.js';
import type { StreamerConfig } from './streamer.js';
import { debug } from './utils.js';

/**
 * Configuration for the starter world.
 *
 * TODO: Add your configuration options here.
 */
export interface StarterWorldConfig extends QueueConfig, StreamerConfig {
  // Add any shared configuration options
}

/**
 * Creates a starter World instance.
 *
 * This implementation stores everything in memory and uses setTimeout
 * for queue processing. It's suitable for:
 * - Development and testing
 * - Understanding the World interface
 * - Starting point for custom implementations
 *
 * For production, replace the implementations in:
 * - storage.ts - Use a real database (MongoDB, PostgreSQL, etc.)
 * - queue.ts - Use a real queue (BullMQ, Agenda, SQS, etc.)
 * - streamer.ts - Use real-time infrastructure (Redis Streams, etc.)
 */
export function createWorld(config: StarterWorldConfig = {}): World {
  debug('Creating world with config:', config);

  const storage = createStorage();
  const { queue, start: startQueue } = createQueue(config);
  const streamer = createStreamer(config);

  debug('Initialization complete');

  return {
    // Spread all storage methods
    ...storage,

    // Spread all queue methods
    ...queue,

    // Spread all streamer methods
    ...streamer,

    /**
     * Starts the queue processor.
     *
     * Messages queued before start() is called are buffered.
     * Once start() is called:
     * - All buffered messages are processed
     * - Future messages are processed immediately
     *
     * This matches the behavior of production worlds like Redis/BullMQ
     * where workers must be started explicitly.
     */
    async start(): Promise<void> {
      await startQueue();
    },
  };
}

// Default export for WORKFLOW_TARGET_WORLD environment variable
// When users set WORKFLOW_TARGET_WORLD=@myorg/world-custom,
// the runtime will import and call this function.
// IMPORTANT: Export the function itself, not the result of calling it.
export default createWorld;

// Re-export types for convenience
export { type QueueConfig } from './queue.js';
export { type StreamerConfig } from './streamer.js';
