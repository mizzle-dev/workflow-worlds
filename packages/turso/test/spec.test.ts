/**
 * Standard Test Suite for Turso World
 *
 * Runs the @workflow/world-testing integration tests.
 */

import { createTestSuite } from '@workflow/world-testing';
import { worldPath } from './setup.js';

createTestSuite(worldPath);
