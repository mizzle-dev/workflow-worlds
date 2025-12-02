/**
 * Test Suite for Starter World
 *
 * This file runs both:
 * 1. The standard @workflow/world-testing suite (integration tests)
 * 2. Extended @workflow-worlds/testing suite (serialization, hooks, etc.)
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestSuite } from '@workflow/world-testing';
import {
  serializationTests,
  queueTests,
  hookCleanupTests,
  streamerTests,
} from '@workflow-worlds/testing';

// Get the absolute path to the built world module
const __dirname = dirname(fileURLToPath(import.meta.url));
const worldPath = join(__dirname, '..', 'dist', 'index.js');

// =============================================================================
// Standard Test Suite
// =============================================================================
// These tests verify the world works correctly with the workflow runtime.
createTestSuite(worldPath);

// =============================================================================
// Extended Test Suite
// =============================================================================
// These tests verify data serialization, hook cleanup, and other edge cases
// that weren't caught in the original test suite.

// Import the individual components for direct testing
// We use dynamic imports to get the built modules
const createStorage = async () => {
  const mod = await import(join(__dirname, '..', 'dist', 'storage.js'));
  return { storage: mod.createStorage() };
};

const createQueue = async () => {
  const mod = await import(join(__dirname, '..', 'dist', 'queue.js'));
  return { queue: mod.createQueue() };
};

const createStreamer = async () => {
  const mod = await import(join(__dirname, '..', 'dist', 'streamer.js'));
  return { streamer: mod.createStreamer() };
};

// Run extended tests
serializationTests({ createStorage });
hookCleanupTests({ createStorage });
queueTests({ createQueue });
streamerTests({ createStreamer });
