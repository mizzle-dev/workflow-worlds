/**
 * Hook Cleanup Tests for Redis World
 */

import { hookCleanupTests } from '@workflow-worlds/testing';
import { createStorage } from './setup.js';

hookCleanupTests({ createStorage });
