/**
 * Hook Cleanup Tests for MongoDB World
 */

import { hookCleanupTests } from '@workflow-worlds/testing';
import { createStorage } from './setup.js';

hookCleanupTests({ createStorage });
