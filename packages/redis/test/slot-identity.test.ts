/**
 * Slot Identity Tests for Redis World
 */

import { slotIdentityTests } from '@workflow-worlds/testing';
import { createStorage } from './setup.js';

slotIdentityTests({ createStorage });
