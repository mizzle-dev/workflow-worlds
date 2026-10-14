/**
 * Slot Identity Tests for MongoDB World
 */

import { slotIdentityTests } from '@workflow-worlds/testing';
import { createStorage } from './setup.js';

slotIdentityTests({ createStorage });
