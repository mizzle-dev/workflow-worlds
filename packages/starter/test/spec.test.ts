/**
 * Standard Test Suite for Starter World
 *
 * Runs the @workflow/world-testing integration tests.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestSuite } from '@workflow/world-testing';

// Get the absolute path to the built world module
const __dirname = dirname(fileURLToPath(import.meta.url));
const worldPath = join(__dirname, '..', 'dist', 'index.js');

// Standard test suite - verifies the world works with the workflow runtime
createTestSuite(worldPath);
