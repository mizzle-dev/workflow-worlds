/**
 * Standard Test Suite for MongoDB World
 *
 * Runs the @workflow/world-testing integration tests.
 */

import { createTestSuite } from '@workflow/world-testing';
import { worldPath } from './setup.js';

createTestSuite(worldPath);
