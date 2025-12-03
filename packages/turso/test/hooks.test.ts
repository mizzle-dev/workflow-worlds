/**
 * Hook Cleanup Tests for Turso World
 */

import { hookCleanupTests } from '@workflow-worlds/testing';
import { createStorage } from './setup.js';

hookCleanupTests({ createStorage });
